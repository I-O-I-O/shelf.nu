import { extractPdfDocumentPageData } from "~/modules/ioio-staff/inventory-import.server";
import {
  inferHandbookCategoryName,
  suggestHandbookArticles,
} from "./pdf-import.shared";
import type { HandbookImportDraft } from "./pdf-import.shared";

export const HANDBOOK_PDF_MAX_BYTES = 5 * 1024 * 1024;
const HANDBOOK_PDF_MAX_CONTENT_LENGTH = 300_000;
const HANDBOOK_PDF_MAX_REFERENCES = 20;

export type HandbookPdfImport = HandbookImportDraft;

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

function headingLevel(
  value: string,
  headingCues: Map<string, 2 | 3>,
  tocLevels: Map<string, 2 | 3>
) {
  const numberedSection = value.match(/^(\d+(?:\.\d+){1,5})\s+(.{2,120})$/u);
  if (numberedSection) {
    return Math.min(numberedSection[1]!.split(".").length + 1, 3);
  }
  const comparison = normalizedForComparison(value);
  const tocLevel = tocLevels.get(comparison);
  if (tocLevel) return tocLevel;
  const fontCueLevel = headingCues.get(comparison);
  if (fontCueLevel) return fontCueLevel;
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
  const isShortStandaloneHeading =
    wordCount <= 9 &&
    value.length <= 72 &&
    /^[\p{Lu}\p{N}][\p{L}\p{N}'’() /&+-]*$/u.test(value);
  return isUppercase || isTitleCase || isShortStandaloneHeading ? 2 : null;
}

function extractTableOfContents(lines: string[], linePages: number[]) {
  const start = lines.findIndex((line) =>
    /^(?:table\s+of\s+)?contents$/iu.test(line.trim())
  );
  if (start < 0) {
    return {
      lines,
      linePages,
      levels: new Map<string, 2 | 3>(),
    };
  }

  const levels = new Map<string, 2 | 3>();
  let end = start;
  let seenEntry = false;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";
    if (!line && seenEntry) {
      end = index;
      continue;
    }
    if (!line) {
      end = index;
      continue;
    }
    const entry = line.match(
      /^(?:(\d+(?:\.\d+){0,5})\s+)?(.{2,120}?)\s*(?:\.{2,}|…{2,}|·{2,})\s*\d{1,4}$/u
    );
    const spacedEntry = line.match(
      /^(?:(\d+(?:\.\d+){0,5})\s+)?(.{2,100}?)\s+(\d{1,3})$/u
    );
    const match = entry ?? spacedEntry;
    if (!match) break;
    const heading = match[2]!.trim();
    const depth = match[1]?.split(".").length ?? 1;
    levels.set(
      normalizedForComparison(heading),
      Math.min(depth + 1, 3) as 2 | 3
    );
    seenEntry = true;
    end = index;
  }

  if (!seenEntry) {
    return {
      lines,
      linePages,
      levels: new Map<string, 2 | 3>(),
    };
  }
  return {
    lines: [...lines.slice(0, start), ...lines.slice(end + 1)],
    linePages: [...linePages.slice(0, start), ...linePages.slice(end + 1)],
    levels,
  };
}

function positionedHeadingCues(
  positionedPages: Array<{
    items: Array<{ text: string; x: number; y: number; height: number }>;
  }>
): Map<string, 2 | 3> {
  const cues = new Map<string, 2 | 3>();
  for (const page of positionedPages) {
    const heights = page.items
      .map((item) => Math.abs(item.height))
      .filter((height) => height > 0);
    if (heights.length < 3) continue;
    heights.sort((left, right) => left - right);
    const bodyHeight = heights[Math.floor(heights.length / 2)] ?? 0;
    if (!bodyHeight) continue;
    const rows = new Map<number, typeof page.items>();
    for (const item of page.items) {
      const rowId = Math.round(item.y * 2) / 2;
      const row = rows.get(rowId) ?? [];
      row.push(item);
      rows.set(rowId, row);
    }
    for (const row of rows.values()) {
      const text = row
        .sort((left, right) => left.x - right.x)
        .map(({ text }) => text)
        .join(" ")
        .replace(/\s+/gu, " ")
        .trim();
      const height = Math.max(...row.map((item) => Math.abs(item.height)));
      if (
        text.length > 2 &&
        text.length <= 100 &&
        height >= bodyHeight * 1.18 &&
        !/[.!?;:]$/u.test(text)
      ) {
        cues.set(
          normalizedForComparison(text),
          height >= bodyHeight * 1.42 ? 2 : 3
        );
      }
    }
  }
  return cues;
}

