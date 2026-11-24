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
import { suggestHandbookArticles } from "./pdf-import.shared";

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
    expect(imported.imageDetectedPages).toEqual([1]);
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

  it("keeps more than twenty source URLs available for multi-article review", () => {
    const references = Array.from(
      { length: 21 },
      (_, index) => `https://example.com/reference-${index + 1}`
    );
    const result = normalizeHandbookPdfPages([
      ["Laser Cutting Guide", "References", ...references].join("\n"),
    ]);

    expect(result.sourceUrls).toHaveLength(21);
    expect(result.sourceUrls).toEqual(references);
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

  it("removes a repeated unpaginated contents block and numbered page footers", () => {
    const result = normalizeHandbookPdfPages(
      [
        [
          "Laser cutter guide",
          "Table of content",
          "Table of content",
          "Introduction to laser cutting",
          "What are vector graphics?",
          "Finger joints",
          "Laser cutter guide 1",
        ].join("\n"),
        [
          "Introduction to laser cutting",
          "The laser follows a vector path.",
          "What are vector graphics?",
          "Vectors describe paths.",
          "Laser cutter guide 2",
        ].join("\n"),
      ],
      { pageNumbers: [1, 2] }
    );

    expect(result.content).toContain("## Introduction to laser cutting");
    expect(result.content).toContain("## What are vector graphics?");
    expect(result.content).not.toContain("Table of content");
    expect(result.content).not.toContain("Laser cutter guide 1");
    expect(result.content).not.toContain("Laser cutter guide 2");
  });

  it("marks possible author notes while preserving their source text", () => {
    const result = normalizeHandbookPdfPages([
      [
        "Maker Guide",
        "Installation",
        "Install the software.",
        "Personal comment",
        "I haven't tested this yet.",
        "TODO: add screenshot",
      ].join("\n"),
    ]);

    expect(result.content).toContain("I haven't tested this yet.");
    expect(result.content).toContain("TODO: add screenshot");
    expect(result.sections.some((section) => section.possibleAuthorNote)).toBe(
      true
    );
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

  it("groups the laser cutting hierarchy into semantic articles in source order", () => {
    const result = normalizeHandbookPdfPages(
      [
        [
          "Challenge 6 Laser cutting done right",
          "Table of Contents",
          "1 Introduction to laser cutting .... 2",
          "1.1 Vector graphics .... 3",
          "1.2 Cutting .... 4",
          "1.3 Engraving and rastering .... 5",
          "2 Finger joints .... 6",
          "2.1 Friction fitting .... 7",
          "3 Software overview .... 8",
          "3.1 Illustrator .... 9",
          "3.2 Inkscape .... 10",
          "3.3 File formats .... 11",
          "4 Inkscape configuration .... 12",
          "4.1 Document setup .... 12",
          "4.2 Geometric bounding box .... 13",
          "4.3 Keyboard shortcuts .... 13",
          "5 Parametric generators .... 14",
          "6 CAD for laser cutting .... 17",
          "7 Tutorials and references .... 20",
        ].join("\n"),
        [
          "Introduction to laser cutting",
          "Laser cutting removes material with a focused beam.",
          "Vector graphics",
          "Vector paths describe the cut geometry.",
          "Cutting",
          "The beam follows vector paths to cut through stock.",
          "Engraving and rastering",
          "Raster engraving marks a filled image.",
          "Finger joints",
          "Finger joints connect two panels.",
          "Friction fitting",
          "A friction fit depends on kerf and material thickness.",
          "https://example.com/finger-joints",
          "Software overview",
          "Choosing software depends on the drawing task.",
          "Illustrator",
          "Adobe Illustrator can prepare vector files.",
          "Inkscape",
          "Inkscape is a free vector editor.",
          "File formats",
          "Use SVG or DXF when supported by the cutter.",
          "Inkscape configuration",
          "Document setup",
          "Set the page size and units.",
          "https://example.com/inkscape-tutorial",
          "Geometric bounding box",
          "Use geometric bounds for precise layouts.",
          "Keyboard shortcuts",
          "Shortcuts speed up repetitive work.",
          "Parametric generators",
          "MakerCase",
          "Generate a box with editable dimensions.",
          "Gear generator",
          "Generate gears for a project.",
          "Maker.js",
          "Create parametric paths in JavaScript.",
          "CAD for laser cutting",
          "CAD overview",
          "Use CAD to build accurate models.",
          "Onshape",
          "Onshape supports collaborative CAD workflows.",
          "Fusion 360",
          "Fusion 360 supports 2D and 3D design workflows.",
          "Exporting",
          "Export a 2D profile for cutting.",
          "Tutorials and references",
          "Tutorials",
          "Follow the setup tutorial.",
          "References",
          "https://example.com/laser-resources",
        ].join("\n"),
      ],
      {
        sourceName: "/private/uploads/Challenge 6 Laser cutting done right.pdf",
      }
    );

    expect(result.categorySuggestion).toBe("Laser Cutting");
    expect(result.sourceName).toBe("Challenge 6 Laser cutting done right.pdf");
    expect(result.sourceOutline[0]).toMatchObject({
      id: "source-section-1",
      title: "Introduction to laser cutting",
      level: 2,
      sourcePage: 2,
    });
    expect(
      result.sourceOutline.find(({ title }) => title === "Friction fitting")
    ).toMatchObject({ level: 3, sourcePage: 2 });
    expect(result.articles.map(({ title }) => title)).toEqual([
      "Laser Cutting Basics",
      "Finger Joints and Friction Fits",
      "Choosing Software for Laser Cutting",
      "Inkscape for Laser Cutting",
      "Parametric Generators for Laser Cutting",
      "CAD for Laser Cutting",
      "Laser Cutting Resources",
    ]);
    expect(result.articles[1]?.sections[0]?.sourceUrls).toContain(
      "https://example.com/finger-joints"
    );
    expect(
      result.articles[6]?.sections.flatMap((section) => section.sourceUrls)
    ).toContain("https://example.com/laser-resources");
    expect(
      result.articles[3]?.sections.flatMap((section) => section.sourceUrls)
    ).toContain("https://example.com/inkscape-tutorial");
    expect(result.content).not.toContain("Table of Contents");
    const inkscapeMarkdown = result.articles[3]?.sections
      .map((section) => section.markdown)
      .join("\n");
    expect(inkscapeMarkdown).toContain("### Document setup");
    expect(inkscapeMarkdown).toContain("### Keyboard shortcuts");
    const allImportedMarkdown = result.articles
      .flatMap((article) => article.sections)
      .map((section) => section.markdown)
      .join("\n");
    expect(allImportedMarkdown).toContain(
      "Raster engraving marks a filled image."
    );
    expect(allImportedMarkdown).toContain(
      "Create parametric paths in JavaScript."
    );
    expect(allImportedMarkdown).toContain(
      "Fusion 360 supports 2D and 3D design workflows."
    );
  });

  it("accepts a multi-article PDF whose total text exceeds the old article limit", async () => {
    const body = Array.from(
      { length: 100 },
      () =>
        "The laser beam follows a carefully prepared path for the selected material."
    ).join("\n");
    const content = [
      "Challenge 6 Laser cutting done right",
      "Introduction to laser cutting",
      body,
      "Finger joints",
      body,
      "Software overview",
      body,
      "Inkscape configuration",
      body,
      "Parametric generators",
      body,
      "CAD for laser cutting",
      body,
      "Tutorials and references",
      body,
    ].join("\n");
    const imported = await importHandbookPdf(makePdfFromPages([content]));

    expect(imported.content.length).toBeGreaterThan(30_000);
    expect(imported.articles.length).toBeGreaterThan(1);
    expect(
      imported.articles.every((article) =>
        article.sections.some((section) => section.markdown.trim())
      )
    ).toBe(true);
  });

  it("keeps all extracted headings and blocks when Claude groups source sections", () => {
    const base = suggestHandbookArticles({
      title: "Workshop handbook",
      content:
        "## Setup\n\nPrepare the workspace.\n\n## Operation\n\nFollow the procedure.",
    });
    expect(base.articles).toHaveLength(1);
    expect(base.sections.map(({ title }) => title)).toEqual([
      "Setup",
      "Operation",
    ]);
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
