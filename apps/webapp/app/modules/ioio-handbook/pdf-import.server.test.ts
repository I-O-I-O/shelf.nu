import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ ocrPdfPages: vi.fn() }));

// why: the OCR module invokes external binaries and renders PDF pages; this
// verifies the shared extraction path passes OCR-recovered text into the
// Handbook normalizer without making the unit suite depend on local binaries.
vi.mock("~/modules/ioio-staff/pdf-ocr.server", () => ({
  PDF_OCR_MAX_PAGES: 20,
  ocrPdfPages: mocks.ocrPdfPages,
  PdfOcrError: class PdfOcrError extends Error {
    code = "unavailable";
    pageCount = 0;
    ocrPagesAttempted = 0;
    ocrPagesSuccessful = 0;
  },
}));

import {
  importHandbookPdf,
  normalizeHandbookPdfPages,
} from "./pdf-import.server";

function makePdfFromPages(pages: readonly string[]) {
  const objects = pages.flatMap((text, index) => {
    const pageObjectId = index * 2 + 1;
    const contentObjectId = pageObjectId + 1;
    const content = text
      .split("\n")
      .map((line) => `(${line.replace(/[\\()]/gu, "\\$&")}) Tj`)
      .join("\n");
    return [
      `${pageObjectId} 0 obj\n<< /Type /Page /Contents ${contentObjectId} 0 R >>\nendobj`,
      `${contentObjectId} 0 obj\n<< /Length 1 >>\nstream\n${content}\nendstream\nendobj`,
    ];
  });
  return Buffer.from(`%PDF-1.4\n${objects.join("\n")}\n%%EOF`, "utf8");
}

function makeImageOnlyPdf() {
  const imageStream = "FF>";
  const contentStream = "q 100 0 0 100 10 10 cm /Im0 Do Q";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>",
    `<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length ${imageStream.length} >>\nstream\n${imageStream}\nendstream`,
    `<< /Length ${contentStream.length} >>\nstream\n${contentStream}\nendstream`,
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

describe("Handbook PDF import normalization", () => {
  it("normalizes OCR text from an image-only scanned PDF", async () => {
    mocks.ocrPdfPages.mockResolvedValueOnce({
      pages: [
        {
          sourceRef: "pdf-page-1",
          page: 1,
          text: "Machine Safety\n\nWear eye protection before starting the machine.",
          positionedItems: [],
        },
      ],
      pageCount: 1,
      ocrPagesAttempted: 1,
      ocrPagesSuccessful: 1,
    });

    const imported = await importHandbookPdf(makeImageOnlyPdf());

    expect(imported.title).toBe("Machine Safety");
    expect(imported.content).toContain(
      "Wear eye protection before starting the machine."
    );
    expect(mocks.ocrPdfPages).toHaveBeenCalledTimes(1);
  });

  it("extracts ordered headings, paragraphs, lists and URLs from a multi-page PDF", async () => {
    const result = await importHandbookPdf(
      makePdfFromPages([
        "Soldering Basics\n\nSafety\nWear eye protection before using the iron.\n\nTools\n- Soldering iron\n- Lead-free solder",
        "Setup\n1. Set the temperature to 350 C.\n2. Clean the tip.\n\nReference\nhttps://example.com/soldering-guide",
      ])
    );

    expect(result.title).toBe("Soldering Basics");
    expect(result.content).toContain("## Safety");
    expect(result.content).toContain(
      "Wear eye protection before using the iron."
    );
    expect(result.content).toContain("- Soldering iron");
    expect(result.content).toContain("1. Set the temperature to 350 C.");
    expect(result.content).toContain("2. Clean the tip.");
    expect(result.content.indexOf("## Safety")).toBeLessThan(
      result.content.indexOf("## Setup")
    );
    expect(result.sourceUrls).toEqual(["https://example.com/soldering-guide"]);
    expect(result.content).not.toContain("https://example.com/soldering-guide");
  });

  it("removes only repeated page-edge headers, footers and standalone page numbers", () => {
    const result = normalizeHandbookPdfPages([
      "IOIO Lab Manual\nWorkshop Safety\nPut on safety glasses.\nIOIO Lab | Page 1",
      "IOIO Lab Manual\nUse the soldering station.\nKeep the work area clear.\nIOIO Lab | Page 2",
    ]);

    expect(result.title).toBe("Workshop Safety");
    expect(result.content).toContain("Put on safety glasses.");
    expect(result.content).toContain("Use the soldering station.");
    expect(result.content).toContain("Keep the work area clear.");
    expect(result.content).not.toContain("IOIO Lab Manual");
    expect(result.content).not.toContain("Page 1");
  });

  it("keeps deeply numbered PDF sections within the article H2/H3 hierarchy", () => {
    const result = normalizeHandbookPdfPages([
      "Filament Guide\n1.1 Changing filament\nStep one.\n1.1.1 Prepare the printer\nCheck the display.\n1.1.1.1 Deep instruction\nContinue carefully.",
    ]);

    expect(result.content).toContain("## 1.1 Changing filament");
    expect(result.content).toContain("### 1.1.1 Prepare the printer");
    expect(result.content).toContain("### 1.1.1.1 Deep instruction");
    expect(result.content).not.toContain("####");
  });

  it("rejects an invalid or unreadable PDF without returning an empty draft", async () => {
    await expect(importHandbookPdf(Buffer.from("not a PDF"))).rejects.toThrow(
      "Upload a valid PDF file."
    );
    expect(() => normalizeHandbookPdfPages([""])).toThrow(
      "No readable document title or text was found"
    );
  });
});