function safeSourceName(value: string) {
  const basename = value.replace(/\\/gu, "/").split("/").pop()?.trim() ?? "";
  const cleaned = basename
    .replace(/[\p{Cc}<>:"|?*]/gu, "")
    .replace(/\s+/gu, " ")
    .slice(0, 180);
  return cleaned || "Imported PDF";
}

/** Convert extracted page text into a reviewed Markdown structure. Only short,
 * repeated text at page edges and standalone page numbers are removed. */
export function normalizeHandbookPdfPages(
  pageTexts: readonly string[],
  {
    sourceName = "Imported PDF",
    headingCues = new Map<string, 2 | 3>(),
    pageNumbers: suppliedPageNumbers,
  }: {
    sourceName?: string;
    headingCues?: Map<string, 2 | 3>;
    pageNumbers?: readonly number[];
  } = {}
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
      return line;
    });
  });

  const originalLines: string[] = [];
  const originalLinePages: number[] = [];
  cleanedPages.forEach((page, index) => {
    const pageNumber = suppliedPageNumbers?.[index] ?? index + 1;
    if (index > 0) {
      originalLines.push("");
      originalLinePages.push(pageNumber);
    }
    for (const line of page) {
      originalLines.push(line);
      originalLinePages.push(pageNumber);
    }
  });
  const toc = extractTableOfContents(originalLines, originalLinePages);
  const lines = toc.lines;
  const titleIndex = lines.findIndex((line) => Boolean(line.trim()));
  const inferredTitle = titleIndex >= 0 ? lines[titleIndex]!.trim() : "";
  const title = inferredTitle;

  const output: string[] = [];
  let paragraph: string[] = [];
  let currentHeading = "";
  const sourceOutline: HandbookPdfImport["sourceOutline"] = [];
  const referencesByHeading = new Map<string, Set<string>>();
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

    const level = headingLevel(line, headingCues, toc.levels);
    const nextLine = lines[index + 1]?.trim() ?? "";
    const hasExplicitHeadingCue =
      toc.levels.has(normalizedForComparison(line)) ||
      headingCues.has(normalizedForComparison(line)) ||
      /^\d+(?:\.\d+){1,5}\s+/u.test(line);
    const shortHeading =
      level !== null &&
      (hasExplicitHeadingCue ||
        level !== 2 ||
        line === line.toLocaleUpperCase() ||
        !nextLine ||
        nextLine.length > line.length);
    if (shortHeading) {
      flushParagraph();
      output.push(`${"#".repeat(level!)} ${line}`);
      sourceOutline.push({
        id: `source-section-${sourceOutline.length + 1}`,
        sourceOrder: sourceOutline.length,
        title: line,
        level: level as 2 | 3,
        sourcePage: toc.linePages[index] ?? 1,
      });
      currentHeading = line;
      continue;
    }
    const urlsInLine = line.match(/https?:\/\/[^\s<>"']+/giu) ?? [];
    const cleaned = collectSourceUrls(line, sourceUrls).trim();
    for (const candidate of urlsInLine) {
      const url = candidate.replace(/[),.;:!?]+$/gu, "");
      if (!sourceUrls.has(url)) continue;
      const referenceHeading = currentHeading || "Introduction";
      const refs =
        referencesByHeading.get(referenceHeading) ?? new Set<string>();
      refs.add(url);
      referencesByHeading.set(referenceHeading, refs);
    }
    if (cleaned) paragraph.push(cleaned);
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
      "This PDF contains more than 300,000 extracted characters. Shorten the document and try again."
    );
  }
  if (references.length > HANDBOOK_PDF_MAX_REFERENCES) {
    throw new HandbookPdfImportError(
      "This PDF contains more than 20 external URLs. Remove some links from the document and try again."
    );
  }
  const referenceIndex = Object.fromEntries(
    [...referencesByHeading].map(([heading, urls]) => [heading, [...urls]])
  );
  const sourcePageById = Object.fromEntries(
    sourceOutline.flatMap(({ id, sourcePage }) =>
      sourcePage === undefined ? [] : [[id, sourcePage]]
    )
  );
  let suggested: ReturnType<typeof suggestHandbookArticles>;
  try {
    suggested = suggestHandbookArticles({
      title,
      content,
      referencesByHeading: referenceIndex,
      sourcePageById,
    });
  } catch {
    const section = {
      id: "source-content",
      sourceOrder: 0,
      title,
      level: 2 as const,
      markdown: content,
      sourceUrls: references,
      sourcePage: sourceOutline[0]?.sourcePage,
    };
    suggested = {
      articles: [{ id: "article-1", title, sections: [section] }],
      sections: [section],
      hierarchyDetected: false,
      fallback: true,
    };
  }
  return {
    title,
    content,
    sourceUrls: references,
    sourceName: safeSourceName(sourceName),
    categorySuggestion: inferHandbookCategoryName(title, content),
    referencesByHeading: referenceIndex,
    sourceOutline,
    ...suggested,
  };
}

export async function importHandbookPdf(
  buffer: Buffer,
  sourceName = "Imported PDF"
) {
  if (buffer.byteLength > HANDBOOK_PDF_MAX_BYTES) {
    throw new HandbookPdfImportError("PDF files must be 5 MB or smaller.");
  }
  if (buffer.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new HandbookPdfImportError("Upload a valid PDF file.");
  }
  const extracted = await extractPdfDocumentPageData(buffer);
  return normalizeHandbookPdfPages(extracted.pages, {
    sourceName,
    headingCues: positionedHeadingCues(extracted.positionedPages),
    pageNumbers: extracted.pageNumbers,
  });
}
