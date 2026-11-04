import { extractPdfDocumentPageText } from "~/modules/ioio-staff/inventory-import.server";

export const HANDBOOK_PDF_MAX_BYTES = 5 * 1024 * 1024;
const HANDBOOK_PDF_MAX_CONTENT_LENGTH = 30_000;
const HANDBOOK_PDF_MAX_REFERENCES = 20;

export type HandbookPdfImport = {
  title: string;
  content: string;
  sourceUrls: string[];
};

export class HandbookPdfImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HandbookPdfImportError";
  }
}

function normalizeLine(value: string) {
  return value
    .normalize("NFKC")
    .replace(/\p{Cc}/gu, (character) =>
      character === "\n" || character === "\r" ? character : ""
    )
    .replace(/[\t\u00a0 ]+/gu, " ")
    .trim();
}

function normalizedForComparison(value: string) {
  return normalizeLine(value)
    .toLocaleLowerCase()
    .replace(/\bpage\s+\d+(?:\s+of\s+\d+)?\b/giu, "page #")
    .replace(/\b\d+\s*\/\s*\d+\b/gu, "#/#");
}

function pageNumberLine(value: string) {
  return /^(?:(?:page|p\.)\s*)?\d{1,4}(?:\s*(?:of|\/)\s*\d{1,4})?$/iu.test(
    value.trim()
  );
}

function findRepeatedPageEdgeLines(pages: string[][]) {
  if (pages.length < 2) return new Set<string>();
  const appearances = new Map<string, number>();
  for (const lines of pages) {
    const nonempty = lines.filter(Boolean);
    const edgeLines = new Set([...nonempty.slice(0, 2), ...nonempty.slice(-2)]);
    for (const line of edgeLines) {
      if (line.length <= 120 && !pageNumberLine(line)) {
        const key = normalizedForComparison(line);
        appearances.set(key, (appearances.get(key) ?? 0) + 1);
      }
    }
  }
  const repeatThreshold = Math.max(2, Math.ceil(pages.length * 0.6));
  return new Set(
    [...appearances]
      .filter(([, count]) => count >= repeatThreshold)
      .map(([line]) => line)
  );
}

function collectSourceUrls(value: string, sourceUrls: Set<string>) {
  return value.replace(/https?:\/\/[^\s<>"']+/giu, (candidate) => {
    const url = candidate.replace(/[),.;:!?]+$/gu, "");
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      // Keep malformed URL-like text in the article body for manual editing.
      return candidate;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return candidate;
    }
    if (url.length > 500) {
      throw new HandbookPdfImportError(
        "This PDF contains a URL longer than the 500-character reference limit."
      );
    }
    sourceUrls.add(url);
    return candidate.slice(url.length).trim()
      ? candidate.slice(url.length)
      : "";
  });
}

function headingLevel(value: string) {
  const numberedSection = value.match(/^(\d+(?:\.\d+){1,5})\s+(.{2,120})$/u);
  if (numberedSection) {
    return Math.min(numberedSection[1]!.split(".").length + 1, 3);
  }
  if (value.length > 100 || /[.!?;:]$/u.test(value)) return null;
  const letters = value.replace(/[^\p{L}]/gu, "");
  const isUppercase =
    letters.length > 2 && letters === letters.toLocaleUpperCase();
  const wordCount = value.split(/\s+/u).length;
  const isTitleCase =
    wordCount <= 10 &&
    /^[\p{Lu}\d][\p{L}\p{N}'’()/-]*(?:\s+[\p{Lu}\d][\p{L}\p{N}'’()/-]*)*$/u.test(
      value
    );
  return isUppercase || isTitleCase ? 2 : null;
}

/** Convert extracted page text into an editable Markdown article. Only short,
 * repeated text at page edges and standalone page numbers are removed. */
export function normalizeHandbookPdfPages(
  pageTexts: readonly string[]
): HandbookPdfImport {
  const pages = pageTexts.map((text) =>
    text.split(/\r?\n/u).map(normalizeLine)
  );
  const repeatedEdges = findRepeatedPageEdgeLines(pages);
  const sourceUrls = new Set<string>();
  const cleanedPages = pages.map((lines) => {
    const nonempty = lines.filter(Boolean);
    const firstEdgeLines = new Set(nonempty.slice(0, 2));
    const lastEdgeLines = new Set(nonempty.slice(-2));
    return lines.map((line) => {
      if (!line) return "";
      const comparison = normalizedForComparison(line);
      const atEdge = firstEdgeLines.has(line) || lastEdgeLines.has(line);
      if (pageNumberLine(line) || (atEdge && repeatedEdges.has(comparison))) {
        return "";
      }
      return collectSourceUrls(line, sourceUrls).trim();
    });
  });

  const lines = cleanedPages.flatMap((page, index) =>
    index === 0 ? page : ["", ...page]
  );
  const titleIndex = lines.findIndex((line) => Boolean(line.trim()));
  const inferredTitle = titleIndex >= 0 ? lines[titleIndex]!.trim() : "";
  const title = inferredTitle;

  const output: string[] = [];
  let paragraph: string[] = [];
  const flushParagraph = () => {
    if (paragraph.length) output.push(paragraph.join(" "));
    paragraph = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";
    if (!line) {
      flushParagraph();
      continue;
    }
    if (index === titleIndex) continue;

    const bullet = line.match(/^([-+*•●▪◦‣])\s+(.+)$/u);
    const ordered = line.match(/^(\d+[.)])\s+(.+)$/u);
    if (bullet || ordered) {
      flushParagraph();
      output.push(
        `${bullet ? "-" : ordered![1]} ${bullet ? bullet[2] : ordered![2]}`
      );
      continue;
    }

    const level = headingLevel(line);
    const nextLine = lines[index + 1]?.trim() ?? "";
    const shortHeading =
      level !== null &&
      (level !== 2 ||
        line === line.toLocaleUpperCase() ||
        !nextLine ||
        nextLine.length > line.length);
    if (shortHeading) {
      flushParagraph();
      output.push(`${"#".repeat(level!)} ${line}`);
      continue;
    }
    paragraph.push(line);
  }
  flushParagraph();

  const content = output.join("\n\n").trim();
  const references = [...sourceUrls];
  if (!title) {
    throw new HandbookPdfImportError(
      "No readable document title or text was found in this PDF."
    );
  }
  if (title.length > 180) {
    throw new HandbookPdfImportError(
      "The first clear document heading is longer than the 180-character title limit."
    );
  }
  if (!content) {
    throw new HandbookPdfImportError(
      "No readable article content was found in this PDF."
    );
  }
  if (content.length > HANDBOOK_PDF_MAX_CONTENT_LENGTH) {
    throw new HandbookPdfImportError(
      "This PDF contains more text than the Handbook article limit. Shorten the document and try again."
    );
  }
  if (references.length > HANDBOOK_PDF_MAX_REFERENCES) {
    throw new HandbookPdfImportError(
      "This PDF contains more than 20 external URLs. Remove some links from the document and try again."
    );
  }
  return { title, content, sourceUrls: references };
}

export async function importHandbookPdf(buffer: Buffer) {
  if (buffer.byteLength > HANDBOOK_PDF_MAX_BYTES) {
    throw new HandbookPdfImportError("PDF files must be 5 MB or smaller.");
  }
  if (buffer.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new HandbookPdfImportError("Upload a valid PDF file.");
  }
  const pages = await extractPdfDocumentPageText(buffer);
  return normalizeHandbookPdfPages(pages);
}
