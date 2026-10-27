// @vitest-environment node

import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockPdfRuntime = vi.hoisted(() => {
  const renderTask = { promise: Promise.resolve(), cancel: vi.fn() };
  const page = {
    getViewport: vi.fn(({ scale }: { scale: number }) => ({
      width: 612 * scale,
      height: 792 * scale,
    })),
    render: vi.fn(() => renderTask),
    cleanup: vi.fn(),
  };
  const document = {
    numPages: 1,
    getPage: vi.fn(() => Promise.resolve(page)),
  };
  const loadingTask = {
    promise: Promise.resolve(document),
    destroy: vi.fn(),
  };
  return {
    document,
    loadingTask,
    page,
    renderTask,
    getDocument: vi.fn(() => loadingTask),
  };
});

const mockCanvasRuntime = vi.hoisted(() => ({
  createCanvas: vi.fn((width: number, height: number) => ({
    width,
    height,
    getContext: vi.fn(() => ({})),
    toBuffer: vi.fn(() => Buffer.from("test-png")),
  })),
  DOMMatrix: class {},
  ImageData: class {},
  Path2D: class {},
}));

// why: rendering and OCR are external runtime integrations; these unit tests
// isolate PDF.js page work while the actual command is represented separately.
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  getDocument: mockPdfRuntime.getDocument,
}));
vi.mock("@napi-rs/canvas", () => mockCanvasRuntime);
import { ocrPdfPages, PDF_OCR_MAX_PAGES, PdfOcrError } from "./pdf-ocr.server";

let testDirectory: string | null = null;
let previousBinary: string | undefined;
let previousLogPath: string | undefined;
let previousFailureFlag: string | undefined;

function makeBlankPdf(pageCount = 1) {
  const pageIds = Array.from({ length: pageCount }, (_, index) => index + 3);
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageIds
      .map((id) => `${id} 0 R`)
      .join(" ")}] /Count ${pageCount} >>`,
    ...pageIds.map(
      () => "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>"
    ),
  ];
  let pdf = "%PDF-1.7\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, "ascii"));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, "ascii");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets
    .slice(1)
    .map((offset) => `${offset.toString().padStart(10, "0")} 00000 n \n`)
    .join("");
  pdf += `trailer\n<< /Size ${
    objects.length + 1
  } /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, "ascii");
}

function resetPdfRuntime(pageCount = 1) {
  mockPdfRuntime.document.numPages = pageCount;
  mockPdfRuntime.document.getPage.mockClear();
  mockPdfRuntime.page.getViewport.mockClear();
  mockPdfRuntime.page.render.mockClear();
  mockPdfRuntime.page.cleanup.mockClear();
  mockPdfRuntime.renderTask.cancel.mockClear();
  mockPdfRuntime.loadingTask.destroy.mockClear();
  mockPdfRuntime.getDocument.mockClear();
  mockCanvasRuntime.createCanvas.mockClear();
}

