import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Canvas as PdfCanvas } from "@napi-rs/canvas";
import type * as NapiCanvas from "@napi-rs/canvas";
import type { ImportHelperRequest } from "./import-helper-contract.server";
import { pdfjsResourceUrl } from "./pdfjs-runtime.server";

const execFileAsync = promisify(execFile);

export const PDF_OCR_MAX_PAGES = 20;
export const PDF_OCR_MAX_IMAGE_DIMENSION = 4000;
export const PDF_OCR_MAX_IMAGE_PIXELS = 16_000_000;
export const PDF_OCR_DOCUMENT_TIMEOUT_MS = 120_000;
export const PDF_OCR_PAGE_TIMEOUT_MS = 15_000;

const PDF_OCR_RENDER_TIMEOUT_MS = 30_000;
const PDF_OCR_CONCURRENCY = 2;
const PDF_OCR_MAX_QUEUE = 4;
const TESSERACT_CHECK_TIMEOUT_MS = 5_000;
const TESSERACT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const OCR_LANGUAGES = "eng+swe";

export type PdfOcrFailureCode =
  | "unavailable"
  | "page-limit"
  | "timeout"
  | "failed"
  | "busy";

export class PdfOcrError extends Error {
  constructor(
    readonly code: PdfOcrFailureCode,
    readonly ocrPagesAttempted = 0,
    readonly ocrPagesSuccessful = 0,
    readonly pageCount = 0
  ) {
    super(`PDF OCR ${code}.`);
    this.name = "PdfOcrError";
  }
}

export type PdfOcrPositionedItem = {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  page: number;
};

export type PdfOcrPage = ImportHelperRequest["document"]["pages"][number] & {
  positionedItems: PdfOcrPositionedItem[];
};

export type PdfOcrResult = {
  pages: PdfOcrPage[];
  pageCount: number;
  ocrPagesAttempted: number;
  ocrPagesSuccessful: number;
};

type PdfJsPage = {
  cleanup(): void;
  getViewport(options: { scale: number }): {
    width: number;
    height: number;
  };
  render(options: {
    canvasContext: object;
    viewport: { width: number; height: number };
  }): { promise: Promise<void>; cancel(): void };
};

let activeDocuments = 0;
const waitingDocuments: Array<() => void> = [];
const tesseractCapabilityChecks = new Map<string, Promise<void>>();

function getTesseractBinary() {
  return process.env.IOIO_TESSERACT_BINARY?.trim() || "tesseract";
}

async function runTesseractCapabilityCheck(binary: string) {
  try {
    const { stdout } = await execFileAsync(binary, ["--list-langs"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024,
      timeout: TESSERACT_CHECK_TIMEOUT_MS,
    });
    const languages = new Set(
      stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /^[a-z_]{3,}$/i.test(line))
    );
    if (!languages.has("eng") || !languages.has("swe")) {
      throw new PdfOcrError("unavailable");
    }
  } catch {
    throw new PdfOcrError("unavailable");
  }
}

async function ensureTesseractAvailable(binary: string) {
  let check = tesseractCapabilityChecks.get(binary);
  if (!check) {
    check = runTesseractCapabilityCheck(binary);
    tesseractCapabilityChecks.set(binary, check);
  }
  try {
    await check;
  } catch (error) {
    tesseractCapabilityChecks.delete(binary);
    throw error;
  }
}

async function withOcrDocumentSlot<T>(work: () => Promise<T>) {
  if (activeDocuments >= PDF_OCR_CONCURRENCY) {
    if (waitingDocuments.length >= PDF_OCR_MAX_QUEUE) {
      throw new PdfOcrError("busy");
    }
    await new Promise<void>((resolve) => waitingDocuments.push(resolve));
  } else {
    activeDocuments += 1;
  }

  try {
    return await work();
  } finally {
    const next = waitingDocuments.shift();
    if (next) next();
    else activeDocuments -= 1;
  }
}

function waitForOperation<T>(
  promise: Promise<T>,
  timeoutMs: number,
  cancel?: () => void
) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timeout = setTimeout(() => {
        cancel?.();
        reject(new PdfOcrError("timeout"));
      }, timeoutMs);
    }),
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