async function installFakeTesseract(languages = ["eng", "swe"]) {
  testDirectory = await mkdtemp(path.join(tmpdir(), "shelf-ocr-test-"));
  previousBinary = process.env.IOIO_TESSERACT_BINARY;
  previousLogPath = process.env.IOIO_TEST_TESSERACT_LOG;
  previousFailureFlag = process.env.IOIO_TEST_TESSERACT_FAIL;
  const binaryPath = path.join(testDirectory, "tesseract");
  const logPath = path.join(testDirectory, "recognized-image-path.txt");
  const languageOutput = ["List of available languages", ...languages].join(
    "\\n"
  );
  await writeFile(
    binaryPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--list-langs") {
  process.stdout.write("${languageOutput}\\n");
  process.exit(0);
}
if (!fs.existsSync(args[0])) process.exit(3);
if (process.env.IOIO_TEST_TESSERACT_LOG) {
  fs.writeFileSync(process.env.IOIO_TEST_TESSERACT_LOG, args[0]);
}
if (process.env.IOIO_TEST_TESSERACT_FAIL === "true") process.exit(4);
if (args[args.length - 1] === "tsv") {
  const headers = "level\\tpage_num\\tblock_num\\tpar_num\\tline_num\\tword_num\\tleft\\ttop\\twidth\\theight\\tconf\\ttext";
  const words = ["OCR", "recovered", "sensor", "text"];
  const rows = words.map((word, index) => ["5", "1", "1", "1", "1", String(index + 1), String(10 + index * 30), "20", "25", "12", "96", word].join("\\t"));
  process.stdout.write([headers, ...rows].join("\\n") + "\\n");
} else {
  process.stdout.write("  OCR recovered sensor text  \\n\\n");
}
`,
    { mode: 0o700 }
  );
  await chmod(binaryPath, 0o700);
  process.env.IOIO_TESSERACT_BINARY = binaryPath;
  process.env.IOIO_TEST_TESSERACT_LOG = logPath;
  return { logPath };
}

afterEach(async () => {
  if (previousBinary === undefined) delete process.env.IOIO_TESSERACT_BINARY;
  else process.env.IOIO_TESSERACT_BINARY = previousBinary;
  if (previousLogPath === undefined) delete process.env.IOIO_TEST_TESSERACT_LOG;
  else process.env.IOIO_TEST_TESSERACT_LOG = previousLogPath;
  if (previousFailureFlag === undefined)
    delete process.env.IOIO_TEST_TESSERACT_FAIL;
  else process.env.IOIO_TEST_TESSERACT_FAIL = previousFailureFlag;
  if (testDirectory) await rm(testDirectory, { recursive: true, force: true });
  testDirectory = null;
});

describe("server-side PDF OCR", () => {
  it("renders PDF.js pages, recognizes English and Swedish text, and removes page images", async () => {
    resetPdfRuntime();
    const { logPath } = await installFakeTesseract();

    const result = await ocrPdfPages(makeBlankPdf());

    expect(result).toMatchObject({
      pageCount: 1,
      ocrPagesAttempted: 1,
      ocrPagesSuccessful: 1,
      pages: [
        {
          sourceRef: "pdf-page-1",
          page: 1,
          text: "OCR recovered sensor text",
          positionedItems: [
            expect.objectContaining({ text: "OCR", x: 10, y: 20, page: 1 }),
            expect.objectContaining({
              text: "recovered",
              x: 40,
              y: 20,
              page: 1,
            }),
            expect.objectContaining({
              text: "sensor",
              x: 70,
              y: 20,
              page: 1,
            }),
            expect.objectContaining({
              text: "text",
              x: 100,
              y: 20,
              page: 1,
            }),
          ],
        },
      ],
    });
    const renderedImagePath = (await readFile(logPath, "utf8")).trim();
    expect(existsSync(renderedImagePath)).toBe(false);
    expect(path.basename(path.dirname(renderedImagePath))).toContain(
      "shelf-pdf-ocr-"
    );
    expect(existsSync(path.dirname(renderedImagePath))).toBe(false);
    expect(mockPdfRuntime.page.render).toHaveBeenCalledTimes(1);
    expect(mockPdfRuntime.page.cleanup).toHaveBeenCalledTimes(1);
    expect(mockPdfRuntime.loadingTask.destroy).toHaveBeenCalledTimes(1);
    const [width, height] = mockCanvasRuntime.createCanvas.mock.calls[0];
    expect(width).toBeLessThanOrEqual(4000);
    expect(height).toBeLessThanOrEqual(4000);
  });

  it("requires both configured language packs", async () => {
    resetPdfRuntime();
    await installFakeTesseract(["eng"]);

    await expect(ocrPdfPages(makeBlankPdf())).rejects.toMatchObject({
      code: "unavailable",
    });
  });

  it("preserves attempted-page counts when the OCR process fails", async () => {
    resetPdfRuntime();
    await installFakeTesseract();
    process.env.IOIO_TEST_TESSERACT_FAIL = "true";

    await expect(ocrPdfPages(makeBlankPdf())).rejects.toMatchObject({
      code: "failed",
      pageCount: 1,
      ocrPagesAttempted: 1,
      ocrPagesSuccessful: 0,
    });
  });

  it("rejects documents over the OCR page limit before rendering pages", async () => {
    resetPdfRuntime(PDF_OCR_MAX_PAGES + 1);
    await installFakeTesseract();
    const result = ocrPdfPages(makeBlankPdf(PDF_OCR_MAX_PAGES + 1));

    await expect(result).rejects.toBeInstanceOf(PdfOcrError);
    await expect(result).rejects.toMatchObject({ code: "page-limit" });
  });
});