function remainingTimeout(deadline: number, maximum: number) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new PdfOcrError("timeout");
  return Math.min(maximum, remaining);
}

function normalizeOcrText(value: string) {
  return value
    .replaceAll("\u0000", "")
    .replace(/\r\n?/g, "\n")
    .replace(/\f/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[\t\u00a0\u2007\u202f ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function pageHasMeaningfulText(text: string) {
  return (text.match(/[\p{L}\p{N}]/gu)?.length ?? 0) >= 3;
}

function parseTesseractTsv(value: string, page: number) {
  const [headerLine, ...dataLines] = value.replace(/\r\n?/g, "\n").split("\n");
  const headers = (headerLine ?? "").split("\t");
  const column = (name: string) => headers.indexOf(name);
  const indices = {
    level: column("level"),
    block: column("block_num"),
    paragraph: column("par_num"),
    line: column("line_num"),
    left: column("left"),
    top: column("top"),
    width: column("width"),
    height: column("height"),
    confidence: column("conf"),
    text: column("text"),
  };
  if (Object.values(indices).some((index) => index < 0)) {
    throw new PdfOcrError("failed");
  }

  const positionedItems: PdfOcrPositionedItem[] = [];
  const lineWords = new Map<string, { order: number; words: string[] }>();
  dataLines.forEach((line, order) => {
    const cells = line.split("\t");
    if (cells[indices.level] !== "5") return;
    const text = cells[indices.text]?.trim();
    if (!text) return;
    const x = Number(cells[indices.left]);
    const y = Number(cells[indices.top]);
    const width = Number(cells[indices.width]);
    const height = Number(cells[indices.height]);
    const confidence = Number(cells[indices.confidence]);
    if (![x, y, width, height].every(Number.isFinite) || confidence < 0) {
      return;
    }
    positionedItems.push({ text, x, y, width, height, page });
    const lineKey = [
      cells[indices.block],
      cells[indices.paragraph],
      cells[indices.line],
    ].join(":");
    const existing = lineWords.get(lineKey);
    if (existing) existing.words.push(text);
    else lineWords.set(lineKey, { order, words: [text] });
  });

  const text = normalizeOcrText(
    [...lineWords.values()]
      .sort((left, right) => left.order - right.order)
      .map(({ words }) => words.join(" "))
      .join("\n")
  );
  return { text, positionedItems };
}

function getOcrDimensions(page: PdfJsPage) {
  const base = page.getViewport({ scale: 1 });
  const maxScale = 200 / 72;
  const dimensionScale =
    PDF_OCR_MAX_IMAGE_DIMENSION / Math.max(base.width, base.height);
  const pixelScale = Math.sqrt(
    PDF_OCR_MAX_IMAGE_PIXELS / (base.width * base.height)
  );
  const scale = Math.min(maxScale, dimensionScale, pixelScale);
  const viewport = page.getViewport({ scale });
  return {
    width: Math.max(1, Math.ceil(viewport.width)),
    height: Math.max(1, Math.ceil(viewport.height)),
    viewport,
  };
}

async function runTesseract(
  binary: string,
  imagePath: string,
  timeout: number
) {
  try {
    const { stdout } = await execFileAsync(
      binary,
      [
        imagePath,
        "stdout",
        "--oem",
        "1",
        "--psm",
        "3",
        "-l",
        OCR_LANGUAGES,
        "tsv",
      ],
      {
        encoding: "utf8",
        maxBuffer: TESSERACT_MAX_OUTPUT_BYTES,
        timeout,
      }
    );
    return parseTesseractTsv(stdout, 1);
  } catch (error) {
    const processError = error as NodeJS.ErrnoException & {
      killed?: boolean;
      signal?: string | null;
    };
    if (processError.code === "ENOENT") {
      throw new PdfOcrError("unavailable");
    }
    if (
      processError.killed ||
      processError.code === "ETIMEDOUT" ||
      processError.signal === "SIGTERM"
    ) {
      throw new PdfOcrError("timeout");
    }
    throw new PdfOcrError("failed");
  }
}

async function renderAndRecognizePages(
  buffer: Buffer,
  binary: string
): Promise<PdfOcrResult> {
  let canvasModule: typeof NapiCanvas;
  try {
    canvasModule = await import("@napi-rs/canvas");
  } catch {
    throw new PdfOcrError("unavailable");
  }
  const canvasGlobals = globalThis as unknown as Record<string, unknown>;
  if (typeof canvasGlobals.DOMMatrix === "undefined") {
    canvasGlobals.DOMMatrix = canvasModule.DOMMatrix;
  }
  if (typeof canvasGlobals.ImageData === "undefined") {
    canvasGlobals.ImageData = canvasModule.ImageData;
  }
  if (typeof canvasGlobals.Path2D === "undefined") {
    canvasGlobals.Path2D = canvasModule.Path2D;
  }

  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    cMapUrl: pdfjsResourceUrl("cmaps"),
    cMapPacked: true,
    standardFontDataUrl: pdfjsResourceUrl("standard_fonts"),
    useSystemFonts: true,
    isEvalSupported: false,
    verbosity: 0,
  });
  const startedAt = Date.now();
  const deadline = startedAt + PDF_OCR_DOCUMENT_TIMEOUT_MS;
  let temporaryDirectory: string | null = null;
  let pageCount = 0;
  let ocrPagesAttempted = 0;
  let ocrPagesSuccessful = 0;
  try {
    const document = await waitForOperation(
      loadingTask.promise,
      remainingTimeout(deadline, PDF_OCR_DOCUMENT_TIMEOUT_MS)
    );
    pageCount = document.numPages;
    if (pageCount > PDF_OCR_MAX_PAGES) {
      throw new PdfOcrError("page-limit");
    }

    temporaryDirectory = await mkdtemp(path.join(tmpdir(), "shelf-pdf-ocr-"));
    const pages: PdfOcrPage[] = [];

    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = (await waitForOperation(
        document.getPage(pageNumber),
        remainingTimeout(deadline, PDF_OCR_PAGE_TIMEOUT_MS)
      )) as PdfJsPage;
      let canvas: PdfCanvas | null = null;
      let imagePath: string | null = null;
      try {
        const { width, height, viewport } = getOcrDimensions(page);
        canvas = canvasModule.createCanvas(width, height);
        const context = canvas.getContext("2d");
        const renderTask = page.render({
          canvasContext: context,
          viewport,
        });
        await waitForOperation(
          renderTask.promise,
          remainingTimeout(deadline, PDF_OCR_RENDER_TIMEOUT_MS),
          () => renderTask.cancel()
        );
        const image = canvas.toBuffer("image/png");
        imagePath = path.join(temporaryDirectory, `page-${pageNumber}.png`);
        await writeFile(imagePath, image, { flag: "wx", mode: 0o600 });
        ocrPagesAttempted += 1;
        const recognized = await runTesseract(
          binary,
          imagePath,
          remainingTimeout(deadline, PDF_OCR_PAGE_TIMEOUT_MS)
        );
        if (pageHasMeaningfulText(recognized.text)) ocrPagesSuccessful += 1;
        pages.push({
          sourceRef: `pdf-page-${pageNumber}`,
          page: pageNumber,
          text: recognized.text,
          positionedItems: recognized.positionedItems.map((item) => ({
            ...item,
            page: pageNumber,
          })),
        });
      } finally {
        page.cleanup();
        if (canvas) {
          canvas.width = 0;
          canvas.height = 0;
        }
        if (imagePath) await rm(imagePath, { force: true });
      }
    }

    return {
      pages,
      pageCount: document.numPages,
      ocrPagesAttempted,
      ocrPagesSuccessful,
    };
  } catch (error) {
    const code = error instanceof PdfOcrError ? error.code : "failed";
    const errorPageCount = error instanceof PdfOcrError ? error.pageCount : 0;
    throw new PdfOcrError(
      code,
      ocrPagesAttempted,
      ocrPagesSuccessful,
      Math.max(pageCount, errorPageCount)
    );
  } finally {
    await loadingTask.destroy();
    if (temporaryDirectory) {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
}

export async function ocrPdfPages(buffer: Buffer): Promise<PdfOcrResult> {
  const binary = getTesseractBinary();
  await ensureTesseractAvailable(binary);
  return withOcrDocumentSlot(() => renderAndRecognizePages(buffer, binary));
}
