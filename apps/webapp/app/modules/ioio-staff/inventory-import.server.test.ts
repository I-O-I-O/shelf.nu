import { createHash } from "node:crypto";
import JSZip from "jszip";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "~/utils/logger";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import type { MouserEnrichmentRequest } from "./import-helper-contract.server";

const database = vi.hoisted(() => ({
  image: { upsert: vi.fn(), findFirst: vi.fn(), deleteMany: vi.fn() },
  asset: { findMany: vi.fn(), findFirst: vi.fn() },
  custody: { count: vi.fn() },
  bookingAsset: { count: vi.fn() },
  consumptionLog: { count: vi.fn() },
  assetKit: { count: vi.fn() },
  reportFound: { count: vi.fn() },
  note: { count: vi.fn() },
  tag: { count: vi.fn() },
  assetCustomFieldValue: { count: vi.fn() },
  auditAsset: { count: vi.fn() },
  auditScan: { count: vi.fn() },
  purchaseItem: { count: vi.fn() },
  assetModel: { findFirst: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
  category: { findFirst: vi.fn(), findMany: vi.fn() },
  qr: { findFirst: vi.fn(), findMany: vi.fn() },
  location: { findMany: vi.fn(), count: vi.fn() },
  ioioWriteOperation: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    updateMany: vi.fn(),
  },
  ioioImportItem: {
    createMany: vi.fn(),
    findMany: vi.fn(),
    findFirst: vi.fn(),
    updateMany: vi.fn(),
  },
  ioioArchivedItem: { findMany: vi.fn() },
}));
const mockStaffAccess = vi.hoisted(() => vi.fn());
const mockGetCategories = vi.hoisted(() => vi.fn());
const mockCreateAsset = vi.hoisted(() => vi.fn());
const mockUpdateAsset = vi.hoisted(() => vi.fn());
const mockDeleteAsset = vi.hoisted(() => vi.fn());
const mockReplaceAssetPlacements = vi.hoisted(() => vi.fn());
const mockCreateAssetModel = vi.hoisted(() => vi.fn());
const mockUpdateAssetMainImage = vi.hoisted(() => vi.fn());
const mockUpdateAssetModelDescriptionIfUnchanged = vi.hoisted(() => vi.fn());
const mockUpdateAssetModelImage = vi.hoisted(() => vi.fn());
const mockCreateCategory = vi.hoisted(() => vi.fn());
const mockRequirePermission = vi.hoisted(() => vi.fn());
const mockGetBrokenSection = vi.hoisted(() => vi.fn());
const mockGetReturnArea = vi.hoisted(() => vi.fn());
const mockGetArchivedCategoryIds = vi.hoisted(() => vi.fn());
const mockRequestImportHelperProposal = vi.hoisted(() => vi.fn());
const mockOcrPdfPages = vi.hoisted(() => vi.fn());
const mockEnrichImportProductRows = vi.hoisted(() => vi.fn());

// why: the tests exercise the pure file parsing and row classification logic;
// database and Shelf mutation services must not be initialized for those tests.
vi.mock("~/database/db.server", () => ({
  db: database,
}));

// why: the classification tests must prove they do not accidentally invoke a
// real Shelf write service while constructing a proposal.
vi.mock("~/modules/asset/service.server", () => ({
  BULK_CREATE_MAX: 100,
  createAsset: mockCreateAsset,
  deleteAsset: mockDeleteAsset,
  replaceAssetPlacements: mockReplaceAssetPlacements,
  updateAssetMainImage: mockUpdateAssetMainImage,
  updateAsset: mockUpdateAsset,
}));

// why: importer tests must observe whether a model is requested without writing
// to Shelf's model tables or invoking model side effects.
vi.mock("~/modules/asset-model/service.server", () => ({
  createAssetModel: mockCreateAssetModel,
  updateAssetModelDescriptionIfUnchanged:
    mockUpdateAssetModelDescriptionIfUnchanged,
  updateAssetModelImage: mockUpdateAssetModelImage,
}));

// why: importer preparation tests must stay offline; bounded external lookup and image validation are exercised in product-enrichment.server.test.ts.
vi.mock("./product-enrichment.server", () => ({
  enrichImportProductRows: mockEnrichImportProductRows,
  processStaffImportImageUpload: vi.fn((bytes: Buffer) => ({
    status: "IMAGE_FOUND",
    mimeType: "image/webp",
    dataBase64: bytes.toString("base64"),
    source: "MANUAL_UPLOAD",
    sourceName: "Manual upload",
  })),
}));

// why: preparation only needs public image URL resolution; Supabase storage access is covered by the existing storage-service tests.
vi.mock("~/utils/storage.server", () => ({
  resolveStorageImageUrl: vi.fn(({ legacyUrl }) => legacyUrl ?? null),
}));

// why: access is only exercised by the request-level prepare/apply functions,
// not by these pure parser and classifier tests.
vi.mock("./access.server", () => ({
  requireIoioStaffAccess: mockStaffAccess,
}));

// why: preparation's category snapshot is independent of the stored SUCCEEDED result.
vi.mock("~/modules/category/service.server", () => ({
  createCategory: mockCreateCategory,
  getActiveCategoriesForOrganization: mockGetCategories,
}));

// why: import tests assert that category creation uses Shelf's permission gate
// and canonical service while avoiding organization/auth database setup.
vi.mock("~/utils/roles.server", () => ({
  requirePermission: mockRequirePermission,
}));

// why: operational-zone configuration is controlled in tests so location
// suggestions remain deterministic without querying IOIO settings tables.
vi.mock("~/modules/ioio-lab-information/broken-section.server", () => ({
  getConfiguredBrokenSection: mockGetBrokenSection,
}));
vi.mock("~/modules/ioio-student/report-return-location.server", () => ({
  getConfiguredReportReturnArea: mockGetReturnArea,
}));
vi.mock("~/modules/ioio-staff/archive.server", () => ({
  getIoioArchivedCategoryIds: mockGetArchivedCategoryIds,
}));
vi.mock("~/modules/ioio-staff/pickup-zone.server", () => ({
  PICKUP_ZONE_NAME: "Pickup Zone",
}));
vi.mock("~/utils/get-random-color", () => ({
  getRandomColor: () => "#123456",
}));

// why: preparation tests control helper availability and responses while the
// helper contract's own tests verify real strict parsing and validation.
vi.mock("./import-helper-client.server", () => ({
  requestImportHelperProposal: mockRequestImportHelperProposal,
}));

// why: importer routing tests need deterministic OCR output and must not depend
// on a Tesseract installation in the unit-test runtime.
vi.mock("./pdf-ocr.server", () => ({
  PDF_OCR_MAX_PAGES: 20,
  PdfOcrError: class PdfOcrError extends Error {
    constructor(readonly code: "unavailable") {
      super(`PDF OCR ${code}.`);
    }
  },
  ocrPdfPages: mockOcrPdfPages,
}));

import { validateImportHelperResponse } from "./import-helper-contract.server";
import { resolveImportReviewState } from "./import-review";
import {
  applyStaffInventoryImport,
  classifyStaffImportRows,
  getIndividualUnitImportLimitError,
  getStaffImportProposalHash,
  getStaffInventoryImportDrafts,
  getStaffInventoryImportProposal,
  parseMouserInvoicePages,
  parseStaffImportFile,
  prepareStaffInventoryImport,
  revertStaffInventoryImportRow,
  saveStaffInventoryImportDraft,
  summarizeStaffImportRows,
  type StaffImportProposal,
  type StaffImportProposalRow,
  type StaffImportReviewDecision,
  type StaffImportResult,
} from "./inventory-import.server";
import { PdfOcrError } from "./pdf-ocr.server";
import type {
  ExistingImportAssetModel,
  ImportProductEnrichmentRow,
  ProductSearchProvider,
} from "./product-enrichment.server";
import {
  MOUSER_FRAGMENTED_EXPECTED_ROWS,
  MOUSER_FRAGMENTED_PAGE_TEXT,
  MOUSER_REAL_FIRST_PAGE_EXPECTED,
  MOUSER_REAL_FIRST_PAGE_PAGES,
  MOUSER_REAL_FIRST_PAGE_TEXT,
  MOUSER_SIX_LINE_EXPECTED,
  MOUSER_SIX_LINE_PAGES,
} from "../../../test/fixtures/mouser-invoice-fragments";

function makeMouserPdf() {
  const content = MOUSER_FRAGMENTED_PAGE_TEXT.split("\n")
    .map((line) => `(${line.replace(/[\\()]/g, "\\$&")}) Tj`)
    .join("\n");
  return Buffer.from(
    `%PDF-1.4\n1 0 obj\n<< /Type /Page /Contents 3 0 R >>\nendobj\n3 0 obj\n<< /Length 1 >>\nstream\n${content}\nendstream\nendobj\n%%EOF`,
    "utf8"
  );
}

function makePdfFromPages(pages: readonly { text: string }[]) {
  const objects = pages.flatMap((page, index) => {
    const pageObjectId = index * 2 + 1;
    const contentObjectId = pageObjectId + 1;
    const content = page.text
      .split("\n")
      .map((line) => `(${line.replace(/[\\()]/g, "\\$&")}) Tj`)
      .join("\n");
    return [
      `${pageObjectId} 0 obj\n<< /Type /Page /Contents ${contentObjectId} 0 R >>\nendobj`,
      `${contentObjectId} 0 obj\n<< /Length 1 >>\nstream\n${content}\nendstream\nendobj`,
    ];
  });
  return Buffer.from(`%PDF-1.4\n${objects.join("\n")}\n%%EOF`, "utf8");
}

function makeHexTextPdf(text: string) {
  const encodedText = Array.from(text)
    .map((character) => character.charCodeAt(0).toString(16).padStart(4, "0"))
    .join("");
  return Buffer.from(
    `%PDF-1.4\n1 0 obj\n<< /Type /Page /Contents 2 0 R >>\nendobj\n2 0 obj\n<< /Length 1 >>\nstream\n<${encodedText}> Tj\nendstream\nendobj\n%%EOF`,
    "latin1"
  );
}

function makeToUnicodePdf(text: string) {
  const characters = [...new Set(Array.from(text))];
  const codes = new Map(
    characters.map((character, index) => [
      character,
      (index + 1).toString(16).padStart(4, "0"),
    ])
  );
  const cmap = [
    "/CIDInit /ProcSet findresource begin",
    "12 dict begin",
    "begincmap",
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
    "/CMapName /Adobe-Identity-UCS def",
    "/CMapType 2 def",
    "1 begincodespacerange",
    "<0000> <FFFF>",
    "endcodespacerange",
    `${characters.length} beginbfchar`,
    ...characters.map((character) => {
      const destination = character.charCodeAt(0).toString(16).padStart(4, "0");
      return `<${codes.get(character)}> <${destination}>`;
    }),
    "endbfchar",
    "endcmap",
    "CMapName currentdict /CMap defineresource pop",
    "end",
    "end",
  ].join("\n");
  const glyphs = text
    .split(" ")
    .map((word) => {
      const encodedWord = Array.from(word)
        .map((character) => codes.get(character))
        .join("");
      return `<${encodedWord}> Tj`;
    })
    .join(` <${codes.get(" ")}> Tj 40 0 Td `);
  const content = `BT /F1 12 Tf 30 700 Td ${glyphs} ET`;
  const streamObject = (stream: string) =>
    `<< /Length ${Buffer.byteLength(
      stream,
      "ascii"
    )} >>\nstream\n${stream}\nendstream`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >>",
    "<< /Type /Font /Subtype /Type0 /BaseFont /MockSubset /Encoding /Identity-H /DescendantFonts [5 0 R] /ToUnicode 6 0 R >>",
    `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /MockSubset /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 600 /W [1 [${characters
      .map(() => "600")
      .join(" ")}]] >>`,
    streamObject(cmap),
    streamObject(content),
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

function preparePdfImportMocks(operationId: string) {
  vi.clearAllMocks();
  mockStaffAccess.mockResolvedValue({
    organizationId: "org-1",
    userId: "staff-1",
  });
  database.asset.findMany.mockResolvedValue([]);
  database.assetModel.findMany.mockResolvedValue([]);
  database.category.findMany.mockResolvedValue([]);
  database.location.findMany.mockResolvedValue([]);
  database.location.count.mockResolvedValue(0);
  database.ioioWriteOperation.findUnique.mockResolvedValue(null);
  database.ioioWriteOperation.findFirst.mockResolvedValue({ id: operationId });
  database.ioioWriteOperation.create.mockResolvedValue({});
  database.ioioImportItem.createMany.mockResolvedValue({ count: 1 });
  database.ioioImportItem.findMany.mockResolvedValue([]);
  mockGetCategories.mockResolvedValue([]);
  mockGetBrokenSection.mockResolvedValue(null);
  mockGetReturnArea.mockResolvedValue(null);
  mockGetArchivedCategoryIds.mockResolvedValue([]);
}

function makeGenericHelperReadyResult({
  pageText,
  items,
}: {
  pageText: string;
  items: Array<{
    productName: string;
    quantity: number;
    evidenceText: string;
    quantityStatus?: "RECEIVED" | "SHIPPED" | "ORDERED" | "UNKNOWN";
    manufacturer?: string | null;
    mpn?: string | null;
    supplierProductNumber?: string | null;
    description?: string | null;
    trackingSuggestion?: "QUANTITY_TRACKED" | "INDIVIDUAL" | null;
  }>;
}) {
  return {
    status: "ready" as const,
    proposal: {
      schemaVersion: 1 as const,
      rows: items.map(
        ({
          productName,
          quantity,
          evidenceText,
          quantityStatus,
          manufacturer,
          mpn,
          supplierProductNumber,
          description,
          trackingSuggestion,
        }) => ({
          sourceRef: "pdf-page-1",
          productName,
          supplierProductNumber: supplierProductNumber ?? null,
          quantity,
          quantityStatus: quantityStatus ?? ("RECEIVED" as const),
          manufacturer: manufacturer ?? null,
          mpn: mpn ?? null,
          description: description ?? productName,
          productMatch: {
            matchType: "NEW" as const,
            candidateId: null,
            confidence: 0.8,
          },
          categorySuggestion: {
            categoryId: null,
            proposedName: null,
            confidence: 0.4,
          },
          trackingSuggestion: {
            mode: trackingSuggestion ?? null,
            confidence: 0.4,
          },
          kitHint: { isKit: false, name: null, confidence: 0.9 },
          settingsSuggestions: [],
          locationSuggestions: [],
          questions: [],
          evidence: [{ sourceRef: "pdf-page-1", text: evidenceText }],
        })
      ),
      questions: [],
      pageText,
    },
  };
}

function makeMouserHelperResponse() {
  return {
    mode: "MOUSER_LINE_ITEM_ENRICHMENT" as const,
    schemaVersion: 2,
    rows: MOUSER_FRAGMENTED_EXPECTED_ROWS.map((item) => ({
      sourceRef:
        item.supplierProductNumber === "713-114993388"
          ? "mouser-p1-line1"
          : "mouser-p1-line2",
      supplierProductNumber: item.supplierProductNumber,
      mpn: item.mpn,
      productName: item.productName,
      manufacturer: item.manufacturer,
      description: item.productName,
      quantity: item.quantity,
      categoryId:
        item.supplierProductNumber === "713-114993388"
          ? "cat-electronics"
          : null,
      categoryConfidence:
        item.supplierProductNumber === "713-114993388" ? 0.9 : 0,
      locationId:
        item.supplierProductNumber === "713-114993388" ? "loc-shelf" : null,
      locationConfidence:
        item.supplierProductNumber === "713-114993388" ? 0.9 : 0,
      confidence: 0.9,
    })),
  } as const;
}

const previewImages = new Map<
  string,
  { id: string; ownerOrgId: string; blob: Buffer; contentType: string }
>();
beforeEach(() => {
  previewImages.clear();
  database.image.upsert.mockImplementation(({ where, create }) => {
    if (!previewImages.has(where.id)) previewImages.set(where.id, create);
    return previewImages.get(where.id);
  });
  database.image.findFirst.mockImplementation(({ where }) => {
    const image = previewImages.get(where.id);
    return image?.ownerOrgId === where.ownerOrgId ? image : null;
  });
  database.image.deleteMany.mockResolvedValue({ count: 0 });
  mockOcrPdfPages.mockReset().mockRejectedValue(new PdfOcrError("unavailable"));
  database.category.findMany.mockResolvedValue([]);
  database.assetModel.findMany.mockResolvedValue([]);
  database.location.findMany.mockResolvedValue([]);
  mockCreateCategory.mockImplementation(({ name }) => ({
    id: "category-created",
    name,
  }));
  mockRequirePermission.mockResolvedValue({});
  mockGetBrokenSection.mockResolvedValue(null);
  mockGetReturnArea.mockResolvedValue(null);
  mockGetArchivedCategoryIds.mockResolvedValue([]);
  mockUpdateAssetModelDescriptionIfUnchanged.mockResolvedValue(true);
  mockUpdateAssetModelImage.mockResolvedValue("https://shelf.test/image.webp");
  mockUpdateAssetMainImage.mockResolvedValue(true);
  mockDeleteAsset.mockResolvedValue(undefined);
  mockReplaceAssetPlacements.mockResolvedValue(undefined);
  database.custody.count.mockResolvedValue(0);
  database.bookingAsset.count.mockResolvedValue(0);
  database.consumptionLog.count.mockResolvedValue(0);
  database.assetKit.count.mockResolvedValue(0);
  database.reportFound.count.mockResolvedValue(0);
  database.note.count.mockResolvedValue(0);
  database.tag.count.mockResolvedValue(0);
  database.assetCustomFieldValue.count.mockResolvedValue(0);
  database.auditAsset.count.mockResolvedValue(0);
  database.auditScan.count.mockResolvedValue(0);
  database.purchaseItem.count.mockResolvedValue(0);
  database.qr.findMany.mockResolvedValue([]);
  mockEnrichImportProductRows.mockImplementation((rows) => ({
    rows: rows.map((row: ImportProductEnrichmentRow) => ({
      ...row,
      assetModelDescription: row.sourceDescription ?? null,
      assetModelDescriptionSource: row.sourceDescription ? "SOURCE" : "NONE",
      productImageProposal: { status: "IMAGE_NOT_FOUND" },
    })),
    diagnostics: {
      newModels: 0,
      existingModelsWithImage: 0,
      imageLookupAttempted: 0,
      imageCandidatesConsidered: 0,
      imageAccepted: 0,
      imageLookupSucceeded: 0,
      imageLookupFailed: 0,
      imageSourceDocument: 0,
      imageSourceManufacturer: 0,
      imageSourceSupplier: 0,
      imageProcessed: 0,
      imageFinalBytes: 0,
      imageMissing: 0,
      imageRejectedReason: {},
      descriptionGenerated: 0,
      descriptionSource: {
        SOURCE: 0,
        SHELF_EXISTING: 0,
        GENERATED: 0,
        NONE: rows.length,
      },
    },
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("staff inventory import safety", () => {
  it("extracts one clear quantity from a PDF table", async () => {
    const rows = await parseStaffImportFile({
      filename: "single-quantity.pdf",
      buffer: makePdfFromPages([
        { text: "Product | Quantity\nUSB-C Cable | 4" },
      ]),
    });

    expect(rows[0]).toMatchObject({
      title: "USB-C Cable",
      quantity: 4,
      quantityStatus: "RECEIVED",
      diagnosticReasonCodes: ["QUANTITY_EXTRACTED"],
    });
  });

  it("normalizes grouped integer quantities without treating currency as quantity", async () => {
    const rows = await parseStaffImportFile({
      filename: "grouped-quantity.pdf",
      buffer: makePdfFromPages([
        {
          text: "Product | Quantity\nCable ties | 1,000\nAdapters | $1,000\nCable clips | 1,000,001",
        },
      ]),
    });

    expect(
      rows.map(({ quantity, diagnosticReasonCodes }) => [
        quantity,
        diagnosticReasonCodes?.[0],
      ])
    ).toEqual([
      [1_000, "QUANTITY_EXTRACTED"],
      [null, "QUANTITY_INVALID"],
      [null, "QUANTITY_INVALID"],
    ]);
  });

  it("uses shipped quantity instead of ordered quantity in a PDF table", async () => {
    const rows = await parseStaffImportFile({
      filename: "shipment.pdf",
      buffer: makePdfFromPages([
        {
          text: "Product | Ordered | Shipped | Price\nUSB-C Cable | 20 | 15 | 52.50",
        },
      ]),
    });

    expect(rows[0]).toMatchObject({
      quantity: 15,
      orderedQuantity: 20,
      receivedQuantity: 15,
      quantityStatus: "SHIPPED",
    });
  });

  it("prefers received over delivered and shipped quantities while retaining the order context", async () => {
    const rows = await parseStaffImportFile({
      filename: "multiple-quantity-concepts.pdf",
      buffer: makePdfFromPages([
        {
          text: "Product | Ordered | Shipped | Delivered | Received | Backordered\nESP32 Board | 20 | 15 | 15 | 14 | 5",
        },
      ]),
    });

    expect(rows[0]).toMatchObject({
      quantity: 14,
      orderedQuantity: 20,
      receivedQuantity: 14,
      quantityStatus: "RECEIVED",
      diagnosticReasonCodes: ["QUANTITY_EXTRACTED"],
    });
  });

  it("keeps unit price and line total out of PDF quantity", async () => {
    const rows = await parseStaffImportFile({
      filename: "price-near-quantity.pdf",
      buffer: makePdfFromPages([
        {
          text: "Product | Qty | Unit Price | Line Total\nUSB-C Cable | 3 | 15.00 | 45.00",
        },
      ]),
    });

    expect(rows[0]?.quantity).toBe(3);
    expect(rows[0]?.quantity).not.toBe(15);
    expect(rows[0]?.quantity).not.toBe(45);
  });

  it("leaves ordered-only PDF quantities blank for staff review", async () => {
    const rows = await parseStaffImportFile({
      filename: "ordered-only.pdf",
      buffer: makePdfFromPages([
        {
          text: "Product | Ordered | Backordered\nESP32 Board | 20 | 5",
        },
      ]),
    });

    expect(rows[0]).toMatchObject({
      quantity: null,
      orderedQuantity: 20,
      quantityStatus: "ORDERED",
      diagnosticReasonCodes: ["QUANTITY_AMBIGUOUS"],
      pdfClassification: "PARTIAL",
    });
  });

  it.each(["0", "-2"])(
    "rejects non-positive PDF quantity %s without coercing it",
    async (quantity) => {
      const rows = await parseStaffImportFile({
        filename: "invalid-quantity.pdf",
        buffer: makePdfFromPages([
          { text: `Product | Quantity\nMotor Driver | ${quantity}` },
        ]),
      });

      expect(rows[0]).toMatchObject({
        quantity: null,
        diagnosticReasonCodes: ["QUANTITY_INVALID"],
        pdfClassification: "PARTIAL",
      });
    }
  );

  it("uses structured PDF table quantities when Claude returns a conflicting value", async () => {
    preparePdfImportMocks("operation-structured-quantity");
    const text =
      "Product | Ordered | Shipped | Unit Price | Total\nUSB-C Cable | 20 | 15 | 3.00 | 45.00";
    mockRequestImportHelperProposal.mockResolvedValue(
      makeGenericHelperReadyResult({
        pageText: text,
        items: [
          {
            productName: "USB-C Cable",
            quantity: 20,
            evidenceText: "USB-C Cable",
          },
        ],
      })
    );

    const prepared = await prepareStaffInventoryImport({
      context: { getSession: () => ({ userId: "staff-1" }) } as never,
      request: new Request("http://localhost/staff/import"),
      file: new File([makePdfFromPages([{ text }])], "shipment.pdf", {
        type: "application/pdf",
      }),
    });

    expect(prepared.status).toBe("PREPARED");
    if (prepared.status !== "PREPARED") throw new Error("Expected proposal");
    expect(prepared.proposal.rows[0]).toMatchObject({
      quantity: 15,
      orderedQuantity: 20,
      receivedQuantity: 15,
      quantityStatus: "SHIPPED",
      diagnosticReasonCodes: expect.arrayContaining(["QUANTITY_EXTRACTED"]),
    });
  });

  it("keeps suggested description and image proposal-only until Apply", async () => {
    preparePdfImportMocks("operation-review-only-product-image");
    const imageDataBase64 = Buffer.from(
      "RIFF\u0004\u0000\u0000\u0000WEBP"
    ).toString("base64");
    mockRequestImportHelperProposal.mockResolvedValue(
      makeGenericHelperReadyResult({
        pageText: "Arduino Nano A000005 shipped 1",
        items: [
          {
            productName: "Arduino Nano",
            quantity: 1,
            evidenceText: "Arduino Nano A000005 shipped 1",
          },
        ],
      })
    );
    mockEnrichImportProductRows.mockImplementationOnce((rows) => ({
      rows: rows.map((row: ImportProductEnrichmentRow) => ({
        ...row,
        assetModelDescription:
          "A compact microcontroller board for electronics prototyping.",
        assetModelDescriptionSource: "GENERATED",
        productImageProposal: {
          status: "IMAGE_FOUND",
          mimeType: "image/webp",
          dataBase64: imageDataBase64,
          sourceName: "Arduino Nano image",
          sourceUrl: "https://openverse.org/image/1",
          license: "cc0",
        },
      })),
      diagnostics: {
        newModels: 1,
        existingModelsWithImage: 0,
        imageLookupAttempted: 1,
        imageCandidatesConsidered: 1,
        imageAccepted: 1,
        imageLookupSucceeded: 1,
        imageLookupFailed: 0,
        imageSourceDocument: 0,
        imageSourceManufacturer: 0,
        imageSourceSupplier: 0,
        imageProcessed: 1,
        imageFinalBytes: 9,
        imageMissing: 0,
        imageRejectedReason: {},
        descriptionGenerated: 1,
        descriptionSource: {
          SOURCE: 0,
          SHELF_EXISTING: 0,
          GENERATED: 1,
          NONE: 0,
        },
      },
    }));

    const prepared = await prepareStaffInventoryImport({
      context: { getSession: () => ({ userId: "staff-1" }) } as never,
      request: new Request("http://localhost/staff/import"),
      file: new File(
        [makePdfFromPages([{ text: "Arduino Nano A000005 shipped 1" }])],
        "arduino-invoice.pdf",
        { type: "application/pdf" }
      ),
    });

    expect(prepared.status).toBe("PREPARED");
    if (prepared.status !== "PREPARED") throw new Error("Expected proposal");
    expect(prepared.proposal.rows[0]).toMatchObject({
      assetModelDescription:
        "A compact microcontroller board for electronics prototyping.",
      productImageProposal: {
        status: "IMAGE_FOUND",
        imageId: expect.stringMatching(/^ioio-import-/),
      },
    });
    expect(
      prepared.proposal.rows[0].productImageProposal?.dataBase64
    ).toBeUndefined();
    expect(previewImages.size).toBe(1);
    expect(mockUpdateAssetModelImage).not.toHaveBeenCalled();
    expect(mockCreateAssetModel).not.toHaveBeenCalled();
  });

  it("keeps a product importable when temporary image persistence fails", async () => {
    preparePdfImportMocks("operation-image-persist-failure");
    mockRequestImportHelperProposal.mockResolvedValue(
      makeGenericHelperReadyResult({
        pageText: "Arduino Nano shipped 1",
        items: [
          {
            productName: "Arduino Nano",
            quantity: 1,
            evidenceText: "Arduino Nano shipped 1",
          },
        ],
      })
    );
    mockEnrichImportProductRows.mockImplementationOnce((rows) => ({
      rows: rows.map((row) => ({
        ...row,
        productImageProposal: {
          status: "IMAGE_FOUND",
          mimeType: "image/webp",
          dataBase64: Buffer.from("RIFF\u0004\u0000\u0000\u0000WEBP").toString(
            "base64"
          ),
          autoAccepted: true,
        },
      })),
      diagnostics: {
        imageLookupAttempted: 1,
        descriptionSource: {
          SOURCE: 0,
          SHELF_EXISTING: 0,
          GENERATED: 0,
          NONE: 1,
        },
      },
    }));
    database.image.upsert.mockRejectedValueOnce(
      new Error("Preview store unavailable")
    );
    const result = await prepareStaffInventoryImport({
      context: { getSession: () => ({ userId: "staff-1" }) } as never,
      request: new Request("http://localhost/staff/import"),
      file: new File(
        [makePdfFromPages([{ text: "Arduino Nano shipped 1" }])],
        "invoice.pdf",
        { type: "application/pdf" }
      ),
    });
    expect(result).toMatchObject({
      status: "PREPARED",
      proposal: {
        rows: [
          {
            productImageProposal: {
              status: "IMAGE_FETCH_FAILED",
              failureReason: "PROPOSAL_IMAGE_PERSIST_FAILED",
            },
          },
        ],
      },
    });
    expect(mockCreateAsset).not.toHaveBeenCalled();
  });

  it("reconstructs six Mouser lines across wrapped text and continuation pages", () => {
    const parsed = parseMouserInvoicePages(MOUSER_SIX_LINE_PAGES);

    expect(parsed.detected).toBe(true);
    expect(parsed.lineItems).toHaveLength(6);
    expect(
      parsed.lineItems.filter((lineItem) =>
        Number.isSafeInteger(lineItem.quantity)
      )
    ).toHaveLength(6);
    expect(
      parsed.lineItems.map(
        ({
          supplierProductNumber,
          mpn,
          rawDescription,
          quantity,
          sourcePage,
        }) => ({
          supplierProductNumber,
          mpn,
          rawDescription,
          quantity,
          sourcePage,
        })
      )
    ).toEqual(MOUSER_SIX_LINE_EXPECTED);
    expect(parsed.lineItems[0]).toMatchObject({
      orderedQuantity: 5,
      shippedQuantity: 3,
      pendingQuantity: 2,
      quantity: 3,
    });
    expect(parsed.lineItems[2]?.mpn).toBeNull();
    expect(parsed.lineItems[5]?.sourcePage).toBe(1);
    expect(parsed.unresolvedLines).toBe(2);
    expect(parsed.lineItems.map((lineItem) => lineItem.quantity)).not.toContain(
      41.02
    );
    expect(
      parsed.lineItems.map((lineItem) => lineItem.supplierProductNumber)
    ).not.toContain("713-100000007");
    expect(
      parsed.lineItems.map((lineItem) => lineItem.supplierProductNumber)
    ).not.toContain("713-100000008");
  });

  it("reconstructs all six visible Mouser first-page commercial lines", () => {
    const parsed = parseMouserInvoicePages(MOUSER_REAL_FIRST_PAGE_PAGES);

    expect(parsed.detected).toBe(true);
    expect(parsed.lineItems).toHaveLength(6);
    expect(
      parsed.lineItems.map(
        ({
          lineNumber,
          supplierProductNumber,
          mpn,
          rawDescription,
          quantity,
        }) => ({
          lineNumber,
          supplierProductNumber,
          mpn,
          description: rawDescription,
          quantity,
        })
      )
    ).toEqual(MOUSER_REAL_FIRST_PAGE_EXPECTED);

    const xiaoEs = parsed.lineItems.find(
      ({ supplierProductNumber }) => supplierProductNumber === "713-102010634"
    );
    const xiaoBoard = parsed.lineItems.find(
      ({ supplierProductNumber }) => supplierProductNumber === "713-113991115"
    );
    expect(xiaoEs?.rawDescription).toContain("XIAO");
    expect(xiaoEs?.rawDescription).not.toContain("Tillv. Artikelnr");
    expect(xiaoBoard?.rawDescription).toContain("XIAO");

    for (const lineItem of parsed.lineItems) {
      expect(lineItem.rawDescription).not.toBe(lineItem.supplierProductNumber);
      expect(lineItem.rawDescription).not.toBe(lineItem.mpn);
      expect(lineItem.rawDescription).not.toMatch(/Tillv\. Artikelnr/i);
    }
  });

  it("uses positioned Mouser columns to associate row identity, description, and shipped quantity", () => {
    const positionedItems: Array<{
      text: string;
      x: number;
      y: number;
      width: number;
      height: number;
      page: number;
    }> = [];
    const add = (text: string, x: number, y: number, width = 36) => {
      positionedItems.push({ text, x, y, width, height: 10, page: 1 });
    };
    add("Line", 36, 100, 18);
    add("No.", 58, 100, 14);
    add("Mousers", 140, 100, 48);
    add("Artikelnummer", 192, 100, 96);
    add("Beskrivning", 310, 100, 80);
    add("Ordered", 600, 100, 50);
    add("Shipped", 690, 100, 52);
    add("Pending", 780, 100, 56);
    add("Unit Price", 880, 100, 65);

    MOUSER_REAL_FIRST_PAGE_EXPECTED.forEach((item) => {
      const y = 180 + item.lineNumber * 80;
      add(String(item.lineNumber), 44, y, 12);
      add(item.supplierProductNumber, 145, y, 110);
      add("T", 145, y + 5, 7);
      add("illv", 153, y + 12, 18);
      add(".", 172, y + 19, 3);
      add("Artikelnr:", 178, y + 26, 52);
      add(item.mpn, 233, y + 28, 72);
      add(item.description, 145, y + 34, 330);
      add(
        "TARIC:8471500000 ECCN:5A992.C COO:CN ACO:-- COD:--",
        145,
        y + 38,
        300
      );
      add(String(item.quantity), 610, y + 34, 12);
      add(String(item.quantity), 700, y + 34, 12);
      add("0", 790, y + 34, 8);
      add("260,76", 890, y + 34, 30);
    });

    const fragmentedText = MOUSER_REAL_FIRST_PAGE_TEXT.replace(
      "3\n713-114993387",
      "713-114993387"
    ).replace("4\n713-102010634", "713-102010634");
    const textOnlyPages = [
      { sourceRef: "pdf-page-1", page: 1, text: fragmentedText },
    ];
    const textOnly = parseMouserInvoicePages(textOnlyPages);
    expect(textOnly.lineItems).toHaveLength(4);

    const parsed = parseMouserInvoicePages(
      textOnlyPages,
      [{ sourceRef: "pdf-page-1", page: 1, items: positionedItems }],
      "pdfjs"
    );

    expect(parsed.positionSource).toBe("pdfjs");
    expect(parsed.lineItems).toHaveLength(6);
    expect(
      parsed.lineItems.map(
        ({
          lineNumber,
          supplierProductNumber,
          mpn,
          rawDescription,
          quantity,
        }) => ({
          lineNumber,
          supplierProductNumber,
          mpn,
          description: rawDescription,
          quantity,
        })
      )
    ).toEqual(MOUSER_REAL_FIRST_PAGE_EXPECTED);
  });

  it("keeps Mouser product titles on descriptions instead of SKU or MPN labels", async () => {
    const rows = await parseStaffImportFile({
      filename: "mouser-real-first-page.pdf",
      contentType: "application/pdf",
      buffer: makePdfFromPages(MOUSER_REAL_FIRST_PAGE_PAGES),
    });

    expect(rows).toHaveLength(6);
    const xiaoEs = rows.find(
      (row) => row.supplierPartNumber === "713-102010634"
    );
    const xiaoBoard = rows.find(
      (row) => row.supplierPartNumber === "713-113991115"
    );
    expect(xiaoEs).toMatchObject({
      manufacturerPartNumber: "102010634",
      quantity: 2,
    });
    expect(xiaoEs?.title).toContain("XIAO");
    expect(xiaoEs?.title).toBe("Seeed Studio XIAO ES");
    expect(xiaoEs?.title).not.toContain("Tillv. Artikelnr");
    expect(xiaoBoard?.title).toContain("XIAO");
    expect(xiaoBoard?.title).toBe("Seeed Studio XIAO ESP32C6");
    expect(
      rows.find((row) => row.supplierPartNumber === "713-102010631")?.title
    ).toBe("Seeed Studio XIAO ESP32C3");
    expect(
      rows.find((row) => row.supplierPartNumber === "713-101010001")?.title
    ).toBe("Seeed Studio 24GHz mmWave Sensor");
    expect(
      rows.find((row) => row.supplierPartNumber === "713-114993387")?.title
    ).toBe("Seeed Studio 60GHz mmWave Sensor");
    expect(
      rows.find((row) => row.supplierPartNumber === "713-114993388")?.title
    ).toBe("Seeed Studio 60GHz mmWave Sensor");
    for (const row of rows) {
      expect(row.title).not.toBe(row.supplierPartNumber);
      expect(row.title).not.toBe(row.manufacturerPartNumber);
      expect(row.title).not.toMatch(/Tillv\. Artikelnr/i);
    }
  });

  it("preserves manufacturer, family, chipset, and variants in Mouser product names", async () => {
    preparePdfImportMocks("operation-mouser-naming-identity");
    const descriptions = [
      "Seeed Studio Seeed Studio XIAO nRF52840",
      "Seeed Studio XIAO nRF52840 Sense (Pre-Soldered)",
      "Seeed Studio Seeed Studio XIAO ESP32-S3 / Utvecklingsverktyg för multiprotokoll",
    ];
    const pdfText = [
      "Radnr",
      "Line No.",
      "Mousers Artikelnummer",
      "Kundens/tillv. Artikelnr",
      "Beskrivning",
      "Ordered",
      "Shipped",
      "Pending",
      "Price",
      ...descriptions.flatMap((description, index) => [
        String(index + 1),
        `713-90000000${index + 1}`,
        `Manufacturer Part No: 90000000${index + 1}`,
        description,
        "1",
        "1",
        "0",
      ]),
    ].join("\n");
    const weakHelperTitles = [
      "XIAO nRF52840",
      "Seeed Studio XIAO nRF52840 Multiprotocol Development Tool",
      "XIAO ES Multiprotocol Development Tool",
    ];
    mockRequestImportHelperProposal.mockImplementation(
      (request: MouserEnrichmentRequest) => {
        if (request.mode !== "MOUSER_LINE_ITEM_ENRICHMENT") {
          throw new Error("Expected Mouser enrichment input");
        }
        const response = {
          mode: "MOUSER_LINE_ITEM_ENRICHMENT" as const,
          schemaVersion: 2,
          rows: request.lineItems.map((item, index) => ({
            sourceRef: item.sourceRef,
            supplierProductNumber: item.supplierProductNumber,
            mpn: item.mpn,
            productName: weakHelperTitles[index]!,
            manufacturer: "Seeed Studio",
            description: item.rawDescription,
            quantity: item.quantity,
            categoryId: null,
            confidence: 0.95,
          })),
        };
        return {
          status: "ready",
          proposal: validateImportHelperResponse(response, request),
        };
      }
    );

    const prepared = await prepareStaffInventoryImport({
      context: { getSession: () => ({ userId: "staff-1" }) } as never,
      request: new Request("http://localhost/staff/import"),
      file: new File(
        [makePdfFromPages([{ text: pdfText }])],
        "mouser-names.pdf",
        {
          type: "application/pdf",
        }
      ),
    });

    expect(prepared.status).toBe("PREPARED");
    if (prepared.status !== "PREPARED") throw new Error("Expected proposal");
    expect(prepared.proposal.rows.map((row) => row.title)).toEqual([
      "Seeed Studio XIAO nRF52840",
      "Seeed Studio XIAO nRF52840 Sense",
      "Seeed Studio XIAO ESP32-S3",
    ]);
    for (const row of prepared.proposal.rows) {
      expect(row.title).toContain("Seeed Studio");
      expect(row.title).not.toMatch(
        /^(?:Multiprotocol Development Tool|ARM Development Board|Development Tool)$/i
      );
    }
    expect(prepared.proposal.rows[1]?.sourceDescription).toContain(
      "(Pre-Soldered)"
    );
    expect(prepared.proposal.rows[2]?.sourceDescription).toContain(
      "Utvecklingsverktyg för multiprotokoll"
    );
  });

  it("rejects an MPN label returned as a Claude product title", async () => {
    preparePdfImportMocks("operation-mouser-clean-title");
    mockGetCategories.mockResolvedValue([
      {
        id: "cat-electronics",
        name: "Electronics",
        description: "General electronic equipment",
        color: "#2878b8",
      },
    ]);
    const helperResponse = {
      mode: "MOUSER_LINE_ITEM_ENRICHMENT" as const,
      schemaVersion: 2,
      rows: MOUSER_REAL_FIRST_PAGE_EXPECTED.map((line) => ({
        sourceRef: `mouser-p1-line${line.lineNumber}`,
        supplierProductNumber: line.supplierProductNumber,
        mpn: line.mpn,
        productName:
          line.supplierProductNumber === "713-102010634"
            ? "T illv . Artikelnr: 102010634 T"
            : line.description,
        manufacturer: "Seeed Studio",
        description: line.description,
        quantity: line.quantity,
        categoryId: null,
        confidence: 0.9,
      })),
    };
    mockRequestImportHelperProposal.mockImplementation((request) => ({
      status: "ready",
      proposal: validateImportHelperResponse(helperResponse, request),
    }));

    const prepared = await prepareStaffInventoryImport({
      context: { getSession: () => ({ userId: "staff-1" }) } as never,
      request: new Request("http://localhost/staff/import"),
      file: new File(
        [makePdfFromPages(MOUSER_REAL_FIRST_PAGE_PAGES)],
        "mouser-real-first-page.pdf",
        { type: "application/pdf" }
      ),
    });

    expect(prepared.status).toBe("PREPARED");
    if (prepared.status !== "PREPARED") throw new Error("Expected proposal");
    expect(prepared.proposal.rows).toHaveLength(6);
    const xiaoEs = prepared.proposal.rows.find(
      (row) => row.supplierPartNumber === "713-102010634"
    );
    const xiaoBoard = prepared.proposal.rows.find(
      (row) => row.supplierPartNumber === "713-113991115"
    );
    expect(xiaoEs?.title).toContain("XIAO");
    expect(xiaoEs?.title).not.toContain("Tillv. Artikelnr");
    expect(xiaoBoard?.title).toContain("XIAO");
    for (const row of prepared.proposal.rows) {
      expect(row.title).not.toBe(row.supplierPartNumber);
      expect(row.title).not.toBe(row.manufacturerPartNumber);
      expect(row.title).not.toMatch(/Tillv\. Artikelnr/i);
    }
  });

  it("fails closed when a detected Mouser invoice has no recognizable item anchors", () => {
    const parsed = parseMouserInvoicePages([
      {
        sourceRef: "pdf-page-1",
        page: 1,
        text: "Mousers Artikelnummer\nOrdered\nShipped\nPending\nPrice",
      },
    ]);

    expect(parsed).toEqual({
      detected: true,
      lineItems: [],
      unresolvedLines: 1,
      detectedLineNumbers: [],
      detectedSupplierSkus: [],
      positionSource: "text",
    });
  });

  it("creates exactly six proposal rows from the six-line Mouser fixture", async () => {
    vi.clearAllMocks();
    mockStaffAccess.mockResolvedValue({
      organizationId: "org-1",
      userId: "staff-1",
    });
    database.asset.findMany.mockResolvedValue([]);
    database.assetModel.findMany.mockResolvedValue([]);
    database.category.findMany.mockResolvedValue([]);
    database.location.findMany.mockResolvedValue([]);
    database.ioioWriteOperation.findUnique.mockResolvedValue(null);
    database.ioioWriteOperation.findFirst.mockResolvedValue({
      id: "operation-mouser-fixture",
    });
    database.ioioWriteOperation.create.mockResolvedValue({});
    database.ioioImportItem.createMany.mockResolvedValue({ count: 6 });
    database.ioioImportItem.findMany.mockResolvedValue([]);
    mockGetCategories.mockResolvedValue([]);
    mockGetBrokenSection.mockResolvedValue(null);
    mockGetReturnArea.mockResolvedValue(null);
    mockGetArchivedCategoryIds.mockResolvedValue([]);
    mockRequestImportHelperProposal.mockResolvedValue({
      status: "manual",
      reason: "helper_not_configured",
    });
    // why: verify page extraction and vendor routing diagnostics omit document text.
    const loggerInfo = vi.spyOn(Logger, "info").mockImplementation(() => {});

    const prepared = await prepareStaffInventoryImport({
      context: { getSession: () => ({ userId: "staff-1" }) } as never,
      request: new Request("http://localhost/staff/import"),
      file: new File(
        [makePdfFromPages(MOUSER_SIX_LINE_PAGES)],
        "mouser-six-lines.pdf",
        { type: "application/pdf" }
      ),
    });

    expect(prepared.status).toBe("PREPARED");
    if (prepared.status !== "PREPARED") throw new Error("Expected proposal");
    expect(prepared.proposal.rows).toHaveLength(6);
    expect(
      prepared.proposal.rows.map((row) => ({
        supplierProductNumber: row.supplierPartNumber,
        mpn: row.manufacturerPartNumber,
        title: row.title,
        quantity: row.quantity,
      }))
    ).toEqual(
      MOUSER_SIX_LINE_EXPECTED.map((line) => ({
        supplierProductNumber: line.supplierProductNumber,
        mpn: line.mpn,
        title: line.rawDescription,
        quantity: line.quantity,
      }))
    );
    expect(prepared.proposal.pdfSummary?.unresolvedLines).toBe(2);
    expect(loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "ioio_staff_import_pdf_text_extracted",
        pageCount: 2,
        extractedCharsPerPage: MOUSER_SIX_LINE_PAGES.map(
          ({ text }) =>
            text
              .split("\n")
              .map((line) => line.trim())
              .join("\n").length
        ),
        meaningfulText: true,
        selectedExtractor: "primary",
        extractorAttempts: [
          expect.objectContaining({
            extractor: "primary",
            meaningfulText: true,
            status: "readable",
          }),
        ],
        detectedVendorParser: "mouser",
      })
    );
    expect(loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "ioio_staff_import_pdf_analysis_selected",
        detectedVendorParser: "mouser",
        genericClaudeFallbackInvoked: false,
      })
    );
    expect(loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "ioio_staff_import_mouser_line_reconstructed",
        lineNumber: 1,
        supplierSku: "713-100000001",
        mpnPresent: true,
        descriptionCharCount: 19,
        ordered: 5,
        shipped: 3,
        pending: 2,
      })
    );
    expect(loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "ioio_staff_import_mouser_parse_summary",
        detectedLineNumbers: [1, 2, 3, 4, 5, 6, 7, 8],
        detectedSupplierSkus: [
          "713-100000001",
          "713-100000002",
          "713-100000003",
          "713-100000004",
          "713-100000005",
          "713-100000006",
          "713-100000007",
          "713-100000008",
        ],
        reconstructedRowCount: 6,
        unresolvedLines: 2,
        positionSource: "text",
      })
    );
    const [helperRequest] = mockRequestImportHelperProposal.mock.calls[0];
    expect(helperRequest.lineItems).toHaveLength(6);
    expect(helperRequest).not.toHaveProperty("document.pages");
  });

  async function applyNewImport({
    quantity,
    type = "QUANTITY_TRACKED",
    existingAssets = [],
    pauseAtUnitIndex,
    duplicateProposal,
    duplicateFile,
    raceWinner,
    omitReviewDecisions = false,
    allowSameFileReimport = false,
    denyStaffAccess = false,
    proposalHashOverride,
    useExistingCategory = true,
    newCategoryName,
    approveNewCategory = false,
    denyCategoryPermission = false,
    categoryArchivedAfterReview = false,
    selectedLocationId,
    submittedLocationId,
    categoryAppearedAfterReview = false,
    ambiguousLocation = false,
    decisionType,
    trackingModeConfirmed,
    minQuantity,
    unitOfMeasure,
    consumptionType,
    skipDecision = false,
    assetModelDescription,
    productImageProposal,
    acceptSuggestedImage = false,
    applyOnlyRowNumber,
    applyOnlyRowNumbers,
    sourceRow,
    proposalRows,
    reviewDecisionRows,
  }: {
    quantity: number;
    type?: "INDIVIDUAL" | "QUANTITY_TRACKED";
    existingAssets?: Array<{
      id: string;
      title: string;
      type?: "INDIVIDUAL" | "QUANTITY_TRACKED";
      quantity?: number | null;
      categoryId?: string | null;
      assetLocations?: Array<{
        locationId: string;
        quantity: number | null;
        assetKitId: string | null;
      }>;
    }>;
    pauseAtUnitIndex?: number;
    duplicateProposal?: { id: string; status: string; organizationId?: string };
    duplicateFile?: { id: string; status: string; proposalSha256: string };
    raceWinner?: { id: string; status: string };
    omitReviewDecisions?: boolean;
    allowSameFileReimport?: boolean;
    denyStaffAccess?: boolean;
    proposalHashOverride?: string;
    useExistingCategory?: boolean;
    newCategoryName?: string;
    approveNewCategory?: boolean;
    denyCategoryPermission?: boolean;
    categoryArchivedAfterReview?: boolean;
    selectedLocationId?: string;
    submittedLocationId?: string;
    categoryAppearedAfterReview?: boolean;
    ambiguousLocation?: boolean;
    decisionType?: "INDIVIDUAL" | "QUANTITY_TRACKED" | null;
    trackingModeConfirmed?: boolean;
    minQuantity?: number | null;
    unitOfMeasure?: string | null;
    consumptionType?: "ONE_WAY" | "TWO_WAY" | null;
    skipDecision?: boolean;
    assetModelDescription?: string | null;
    productImageProposal?: {
      status: "IMAGE_FOUND";
      mimeType: "image/webp";
      dataBase64?: string;
      imageId?: string;
      sourceName?: string;
      sourceUrl?: string;
      license?: string;
    };
    acceptSuggestedImage?: boolean;
    applyOnlyRowNumber?: number;
    applyOnlyRowNumbers?: number[];
    sourceRow?: {
      title: string;
      quantity: number | null;
      receivedQuantity?: number | null;
      orderedQuantity?: number | null;
      quantityStatus?: "RECEIVED" | "SHIPPED" | "ORDERED" | "UNKNOWN";
    };
    proposalRows?: StaffImportProposalRow[];
    reviewDecisionRows?: StaffImportReviewDecision[];
  }) {
    vi.clearAllMocks();
    const operationId = `operation-${type}-${quantity}`;
    const row = {
      rowNumber: 2,
      title: sourceRow?.title ?? "Arduino Nano",
      action: "CREATE" as const,
      assetId: null,
      type,
      trackingSource:
        type === "INDIVIDUAL"
          ? ("SOURCE_EXPLICIT" as const)
          : ("DETERMINISTIC_DEFAULT" as const),
      trackingReason:
        type === "INDIVIDUAL"
          ? "The source explicitly marks this item for individual tracking."
          : "Default for identical stock and component inventory.",
      trackingReasonCode:
        type === "INDIVIDUAL"
          ? ("EXPLICIT_SERIALIZED_SOURCE" as const)
          : ("DEFAULT_QUANTITY" as const),
      quantity: sourceRow ? sourceRow.quantity : quantity,
      receivedQuantity: sourceRow
        ? sourceRow.receivedQuantity ?? null
        : quantity,
      ...(sourceRow?.orderedQuantity !== undefined
        ? { orderedQuantity: sourceRow.orderedQuantity }
        : {}),
      quantityStatus: sourceRow?.quantityStatus ?? ("RECEIVED" as const),
      category: useExistingCategory ? "Electronics" : null,
      categoryId: useExistingCategory ? "category-electronics" : null,
      location: null,
      locationId: selectedLocationId ?? null,
      ...(ambiguousLocation
        ? { locationResolution: "AMBIGUOUS" as const }
        : {}),
      currentQuantity: null,
      currentCategoryId: null,
      currentLocationId: null,
      reason: "New item",
      assetModelDescription: assetModelDescription ?? null,
      existingAssetModelDescription: null,
      productImageProposal: productImageProposal ?? {
        status: "IMAGE_NOT_FOUND" as const,
      },
      acceptSuggestedImage,
    };
    const rows = proposalRows ?? [row];
    const proposalContent = {
      version: 1 as const,
      operationId,
      organizationId: "org-1",
      source: { filename: "inventory.csv", size: 42, sha256: "hash" },
      rows,
      counts: {
        CREATE: rows.filter(({ action }) => action === "CREATE").length,
        INCREASE_QUANTITY: 0,
        NO_CHANGE: 0,
        POSSIBLE_DUPLICATE: 0,
        NEEDS_REVIEW: 0,
        IGNORE: 0,
        UPDATE_QUANTITY: 0,
        UPDATE_LOCATION: 0,
        UPDATE_CATEGORY: 0,
        AMBIGUOUS: 0,
        REJECT: 0,
      },
      createdAt: new Date().toISOString(),
      categoryOptions: useExistingCategory
        ? [
            {
              id: "category-electronics",
              name: "Electronics",
              color: "#2878b8",
              archived: false,
            },
          ]
        : [],
      locationOptions: selectedLocationId
        ? [
            {
              id: selectedLocationId,
              name: "Problem / Broken Zone",
              parentId: null,
              pathLabel: "IOIO Lab – B477 · Problem / Broken Zone",
              operational: true,
              currentUnits: 18,
            },
          ]
        : [],
    };
    const proposal = {
      ...proposalContent,
      proposalHash: getStaffImportProposalHash(proposalContent),
    };
    const operation = {
      id: operationId,
      operationType: "INVENTORY_IMPORT",
      organizationId: "org-1",
      userId: "staff-1",
      status: "PREPARED",
      fileSha256: proposal.source.sha256,
      createdAt: new Date(),
      updatedAt: new Date(),
      description: JSON.stringify({ proposal }),
    };
    const ledgerRows: Array<Record<string, any>> = [];
    const assetRows: Array<Record<string, any>> = [];
    let modelId: string | null = null;
    let modelIdentityKey: string | null = null;
    let claimAttempted = false;
    if (denyStaffAccess) {
      mockStaffAccess.mockRejectedValue(new Error("Staff access denied."));
    } else {
      mockStaffAccess.mockResolvedValue({
        organizationId: "org-1",
        userId: "staff-1",
      });
    }
    mockGetCategories.mockResolvedValue(
      useExistingCategory
        ? [
            {
              id: "category-electronics",
              name: "Electronics",
              color: "#2878b8",
            },
          ]
        : []
    );
    if (approveNewCategory) {
      mockCreateCategory.mockImplementation(({ name }) => {
        mockGetCategories.mockResolvedValue([{ id: "category-created", name }]);
        return { id: "category-created", name };
      });
    }
    if (categoryAppearedAfterReview) {
      mockGetCategories.mockResolvedValue([
        { id: "category-created-elsewhere", name: newCategoryName },
      ]);
    }
    if (categoryArchivedAfterReview) {
      mockGetCategories.mockReset().mockResolvedValue([]);
    }
    if (denyCategoryPermission) {
      mockRequirePermission.mockRejectedValue(new Error("Permission denied"));
    }
    if (selectedLocationId) {
      database.location.findMany.mockResolvedValue([
        { id: "room", name: "IOIO Lab – B477", parentId: null },
        {
          id: selectedLocationId,
          name: "Problem / Broken Zone",
          parentId: "room",
        },
      ]);
      mockGetBrokenSection.mockResolvedValue({ id: selectedLocationId });
    }
    database.ioioWriteOperation.findFirst.mockImplementation(({ where }) => {
      if (where.id === operationId) return operation;
      if (where.proposalSha256) {
        if (claimAttempted && raceWinner) return raceWinner;
        return duplicateProposal?.organizationId === undefined ||
          duplicateProposal.organizationId === where.organizationId
          ? duplicateProposal ?? null
          : null;
      }
      if (where.fileSha256 && where.organizationId === "org-1") {
        return duplicateFile ?? null;
      }
      return null;
    });
    database.ioioWriteOperation.updateMany.mockImplementation(
      ({ where, data }) => {
        if (
          where.id !== operationId ||
          where.organizationId !== "org-1" ||
          where.userId !== "staff-1"
        ) {
          return { count: 0 };
        }
        if (where.status && where.status !== operation.status) {
          return { count: 0 };
        }
        if (
          where.status === "PREPARED" &&
          data.status === "APPLYING" &&
          raceWinner
        ) {
          claimAttempted = true;
          throw { code: "P2002" };
        }
        Object.assign(operation, data);
        return { count: 1 };
      }
    );
    database.ioioImportItem.createMany.mockImplementation(({ data }) => {
      for (const item of data) {
        if (ledgerRows.some((entry) => entry.identityKey === item.identityKey))
          continue;
        ledgerRows.push({
          ...item,
          id: `ledger-${ledgerRows.length + 1}`,
          status: item.unitIndex === pauseAtUnitIndex ? "IN_FLIGHT" : "PENDING",
          attempt: 0,
          heartbeatAt: null,
          errorCode: null,
          errorMessage: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }
      return { count: data.length };
    });
    database.ioioImportItem.findMany.mockImplementation(({ where }) =>
      ledgerRows.filter(
        (item) =>
          item.operationId === where.operationId &&
          item.organizationId === where.organizationId &&
          (!where.status || item.status === where.status)
      )
    );
    database.ioioImportItem.findFirst.mockImplementation(
      ({ where }) =>
        ledgerRows.find(
          (item) =>
            item.id === where.id &&
            item.operationId === where.operationId &&
            item.organizationId === where.organizationId
        ) ?? null
    );
    database.ioioImportItem.updateMany.mockImplementation(({ where, data }) => {
      const item = ledgerRows.find(
        (entry) =>
          entry.id === where.id &&
          entry.operationId === where.operationId &&
          entry.organizationId === where.organizationId &&
          (!where.status || entry.status === where.status)
      );
      if (!item) return { count: 0 };
      for (const [key, value] of Object.entries(data)) {
        item[key] =
          key === "attempt" && typeof value === "object"
            ? item.attempt + (value as { increment: number }).increment
            : value;
      }
      item.updatedAt = new Date();
      return { count: 1 };
    });
    database.assetModel.findFirst.mockImplementation(({ where }) => {
      if (where.id) return where.id === modelId ? { id: modelId } : null;
      if (where.importIdentityKey)
        return where.importIdentityKey === modelIdentityKey && modelId
          ? { id: modelId }
          : null;
      return where.name === "Arduino Nano" && modelId ? { id: modelId } : null;
    });
    database.assetModel.findMany.mockResolvedValue([]);
    database.assetModel.updateMany.mockResolvedValue({ count: 0 });
    mockCreateAssetModel.mockImplementation(({ id, importIdentityKey }) => {
      modelId = id;
      modelIdentityKey = importIdentityKey ?? null;
      return { id, importIdentityKey: modelIdentityKey };
    });
    database.asset.findMany.mockImplementation(({ where }) => {
      const availableAssets = [...existingAssets, ...assetRows];
      if (typeof where.title === "string")
        return availableAssets.filter((asset) => asset.title === where.title);
      if (where.title?.startsWith)
        return availableAssets.filter((asset) =>
          asset.title.startsWith(where.title.startsWith)
        );
      return [];
    });
    database.asset.findFirst.mockResolvedValue(null);
    database.category.findFirst.mockResolvedValue(null);
    database.qr.findFirst.mockResolvedValue(null);
    if (!selectedLocationId) database.location.findMany.mockResolvedValue([]);
    mockCreateAsset.mockImplementation((asset) => {
      assetRows.push(asset);
      return { id: asset.id };
    });

    const result = await applyStaffInventoryImport({
      context: { getSession: () => ({ userId: "staff-1" }) } as never,
      request: new Request("http://localhost/staff/import"),
      operationId,
      proposalHash: proposalHashOverride ?? proposal.proposalHash,
      allowSameFileReimport,
      applyOnlyRowNumber,
      applyOnlyRowNumbers,
      ...(!omitReviewDecisions
        ? {
            reviewDecisions: JSON.stringify(
              reviewDecisionRows ?? [
                skipDecision
                  ? { rowNumber: row.rowNumber, decision: "IGNORE" }
                  : {
                      rowNumber: row.rowNumber,
                      decision: "APPROVE",
                      title: row.title,
                      assetId: null,
                      categoryId: useExistingCategory ? row.categoryId : null,
                      newCategoryName: newCategoryName ?? null,
                      approveNewCategory,
                      locationId:
                        submittedLocationId ?? selectedLocationId ?? null,
                      quantity,
                      type: decisionType === undefined ? type : decisionType,
                      trackingModeConfirmed:
                        trackingModeConfirmed ?? type === "INDIVIDUAL",
                      trackingModeSelectedByStaff: type === "INDIVIDUAL",
                      minQuantity,
                      unitOfMeasure,
                      consumptionType,
                      assetModelDescription: assetModelDescription ?? null,
                      acceptSuggestedImage,
                    },
              ]
            ),
          }
        : {}),
    });
    return {
      result,
      assetRows,
      ledgerRows,
      operationId,
      modelId,
      operation,
      proposalHash: proposal.proposalHash,
    };
  }

  async function applyAfterConcurrentAssetEdit(
    changedField: "quantity" | "categoryId" | "locationId"
  ) {
    vi.clearAllMocks();
    const operationId = `operation-stale-${changedField}`;
    const expectedAssetState = {
      assetId: "asset-existing",
      title: "USB-C Cable",
      type: "QUANTITY_TRACKED" as const,
      quantity: 20,
      categoryId: "category-electronics",
      locationIds: ["location-a"],
      assetModelId: null,
    };
    const asset = {
      id: "asset-existing",
      title: "USB-C Cable",
      type: "QUANTITY_TRACKED" as const,
      quantity: changedField === "quantity" ? 21 : 20,
      categoryId:
        changedField === "categoryId"
          ? "category-other"
          : "category-electronics",
      assetModelId: null,
      assetLocations: [
        {
          locationId:
            changedField === "locationId" ? "location-b" : "location-a",
          quantity: 20,
          assetKitId: null,
        },
      ],
    };
    const row = {
      rowNumber: 2,
      title: "USB-C Cable",
      action: "UPDATE_QUANTITY" as const,
      assetId: "asset-existing",
      type: "QUANTITY_TRACKED" as const,
      quantity: 5,
      receivedQuantity: 5,
      quantityStatus: "RECEIVED" as const,
      category: null,
      categoryId: "category-electronics",
      location: null,
      locationId: "location-a",
      locationLabel: "Shelf A",
      currentQuantity: 20,
      currentCategoryId: "category-electronics",
      currentLocationId: "location-a",
      expectedAssetState,
      proposedQuantity: 25,
      reason: "Existing stock",
    };
    const proposalContent = {
      version: 1 as const,
      operationId,
      organizationId: "org-1",
      source: { filename: "stock.csv", size: 10, sha256: "file-hash" },
      rows: [row],
      counts: {
        CREATE: 0,
        INCREASE_QUANTITY: 0,
        NO_CHANGE: 0,
        POSSIBLE_DUPLICATE: 0,
        NEEDS_REVIEW: 0,
        IGNORE: 0,
        UPDATE_QUANTITY: 1,
        UPDATE_LOCATION: 0,
        UPDATE_CATEGORY: 0,
        AMBIGUOUS: 0,
        REJECT: 0,
      },
      createdAt: new Date().toISOString(),
      categoryOptions: [
        {
          id: "category-electronics",
          name: "Electronics",
          color: "#2878b8",
        },
      ],
      locationOptions: [
        {
          id: "location-a",
          name: "Shelf A",
          parentId: null,
          pathLabel: "Shelf A",
          operational: false,
          currentUnits: 20,
        },
      ],
    };
    const proposal = {
      ...proposalContent,
      proposalHash: getStaffImportProposalHash(proposalContent),
    };
    const operation = {
      id: operationId,
      operationType: "INVENTORY_IMPORT",
      organizationId: "org-1",
      userId: "staff-1",
      status: "PREPARED",
      fileSha256: proposal.source.sha256,
      createdAt: new Date(),
      updatedAt: new Date(),
      description: JSON.stringify({ proposal }),
    };
    const ledgerRows: Array<Record<string, any>> = [];
    mockStaffAccess.mockResolvedValue({
      organizationId: "org-1",
      userId: "staff-1",
    });
    mockGetCategories.mockResolvedValue([
      {
        id: "category-electronics",
        name: "Electronics",
        color: "#2878b8",
      },
    ]);
    database.ioioWriteOperation.findFirst.mockImplementation(({ where }) =>
      where.id === operationId ? operation : null
    );
    database.ioioWriteOperation.updateMany.mockImplementation(
      ({ where, data }) => {
        if (
          where.id !== operationId ||
          (where.status && where.status !== operation.status)
        ) {
          return { count: 0 };
        }
        Object.assign(operation, data);
        return { count: 1 };
      }
    );
    database.ioioImportItem.createMany.mockImplementation(({ data }) => {
      for (const item of data) {
        ledgerRows.push({
          ...item,
          id: `ledger-${ledgerRows.length + 1}`,
          status: "PENDING",
          attempt: 0,
          heartbeatAt: null,
          errorCode: null,
          errorMessage: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }
      return { count: data.length };
    });
    database.ioioImportItem.findMany.mockImplementation(({ where }) =>
      ledgerRows.filter(
        (item) =>
          item.operationId === where.operationId &&
          item.organizationId === where.organizationId &&
          (!where.status || item.status === where.status)
      )
    );
    database.ioioImportItem.findFirst.mockImplementation(
      ({ where }) =>
        ledgerRows.find(
          (item) => item.id === where.id && item.operationId === operationId
        ) ?? null
    );
    database.ioioImportItem.updateMany.mockImplementation(({ where, data }) => {
      const item = ledgerRows.find((entry) => entry.id === where.id);
      if (!item || (where.status && item.status !== where.status))
        return { count: 0 };
      Object.assign(item, data, { updatedAt: new Date() });
      return { count: 1 };
    });
    database.asset.findMany.mockResolvedValue([asset]);
    database.asset.findFirst.mockResolvedValue(asset);
    database.location.findMany.mockResolvedValue([
      { id: "location-a", name: "Shelf A", parentId: null },
    ]);

    return applyStaffInventoryImport({
      context: { getSession: () => ({ userId: "staff-1" }) } as never,
      request: new Request("http://localhost/staff/import"),
      operationId,
      proposalHash: proposal.proposalHash,
      reviewDecisions: JSON.stringify([
        {
          rowNumber: 2,
          decision: "APPROVE",
          title: "USB-C Cable",
          assetId: "asset-existing",
          categoryId: "category-electronics",
          locationId: "location-a",
          quantity: 5,
        },
      ]),
    });
  }

  it("defaults a single imported product to quantity tracking", async () => {
    const { result, assetRows, ledgerRows, modelId } = await applyNewImport({
      quantity: 1,
    });

    expect(assetRows).toHaveLength(1);
    expect(assetRows[0]).toMatchObject({
      title: "Arduino Nano",
      type: "QUANTITY_TRACKED",
      quantity: 1,
    });
    expect(assetRows[0]).not.toHaveProperty("assetModelId");
    expect(ledgerRows.find((item) => item.unitIndex === null)?.status).toBe(
      "DONE"
    );
    expect(modelId).toBeNull();
    expect(mockCreateAssetModel).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      totalRows: 1,
      succeededRows: 1,
    });
    expect(
      database.ioioWriteOperation.updateMany.mock.calls.at(-1)?.[0].data.status
    ).toBe("SUCCEEDED");
  });

  it("saves and reopens a review draft without writing canonical inventory", async () => {
    vi.clearAllMocks();
    mockStaffAccess.mockResolvedValue({
      organizationId: "org-1",
      userId: "staff-1",
    });
    const proposalContent = {
      version: 1 as const,
      operationId: "draft-operation",
      organizationId: "org-1",
      source: { filename: "inventory.csv", size: 42, sha256: "draft-hash" },
      rows: [
        {
          rowNumber: 2,
          title: "Arduino Nano",
          action: "CREATE" as const,
          assetId: null,
          type: "QUANTITY_TRACKED" as const,
          quantity: 4,
          receivedQuantity: 4,
          category: "Electronics",
          categoryId: "category-electronics",
          location: null,
          locationId: null,
          currentQuantity: null,
          currentCategoryId: null,
          currentLocationId: null,
          reason: "New item",
          productImageProposal: {
            status: "IMAGE_FOUND" as const,
            mimeType: "image/webp" as const,
            imageId: `ioio-import-${"a".repeat(64)}`,
            autoAccepted: true,
          },
        },
      ],
      counts: {
        CREATE: 1,
        INCREASE_QUANTITY: 0,
        NO_CHANGE: 0,
        POSSIBLE_DUPLICATE: 0,
        NEEDS_REVIEW: 0,
        IGNORE: 0,
        UPDATE_QUANTITY: 0,
        UPDATE_LOCATION: 0,
        UPDATE_CATEGORY: 0,
        AMBIGUOUS: 0,
        REJECT: 0,
      },
      createdAt: new Date().toISOString(),
      categoryOptions: [
        { id: "category-electronics", name: "Electronics", archived: false },
      ],
      locationOptions: [
        {
          id: "location-shelf-b3",
          name: "Shelf B3",
          parentId: "section-b",
          pathLabel: "Storage / Section B / Shelf B3",
          operational: false,
          currentUnits: 2,
        },
      ],
    };
    const proposal = {
      ...proposalContent,
      proposalHash: getStaffImportProposalHash(proposalContent),
    };
    const operation = {
      id: proposal.operationId,
      operationType: "INVENTORY_IMPORT",
      organizationId: "org-1",
      userId: "staff-1",
      status: "PREPARED",
      fileSha256: proposal.source.sha256,
      createdAt: new Date(),
      updatedAt: new Date(),
      description: JSON.stringify({ kind: "STAFF_INVENTORY_IMPORT", proposal }),
    };
    database.ioioWriteOperation.findFirst.mockImplementation(({ where }) =>
      where.id === operation.id ? operation : null
    );
    database.ioioWriteOperation.updateMany.mockImplementation(
      ({ where, data }) => {
        if (where.id !== operation.id || operation.status !== "PREPARED") {
          return { count: 0 };
        }
        Object.assign(operation, data);
        return { count: 1 };
      }
    );
    database.ioioWriteOperation.findMany.mockResolvedValue([operation]);
    database.ioioImportItem.findMany.mockResolvedValue([]);

    const decisions = [
      {
        rowNumber: 2,
        decision: "APPROVE" as const,
        title: "Arduino Nano",
        categoryId: "category-electronics",
        locationId: "location-shelf-b3",
        quantity: 4,
        type: "INDIVIDUAL" as const,
        trackingModeConfirmed: false,
        trackingModeSelectedByStaff: true,
      },
    ];
    await saveStaffInventoryImportDraft({
      context: { getSession: () => ({ userId: "staff-1" }) } as never,
      request: new Request("http://localhost/staff/import"),
      operationId: operation.id,
      reviewDecisions: JSON.stringify(decisions),
    });
    const reopened = await getStaffInventoryImportProposal({
      context: { getSession: () => ({ userId: "staff-1" }) } as never,
      request: new Request("http://localhost/staff/import"),
      operationId: operation.id,
    });
    const drafts = await getStaffInventoryImportDrafts({
      context: { getSession: () => ({ userId: "staff-1" }) } as never,
      request: new Request("http://localhost/staff/import"),
    });

    expect(reopened.rows[0].productImageProposal).toMatchObject({
      status: "IMAGE_FOUND",
      imageId: `ioio-import-${"a".repeat(64)}`,
    });
    expect(reopened.rows[0].productImageProposal?.dataBase64).toBeUndefined();
    expect(reopened.savedReviewDecisions).toMatchObject(decisions);
    expect(reopened.rows[0]?.locationId).toBeNull();
    expect(drafts).toEqual([
      expect.objectContaining({
        operationId: operation.id,
        filename: "inventory.csv",
        rowCount: 1,
      }),
    ]);
    expect(mockCreateAsset).not.toHaveBeenCalled();
    expect(mockCreateAssetModel).not.toHaveBeenCalled();
  });

  it("applies one approved row from a 20-row proposal and leaves the other 19 pending", async () => {
    const proposalRows: StaffImportProposalRow[] = Array.from(
      { length: 20 },
      (_, index) => ({
        rowNumber: index + 2,
        title: index === 0 ? "Arduino Nano" : `Inventory Item ${index + 1}`,
        action: "CREATE",
        assetId: null,
        type: "QUANTITY_TRACKED",
        quantity: 1,
        receivedQuantity: 1,
        category: "Electronics",
        categoryId: "category-electronics",
        location: null,
        locationId: null,
        currentQuantity: null,
        currentCategoryId: null,
        currentLocationId: null,
        reason: "New item",
        ...(index === 0
          ? {
              productImageProposal: {
                status: "IMAGE_FOUND" as const,
                mimeType: "image/webp" as const,
                dataBase64: Buffer.from(
                  "RIFF\u0004\u0000\u0000\u0000WEBP"
                ).toString("base64"),
                source: "OPENVERSE" as const,
                autoAccepted: true,
              },
            }
          : {
              productImageProposal: {
                status: "IMAGE_FOUND" as const,
                mimeType: "image/webp" as const,
                imageId: `ioio-import-${"b".repeat(64)}`,
                autoAccepted: true,
              },
            }),
      })
    );
    const decisions: StaffImportReviewDecision[] = proposalRows.map(
      (row, index) => ({
        rowNumber: row.rowNumber,
        decision: index === 0 ? "APPROVE" : null,
        ...(index === 0
          ? {
              title: row.title,
              assetId: null,
              categoryId: row.categoryId,
              locationId: null,
              quantity: 1,
              type: "QUANTITY_TRACKED",
              unitOfMeasure: "pcs",
              consumptionType: "TWO_WAY",
              acceptSuggestedImage: true,
            }
          : {}),
      })
    );
    const {
      result,
      assetRows,
      ledgerRows,
      operation,
      operationId,
      proposalHash,
    } = await applyNewImport({
      quantity: 1,
      type: "QUANTITY_TRACKED",
      proposalRows,
      reviewDecisionRows: decisions,
    });

    expect(assetRows).toHaveLength(1);
    expect(result).toMatchObject({ succeededRows: 1, remainingRows: 19 });
    expect(operation.status).toBe("PREPARED");
    expect(ledgerRows.filter((item) => item.status === "DONE")).toHaveLength(1);
    expect(ledgerRows.filter((item) => item.status === "PENDING")).toHaveLength(
      19
    );
    expect(mockUpdateAssetMainImage).toHaveBeenCalledTimes(1);
    await expect(
      applyStaffInventoryImport({
        context: { getSession: () => ({ userId: "staff-1" }) } as never,
        request: new Request("http://localhost/staff/import"),
        operationId,
        proposalHash,
        reviewDecisions: JSON.stringify(decisions),
      })
    ).rejects.toThrow("There are no approved rows left to apply.");
    expect(assetRows).toHaveLength(1);
    const reopened = await getStaffInventoryImportProposal({
      context: { getSession: () => ({ userId: "staff-1" }) } as never,
      request: new Request("http://localhost/staff/import"),
      operationId,
    });
    expect(reopened.rows[1].productImageProposal?.imageId).toBe(
      `ioio-import-${"b".repeat(64)}`
    );
    expect(reopened.rows[1].productImageProposal?.dataBase64).toBeUndefined();
    expect(reopened.appliedRowNumbers).toEqual([2]);
    expect(reopened.ignoredRowNumbers).toEqual([]);
  });

  it("applies only the requested row and preserves the other approved draft decisions", async () => {
    const proposalRows: StaffImportProposalRow[] = Array.from(
      { length: 3 },
      (_, index) => ({
        rowNumber: index + 2,
        title: `Inventory Item ${index + 1}`,
        action: "CREATE",
        assetId: null,
        type: "QUANTITY_TRACKED",
        quantity: 1,
        receivedQuantity: 1,
        category: "Electronics",
        categoryId: "category-electronics",
        location: null,
        locationId: null,
        currentQuantity: null,
        currentCategoryId: null,
        currentLocationId: null,
        reason: "New item",
      })
    );
    const decisions: StaffImportReviewDecision[] = proposalRows.map((row) => ({
      rowNumber: row.rowNumber,
      decision: "APPROVE",
      title: row.title,
      assetId: null,
      categoryId: row.categoryId,
      locationId: null,
      quantity: 1,
      type: "QUANTITY_TRACKED",
      unitOfMeasure: "pcs",
      consumptionType: "TWO_WAY",
      minQuantity: row.rowNumber === 4 ? -1 : null,
    }));
    const { result, assetRows, ledgerRows, operationId, proposalHash } =
      await applyNewImport({
        quantity: 1,
        proposalRows,
        reviewDecisionRows: decisions,
        applyOnlyRowNumber: 3,
      });

    expect(assetRows.map(({ title }) => title)).toEqual(["Inventory Item 2"]);
    expect(result).toMatchObject({ succeededRows: 1, remainingRows: 2 });
    expect(ledgerRows.filter((item) => item.status === "DONE")).toHaveLength(1);
    expect(ledgerRows.filter((item) => item.status === "PENDING")).toHaveLength(
      2
    );
    const reopened = await getStaffInventoryImportProposal({
      context: { getSession: () => ({ userId: "staff-1" }) } as never,
      request: new Request("http://localhost/staff/import"),
      operationId,
    });
    expect(reopened.appliedRowNumbers).toEqual([3]);
    expect(reopened.savedReviewDecisions).toMatchObject(
      decisions.map((decision) => ({
        rowNumber: decision.rowNumber,
        decision: "APPROVE",
      }))
    );
    const retry = await applyStaffInventoryImport({
      context: { getSession: () => ({ userId: "staff-1" }) } as never,
      request: new Request("http://localhost/staff/import"),
      operationId,
      proposalHash,
      applyOnlyRowNumber: 3,
      reviewDecisions: JSON.stringify(decisions),
    });
    expect(retry).toMatchObject({
      status: "NEEDS_REVIEW",
      blockedRows: [{ rowNumber: 3, issues: [{ code: "ALREADY_IMPORTED" }] }],
    });
    expect(assetRows).toHaveLength(1);
    const next = await applyStaffInventoryImport({
      context: { getSession: () => ({ userId: "staff-1" }) } as never,
      request: new Request("http://localhost/staff/import"),
      operationId,
      proposalHash,
      applyOnlyRowNumber: 2,
      reviewDecisions: JSON.stringify(decisions),
    });
    expect(next).toMatchObject({ succeededRows: 1, remainingRows: 1 });
    expect(assetRows).toHaveLength(2);
  });

  it("keeps an explicit Create new tracking decision when reclassification finds an individual candidate", async () => {
    const expectedAssetState = {
      assetId: "existing-board",
      title: "Arduino Nano",
      type: "INDIVIDUAL" as const,
      quantity: null,
      categoryId: "category-electronics",
      locationIds: [],
      assetModelId: null,
    };
    const row: StaffImportProposalRow = {
      rowNumber: 2,
      title: "Arduino Nano",
      action: "POSSIBLE_DUPLICATE",
      assetId: null,
      type: "QUANTITY_TRACKED",
      trackingSource: "DETERMINISTIC_DEFAULT",
      quantity: 1,
      receivedQuantity: 1,
      categoryId: "category-electronics",
      locationId: null,
      currentQuantity: null,
      currentCategoryId: null,
      currentLocationId: null,
      reason: "Review possible duplicate",
      matchCandidates: [
        {
          id: "existing-board",
          title: "Arduino Nano",
          type: "INDIVIDUAL",
          quantity: null,
          category: "Electronics",
          location: null,
          expectedAssetState,
        },
      ],
    };
    const { result, assetRows } = await applyNewImport({
      quantity: 1,
      proposalRows: [row],
      existingAssets: [
        {
          id: "existing-board",
          title: "Arduino Nano",
          type: "INDIVIDUAL",
          quantity: null,
          categoryId: "category-electronics",
          assetLocations: [],
        },
      ],
      reviewDecisionRows: [
        {
          rowNumber: 2,
          decision: null,
          title: row.title,
          assetId: null,
          categoryId: row.categoryId,
          locationId: null,
          quantity: 1,
          type: "QUANTITY_TRACKED",
          productChoice: "NEW",
        },
      ],
      applyOnlyRowNumber: 2,
    });
    expect(result).toMatchObject({ succeededRows: 1 });
    expect(assetRows).toHaveLength(1);
    expect(assetRows[0]).toMatchObject({
      type: "QUANTITY_TRACKED",
      quantity: 1,
    });
  });

  it.each([false, true])(
    "validates required fields instead of stored CONFLICT (missing category: %s)",
    async (missingCategory) => {
      const row: StaffImportProposalRow = {
        rowNumber: 2,
        title: "Arduino Nano",
        action: "CREATE",
        reviewState: "CONFLICT",
        assetId: null,
        type: "QUANTITY_TRACKED",
        quantity: 5,
        receivedQuantity: 5,
        categoryId: missingCategory ? null : "category-electronics",
        locationId: null,
        currentQuantity: null,
        currentCategoryId: null,
        currentLocationId: null,
        reason: "Historical review state",
      };
      const { result, assetRows } = await applyNewImport({
        quantity: 5,
        proposalRows: [row],
        reviewDecisionRows: [
          {
            rowNumber: 2,
            decision: "APPROVE",
            title: row.title,
            assetId: null,
            categoryId: row.categoryId,
            locationId: null,
            quantity: 5,
            type: "QUANTITY_TRACKED",
            productChoice: "NEW",
          },
        ],
      });
      if (missingCategory) {
        expect(result).toMatchObject({
          status: "NEEDS_REVIEW",
          readyCount: 0,
          blockedCount: 1,
          blockedRows: [
            { rowNumber: 2, issues: [{ code: "MISSING_CATEGORY" }] },
          ],
        });
        expect(assetRows).toHaveLength(0);
      } else {
        expect(result).toMatchObject({ succeededRows: 1 });
        expect(assetRows).toHaveLength(1);
      }
    }
  );

  it("returns all blocked selected rows before writing a mixed batch", async () => {
    const rows: StaffImportProposalRow[] = Array.from(
      { length: 6 },
      (_, index) => ({
        rowNumber: index + 2,
        title: `Product ${index + 1}`,
        action: "CREATE",
        reviewState: "CONFLICT",
        assetId: null,
        type: "QUANTITY_TRACKED",
        quantity: 1,
        receivedQuantity: 1,
        categoryId: index < 3 ? "category-electronics" : null,
        locationId: null,
        currentQuantity: null,
        currentCategoryId: null,
        currentLocationId: null,
        reason: "New item",
      })
    );
    const { result, assetRows } = await applyNewImport({
      quantity: 1,
      proposalRows: rows,
      applyOnlyRowNumbers: [2, 3, 4, 5, 6],
      reviewDecisionRows: rows.map((row) => ({
        rowNumber: row.rowNumber,
        decision: "APPROVE",
        title: row.title,
        assetId: null,
        categoryId: row.categoryId,
        locationId: null,
        quantity: 1,
        type: "QUANTITY_TRACKED",
        productChoice: "NEW",
      })),
    });
    expect(result).toMatchObject({
      status: "NEEDS_REVIEW",
      readyCount: 3,
      blockedCount: 2,
      blockedRows: [
        { rowNumber: 5, issues: [{ code: "MISSING_CATEGORY" }] },
        { rowNumber: 6, issues: [{ code: "MISSING_CATEGORY" }] },
      ],
    });
    expect(assetRows).toHaveLength(0);
    expect(mockCreateCategory).not.toHaveBeenCalled();
  });

  it("accepts a direct row import without a second approval flag", async () => {
    const { result, assetRows } = await applyNewImport({
      quantity: 5,
      applyOnlyRowNumber: 2,
      reviewDecisionRows: [
        {
          rowNumber: 2,
          decision: null,
          title: "Arduino Nano",
          assetId: null,
          categoryId: "category-electronics",
          locationId: null,
          quantity: 5,
          type: "QUANTITY_TRACKED",
          productChoice: "NEW",
        },
      ],
    });
    expect(result).toMatchObject({ succeededRows: 1 });
    expect(assetRows).toHaveLength(1);
  });

  it("returns an explicit ignored issue for an ignored row in a scoped import", async () => {
    const { result, assetRows } = await applyNewImport({
      quantity: 1,
      skipDecision: true,
      applyOnlyRowNumber: 2,
    });
    expect(result).toMatchObject({
      status: "NEEDS_REVIEW",
      readyCount: 0,
      blockedCount: 1,
      blockedRows: [{ rowNumber: 2, issues: [{ code: "IGNORED" }] }],
    });
    expect(assetRows).toHaveLength(0);
  });

  it.each([0, -1])(
    "returns structured invalid quantity for %s without writes",
    async (quantity) => {
      const { result, assetRows } = await applyNewImport({ quantity });
      expect(result).toMatchObject({
        status: "NEEDS_REVIEW",
        blockedRows: [{ issues: [{ code: "INVALID_QUANTITY" }] }],
      });
      expect(assetRows).toHaveLength(0);
    }
  );

  it("keeps ignored rows resolved while the rest of the proposal remains pending", async () => {
    const remainingRow: StaffImportProposalRow = {
      rowNumber: 3,
      title: "USB-C Cable",
      action: "CREATE",
      assetId: null,
      type: "QUANTITY_TRACKED",
      quantity: 1,
      receivedQuantity: 1,
      category: "Electronics",
      categoryId: "category-electronics",
      location: null,
      locationId: null,
      currentQuantity: null,
      currentCategoryId: null,
      currentLocationId: null,
      reason: "New item",
    };
    const { result, assetRows, operationId } = await applyNewImport({
      quantity: 1,
      type: "QUANTITY_TRACKED",
      proposalRows: [
        {
          rowNumber: 2,
          title: "Arduino Nano",
          action: "CREATE",
          assetId: null,
          type: "QUANTITY_TRACKED",
          quantity: 1,
          receivedQuantity: 1,
          category: "Electronics",
          categoryId: "category-electronics",
          location: null,
          locationId: null,
          currentQuantity: null,
          currentCategoryId: null,
          currentLocationId: null,
          reason: "New item",
        },
        remainingRow,
      ],
      reviewDecisionRows: [
        { rowNumber: 2, decision: "IGNORE" },
        { rowNumber: 3, decision: null },
      ],
    });
    const reopened = await getStaffInventoryImportProposal({
      context: { getSession: () => ({ userId: "staff-1" }) } as never,
      request: new Request("http://localhost/staff/import"),
      operationId,
    });

    expect(result).toMatchObject({ skippedRows: 1, remainingRows: 1 });
    expect(assetRows).toHaveLength(0);
    expect(reopened.ignoredRowNumbers).toEqual([2]);
    expect(reopened.appliedRowNumbers).toEqual([]);
  });

  it("applies only the three approved rows from a partial proposal", async () => {
    const proposalRows: StaffImportProposalRow[] = Array.from(
      { length: 5 },
      (_, index) => ({
        rowNumber: index + 2,
        title: index === 0 ? "Arduino Nano" : `Inventory Item ${index + 1}`,
        action: "CREATE",
        assetId: null,
        type: "QUANTITY_TRACKED",
        quantity: 1,
        receivedQuantity: 1,
        category: "Electronics",
        categoryId: "category-electronics",
        location: null,
        locationId: null,
        currentQuantity: null,
        currentCategoryId: null,
        currentLocationId: null,
        reason: "New item",
      })
    );
    const decisions: StaffImportReviewDecision[] = proposalRows.map(
      (row, index) => ({
        rowNumber: row.rowNumber,
        decision: index < 3 ? "APPROVE" : null,
        ...(index < 3
          ? {
              title: row.title,
              assetId: null,
              categoryId: row.categoryId,
              locationId: null,
              quantity: 1,
              type: "QUANTITY_TRACKED",
              unitOfMeasure: "pcs",
              consumptionType: "TWO_WAY",
            }
          : {}),
      })
    );
    const { result, assetRows } = await applyNewImport({
      quantity: 1,
      type: "QUANTITY_TRACKED",
      proposalRows,
      reviewDecisionRows: decisions,
    });

    expect(assetRows).toHaveLength(3);
    expect(result).toMatchObject({ succeededRows: 3, remainingRows: 2 });
  });

  it("applies the received shipment quantity parsed from a PDF through the existing Shelf path", async () => {
    const [sourceRow] = await parseStaffImportFile({
      filename: "shipment.pdf",
      buffer: makePdfFromPages([
        {
          text: "Product | Ordered | Shipped | Category\nArduino Nano | 5 | 4 | Electronics",
        },
      ]),
    });
    expect(sourceRow).toMatchObject({
      quantity: 4,
      receivedQuantity: 4,
      orderedQuantity: 5,
      quantityStatus: "SHIPPED",
    });

    const { assetRows, result } = await applyNewImport({
      quantity: 4,
      type: "QUANTITY_TRACKED",
      sourceRow,
    });

    expect(assetRows).toHaveLength(1);
    expect(assetRows[0]).toMatchObject({
      title: "Arduino Nano",
      type: "QUANTITY_TRACKED",
      quantity: 4,
    });
    expect(result).toMatchObject({ totalRows: 1, succeededRows: 1 });
  });

  it("creates a proposed category only after explicit approval and Shelf permission", async () => {
    const { result } = await applyNewImport({
      quantity: 1,
      type: "QUANTITY_TRACKED",
      useExistingCategory: false,
      newCategoryName: "Sensors",
      approveNewCategory: true,
    });

    const applied = result as StaffImportResult;
    expect(applied.succeededRows).toBe(1);
    expect(mockRequirePermission).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "staff-1",
        entity: PermissionEntity.category,
        action: PermissionAction.create,
      })
    );
    expect(mockCreateCategory).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Sensors",
        userId: "staff-1",
        organizationId: "org-1",
      })
    );
  });

  it("does not create a category when the staff member lacks category:create permission", async () => {
    await expect(
      applyNewImport({
        quantity: 1,
        type: "QUANTITY_TRACKED",
        useExistingCategory: false,
        newCategoryName: "Sensors",
        approveNewCategory: true,
        denyCategoryPermission: true,
      })
    ).rejects.toThrow("Permission denied");

    expect(mockCreateCategory).not.toHaveBeenCalled();
    expect(mockCreateAsset).not.toHaveBeenCalled();
  });

  it("blocks Apply when a new category has not been explicitly approved", async () => {
    await expect(
      applyNewImport({
        quantity: 1,
        type: "QUANTITY_TRACKED",
        useExistingCategory: false,
        newCategoryName: "Sensors",
      })
    ).resolves.toMatchObject({
      result: {
        status: "NEEDS_REVIEW",
        blockedRows: [
          {
            issues: expect.arrayContaining([
              expect.objectContaining({ code: "MISSING_CATEGORY" }),
            ]),
          },
        ],
      },
    });

    expect(mockCreateCategory).not.toHaveBeenCalled();
    expect(mockCreateAsset).not.toHaveBeenCalled();
  });

  it("blocks a category archived after review before writing", async () => {
    await expect(
      applyNewImport({
        quantity: 1,
        type: "QUANTITY_TRACKED",
        categoryArchivedAfterReview: true,
      })
    ).resolves.toMatchObject({
      result: {
        status: "NEEDS_REVIEW",
        blockedRows: [
          {
            issues: expect.arrayContaining([
              expect.objectContaining({ code: "INVALID_CATEGORY" }),
            ]),
          },
        ],
      },
    });
    expect(mockCreateAsset).not.toHaveBeenCalled();
  });

  it("blocks a category that appeared after review before any inventory write", async () => {
    await expect(
      applyNewImport({
        quantity: 1,
        type: "QUANTITY_TRACKED",
        useExistingCategory: false,
        newCategoryName: "Sensors",
        approveNewCategory: true,
        categoryAppearedAfterReview: true,
      })
    ).resolves.toMatchObject({
      result: {
        status: "NEEDS_REVIEW",
        blockedRows: [
          {
            issues: expect.arrayContaining([
              expect.objectContaining({ code: "INVALID_CATEGORY" }),
            ]),
          },
        ],
      },
    });
    expect(mockCreateCategory).not.toHaveBeenCalled();
    expect(mockCreateAsset).not.toHaveBeenCalled();
  });

  it("does not let Approve bypass a category that still needs a decision", async () => {
    await expect(
      applyNewImport({
        quantity: 1,
        type: "QUANTITY_TRACKED",
        useExistingCategory: false,
        newCategoryName: "Sensors",
        approveNewCategory: false,
      })
    ).resolves.toMatchObject({
      result: {
        status: "NEEDS_REVIEW",
        blockedRows: [
          {
            issues: expect.arrayContaining([
              expect.objectContaining({ code: "MISSING_CATEGORY" }),
            ]),
          },
        ],
      },
    });
    expect(mockCreateCategory).not.toHaveBeenCalled();
    expect(mockCreateAsset).not.toHaveBeenCalled();
  });

  it("does not let Approve bypass an ambiguous location", async () => {
    await expect(
      applyNewImport({
        quantity: 1,
        type: "QUANTITY_TRACKED",
        ambiguousLocation: true,
      })
    ).resolves.toMatchObject({
      result: {
        status: "NEEDS_REVIEW",
        blockedRows: [
          {
            issues: expect.arrayContaining([
              expect.objectContaining({ code: "MISSING_LOCATION" }),
            ]),
          },
        ],
      },
    });
    expect(mockCreateAsset).not.toHaveBeenCalled();
  });

  it("allows an explicit skip without creating inventory", async () => {
    const { result, assetRows } = await applyNewImport({
      quantity: 1,
      useExistingCategory: false,
      skipDecision: true,
    });

    expect((result as StaffImportResult).skippedRows).toBe(1);
    expect(assetRows).toHaveLength(0);
    expect(mockCreateAsset).not.toHaveBeenCalled();
  });

  it("requires tracking mode and persists reviewed quantity settings", async () => {
    await expect(
      applyNewImport({
        quantity: 1,
        type: "QUANTITY_TRACKED",
        decisionType: null,
      })
    ).resolves.toMatchObject({
      result: {
        status: "NEEDS_REVIEW",
        blockedRows: [
          {
            issues: expect.arrayContaining([
              expect.objectContaining({ code: "TRACKING_REVIEW_REQUIRED" }),
            ]),
          },
        ],
      },
    });

    const { assetRows } = await applyNewImport({
      quantity: 5,
      type: "QUANTITY_TRACKED",
      minQuantity: 2,
      unitOfMeasure: "boxes",
      consumptionType: "ONE_WAY",
    });
    expect(assetRows[0]).toMatchObject({
      quantity: 5,
      minQuantity: 2,
      unitOfMeasure: "boxes",
      consumptionType: "ONE_WAY",
    });
  });

  it("blocks a new individual-tracking proposal until staff confirms it", async () => {
    await expect(
      applyNewImport({
        quantity: 2,
        type: "INDIVIDUAL",
        trackingModeConfirmed: false,
      })
    ).resolves.toMatchObject({
      result: {
        status: "NEEDS_REVIEW",
        blockedRows: [
          {
            issues: expect.arrayContaining([
              expect.objectContaining({ code: "TRACKING_REVIEW_REQUIRED" }),
            ]),
          },
        ],
      },
    });
    expect(mockCreateAsset).not.toHaveBeenCalled();
  });

  it("allows a confirmed manual override from quantity to individual tracking", async () => {
    const { assetRows } = await applyNewImport({
      quantity: 2,
      type: "QUANTITY_TRACKED",
      reviewDecisionRows: [
        {
          rowNumber: 2,
          decision: "APPROVE",
          title: "Arduino Nano",
          assetId: null,
          categoryId: "category-electronics",
          locationId: null,
          quantity: 2,
          type: "INDIVIDUAL",
          trackingModeConfirmed: true,
          trackingModeSelectedByStaff: true,
          productChoice: "NEW",
        },
      ],
    });

    expect(assetRows).toHaveLength(2);
    expect(assetRows.every((asset) => asset.type === "INDIVIDUAL")).toBe(true);
  });

  it("blocks individual tracking unless staff selected it explicitly", async () => {
    const { result, assetRows } = await applyNewImport({
      quantity: 1,
      type: "INDIVIDUAL",
      reviewDecisionRows: [
        {
          rowNumber: 2,
          decision: "APPROVE",
          title: "Rigol DS1054Z Digital Oscilloscope",
          assetId: null,
          categoryId: "category-electronics",
          locationId: null,
          quantity: 1,
          type: "INDIVIDUAL",
          trackingModeConfirmed: true,
          trackingModeSelectedByStaff: false,
          productChoice: "NEW",
        },
      ],
    });

    expect(result).toMatchObject({
      status: "NEEDS_REVIEW",
      blockedRows: [
        {
          issues: expect.arrayContaining([
            expect.objectContaining({ code: "TRACKING_REVIEW_REQUIRED" }),
          ]),
        },
      ],
    });
    expect(assetRows).toHaveLength(0);
    expect(mockCreateAssetModel).not.toHaveBeenCalled();
  });

  it("normalizes a legacy source-individual proposal to quantity when staff keeps the default", async () => {
    const { assetRows } = await applyNewImport({
      quantity: 1,
      type: "INDIVIDUAL",
      reviewDecisionRows: [
        {
          rowNumber: 2,
          decision: "APPROVE",
          title: "Rigol DS1054Z Digital Oscilloscope",
          assetId: null,
          categoryId: "category-electronics",
          locationId: null,
          quantity: 1,
          type: "QUANTITY_TRACKED",
          trackingModeSelectedByStaff: false,
          productChoice: "NEW",
        },
      ],
    });

    expect(assetRows).toHaveLength(1);
    expect(assetRows[0]).toMatchObject({
      title: "Rigol DS1054Z Digital Oscilloscope",
      type: "QUANTITY_TRACKED",
      quantity: 1,
    });
    expect(mockCreateAssetModel).not.toHaveBeenCalled();
  });

  it("keeps a staff-selected individual mode on a legacy source-individual draft", async () => {
    const { assetRows } = await applyNewImport({
      quantity: 2,
      type: "INDIVIDUAL",
      reviewDecisionRows: [
        {
          rowNumber: 2,
          decision: "APPROVE",
          title: "Arduino Nano",
          assetId: null,
          categoryId: "category-electronics",
          locationId: null,
          quantity: 2,
          type: "INDIVIDUAL",
          trackingModeConfirmed: true,
          trackingModeSelectedByStaff: true,
          productChoice: "NEW",
        },
      ],
    });

    expect(assetRows).toHaveLength(2);
    expect(assetRows.every((asset) => asset.type === "INDIVIDUAL")).toBe(true);
  });

  it("rejects review attempts to change an existing model tracking mode", async () => {
    const proposalRow = {
      rowNumber: 2,
      title: "USB-C Cable",
      action: "NO_CHANGE" as const,
      assetId: "existing-cable",
      type: "QUANTITY_TRACKED" as const,
      trackingSource: "EXISTING_MODEL" as const,
      trackingReasonCode: "EXISTING_MODEL_QUANTITY" as const,
      trackingReason:
        "Uses this existing Shelf model’s quantity tracking mode.",
      quantity: 1,
      receivedQuantity: 1,
      quantityStatus: "RECEIVED" as const,
      category: "Electronics",
      categoryId: "category-electronics",
      location: null,
      locationId: null,
      currentQuantity: 1,
      currentCategoryId: "category-electronics",
      currentLocationId: null,
      reason: "Existing model",
      expectedAssetState: {
        assetId: "existing-cable",
        title: "USB-C Cable",
        type: "QUANTITY_TRACKED" as const,
        quantity: 1,
        categoryId: "category-electronics",
        locationIds: [],
        assetModelId: null,
      },
    };
    await expect(
      applyNewImport({
        quantity: 1,
        proposalRows: [proposalRow],
        reviewDecisionRows: [
          {
            rowNumber: 2,
            decision: "APPROVE",
            title: "USB-C Cable",
            assetId: "existing-cable",
            categoryId: "category-electronics",
            locationId: null,
            quantity: 1,
            type: "INDIVIDUAL",
            trackingModeConfirmed: true,
          },
        ],
      })
    ).resolves.toMatchObject({
      result: {
        status: "NEEDS_REVIEW",
        blockedRows: [
          {
            issues: expect.arrayContaining([
              expect.objectContaining({ code: "TRACKING_REVIEW_REQUIRED" }),
            ]),
          },
        ],
      },
    });
    expect(mockCreateAsset).not.toHaveBeenCalled();
  });

  it("rejects a client location ID outside the organization proposal options", async () => {
    await expect(
      applyNewImport({ quantity: 1, submittedLocationId: "foreign-location" })
    ).resolves.toMatchObject({
      result: {
        status: "NEEDS_REVIEW",
        blockedRows: [{ issues: [{ code: "INVALID_LOCATION" }] }],
      },
    });
    expect(mockCreateAsset).not.toHaveBeenCalled();
  });

  it("allows an explicit manual choice of a valid operational location", async () => {
    const { result, assetRows } = await applyNewImport({
      quantity: 1,
      type: "QUANTITY_TRACKED",
      selectedLocationId: "broken-zone",
    });

    expect((result as StaffImportResult).succeededRows).toBe(1);
    expect(assetRows[0].locationId).toBe("broken-zone");
  });

  it("creates five individual Assets with one model and distinct QR IDs", async () => {
    const { result, assetRows, ledgerRows, modelId } = await applyNewImport({
      quantity: 5,
      type: "INDIVIDUAL",
    });

    expect(
      ledgerRows
        .filter((item) => item.unitIndex !== null)
        .map((item) => [item.unitIndex, item.status])
    ).toEqual([
      [0, "DONE"],
      [1, "DONE"],
      [2, "DONE"],
      [3, "DONE"],
      [4, "DONE"],
    ]);
    expect(assetRows).toHaveLength(5);
    expect(assetRows.map((asset) => asset.title)).toEqual([
      "Arduino Nano #001",
      "Arduino Nano #002",
      "Arduino Nano #003",
      "Arduino Nano #004",
      "Arduino Nano #005",
    ]);
    expect(assetRows.every((asset) => asset.assetModelId === modelId)).toBe(
      true
    );
    expect(new Set(assetRows.map((asset) => asset.id)).size).toBe(5);
    expect(new Set(assetRows.map((asset) => asset.newQrId)).size).toBe(5);
    expect(ledgerRows.filter((item) => item.unitIndex !== null)).toHaveLength(
      5
    );
    expect(result).toMatchObject({
      totalRows: 5,
      succeededRows: 5,
      failedRowsCount: 0,
      conflictedRowsCount: 0,
    });
    expect(mockCreateAssetModel).toHaveBeenCalledTimes(1);
  });

  it("returns the stored successful result on a second apply without duplicate Assets", async () => {
    const { result, assetRows, operationId, proposalHash } =
      await applyNewImport({
        quantity: 5,
        type: "INDIVIDUAL",
      });
    const secondResult = await applyStaffInventoryImport({
      context: { getSession: () => ({ userId: "staff-1" }) } as never,
      request: new Request("http://localhost/staff/import"),
      operationId,
      proposalHash,
    });

    expect(secondResult).toEqual(result);
    expect(assetRows).toHaveLength(5);
    expect(mockCreateAsset).toHaveBeenCalledTimes(5);
    expect(mockCreateAssetModel).toHaveBeenCalledTimes(1);
  });

  it("rejects a proposal with unresolved rows even when Apply is called directly", async () => {
    await expect(
      applyNewImport({ quantity: 1, omitReviewDecisions: true })
    ).rejects.toThrow("Staff confirmation is required");
    expect(mockCreateAsset).not.toHaveBeenCalled();
  });

  it("rejects a stale proposal hash before any inventory write", async () => {
    await expect(
      applyNewImport({ quantity: 1, proposalHashOverride: "stale-hash" })
    ).rejects.toThrow("proposal changed after review");
    expect(mockCreateAsset).not.toHaveBeenCalled();
  });

  it("enforces the existing staff access gate on Apply", async () => {
    await expect(
      applyNewImport({ quantity: 1, denyStaffAccess: true })
    ).rejects.toThrow("Staff access denied");
    expect(mockCreateAsset).not.toHaveBeenCalled();
  });

  it("blocks an equivalent reviewed proposal already applying elsewhere", async () => {
    const { result, assetRows } = await applyNewImport({
      quantity: 1,
      raceWinner: { id: "operation-winner", status: "APPLYING" },
    });

    expect(result).toEqual({
      status: "IN_PROGRESS",
      operationId: "operation-winner",
    });
    expect(assetRows).toHaveLength(0);
    expect(mockCreateAsset).not.toHaveBeenCalled();
  });

  it("warns and blocks when the exact reviewed proposal already succeeded", async () => {
    const { result, assetRows } = await applyNewImport({
      quantity: 1,
      duplicateProposal: { id: "completed-import", status: "SUCCEEDED" },
    });

    expect(result).toMatchObject({
      status: "DUPLICATE",
      code: "SAME_PROPOSAL",
      canOverride: false,
    });
    expect(assetRows).toHaveLength(0);
    expect(mockCreateAsset).not.toHaveBeenCalled();
  });

  it("warns for the same PDF with changed decisions and requires an explicit override", async () => {
    const duplicateFile = {
      id: "prior-file-import",
      status: "SUCCEEDED",
      proposalSha256: "a-different-reviewed-proposal-hash",
    };
    const blocked = await applyNewImport({ quantity: 1, duplicateFile });
    expect(blocked.result).toMatchObject({
      status: "DUPLICATE",
      code: "SAME_FILE_DIFFERENT_PROPOSAL",
      canOverride: true,
    });
    expect(blocked.assetRows).toHaveLength(0);

    const explicitlyConfirmed = await applyNewImport({
      quantity: 1,
      duplicateFile,
      allowSameFileReimport: true,
    });
    expect(explicitlyConfirmed.result).toMatchObject({
      totalRows: 1,
      succeededRows: 1,
    });
    expect(explicitlyConfirmed.assetRows).toHaveLength(1);
  });

  it("does not treat a matching proposal hash in another organization as a duplicate", async () => {
    const { result, assetRows } = await applyNewImport({
      quantity: 1,
      duplicateProposal: {
        id: "other-org-import",
        status: "SUCCEEDED",
        organizationId: "org-2",
      },
    });

    expect(result).toMatchObject({ succeededRows: 1 });
    expect(assetRows).toHaveLength(1);
  });

  it.each(["quantity", "categoryId", "locationId"] as const)(
    "blocks a %s edit after review as CONFLICT without overwriting it",
    async (changedField) => {
      await expect(
        applyAfterConcurrentAssetEdit(changedField)
      ).resolves.toMatchObject({
        status: "NEEDS_REVIEW",
        blockedRows: [{ issues: [{ code: "CANONICAL_DATA_CHANGED" }] }],
      });
      expect(mockUpdateAsset).not.toHaveBeenCalled();
    }
  );

  it("resumes after three DONE units without recreating them", async () => {
    const {
      result: firstResult,
      assetRows,
      ledgerRows,
      operationId,
      operation,
      proposalHash,
    } = await applyNewImport({
      quantity: 5,
      type: "INDIVIDUAL",
      pauseAtUnitIndex: 3,
    });
    expect(firstResult).toEqual({ status: "IN_PROGRESS", operationId });
    expect(assetRows).toHaveLength(3);

    operation.updatedAt = new Date(Date.now() - 11 * 60 * 1000);
    const pausedUnit = ledgerRows.find((item) => item.unitIndex === 3)!;
    pausedUnit.updatedAt = new Date(Date.now() - 11 * 60 * 1000);
    const parentItem = ledgerRows.find((item) => item.unitIndex === null)!;
    parentItem.updatedAt = new Date(Date.now() - 11 * 60 * 1000);
    parentItem.heartbeatAt = new Date(Date.now() - 11 * 60 * 1000);
    const firstThreeIds = ledgerRows
      .filter((item) => item.unitIndex !== null && item.unitIndex < 3)
      .map((item) => item.targetAssetId);

    const resumedResult = await applyStaffInventoryImport({
      context: { getSession: () => ({ userId: "staff-1" }) } as never,
      request: new Request("http://localhost/staff/import"),
      operationId,
      proposalHash,
    });

    expect(
      ledgerRows
        .filter((item) => item.unitIndex !== null)
        .map((item) => [item.unitIndex, item.status])
    ).toEqual([
      [0, "DONE"],
      [1, "DONE"],
      [2, "DONE"],
      [3, "DONE"],
      [4, "DONE"],
    ]);
    expect(assetRows).toHaveLength(5);
    expect(resumedResult).toMatchObject({ totalRows: 5, succeededRows: 5 });
    expect(new Set(assetRows.map((asset) => asset.id)).size).toBe(5);
    expect(
      assetRows.filter((asset) => firstThreeIds.includes(asset.id))
    ).toHaveLength(3);
    expect(mockCreateAsset).toHaveBeenCalledTimes(5);
    expect(resumedResult).toMatchObject({
      totalRows: 5,
      succeededRows: 5,
      failedRowsCount: 0,
      conflictedRowsCount: 0,
    });
  });

  it("uses a deterministic alternative when an individual unit title already exists", async () => {
    const { assetRows } = await applyNewImport({
      quantity: 2,
      type: "INDIVIDUAL",
      existingAssets: [{ id: "existing-asset", title: "Arduino Nano #001" }],
    });

    expect(assetRows.map((asset) => asset.title)).toEqual([
      expect.stringMatching(/^Arduino Nano #001 \(import .*\)$/),
      "Arduino Nano #002",
    ]);
  });

  it("preserves quantity-tracked quantity semantics without creating individual units", async () => {
    const { result, assetRows, ledgerRows, modelId } = await applyNewImport({
      quantity: 5,
      type: "QUANTITY_TRACKED",
    });

    expect(assetRows).toHaveLength(1);
    expect(assetRows[0]).toMatchObject({
      type: "QUANTITY_TRACKED",
      quantity: 5,
    });
    expect(mockCreateAssetModel).not.toHaveBeenCalled();
    expect(assetRows[0]).not.toHaveProperty("assetModelId");
    expect(ledgerRows.filter((item) => item.unitIndex !== null)).toHaveLength(
      0
    );
    expect(modelId).toBeNull();
    expect(mockCreateAssetModel).not.toHaveBeenCalled();
    expect(result).toMatchObject({ totalRows: 1, succeededRows: 1 });
  });

  it("stores an accepted image through Shelf image service during Apply", async () => {
    const imageDataBase64 = Buffer.from(
      "RIFF\u0004\u0000\u0000\u0000WEBP"
    ).toString("base64");
    const { assetRows, modelId } = await applyNewImport({
      quantity: 1,
      type: "INDIVIDUAL",
      assetModelDescription:
        "A compact microcontroller board for electronics prototyping.",
      productImageProposal: {
        status: "IMAGE_FOUND",
        mimeType: "image/webp",
        dataBase64: imageDataBase64,
        sourceName: "Arduino Nano image",
        sourceUrl: "https://openverse.org/image/1",
        license: "cc0",
      },
      acceptSuggestedImage: true,
    });

    expect(assetRows[0].assetModelId).toBe(modelId);
    expect(mockUpdateAssetMainImage).not.toHaveBeenCalled();
    expect(mockUpdateAssetModelImage).toHaveBeenCalledWith(
      expect.objectContaining({
        assetModelId: modelId,
        organizationId: "org-1",
        onlyIfMissing: true,
        request: expect.any(Request),
      })
    );
    const formData =
      await mockUpdateAssetModelImage.mock.calls[0][0].request.formData();
    expect(formData.get("image")).toMatchObject({
      type: "image/webp",
      name: "product-image.webp",
    });
  });

  it("enriches quantity-tracked inventory without attaching an AssetModel", async () => {
    const imageDataBase64 = Buffer.from(
      "RIFF\u0004\u0000\u0000\u0000WEBP"
    ).toString("base64");
    const { assetRows, modelId } = await applyNewImport({
      quantity: 5,
      type: "QUANTITY_TRACKED",
      assetModelDescription:
        "A compact microcontroller board for electronics prototyping.",
      productImageProposal: {
        status: "IMAGE_FOUND",
        mimeType: "image/webp",
        dataBase64: imageDataBase64,
      },
      acceptSuggestedImage: true,
    });

    expect(assetRows[0]).toMatchObject({
      type: "QUANTITY_TRACKED",
      quantity: 5,
      description:
        "A compact microcontroller board for electronics prototyping.",
    });
    expect(assetRows[0]).not.toHaveProperty("assetModelId");
    expect(modelId).toBeNull();
    expect(mockCreateAssetModel).not.toHaveBeenCalled();
    expect(mockUpdateAssetModelImage).not.toHaveBeenCalled();
    expect(mockUpdateAssetMainImage).toHaveBeenCalledWith(
      expect.objectContaining({
        assetId: assetRows[0].id,
        userId: "staff-1",
        organizationId: "org-1",
        isNewAsset: true,
        maxProcessedBytes: 2 * 1024 * 1024,
        request: expect.any(Request),
      })
    );
    const imageForm =
      await mockUpdateAssetMainImage.mock.calls[0][0].request.formData();
    expect(imageForm.get("mainImage")).toMatchObject({
      type: "image/webp",
      name: "product-image.webp",
    });
    expect(imageForm.get("image")).toBeNull();
  });

  it("does not upload a suggested image when staff leaves it unchecked", async () => {
    await applyNewImport({
      quantity: 1,
      type: "INDIVIDUAL",
      assetModelDescription: "A compact microcontroller board.",
      productImageProposal: {
        status: "IMAGE_FOUND",
        mimeType: "image/webp",
        dataBase64: Buffer.from("RIFF\u0004\u0000\u0000\u0000WEBP").toString(
          "base64"
        ),
      },
      acceptSuggestedImage: false,
    });
    expect(mockUpdateAssetModelImage).not.toHaveBeenCalled();
  });

  it("enforces named individual-unit limits without affecting quantity-tracked rows", () => {
    const individualRow = {
      rowNumber: 2,
      title: "Arduino Nano",
      action: "CREATE",
      assetId: null,
      type: "INDIVIDUAL",
      quantity: 101,
      receivedQuantity: 101,
      quantityStatus: "RECEIVED",
    };
    const quantityTrackedRow = {
      ...individualRow,
      type: "QUANTITY_TRACKED",
      quantity: 5000,
      receivedQuantity: 5000,
    };

    expect(
      getIndividualUnitImportLimitError([individualRow] as never)
    ).toContain("100 individual units");
    expect(
      getIndividualUnitImportLimitError(
        Array.from({ length: 6 }, (_, index) => ({
          ...individualRow,
          rowNumber: index + 2,
          quantity: 100,
          receivedQuantity: 100,
        })) as never
      )
    ).toContain("500 individual units");
    expect(
      getIndividualUnitImportLimitError([quantityTrackedRow] as never)
    ).toBeNull();
  });

  it("parses the supported safe columns and preserves row numbers", async () => {
    const rows = await parseStaffImportFile({
      filename: "inventory.csv",
      contentType: "text/csv",
      buffer: Buffer.from(
        "Name,Quantity,Category,Location\nArduino Nano,8,Boards,B477\n"
      ),
    });

    expect(rows).toMatchObject([
      {
        rowNumber: 2,
        title: "Arduino Nano",
        quantity: 8,
        category: "Boards",
        location: "B477",
        type: null,
      },
    ]);
  });

  it.each(["Qty", "Quantity", "Quantity on hand", "Stock qty", "Antal"])(
    "normalizes the %s spreadsheet quantity header and whitespace",
    async (quantityHeader) => {
      const rows = await parseStaffImportFile({
        filename: "inventory.csv",
        buffer: Buffer.from(`Product,${quantityHeader}\nUSB-C Cable, 5 \n`),
      });

      expect(rows[0]).toMatchObject({
        title: "USB-C Cable",
        quantity: 5,
        quantityStatus: "RECEIVED",
      });
    }
  );

  it("rejects personal borrower columns before proposal creation", async () => {
    await expect(
      parseStaffImportFile({
        filename: "inventory.csv",
        buffer: Buffer.from(
          "Name,Borrower email\nArduino Nano,person@example.com\n"
        ),
      })
    ).rejects.toThrow("Personal borrower or account columns are not accepted.");
  });

  it("reads the first worksheet of an XLSX as values", async () => {
    const workbook = new JSZip();
    workbook.file(
      "xl/workbook.xml",
      '<workbook><sheets><sheet name="Inventory" r:id="rId1" /></sheets></workbook>'
    );
    workbook.file(
      "xl/_rels/workbook.xml.rels",
      '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml" /></Relationships>'
    );
    workbook.file(
      "xl/worksheets/sheet1.xml",
      '<worksheet><sheetData><row><c r="A1" t="inlineStr"><is><t>Name</t></is></c><c r="B1" t="inlineStr"><is><t>Quantity</t></is></c></row><row><c r="A2" t="inlineStr"><is><t>Arduino Nano</t></is></c><c r="B2"><v>8</v></c></row></sheetData></worksheet>'
    );
    const buffer = await workbook.generateAsync({ type: "nodebuffer" });
    const rows = await parseStaffImportFile({
      filename: "inventory.xlsx",
      contentType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer,
    });

    expect(rows[0]).toMatchObject({ title: "Arduino Nano", quantity: 8 });
  });

  it("keeps procurement fields while ignoring price and invoice columns", async () => {
    const rows = await parseStaffImportFile({
      filename: "mouser-order.csv",
      contentType: "text/csv",
      buffer: Buffer.from(
        "Product Description,Manufacturer,MPN,Quantity Ordered,Quantity Shipped,Unit Price,Invoice Number\nArduino ABX00028 Nano Every,Arduino,ABX00028,5,4,25.00,INV-42\n"
      ),
    });

    expect(rows[0]).toMatchObject({
      title: "Arduino ABX00028 Nano Every",
      sourceDescription: "Arduino ABX00028 Nano Every",
      manufacturer: "Arduino",
      manufacturerPartNumber: "ABX00028",
      orderedQuantity: 5,
      receivedQuantity: 4,
      quantityStatus: "RECEIVED",
    });
    expect(rows[0]).not.toHaveProperty("price");
    expect(rows[0]).not.toHaveProperty("invoiceNumber");
  });

  it("extracts delimited PDF text into a review-required proposal row", async () => {
    const pdf = Buffer.from(
      `%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nstream\n(Name|Quantity|Category|Location) Tj\n(Arduino Nano|8|Boards|B477) Tj\nendstream\nendobj\n%%EOF`,
      "latin1"
    );
    const rows = await parseStaffImportFile({
      filename: "inventory.pdf",
      contentType: "application/pdf",
      buffer: pdf,
    });

    expect(rows[0]).toMatchObject({
      title: "Arduino Nano",
      quantity: 8,
      category: "Boards",
      location: "B477",
      reviewRequired: true,
    });
  });

  it("sends readable unknown-supplier invoices to generic Claude with page context", async () => {
    preparePdfImportMocks("operation-generic-invoice");
    const pageText =
      "Acme Components Invoice\nUSB-C Cable, SKU CB-120, shipped quantity 4";
    mockRequestImportHelperProposal.mockResolvedValue(
      makeGenericHelperReadyResult({
        pageText,
        items: [
          {
            productName: "USB-C Cable",
            quantity: 4,
            evidenceText: "USB-C Cable, SKU CB-120, shipped quantity 4",
            trackingSuggestion: "INDIVIDUAL",
          },
        ],
      })
    );
    mockGetCategories.mockResolvedValue([
      {
        id: "cat-cables",
        name: "Cables & adapters",
        description: "Cables, connectors, and adapters",
        color: "#2878b8",
      },
    ]);
    database.location.count.mockResolvedValue(2);
    database.location.findMany.mockResolvedValue([
      {
        id: "location-lab",
        name: "Lab",
        parentId: null,
        description: null,
        color: null,
      },
      {
        id: "location-cable-drawer",
        name: "USB Cable Drawer",
        parentId: "location-lab",
        description: "Cable and connector storage",
        color: null,
      },
    ]);
    database.asset.findMany.mockResolvedValue(
      Array.from({ length: 3 }, (_, index) => ({
        id: `existing-cable-${index}`,
        title: `Existing cable ${index}`,
        type: "QUANTITY_TRACKED",
        quantity: 1,
        description: null,
        categoryId: "cat-cables",
        assetModelId: null,
        assetLocations: [
          {
            locationId: "location-cable-drawer",
            quantity: 1,
            assetKitId: null,
          },
        ],
      }))
    );
    // why: capture privacy-safe extraction and routing diagnostics without
    // emitting test log output.
    const loggerInfo = vi.spyOn(Logger, "info").mockImplementation(() => {});

    const prepared = await prepareStaffInventoryImport({
      context: { getSession: () => ({ userId: "staff-1" }) } as never,
      request: new Request("http://localhost/staff/import"),
      file: new File(
        [makePdfFromPages([{ text: pageText }])],
        "acme-invoice.pdf",
        { type: "application/pdf" }
      ),
    });

    expect(prepared.status).toBe("PREPARED");
    if (prepared.status !== "PREPARED") throw new Error("Expected proposal");
    expect(prepared.proposal.rows).toHaveLength(1);
    expect(prepared.proposal.rows[0]).toMatchObject({
      title: "USB-C Cable",
      quantity: 4,
      type: "QUANTITY_TRACKED",
      trackingSource: "DETERMINISTIC_DEFAULT",
    });
    expect(mockRequestImportHelperProposal).toHaveBeenCalledTimes(1);
    const [helperRequest] = mockRequestImportHelperProposal.mock.calls[0];
    expect(helperRequest.activeCategories).toEqual([
      expect.objectContaining({ id: "cat-cables", name: "Cables & adapters" }),
    ]);
    expect(helperRequest.relevantLocations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "location-cable-drawer",
          pathLabel: "Lab · USB Cable Drawer",
          occupancy: expect.objectContaining({
            context: expect.stringContaining("Cables & adapters: 3 assets"),
          }),
        }),
      ])
    );
    expect(prepared.proposal.rows[0]).toMatchObject({
      categoryId: "cat-cables",
      locationId: "location-cable-drawer",
    });
    expect(helperRequest.document.pages).toEqual([
      { sourceRef: "pdf-page-1", page: 1, text: pageText },
    ]);
    expect(loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "ioio_staff_import_generic_suggestion_resolution",
        categoryCandidateCount: 1,
        categoryCandidates: [
          {
            id: "cat-cables",
            name: "Cables & adapters",
            hierarchyDepth: 0,
            descriptionPresent: true,
          },
        ],
        locationCandidateCount: 2,
        locationCandidates: expect.arrayContaining([
          expect.objectContaining({
            id: "location-cable-drawer",
            name: "USB Cable Drawer",
            pathDepth: 2,
            descriptionPresent: true,
            assignable: true,
          }),
        ]),
      })
    );
    expect(loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "ioio_staff_import_pdf_text_extracted",
        pageCount: 1,
        extractedCharsPerPage: [pageText.length],
        totalExtractedChars: pageText.length,
        meaningfulText: true,
        selectedExtractor: "primary",
        extractorAttempts: [
          expect.objectContaining({
            extractor: "primary",
            meaningfulText: true,
            status: "readable",
          }),
        ],
        detectedVendorParser: null,
      })
    );
    expect(loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "ioio_staff_import_pdf_analysis_selected",
        detectedVendorParser: null,
        genericClaudeFallbackInvoked: true,
        genericClaudeResult: "line-items-found",
      })
    );
  });

  it("searches from text-only PDF invoice identity and applies the proposed image", async () => {
    preparePdfImportMocks("operation-pdf-product-image-search");
    const pageText = [
      "Seeed Studio supplier invoice",
      "XIAO ESP32-S3 Sense | 113991115 | Shipped quantity 5",
    ].join("\n");
    mockRequestImportHelperProposal.mockResolvedValue(
      makeGenericHelperReadyResult({
        pageText,
        items: [
          {
            productName: "XIAO ESP32-S3 Sense",
            manufacturer: "Seeed Studio",
            mpn: "113991115",
            supplierProductNumber: "SUP-113991115",
            quantity: 5,
            evidenceText:
              "XIAO ESP32-S3 Sense | 113991115 | Shipped quantity 5",
            description: "XIAO ESP32-S3 Sense compact camera development board",
          },
        ],
      })
    );
    const actualProductEnrichment = (await vi.importActual(
      "./product-enrichment.server"
    )) as {
      enrichImportProductRows: (
        rows: ImportProductEnrichmentRow[],
        models: ExistingImportAssetModel[],
        getKey:
          | ((row: ImportProductEnrichmentRow) => string | undefined)
          | undefined,
        provider: ProductSearchProvider
      ) => Promise<{
        rows: ImportProductEnrichmentRow[];
        diagnostics: object;
      }>;
    };
    const imageBytes = await sharp({
      create: {
        width: 320,
        height: 240,
        channels: 3,
        background: { r: 48, g: 110, b: 172 },
      },
    })
      .png()
      .toBuffer();
    const productPageUrl =
      "https://www.seeedstudio.com/xiao-esp32-s3-sense.html";
    const imageUrl = "https://media.seeedstudio.com/xiao-esp32-s3-sense.png";
    const productPage = Buffer.from(
      `<script type="application/ld+json">${JSON.stringify({
        "@type": "Product",
        name: "XIAO ESP32-S3 Sense",
        brand: { "@type": "Brand", name: "Seeed Studio" },
        mpn: "113991115",
        image: imageUrl,
      })}</script>`
    );
    // why: product search is an external provider; keep its invoice query and
    // result deterministic while the actual PDF/enrichment/Apply code runs.
    const searchMock = vi.fn((query: string) =>
      query === "Seeed Studio 113991115"
        ? Promise.resolve([
            {
              productPageUrl,
              title: "Seeed Studio XIAO ESP32-S3 Sense",
              description: "Manufacturer product page, MPN 113991115",
              sourceDomain: "www.seeedstudio.com",
            },
          ])
        : Promise.resolve([])
    );
    const provider: ProductSearchProvider = { search: searchMock };
    // why: product page and image hosts are untrusted network dependencies;
    // mocked Responses keep this full PDF-to-Apply path offline and bounded.
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((input) => {
        const url = String(input);
        if (url === productPageUrl) {
          return Promise.resolve(
            new Response(productPage, {
              headers: { "content-type": "text/html; charset=utf-8" },
            })
          );
        }
        if (url === imageUrl) {
          return Promise.resolve(
            new Response(imageBytes, {
              headers: { "content-type": "image/png" },
            })
          );
        }
        throw new Error("Unexpected outbound URL");
      });
    mockEnrichImportProductRows.mockImplementationOnce(
      async (
        rows: ImportProductEnrichmentRow[],
        models: ExistingImportAssetModel[],
        getKey:
          | ((row: ImportProductEnrichmentRow) => string | undefined)
          | undefined
      ) =>
        actualProductEnrichment.enrichImportProductRows(
          rows,
          models,
          getKey,
          provider
        )
    );

    const prepared = await prepareStaffInventoryImport({
      context: { getSession: () => ({ userId: "staff-1" }) } as never,
      request: new Request("http://localhost/staff/import"),
      file: new File([makePdfFromPages([{ text: pageText }])], "seeed.pdf", {
        type: "application/pdf",
      }),
    });

    expect(prepared.status).toBe("PREPARED");
    if (prepared.status !== "PREPARED") throw new Error("Expected proposal");
    const proposedRow = prepared.proposal.rows[0];
    expect(proposedRow).toMatchObject({
      title: "XIAO ESP32-S3 Sense",
      manufacturer: "Seeed Studio",
      manufacturerPartNumber: "113991115",
      supplierPartNumber: "SUP-113991115",
      quantity: 5,
      productImageProposal: {
        status: "IMAGE_FOUND",
        source: "MANUFACTURER",
        identityEvidence: "EXACT_MPN",
        autoAccepted: true,
      },
    });
    expect(proposedRow.productUrl).toBeUndefined();
    expect(proposedRow.productImageUrl).toBeUndefined();
    expect(searchMock).toHaveBeenCalledWith("Seeed Studio 113991115", 5);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(proposedRow.productImageProposal?.imageId).toMatch(/^ioio-import-/);
    expect(proposedRow.productImageProposal?.dataBase64).toBeUndefined();
    expect(
      previewImages.get(proposedRow.productImageProposal?.imageId ?? "")!.blob
        .byteLength
    ).toBeLessThanOrEqual(2 * 1024 * 1024);

    const { result } = await applyNewImport({
      quantity: 5,
      type: "QUANTITY_TRACKED",
      assetModelDescription: proposedRow.assetModelDescription,
      productImageProposal: {
        status: "IMAGE_FOUND",
        mimeType: "image/webp",
        imageId: proposedRow.productImageProposal?.imageId,
        sourceName: proposedRow.productImageProposal?.sourceName,
        sourceUrl: proposedRow.productImageProposal?.sourceUrl,
      },
      acceptSuggestedImage: true,
    });

    expect(result.succeededRows).toBe(1);
    expect(mockUpdateAssetMainImage).toHaveBeenCalledTimes(1);
    expect(mockCreateAssetModel).not.toHaveBeenCalled();
  });

  it("uses generic Claude for a readable text-based purchase list", async () => {
    preparePdfImportMocks("operation-generic-purchase-list");
    const pageText =
      "Workshop purchase list\nUSB-C cables x4\nAA rechargeable batteries x8";
    mockRequestImportHelperProposal.mockResolvedValue(
      makeGenericHelperReadyResult({
        pageText,
        items: [
          {
            productName: "USB-C cables",
            quantity: 4,
            evidenceText: "USB-C cables x4",
          },
          {
            productName: "AA rechargeable batteries",
            quantity: 8,
            evidenceText: "AA rechargeable batteries x8",
          },
        ],
      })
    );

    const prepared = await prepareStaffInventoryImport({
      context: { getSession: () => ({ userId: "staff-1" }) } as never,
      request: new Request("http://localhost/staff/import"),
      file: new File(
        [makePdfFromPages([{ text: pageText }])],
        "workshop-purchase-list.pdf",
        { type: "application/pdf" }
      ),
    });

    expect(prepared.status).toBe("PREPARED");
    if (prepared.status !== "PREPARED") throw new Error("Expected proposal");
    expect(prepared.proposal.rows.map((row) => row.title)).toEqual([
      "USB-C cables",
      "AA rechargeable batteries",
    ]);
    expect(mockRequestImportHelperProposal).toHaveBeenCalledTimes(1);
    expect(mockOcrPdfPages).not.toHaveBeenCalled();
    expect(
      prepared.status === "PREPARED" && prepared.proposal.diagnostics
    ).toMatchObject({
      rowsParsed: 2,
      rowsWithQuantity: 2,
      quantityNeedsReview: 0,
      rowsWithSuggestedLocation: 0,
      locationUnresolved: 2,
    });
  });

  it("does not keep a tentative helper quantity when the quantity status is unknown", async () => {
    preparePdfImportMocks("operation-ambiguous-quantity");
    const text =
      "Supplier invoice\nUSB-C cable, qty could be ordered or shipped";
    mockRequestImportHelperProposal.mockResolvedValue(
      makeGenericHelperReadyResult({
        pageText: text,
        items: [
          {
            productName: "USB-C cable",
            quantity: 1,
            quantityStatus: "UNKNOWN",
            evidenceText: "USB-C cable, qty could be ordered or shipped",
          },
        ],
      })
    );

    const prepared = await prepareStaffInventoryImport({
      context: { getSession: () => ({ userId: "staff-1" }) } as never,
      request: new Request("http://localhost/staff/import"),
      file: new File([makePdfFromPages([{ text }])], "ambiguous.pdf", {
        type: "application/pdf",
      }),
    });

    expect(prepared.status).toBe("PREPARED");
    if (prepared.status !== "PREPARED") throw new Error("Expected proposal");
    expect(prepared.proposal.rows[0]).toMatchObject({
      quantity: null,
      quantityStatus: "UNKNOWN",
      action: "NEEDS_REVIEW",
      diagnosticReasonCodes: expect.arrayContaining(["QUANTITY_AMBIGUOUS"]),
    });
    expect(prepared.proposal.diagnostics).toMatchObject({
      rowsParsed: 1,
      rowsWithQuantity: 0,
      quantityNeedsReview: 1,
    });
  });

  it("uses PDF.js ToUnicode mappings and positioned items before generic Claude", async () => {
    preparePdfImportMocks("operation-pdfjs-fallback");
    const expectedPageText = "ACME WIDGET";
    mockRequestImportHelperProposal.mockResolvedValue(
      makeGenericHelperReadyResult({
        pageText: expectedPageText,
        items: [
          {
            productName: "Acme widget",
            quantity: 1,
            evidenceText: expectedPageText,
          },
        ],
      })
    );
    // why: capture per-extractor diagnostics while keeping the real PDF.js
    // implementation and semantic helper routing in the test.
    const loggerInfo = vi.spyOn(Logger, "info").mockImplementation(() => {});

    const prepared = await prepareStaffInventoryImport({
      context: { getSession: () => ({ userId: "staff-1" }) } as never,
      request: new Request("http://localhost/staff/import"),
      file: new File([makeToUnicodePdf(expectedPageText)], "acme.pdf", {
        type: "application/pdf",
      }),
    });

    expect(prepared.status).toBe("PREPARED");
    expect(mockRequestImportHelperProposal).toHaveBeenCalledTimes(1);
    expect(mockOcrPdfPages).not.toHaveBeenCalled();
    const [helperRequest] = mockRequestImportHelperProposal.mock.calls[0];
    expect(helperRequest.document.pages).toEqual([
      { sourceRef: "pdf-page-1", page: 1, text: expectedPageText },
    ]);
    expect(loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "ioio_staff_import_pdf_text_extracted",
        pageCount: 1,
        extractedCharsPerPage: [expectedPageText.length],
        totalExtractedChars: expectedPageText.length,
        meaningfulText: true,
        selectedExtractor: "pdfjs",
        extractorAttempts: [
          expect.objectContaining({
            extractor: "primary",
            meaningfulText: false,
            status: "empty",
          }),
          expect.objectContaining({
            extractor: "pdfjs",
            meaningfulText: true,
            status: "readable",
          }),
        ],
        detectedVendorParser: null,
      })
    );
    expect(loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "ioio_staff_import_pdf_analysis_selected",
        genericClaudeFallbackInvoked: true,
      })
    );
  });

  it("routes OCR-recovered unknown-supplier text to generic Claude", async () => {
    preparePdfImportMocks("operation-ocr-generic");
    const recoveredText =
      "Nordic Parts invoice\nUSB-C cable, supplier SKU NP-44, delivered 4";
    mockOcrPdfPages.mockResolvedValueOnce({
      pages: [{ sourceRef: "pdf-page-1", page: 1, text: recoveredText }],
      pageCount: 1,
      ocrPagesAttempted: 1,
      ocrPagesSuccessful: 1,
    });
    mockRequestImportHelperProposal.mockResolvedValue(
      makeGenericHelperReadyResult({
        pageText: recoveredText,
        items: [
          {
            productName: "USB-C cable",
            quantity: 4,
            evidenceText: "USB-C cable, supplier SKU NP-44, delivered 4",
          },
        ],
      })
    );
    const loggerInfo = vi.spyOn(Logger, "info").mockImplementation(() => {});

    const prepared = await prepareStaffInventoryImport({
      context: { getSession: () => ({ userId: "staff-1" }) } as never,
      request: new Request("http://localhost/staff/import"),
      file: new File([makeImageOnlyPdf()], "nordic-parts.pdf", {
        type: "application/pdf",
      }),
    });

    expect(prepared.status).toBe("PREPARED");
    if (prepared.status !== "PREPARED") throw new Error("Expected proposal");
    expect(prepared.proposal.rows[0]).toMatchObject({
      quantity: 4,
      receivedQuantity: 4,
      quantityStatus: "RECEIVED",
      diagnosticReasonCodes: expect.arrayContaining(["QUANTITY_EXTRACTED"]),
    });
    expect(mockOcrPdfPages).toHaveBeenCalledTimes(1);
    const [helperRequest] = mockRequestImportHelperProposal.mock.calls[0];
    expect(helperRequest.document.pages).toEqual([
      { sourceRef: "pdf-page-1", page: 1, text: recoveredText },
    ]);
    expect(loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "ioio_staff_import_pdf_text_extracted",
        selectedExtractor: "ocr",
        extractedCharsPerPage: [recoveredText.length],
        ocrPagesAttempted: 1,
        ocrPagesSuccessful: 1,
        extractorAttempts: [
          expect.objectContaining({ extractor: "primary", status: "empty" }),
          expect.objectContaining({ extractor: "pdfjs", status: "empty" }),
          expect.objectContaining({ extractor: "ocr", status: "readable" }),
        ],
      })
    );
    expect(loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "ioio_staff_import_pdf_analysis_selected",
        genericClaudeFallbackInvoked: true,
      })
    );
  });

  it("preserves Mouser parsing for OCR-recovered invoice pages", async () => {
    preparePdfImportMocks("operation-ocr-mouser");
    mockOcrPdfPages.mockResolvedValueOnce({
      pages: [
        {
          sourceRef: "pdf-page-1",
          page: 1,
          text: MOUSER_FRAGMENTED_PAGE_TEXT,
        },
      ],
      pageCount: 1,
      ocrPagesAttempted: 1,
      ocrPagesSuccessful: 1,
    });
    mockRequestImportHelperProposal.mockResolvedValue({
      status: "manual",
      reason: "helper_not_configured",
    });
    const loggerInfo = vi.spyOn(Logger, "info").mockImplementation(() => {});

    const prepared = await prepareStaffInventoryImport({
      context: { getSession: () => ({ userId: "staff-1" }) } as never,
      request: new Request("http://localhost/staff/import"),
      file: new File([makeImageOnlyPdf()], "mouser-invoice.pdf", {
        type: "application/pdf",
      }),
    });

    expect(prepared.status).toBe("PREPARED");
    if (prepared.status !== "PREPARED") throw new Error("Expected proposal");
    expect(prepared.proposal.rows).toHaveLength(2);
    expect(prepared.proposal.rows.map((row) => row.supplierPartNumber)).toEqual(
      ["713-114993388", "713-101010001"]
    );
    expect(mockRequestImportHelperProposal).toHaveBeenCalledTimes(1);
    expect(loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "ioio_staff_import_pdf_analysis_selected",
        detectedVendorParser: "mouser",
        genericClaudeFallbackInvoked: false,
        mouserEnrichmentInvoked: true,
      })
    );
  });

  it("returns a readable-text recovery error when OCR yields no useful text", async () => {
    mockOcrPdfPages.mockResolvedValueOnce({
      pages: [{ sourceRef: "pdf-page-1", page: 1, text: "***" }],
      pageCount: 1,
      ocrPagesAttempted: 1,
      ocrPagesSuccessful: 0,
    });
    const loggerInfo = vi.spyOn(Logger, "info").mockImplementation(() => {});

    await expect(
      parseStaffImportFile({
        filename: "unreadable-scan.pdf",
        contentType: "application/pdf",
        buffer: makeImageOnlyPdf(),
      })
    ).rejects.toThrow("Readable text could not be recovered from this PDF.");
    expect(mockOcrPdfPages).toHaveBeenCalledTimes(1);
    expect(loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "ioio_staff_import_pdf_text_extracted",
        classification: "ocr-no-readable-text",
        selectedExtractor: null,
        ocrPagesAttempted: 1,
        ocrPagesSuccessful: 0,
      })
    );
  });

  it("returns a concise unresolved result when Claude finds no inventory items", async () => {
    preparePdfImportMocks("operation-generic-unresolved");
    const pageText =
      "Supplier terms and conditions, delivery policy, and address";
    mockRequestImportHelperProposal.mockResolvedValue(
      makeGenericHelperReadyResult({ pageText, items: [] })
    );
    // why: inspect the safe route diagnostic without outputting document text.
    const loggerInfo = vi.spyOn(Logger, "info").mockImplementation(() => {});

    await expect(
      prepareStaffInventoryImport({
        context: { getSession: () => ({ userId: "staff-1" }) } as never,
        request: new Request("http://localhost/staff/import"),
        file: new File(
          [makePdfFromPages([{ text: pageText }])],
          "supplier-terms.pdf",
          { type: "application/pdf" }
        ),
      })
    ).rejects.toThrow(
      "Claude could not confidently identify product line items in this document."
    );

    expect(mockRequestImportHelperProposal).toHaveBeenCalledTimes(1);
    expect(loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "ioio_staff_import_pdf_analysis_selected",
        meaningfulText: true,
        genericClaudeFallbackInvoked: true,
        genericClaudeResult: "no-line-items",
      })
    );
  });

  it("asks for AI analysis when readable unknown-format text has no safe helper or table result", async () => {
    preparePdfImportMocks("operation-generic-unavailable");
    const pageText = "Northstar invoice\nItem K-42\nUSB adapter\n4\n21,50";
    mockRequestImportHelperProposal.mockResolvedValue({
      status: "manual",
      reason: "helper_busy_503",
    });
    // why: inspect route diagnostics while keeping test logs free of document text.
    const loggerInfo = vi.spyOn(Logger, "info").mockImplementation(() => {});

    await expect(
      prepareStaffInventoryImport({
        context: { getSession: () => ({ userId: "staff-1" }) } as never,
        request: new Request("http://localhost/staff/import"),
        file: new File(
          [makePdfFromPages([{ text: pageText }])],
          "northstar-invoice.pdf",
          { type: "application/pdf" }
        ),
      })
    ).rejects.toThrow(
      "This PDF contains readable text, but AI-assisted document analysis is required to identify product line items."
    );

    expect(loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "ioio_staff_import_pdf_analysis_selected",
        meaningfulText: true,
        detectedVendorParser: null,
        genericClaudeFallbackInvoked: true,
        genericClaudeResult: "helper_busy_503",
      })
    );
  });

  it("never turns fragmented readable generic PDF text into direct inventory rows", async () => {
    preparePdfImportMocks("operation-generic-fragments");
    const fragments = Array.from(
      { length: 400 },
      (_, index) =>
        ["713-1", "T", "illv", ". Artikelnr: 1", "260,76", "Continued"][
          index % 6
        ]
    );
    const pageText = ["Acme invoice", ...fragments].join("\n");
    mockRequestImportHelperProposal.mockResolvedValue({
      status: "manual",
      reason: "helper_not_configured",
    });

    await expect(
      prepareStaffInventoryImport({
        context: { getSession: () => ({ userId: "staff-1" }) } as never,
        request: new Request("http://localhost/staff/import"),
        file: new File(
          [makePdfFromPages([{ text: pageText }])],
          "fragmented-invoice.pdf",
          { type: "application/pdf" }
        ),
      })
    ).rejects.toThrow(
      "This PDF contains readable text, but AI-assisted document analysis is required to identify product line items."
    );

    const [helperRequest] = mockRequestImportHelperProposal.mock.calls[0];
    expect(helperRequest.document.pages).toHaveLength(1);
    expect(helperRequest.document.pages[0].text).toContain(". Artikelnr: 1");
    expect(database.ioioWriteOperation.create).not.toHaveBeenCalled();
    expect(database.ioioImportItem.createMany).not.toHaveBeenCalled();
  });

  it("extracts readable hexadecimal PDF text without classifying it as scanned", async () => {
    await expect(
      parseStaffImportFile({
        filename: "hex-text.pdf",
        contentType: "application/pdf",
        buffer: makeHexTextPdf("Purchase list for USB adapters"),
      })
    ).rejects.toThrow(
      "This PDF contains readable text, but AI-assisted document analysis is required to identify product line items."
    );
  });

  it("does not label an unsupported PDF text encoding as a scanned document", async () => {
    const pdf = Buffer.from(
      "%PDF-1.4\n1 0 obj\n<< /Type /Page /Contents 2 0 R >>\nendobj\n2 0 obj\n<< /Length 1 >>\nstream\n<ff> Tj\nendstream\nendobj\n%%EOF",
      "latin1"
    );

    await expect(
      parseStaffImportFile({
        filename: "unsupported-text-encoding.pdf",
        contentType: "application/pdf",
        buffer: pdf,
      })
    ).rejects.toThrow("This PDF requires OCR before it can be analyzed.");
  });

  it("reports the OCR-required state when OCR is not installed", async () => {
    // why: the unit-test runtime has no system OCR binary or language packs.
    const loggerInfo = vi.spyOn(Logger, "info").mockImplementation(() => {});
    await expect(
      parseStaffImportFile({
        filename: "inventory.pdf",
        contentType: "application/pdf",
        buffer: makeImageOnlyPdf(),
      })
    ).rejects.toThrow("This PDF requires OCR before it can be analyzed.");
    expect(loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "ioio_staff_import_pdf_text_extracted",
        pageCount: 1,
        extractedCharsPerPage: [0],
        totalExtractedChars: 0,
        meaningfulText: false,
        selectedExtractor: null,
        extractorAttempts: [
          expect.objectContaining({
            extractor: "primary",
            extractedCharsPerPage: [0],
            meaningfulText: false,
          }),
          expect.objectContaining({
            extractor: "pdfjs",
            meaningfulText: false,
            status: "empty",
          }),
          expect.objectContaining({ extractor: "ocr", status: "unavailable" }),
        ],
        ocrPagesAttempted: 0,
        ocrPagesSuccessful: 0,
        genericClaudeFallbackInvoked: false,
        classification: "ocr-unavailable",
      })
    );
  });

  it("keeps PDF.js failures distinct from missing OCR capability", async () => {
    // why: malformed page structure and missing OCR are separate failure states.
    const loggerInfo = vi.spyOn(Logger, "info").mockImplementation(() => {});

    await expect(
      parseStaffImportFile({
        filename: "unreadable-page.pdf",
        contentType: "application/pdf",
        buffer: Buffer.from(
          "%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\n%%EOF",
          "latin1"
        ),
      })
    ).rejects.toThrow("This PDF requires OCR before it can be analyzed.");
    expect(loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "ioio_staff_import_pdf_text_extracted",
        selectedExtractor: null,
        extractorAttempts: [
          expect.objectContaining({ extractor: "primary", status: "empty" }),
          expect.objectContaining({ extractor: "pdfjs", status: "error" }),
          expect.objectContaining({ extractor: "ocr", status: "unavailable" }),
        ],
        classification: "ocr-unavailable",
      })
    );
  });

  it("does not report scanned when decoded text cannot be linked to a page object", async () => {
    const pdf = Buffer.from(
      "%PDF-1.4\n1 0 obj\n<< /Type /Page /Contents 99 0 R >>\nendobj\n3 0 obj\nstream\n(Seeed Studio mmWave Sensor) Tj\nendstream\nendobj\n%%EOF",
      "latin1"
    );

    await expect(
      parseStaffImportFile({
        filename: "mouser-invoice.pdf",
        contentType: "application/pdf",
        buffer: pdf,
      })
    ).rejects.toThrow(
      "This PDF contains readable text, but AI-assisted document analysis is required to identify product line items."
    );
  });

  it("rejects malformed PDFs before calling the helper", async () => {
    mockRequestImportHelperProposal.mockClear();
    await expect(
      parseStaffImportFile({
        filename: "not-a-pdf.pdf",
        contentType: "application/pdf",
        buffer: Buffer.from("not a PDF"),
      })
    ).rejects.toThrow("not a valid PDF");
    expect(mockRequestImportHelperProposal).not.toHaveBeenCalled();
  });

  it("keeps grouped Mouser rows when Claude enrichment is not configured", async () => {
    vi.clearAllMocks();
    mockStaffAccess.mockResolvedValue({
      organizationId: "org-1",
      userId: "staff-1",
    });
    database.asset.findMany.mockResolvedValue([]);
    database.assetModel.findMany.mockResolvedValue([]);
    database.category.findMany.mockResolvedValue([]);
    database.location.findMany.mockResolvedValue([]);
    mockGetCategories.mockResolvedValue([]);
    mockGetBrokenSection.mockResolvedValue(null);
    mockGetReturnArea.mockResolvedValue(null);
    mockGetArchivedCategoryIds.mockResolvedValue([]);
    mockRequestImportHelperProposal.mockResolvedValue({
      status: "manual",
      reason: "helper_not_configured",
    });
    database.asset.findMany.mockResolvedValue([]);
    database.assetModel.findMany.mockResolvedValue([]);
    database.ioioWriteOperation.findUnique.mockResolvedValue(null);
    database.ioioWriteOperation.findFirst.mockResolvedValue({
      id: "operation-mouser-unconfigured",
    });
    database.ioioWriteOperation.create.mockResolvedValue({});
    database.ioioImportItem.createMany.mockResolvedValue({ count: 2 });
    database.ioioImportItem.findMany.mockResolvedValue([]);
    mockGetCategories.mockResolvedValue([
      { id: "cat-electronics", name: "Electronics", color: "#2878b8" },
    ]);

    const prepared = await prepareStaffInventoryImport({
      context: { getSession: () => ({ userId: "staff-1" }) } as never,
      request: new Request("http://localhost/staff/import"),
      file: new File([makeMouserPdf()], "mouser-invoice.pdf", {
        type: "application/pdf",
      }),
    });

    expect(mockRequestImportHelperProposal).toHaveBeenCalledTimes(1);
    expect(prepared.status).toBe("PREPARED");
    if (prepared.status !== "PREPARED") throw new Error("Expected proposal");
    expect(prepared.proposal.source.extractionProvider).toBe(
      "mouser-deterministic:v1"
    );
    expect(prepared.proposal.rows).toHaveLength(2);
    expect(prepared.proposal.rows.map((row) => row.supplierPartNumber)).toEqual(
      ["713-114993388", "713-101010001"]
    );
    expect(prepared.proposal.rows.map((row) => row.quantity)).toEqual([1, 4]);
    const [helperRequest] = mockRequestImportHelperProposal.mock.calls[0];
    expect(helperRequest.mode).toBe("MOUSER_LINE_ITEM_ENRICHMENT");
    expect(helperRequest).not.toHaveProperty("document.pages");
  });

  it("sends only grouped Mouser line items to Claude for minimal enrichment", async () => {
    const pdf = makeMouserPdf();
    const helperResponse = makeMouserHelperResponse();

    vi.clearAllMocks();
    mockStaffAccess.mockResolvedValue({
      organizationId: "org-1",
      userId: "staff-1",
    });
    database.asset.findMany.mockResolvedValue([
      {
        id: "asset-existing-cable",
        title: "USB-C Cable",
        type: "QUANTITY_TRACKED",
        quantity: 18,
        description: null,
        categoryId: "cat-electronics",
        assetModelId: null,
        assetLocations: [
          { locationId: "loc-shelf", quantity: 18, assetKitId: null },
        ],
      },
    ]);
    database.location.findMany.mockResolvedValue([
      {
        id: "room",
        name: "IOIO Lab – B477",
        parentId: null,
        description: null,
        color: null,
      },
      {
        id: "loc-shelf",
        name: "Container A1-1.1",
        parentId: "room",
        description: "General storage",
        color: "#2878b8",
      },
      {
        id: "broken",
        name: "Problem / Broken Zone",
        parentId: "room",
        description: null,
        color: null,
      },
      {
        id: "pickup",
        name: "Pickup Zone",
        parentId: "room",
        description: null,
        color: null,
      },
      {
        id: "return",
        name: "Return Section",
        parentId: "room",
        description: null,
        color: null,
      },
    ]);
    mockGetBrokenSection.mockResolvedValue({ id: "broken" });
    mockGetReturnArea.mockResolvedValue("IOIO Lab – B477 · Return Section");
    mockGetCategories.mockResolvedValue([
      {
        id: "cat-electronics",
        name: "Electronics",
        description: "General electronic equipment",
        color: "#2878b8",
      },
    ]);
    database.ioioWriteOperation.findUnique.mockResolvedValue(null);
    database.ioioWriteOperation.findFirst.mockResolvedValue({
      id: "operation-pdf-helper",
    });
    database.ioioImportItem.createMany.mockResolvedValue({ count: 1 });
    database.ioioImportItem.findMany.mockResolvedValue([]);
    mockRequestImportHelperProposal.mockImplementation((request) => ({
      status: "ready",
      proposal: validateImportHelperResponse(helperResponse, request),
    }));

    const prepared = await prepareStaffInventoryImport({
      context: { getSession: () => ({ userId: "staff-1" }) } as never,
      request: new Request("http://localhost/staff/import"),
      file: new File([pdf], "inventory.pdf", { type: "application/pdf" }),
    });

    expect(prepared.status).toBe("PREPARED");
    if (prepared.status !== "PREPARED") throw new Error("Expected proposal");
    expect(mockRequestImportHelperProposal).toHaveBeenCalledTimes(1);
    const [helperRequest] = mockRequestImportHelperProposal.mock.calls[0];
    expect(helperRequest).toMatchObject({
      mode: "MOUSER_LINE_ITEM_ENRICHMENT",
      schemaVersion: 2,
      lineItems: [
        {
          sourceRef: "mouser-p1-line1",
          sourcePage: 1,
          supplierProductNumber: "713-114993388",
          mpn: "114993388",
          rawDescription: "Seeed Studio Seeed Studio 60GHz mmWave Sensor",
          quantity: 1,
        },
        {
          sourceRef: "mouser-p1-line2",
          sourcePage: 1,
          supplierProductNumber: "713-101010001",
          mpn: "101010001",
          rawDescription:
            "Seeed Studio 24GHz mmWave Sensor / Avståndssensormoduler – öppen ram",
          quantity: 4,
        },
      ],
      activeCategories: [
        {
          id: "cat-electronics",
          name: "Electronics",
          description: "General electronic equipment",
        },
      ],
    });
    expect(helperRequest).not.toHaveProperty("document.pages");
    expect(helperRequest.relevantLocations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "loc-shelf",
          pathLabel: expect.stringContaining("Container A1-1.1"),
          description: expect.stringContaining(
            "General storage | Existing category placement: Electronics: 1 asset"
          ),
        }),
      ])
    );
    expect(helperRequest).not.toHaveProperty("allowedTrackingModes");
    expect(helperRequest.document.sha256).toBe(
      createHash("sha256").update(pdf).digest("hex")
    );
    expect(prepared.proposal.locationOptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "broken", operational: true }),
        expect.objectContaining({ id: "pickup", operational: true }),
        expect.objectContaining({ id: "return", operational: true }),
      ])
    );
    expect(prepared.proposal.source.sha256).toBe(helperRequest.document.sha256);
    expect(database.category.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: "org-1", id: { in: [] } },
      })
    );
    expect(database.location.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: "org-1" }),
      })
    );
    expect(prepared.proposal.source.extractionProvider).toBe(
      "mouser-deterministic+claude-enrichment:v2"
    );
    expect(prepared.proposal.rows).toHaveLength(2);
    expect(prepared.proposal.rows[0]).toMatchObject({
      locationId: "loc-shelf",
      locationLabel: "IOIO Lab – B477 · Container A1-1.1",
      categoryId: "cat-electronics",
    });
    expect(
      prepared.proposal.rows.map((row) => ({
        supplierProductNumber: row.supplierPartNumber,
        mpn: row.manufacturerPartNumber,
        title: row.title,
        quantity: row.quantity,
        receivedQuantity: row.receivedQuantity,
        categoryId: row.categoryId,
        type: row.type,
        sourcePage: row.sourceEvidence?.[0]?.page,
      }))
    ).toEqual([
      {
        supplierProductNumber: "713-114993388",
        mpn: "114993388",
        title: "Seeed Studio 60GHz mmWave Sensor",
        quantity: 1,
        receivedQuantity: 1,
        categoryId: "cat-electronics",
        type: "QUANTITY_TRACKED",
        sourcePage: 1,
      },
      {
        supplierProductNumber: "713-101010001",
        mpn: "101010001",
        title: "Seeed Studio 24GHz mmWave Sensor",
        // The useful full invoice description remains available separately.
        quantity: 4,
        receivedQuantity: 4,
        categoryId: null,
        type: "QUANTITY_TRACKED",
        sourcePage: 1,
      },
    ]);
    expect(prepared.proposal.rows[1]).toMatchObject({
      proposedCategoryName: null,
      categoryId: null,
      action: "CREATE",
    });
    expect(prepared.proposal.rows[1]?.suggestedCategory).toBeUndefined();
    expect(
      prepared.proposal.rows.map((row) => row.supplierPartNumber)
    ).not.toContain("260,76");
    expect(prepared.proposal.rows.map((row) => row.helperCandidate)).toEqual([
      undefined,
      undefined,
    ]);
    expect(mockCreateAsset).not.toHaveBeenCalled();
    expect(mockUpdateAsset).not.toHaveBeenCalled();
    expect(mockCreateAssetModel).not.toHaveBeenCalled();
  });

  it.each([
    { reason: "invalid_response" as const, label: "invalid helper output" },
    { reason: "network_error" as const, label: "unavailable helper" },
    {
      reason: "helper_not_configured" as const,
      label: "unconfigured helper",
    },
  ])(
    "uses deterministic rows when the $label cannot return a proposal",
    async ({ reason }) => {
      const pdf = Buffer.from(
        `%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nstream\n(Name|Quantity|Category|Location) Tj\n(Arduino Nano|4|Boards|Shelf A) Tj\nendstream\nendobj\n%%EOF`,
        "latin1"
      );
      vi.clearAllMocks();
      mockStaffAccess.mockResolvedValue({
        organizationId: "org-1",
        userId: "staff-1",
      });
      database.asset.findMany.mockResolvedValue([]);
      database.location.findMany.mockResolvedValue([
        { id: "loc-shelf", name: "Shelf A" },
      ]);
      mockGetCategories.mockResolvedValue([
        { id: "cat-boards", name: "Boards" },
      ]);
      database.ioioWriteOperation.findUnique.mockResolvedValue(null);
      database.ioioWriteOperation.findFirst.mockResolvedValue({
        id: "operation-pdf-fallback",
      });
      database.ioioImportItem.createMany.mockResolvedValue({ count: 1 });
      database.ioioImportItem.findMany.mockResolvedValue([]);
      mockRequestImportHelperProposal.mockResolvedValue({
        status: "manual",
        reason,
      });

      const prepared = await prepareStaffInventoryImport({
        context: { getSession: () => ({ userId: "staff-1" }) } as never,
        request: new Request("http://localhost/staff/import"),
        file: new File([pdf], "inventory.pdf", { type: "application/pdf" }),
      });

      expect(prepared.status).toBe("PREPARED");
      if (prepared.status !== "PREPARED") throw new Error("Expected proposal");
      expect(prepared.proposal.source.extractionProvider).toBe("deterministic");
      expect(prepared.proposal.rows).toHaveLength(1);
      expect(prepared.proposal.rows[0]).toMatchObject({
        title: "Arduino Nano",
        quantity: 4,
        sourceEvidence: [{ sourceRef: "pdf-page-1", page: 1 }],
      });
      expect(mockCreateAsset).not.toHaveBeenCalled();
      expect(mockUpdateAsset).not.toHaveBeenCalled();
      expect(mockCreateAssetModel).not.toHaveBeenCalled();
    }
  );

  it("returns a stored SUCCEEDED result without creating PENDING ledger rows", async () => {
    const result = {
      operationId: "operation-succeeded",
      createdIds: ["asset-1"],
      updatedIds: [],
      reusedIds: [],
      failedRows: [],
      conflictRows: [],
      ignoredRows: 0,
      reviewedRows: 1,
      totalRows: 1,
      succeededRows: 1,
      failedRowsCount: 0,
      conflictedRowsCount: 0,
      skippedRows: 0,
    };
    const proposal = {
      version: 1 as const,
      operationId: result.operationId,
      organizationId: "org-1",
      source: {
        filename: "inventory.csv",
        size: 16,
        sha256: "file-sha",
      },
      rows: [],
      counts: {},
      createdAt: "2026-10-26T00:00:00.000Z",
    };
    mockStaffAccess.mockResolvedValue({
      organizationId: "org-1",
      userId: "staff-1",
    });
    database.asset.findMany.mockResolvedValue([]);
    database.location.findMany.mockResolvedValue([]);
    mockGetCategories.mockResolvedValue([]);
    database.ioioWriteOperation.findUnique.mockResolvedValue({
      status: "SUCCEEDED",
      description: JSON.stringify({ proposal, result }),
      createdAt: new Date("2026-10-26T00:00:00.000Z"),
    });

    const response = await prepareStaffInventoryImport({
      context: { getSession: () => ({ userId: "staff-1" }) } as never,
      request: new Request("http://localhost/staff/import"),
      file: new File(["Name,Quantity\nNano,1"], "inventory.csv", {
        type: "text/csv",
      }),
    });

    expect(response).toEqual({ status: "SUCCEEDED", result });
    expect(database.ioioImportItem.createMany).not.toHaveBeenCalled();
    expect(database.ioioWriteOperation.create).not.toHaveBeenCalled();
  });

  it("returns the stored PARTIAL result when the same file is prepared again", async () => {
    vi.clearAllMocks();
    const result = {
      operationId: "operation-partial",
      createdIds: ["asset-1"],
      updatedIds: [],
      reusedIds: [],
      failedRows: [{ rowNumber: 3, reason: "Needs correction." }],
      conflictRows: [],
      ignoredRows: 0,
      reviewedRows: 1,
      totalRows: 2,
      succeededRows: 1,
      failedRowsCount: 1,
      conflictedRowsCount: 0,
      skippedRows: 0,
    };
    mockStaffAccess.mockResolvedValue({
      organizationId: "org-1",
      userId: "staff-1",
    });
    database.asset.findMany.mockResolvedValue([]);
    database.location.findMany.mockResolvedValue([]);
    mockGetCategories.mockResolvedValue([]);
    database.ioioWriteOperation.findUnique.mockResolvedValue({
      status: "PARTIAL",
      description: JSON.stringify({ result }),
      createdAt: new Date(),
    });

    const prepared = await prepareStaffInventoryImport({
      context: { getSession: () => ({ userId: "staff-1" }) } as never,
      request: new Request("http://localhost/staff/import"),
      file: new File(["Name,Quantity\nNano,1"], "inventory.csv", {
        type: "text/csv",
      }),
    });

    expect(prepared).toEqual({ status: "PARTIAL", result });
    expect(database.ioioImportItem.createMany).not.toHaveBeenCalled();
    expect(database.ioioWriteOperation.create).not.toHaveBeenCalled();
  });

  it("resumes from DONE ledger rows without repeating the Shelf write", async () => {
    const operationId = "operation-resume";
    const row = {
      rowNumber: 2,
      title: "Arduino Nano",
      action: "CREATE" as const,
      assetId: null,
      type: "QUANTITY_TRACKED" as const,
      quantity: 1,
      category: "Electronics",
      categoryId: "category-electronics",
      location: null,
      locationId: null,
      currentQuantity: null,
      currentCategoryId: null,
      currentLocationId: null,
      reason: "New item",
    };
    const proposalContent = {
      version: 1 as const,
      operationId,
      organizationId: "org-1",
      source: { filename: "inventory.csv", size: 42, sha256: "resume-hash" },
      rows: [row],
      counts: {
        CREATE: 1,
        INCREASE_QUANTITY: 0,
        NO_CHANGE: 0,
        POSSIBLE_DUPLICATE: 0,
        NEEDS_REVIEW: 0,
        IGNORE: 0,
        UPDATE_QUANTITY: 0,
        UPDATE_LOCATION: 0,
        UPDATE_CATEGORY: 0,
        AMBIGUOUS: 0,
        REJECT: 0,
      },
      createdAt: new Date().toISOString(),
    };
    const proposal = {
      ...proposalContent,
      proposalHash: getStaffImportProposalHash(proposalContent),
    };
    const operation = {
      id: operationId,
      operationType: "INVENTORY_IMPORT",
      organizationId: "org-1",
      userId: "staff-1",
      status: "APPLYING",
      createdAt: new Date(),
      updatedAt: new Date(Date.now() - 11 * 60 * 1000),
      description: JSON.stringify({
        proposal,
        executionPlan: { rows: [row], reviewedRows: 1 },
      }),
    };
    const ledgerItem = {
      id: "ledger-1",
      operationId,
      organizationId: "org-1",
      rowKey: "row-2",
      unitIndex: null,
      status: "DONE",
      attempt: 1,
      heartbeatAt: null,
      updatedAt: new Date(),
      writtenState: { outcome: "created", assetId: "asset-1" },
    };
    mockStaffAccess.mockResolvedValue({
      organizationId: "org-1",
      userId: "staff-1",
    });
    database.ioioWriteOperation.findFirst.mockResolvedValue(operation);
    database.ioioWriteOperation.updateMany.mockResolvedValue({ count: 1 });
    database.ioioImportItem.createMany.mockResolvedValue({ count: 0 });
    database.ioioImportItem.findMany.mockImplementation(({ where }) =>
      where.status === "IN_FLIGHT" ? [] : [ledgerItem]
    );

    const result = await applyStaffInventoryImport({
      context: { getSession: () => ({ userId: "staff-1" }) } as never,
      request: new Request("http://localhost/staff/import"),
      operationId,
      proposalHash: proposal.proposalHash,
    });

    expect(result).toMatchObject({
      operationId,
      createdIds: ["asset-1"],
      updatedIds: [],
      reusedIds: [],
      failedRows: [],
      conflictRows: [],
      totalRows: 1,
      succeededRows: 1,
      failedRowsCount: 0,
      conflictedRowsCount: 0,
      skippedRows: 0,
    });
    expect(
      database.ioioWriteOperation.updateMany.mock.calls.at(-1)?.[0].data.status
    ).toBe("SUCCEEDED");
    expect(database.ioioImportItem.updateMany).not.toHaveBeenCalled();
    expect(mockCreateAsset).not.toHaveBeenCalled();
    expect(mockUpdateAsset).not.toHaveBeenCalled();
  });

  it.each([
    { label: "all DONE", statuses: ["DONE"], expected: "SUCCEEDED" },
    {
      label: "DONE and SKIPPED",
      statuses: ["DONE", "SKIPPED"],
      expected: "SUCCEEDED",
    },
    {
      label: "DONE and FAILED",
      statuses: ["DONE", "FAILED"],
      expected: "PARTIAL",
    },
    {
      label: "DONE and CONFLICT",
      statuses: ["DONE", "CONFLICT"],
      expected: "PARTIAL",
    },
    {
      label: "DONE, FAILED, and CONFLICT",
      statuses: ["DONE", "FAILED", "CONFLICT"],
      expected: "PARTIAL",
    },
    {
      label: "DONE, SKIPPED, and FAILED",
      statuses: ["DONE", "SKIPPED", "FAILED"],
      expected: "PARTIAL",
    },
    { label: "all FAILED", statuses: ["FAILED", "FAILED"], expected: "FAILED" },
    {
      label: "all CONFLICT",
      statuses: ["CONFLICT", "CONFLICT"],
      expected: "FAILED",
    },
    {
      label: "active work",
      statuses: ["DONE", "IN_FLIGHT"],
      expected: "APPLYING",
    },
  ])("aggregates $label as $expected", ({ statuses, expected }) => {
    expect(
      summarizeStaffImportRows(
        statuses as Array<
          "PENDING" | "IN_FLIGHT" | "DONE" | "FAILED" | "CONFLICT" | "SKIPPED"
        >
      ).status
    ).toBe(expected);
  });

  it("counts total, successful, failed, conflicted, and skipped rows", () => {
    expect(
      summarizeStaffImportRows([
        "DONE",
        "DONE",
        "SKIPPED",
        "FAILED",
        "CONFLICT",
      ])
    ).toEqual({
      totalRows: 5,
      succeededRows: 2,
      failedRowsCount: 1,
      conflictedRowsCount: 1,
      skippedRows: 1,
      status: "PARTIAL",
    });
  });

  it("returns PARTIAL results without retrying terminal ledger rows", async () => {
    vi.clearAllMocks();
    const operationId = "operation-partial";
    const result = {
      operationId,
      createdIds: ["asset-done"],
      updatedIds: [],
      reusedIds: [],
      failedRows: [{ rowNumber: 3, reason: "Invalid category." }],
      conflictRows: [{ rowNumber: 4, reason: "Needs manual review." }],
      ignoredRows: 0,
      reviewedRows: 4,
      totalRows: 4,
      succeededRows: 1,
      failedRowsCount: 1,
      conflictedRowsCount: 1,
      skippedRows: 0,
    };
    mockStaffAccess.mockResolvedValue({
      organizationId: "org-1",
      userId: "staff-1",
    });
    database.ioioWriteOperation.findFirst.mockResolvedValue({
      id: operationId,
      operationType: "INVENTORY_IMPORT",
      organizationId: "org-1",
      userId: "staff-1",
      status: "PARTIAL",
      description: JSON.stringify({ result }),
    });

    await expect(
      applyStaffInventoryImport({
        context: { getSession: () => ({ userId: "staff-1" }) } as never,
        request: new Request("http://localhost/staff/import"),
        operationId,
        proposalHash: "unused-terminal-status-hash",
      })
    ).resolves.toEqual(result);
    expect(database.ioioImportItem.createMany).not.toHaveBeenCalled();
    expect(database.ioioImportItem.updateMany).not.toHaveBeenCalled();
    expect(mockCreateAsset).not.toHaveBeenCalled();
    expect(mockUpdateAsset).not.toHaveBeenCalled();
  });

  it("skips blank separators, repeated headers, and page markers in PDF tables", async () => {
    const pdf = Buffer.from(
      `%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nstream\n(Name|Quantity|Category|Location) Tj\n(Arduino Nano|8|Boards|B477) Tj\n(|||) Tj\n(Name|Quantity|Category|Location) Tj\n(Page 2 of 2|||) Tj\n(Arduino Uno|3|Boards|B477) Tj\nendstream\nendobj\n%%EOF`,
      "latin1"
    );

    const rows = await parseStaffImportFile({
      filename: "inventory.pdf",
      contentType: "application/pdf",
      buffer: pdf,
    });

    expect(rows.map((row) => row.title)).toEqual([
      "Arduino Nano",
      "Arduino Uno",
    ]);
  });

  it("keeps a PDF row with inventory values but no item name for review", async () => {
    const pdf = Buffer.from(
      `%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nstream\n(Name|Quantity|Category|Location) Tj\n(|8|Boards|B477) Tj\nendstream\nendobj\n%%EOF`,
      "latin1"
    );

    const rows = await parseStaffImportFile({
      filename: "inventory.pdf",
      contentType: "application/pdf",
      buffer: pdf,
    });

    expect(rows[0]).toMatchObject({
      title: "",
      quantity: 8,
      pdfClassification: "PARTIAL",
      reviewRequired: true,
    });
  });

  it("preserves valid PDF rows when another row has an invalid quantity", async () => {
    const pdf = Buffer.from(
      `%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nstream\n(Name|Quantity|Category|Location) Tj\n(Arduino Nano|8|Boards|B477) Tj\n(|6|Boards|B477) Tj\n(Multimeter|not-a-number|Measurement|B443) Tj\nendstream\nendobj\n%%EOF`,
      "latin1"
    );

    const rows = await parseStaffImportFile({
      filename: "inventory.pdf",
      contentType: "application/pdf",
      buffer: pdf,
    });

    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      title: "Arduino Nano",
      pdfClassification: "VALID_ITEM",
    });
    expect(rows[1]).toMatchObject({
      title: "",
      pdfClassification: "PARTIAL",
    });
    expect(rows[2]).toMatchObject({
      title: "Multimeter",
      quantity: null,
      pdfClassification: "PARTIAL",
    });
  });

  it("does not auto-resolve duplicate names", () => {
    const rows = classifyStaffImportRows({
      rows: [
        {
          rowNumber: 2,
          title: "Arduino Nano",
          quantity: null,
          category: null,
          location: null,
          type: null,
        },
      ],
      assets: [
        {
          id: "asset-1",
          title: "Arduino Nano",
          type: "INDIVIDUAL",
          quantity: null,
          categoryId: null,
          assetLocations: [],
        },
        {
          id: "asset-2",
          title: "Arduino Nano",
          type: "INDIVIDUAL",
          quantity: null,
          categoryId: null,
          assetLocations: [],
        },
      ],
      categories: [],
      locations: [],
    });

    expect(rows[0].action).toBe("AMBIGUOUS");
    expect(rows[0].assetId).toBeNull();
  });

  it("creates one controlled quantity update when the match is unique", () => {
    const [row] = classifyStaffImportRows({
      rows: [
        {
          rowNumber: 2,
          title: "Arduino Nano",
          quantity: 8,
          category: null,
          location: null,
          type: "QUANTITY_TRACKED",
        },
      ],
      assets: [
        {
          id: "asset-1",
          title: "Arduino Nano",
          type: "QUANTITY_TRACKED",
          quantity: 4,
          categoryId: null,
          assetLocations: [],
        },
      ],
      categories: [],
      locations: [],
    });

    expect(row.action).toBe("UPDATE_QUANTITY");
    expect(row.assetId).toBe("asset-1");
    expect(row.reason).toContain("quantity");
  });

  it("proposes an increase only from confirmed received quantity", () => {
    const [received] = classifyStaffImportRows({
      rows: [
        {
          rowNumber: 2,
          title: "Arduino Nano",
          quantity: 5,
          orderedQuantity: 5,
          receivedQuantity: 5,
          quantityStatus: "RECEIVED",
          category: "Boards & Embedded Systems",
          location: null,
          type: "QUANTITY_TRACKED",
          sourceDescription: "ARDUINO ABX00028 NANO",
        },
      ],
      assets: [
        {
          id: "asset-1",
          title: "Arduino Nano",
          type: "QUANTITY_TRACKED",
          quantity: 8,
          categoryId: "category-1",
          assetLocations: [],
        },
      ],
      categories: [{ id: "category-1", name: "Boards & Embedded Systems" }],
      locations: [],
    });

    expect(received.action).toBe("INCREASE_QUANTITY");
    expect(received.proposedQuantity).toBe(13);

    const [ordered] = classifyStaffImportRows({
      rows: [
        {
          rowNumber: 2,
          title: "Arduino Nano",
          quantity: 5,
          orderedQuantity: 5,
          quantityStatus: "ORDERED",
          category: "Boards & Embedded Systems",
          location: null,
          type: "QUANTITY_TRACKED",
          sourceDescription: "ARDUINO ABX00028 NANO",
        },
      ],
      assets: [
        {
          id: "asset-1",
          title: "Arduino Nano",
          type: "QUANTITY_TRACKED",
          quantity: 8,
          categoryId: "category-1",
          assetLocations: [],
        },
      ],
      categories: [{ id: "category-1", name: "Boards & Embedded Systems" }],
      locations: [],
    });

    expect(ordered.action).toBe("NEEDS_REVIEW");
    expect(ordered.proposedQuantity).toBe(8);
  });

  it.each([
    ["USB-C Cable", 20],
    ["Arduino Nano", 5],
    ["JST cable", 10],
    ["small sensor module", 8],
    ["DC motor", 10],
  ])("defaults %s stock to quantity tracking", (title, quantity) => {
    const [row] = classifyStaffImportRows({
      rows: [
        {
          rowNumber: 2,
          title,
          quantity,
          category: "Electronics",
          location: null,
          type: null,
        },
      ],
      assets: [],
      categories: [{ id: "electronics", name: "Electronics" }],
      locations: [],
    });

    expect(row).toMatchObject({
      action: "CREATE",
      type: "QUANTITY_TRACKED",
      trackingSource: "DETERMINISTIC_DEFAULT",
      trackingReasonCode: "DEFAULT_QUANTITY",
    });
  });

  it("uses existing Shelf tracking semantics even when source mode differs", () => {
    const [quantityModelRow] = classifyStaffImportRows({
      rows: [
        {
          rowNumber: 2,
          title: "USB-C Cable",
          quantity: 20,
          receivedQuantity: 20,
          quantityStatus: "RECEIVED",
          category: null,
          location: null,
          type: "INDIVIDUAL",
          trackingSource: "SOURCE_EXPLICIT",
        },
      ],
      assets: [
        {
          id: "quantity-cable",
          title: "USB-C Cable",
          type: "QUANTITY_TRACKED",
          quantity: 10,
          categoryId: null,
          assetLocations: [],
        },
      ],
      categories: [],
      locations: [],
    });
    const [individualModelRow] = classifyStaffImportRows({
      rows: [
        {
          rowNumber: 3,
          title: "Rigol DS1054Z",
          quantity: 1,
          category: null,
          location: null,
          type: null,
        },
      ],
      assets: [
        {
          id: "individual-scope",
          title: "Rigol DS1054Z",
          type: "INDIVIDUAL",
          quantity: null,
          categoryId: null,
          assetLocations: [],
        },
      ],
      categories: [],
      locations: [],
    });

    expect(quantityModelRow).toMatchObject({
      type: "QUANTITY_TRACKED",
      trackingSource: "EXISTING_MODEL",
      trackingReasonCode: "EXISTING_MODEL_QUANTITY",
    });
    expect(individualModelRow).toMatchObject({
      type: "INDIVIDUAL",
      trackingSource: "EXISTING_MODEL",
      trackingReasonCode: "EXISTING_MODEL_INDIVIDUAL",
    });
  });

  it("uses the tracking mode of a linked AssetModel and increases its quantity asset", () => {
    const [row] = classifyStaffImportRows({
      rows: [
        {
          rowNumber: 2,
          title: "Arduino Nano",
          quantity: 4,
          receivedQuantity: 4,
          quantityStatus: "RECEIVED",
          category: null,
          location: null,
          type: "INDIVIDUAL",
          trackingSource: "SOURCE_EXPLICIT",
          existingAssetModelId: "model-nano",
        },
      ],
      assets: [
        {
          id: "quantity-nano",
          title: "Arduino Nano Stock",
          type: "QUANTITY_TRACKED",
          quantity: 3,
          categoryId: null,
          assetModelId: "model-nano",
          assetLocations: [],
        },
      ],
      categories: [],
      locations: [],
    });

    expect(row).toMatchObject({
      action: "INCREASE_QUANTITY",
      assetId: "quantity-nano",
      type: "QUANTITY_TRACKED",
      proposedQuantity: 7,
      trackingSource: "EXISTING_MODEL",
      trackingReasonCode: "EXISTING_MODEL_QUANTITY",
    });
  });

  it("does not use quantity, manufacturer, category, or MPN alone as individual evidence", () => {
    const [row] = classifyStaffImportRows({
      rows: [
        {
          rowNumber: 2,
          title: "Seeed Studio XIAO ESP32-S3 Sense",
          quantity: 20,
          category: "Electronics",
          location: null,
          type: null,
          manufacturer: "Seeed Studio",
          manufacturerPartNumber: "SKU-ESP32S3-SENSE",
        },
      ],
      assets: [],
      categories: [{ id: "electronics", name: "Electronics" }],
      locations: [],
    });

    expect(row).toMatchObject({
      type: "QUANTITY_TRACKED",
      trackingSource: "DETERMINISTIC_DEFAULT",
      trackingReasonCode: "DEFAULT_QUANTITY",
    });
  });

  it("defaults serial-number rows to quantity tracking and permits a manual individual override", () => {
    const [row] = classifyStaffImportRows({
      rows: [
        {
          rowNumber: 2,
          title: "Digital oscilloscope",
          quantity: 1,
          category: "Electronics",
          location: null,
          type: null,
          serialNumber: "SCOPE-1042",
        },
      ],
      assets: [],
      categories: [{ id: "electronics", name: "Electronics" }],
      locations: [],
    });

    expect(row).toMatchObject({
      type: "QUANTITY_TRACKED",
      trackingSource: "DETERMINISTIC_DEFAULT",
      trackingReasonCode: "DEFAULT_QUANTITY",
    });
    const state = (trackingModeConfirmed: boolean) =>
      resolveImportReviewState({
        row,
        decision: {
          decision: "APPROVE",
          title: row.title,
          categoryId: row.categoryId,
          quantity: 1,
          type: "INDIVIDUAL",
          trackingModeConfirmed,
          trackingModeSelectedByStaff: true,
          productChoice: "NEW",
        },
        categoryAvailable: true,
        locationAvailable: true,
      });
    expect(state(false)).toBe("NEEDS_REVIEW");
    expect(state(true)).toBe("READY");
  });

  it("defaults equipment rows to quantity tracking regardless of source evidence", () => {
    const [strong] = classifyStaffImportRows({
      rows: [
        {
          rowNumber: 2,
          title: "Rigol DS1054Z Digital Oscilloscope",
          quantity: 2,
          category: "Electronics",
          sourceDescription: "Loanable test equipment",
          location: null,
          type: null,
        },
      ],
      assets: [],
      categories: [{ id: "electronics", name: "Electronics" }],
      locations: [],
    });
    const [ambiguous] = classifyStaffImportRows({
      rows: [
        {
          rowNumber: 3,
          title: "Digital oscilloscope",
          quantity: 2,
          category: "Electronics",
          sourceDescription: "Digital oscilloscope",
          location: null,
          type: null,
        },
      ],
      assets: [],
      categories: [{ id: "electronics", name: "Electronics" }],
      locations: [],
    });

    expect(strong).toMatchObject({
      type: "QUANTITY_TRACKED",
      trackingSource: "DETERMINISTIC_DEFAULT",
      trackingReasonCode: "DEFAULT_QUANTITY",
    });
    expect(ambiguous).toMatchObject({
      type: "QUANTITY_TRACKED",
      trackingSource: "DETERMINISTIC_DEFAULT",
      trackingReasonCode: "DEFAULT_QUANTITY",
    });
  });
});

describe("normalized spreadsheet import", () => {
  const parse = (text: string) =>
    parseStaffImportFile({ filename: "stock.csv", buffer: Buffer.from(text) });
  it("normalizes explicit tracking modes and per-unit serial evidence", async () => {
    const [serialized, explicitQuantity, sourceIndividual] = await parse(
      "Product,Qty,Serial Number,Tracking Mode\nOscilloscope,1,SCOPE-1042,\nUSB-C Cable,20,,QUANTITY_TRACKED\nDigital oscilloscope,1,SCOPE-1043,INDIVIDUAL"
    );

    expect(serialized).toMatchObject({
      title: "Oscilloscope",
      serialNumber: "SCOPE-1042",
      type: null,
    });
    expect(explicitQuantity).toMatchObject({
      title: "USB-C Cable",
      type: "QUANTITY_TRACKED",
      trackingSource: "SOURCE_EXPLICIT",
    });
    expect(sourceIndividual).toMatchObject({
      title: "Digital oscilloscope",
      serialNumber: "SCOPE-1043",
      type: null,
    });
  });

  it.each([
    ["Rigol DS1054Z Digital Oscilloscope", 1],
    ["UNI-T UT61E+ Digital Multimeter", 2],
  ])(
    "defaults PDF row %s (quantity %i) to quantity tracking",
    async (title, quantity) => {
      const rows = await parseStaffImportFile({
        filename: "equipment.pdf",
        buffer: makePdfFromPages([
          {
            text: `Product | Quantity | Category\n${title} | ${quantity} | Electronics`,
          },
        ]),
      });
      const [proposalRow] = classifyStaffImportRows({
        rows,
        assets: [],
        categories: [{ id: "electronics", name: "Electronics" }],
        locations: [],
      });

      expect(proposalRow).toMatchObject({
        title,
        quantity,
        type: "QUANTITY_TRACKED",
        trackingSource: "DETERMINISTIC_DEFAULT",
        trackingReasonCode: "DEFAULT_QUANTITY",
      });
    }
  );

  it("defaults ordinary CSV components to quantity tracking", async () => {
    const rows = await parse("Product,Qty\nResistor assortment,1");
    const [proposalRow] = classifyStaffImportRows({
      rows,
      assets: [],
      categories: [],
      locations: [],
    });

    expect(proposalRow).toMatchObject({
      title: "Resistor assortment",
      quantity: 1,
      type: "QUANTITY_TRACKED",
      trackingSource: "DETERMINISTIC_DEFAULT",
    });
  });

  it("defaults ordinary XLSX components to quantity tracking", async () => {
    const workbook = new JSZip();
    workbook.file(
      "xl/workbook.xml",
      '<workbook><sheets><sheet name="Inventory" r:id="rId1" /></sheets></workbook>'
    );
    workbook.file(
      "xl/_rels/workbook.xml.rels",
      '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml" /></Relationships>'
    );
    workbook.file(
      "xl/worksheets/sheet1.xml",
      '<worksheet><sheetData><row><c r="A1" t="inlineStr"><is><t>Product</t></is></c><c r="B1" t="inlineStr"><is><t>Qty</t></is></c></row><row><c r="A2" t="inlineStr"><is><t>Resistor assortment</t></is></c><c r="B2"><v>1</v></c></row></sheetData></worksheet>'
    );
    const rows = await parseStaffImportFile({
      filename: "components.xlsx",
      buffer: await workbook.generateAsync({ type: "nodebuffer" }),
    });
    const [proposalRow] = classifyStaffImportRows({
      rows,
      assets: [],
      categories: [],
      locations: [],
    });

    expect(proposalRow).toMatchObject({
      title: "Resistor assortment",
      quantity: 1,
      type: "QUANTITY_TRACKED",
      trackingSource: "DETERMINISTIC_DEFAULT",
    });
  });

  it.each(["PDF", "CSV", "XLSX"] as const)(
    "defaults %s equipment imports to quantity tracking",
    async (format) => {
      let rows: Awaited<ReturnType<typeof parseStaffImportFile>>;
      if (format === "PDF") {
        rows = await parseStaffImportFile({
          filename: "equipment.pdf",
          buffer: makePdfFromPages([
            {
              text: "Product | Quantity | Description\nDigital oscilloscope | 2 | Serialized loanable test equipment",
            },
          ]),
        });
      } else if (format === "CSV") {
        rows = await parseStaffImportFile({
          filename: "equipment.csv",
          buffer: Buffer.from(
            "Product,Qty,Serial Number,Tracking Mode,Description\nDigital oscilloscope,2,SCOPE-1042,INDIVIDUAL,Serialized loanable test equipment"
          ),
        });
      } else {
        const workbook = new JSZip();
        workbook.file(
          "xl/workbook.xml",
          '<workbook><sheets><sheet name="Inventory" r:id="rId1" /></sheets></workbook>'
        );
        workbook.file(
          "xl/_rels/workbook.xml.rels",
          '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml" /></Relationships>'
        );
        workbook.file(
          "xl/worksheets/sheet1.xml",
          '<worksheet><sheetData><row><c r="A1" t="inlineStr"><is><t>Product</t></is></c><c r="B1" t="inlineStr"><is><t>Qty</t></is></c><c r="C1" t="inlineStr"><is><t>Serial Number</t></is></c><c r="D1" t="inlineStr"><is><t>Tracking Mode</t></is></c><c r="E1" t="inlineStr"><is><t>Description</t></is></c></row><row><c r="A2" t="inlineStr"><is><t>Digital oscilloscope</t></is></c><c r="B2"><v>2</v></c><c r="C2" t="inlineStr"><is><t>SCOPE-1042</t></is></c><c r="D2" t="inlineStr"><is><t>INDIVIDUAL</t></is></c><c r="E2" t="inlineStr"><is><t>Serialized loanable test equipment</t></is></c></row></sheetData></worksheet>'
        );
        rows = await parseStaffImportFile({
          filename: "equipment.xlsx",
          buffer: await workbook.generateAsync({ type: "nodebuffer" }),
        });
      }

      const [proposalRow] = classifyStaffImportRows({
        rows,
        assets: [],
        categories: [],
        locations: [],
      });

      expect(proposalRow).toMatchObject({
        type: "QUANTITY_TRACKED",
        trackingSource: "DETERMINISTIC_DEFAULT",
        trackingReasonCode: "DEFAULT_QUANTITY",
      });
    }
  );

  it.each([",", ";", "\t"])(
    "reads quoted fields, BOM and %s delimiters",
    async (delimiter) => {
      const rows = await parse(
        "\uFEFFProduct name" +
          delimiter +
          "Antal" +
          delimiter +
          "Description\nBoard" +
          delimiter +
          "3" +
          delimiter +
          '"Small, useful board"\n'
      );
      expect(rows[0]).toMatchObject({
        title: "Board",
        quantity: 3,
        sourceDescription: "Small, useful board",
      });
    }
  );
  it("detects metadata before headers, ignores noise, and retains rejected rows", async () => {
    const rows = await parse(
      "Supplier: Example\nExport date: today\n\nProduct;Received;Ordered;Brand;MPN;Unrelated\nBoard;2;5;Maker;ABC;ignored\nMotor;-1;4;Maker;XYZ;ignored\nTotal;20;;;;\nVAT 25%;4;;;;\nFreight;1;;;;\n"
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      title: "Board",
      quantity: 2,
      orderedQuantity: 5,
      manufacturer: "Maker",
      manufacturerPartNumber: "ABC",
    });
    expect(rows[1].uncertainFields).toContain("Spreadsheet row");
    expect(rows[0].sourceNotes).toContain("source row: 5");
  });
  it("preserves duplicate identities for explicit review without combining variants", async () => {
    const rows = await parse(
      "Name,Qty,MPN,Brand\nBoard,2,A,Maker\nBoard variant,3,B,Maker\nBoard,4,A,Maker\n"
    );
    expect(rows).toHaveLength(3);
    expect(rows[0].uncertainFields).toContain("Duplicate spreadsheet identity");
    expect(rows[1].uncertainFields).toBeUndefined();
    expect(rows[2].quantity).toBe(4);
  });
  it("does not use ordered-only quantities as received inventory", async () => {
    const rows = await parse("Name,Ordered\nBoard,5\n");
    expect(rows[0]).toMatchObject({
      quantity: null,
      orderedQuantity: 5,
      quantityStatus: "ORDERED",
    });
  });
  it("produces equivalent 20-product rows from multiple-sheet XLSX and CSV", async () => {
    const matrix = [
      ["Product name", "Qty", "Brand", "MPN"],
      ...[
        "Arduino Nano",
        "ESP32 DevKit",
        "Raspberry Pi Pico",
        "XIAO ESP32-S3 Sense",
        "USB-C Cable",
        "HDMI Adapter",
        "JST Connector",
        "NEMA 17 Motor",
        "Micro Servo",
        "Motor Driver",
        "Temperature Sensor",
        "Distance Sensor",
        "IMU Module",
        "Pressure Sensor",
        "Breadboard",
        "Resistor Kit",
        "LED Strip",
        "Bench Power Supply",
        "Digital Multimeter",
        "Soldering Iron",
      ].map((name, index) => [name, `${index + 1}`, "Maker", `PN-${index}`]),
    ];
    const csv = await parse(matrix.map((row) => row.join(";")).join("\n"));
    const workbook = new JSZip();
    workbook.file(
      "xl/workbook.xml",
      '<workbook><sheets><sheet name="Notes" r:id="n"/><sheet name="Inventory" r:id="i"/></sheets></workbook>'
    );
    workbook.file(
      "xl/_rels/workbook.xml.rels",
      '<Relationships><Relationship Target="worksheets/notes.xml" Id="n"/><Relationship Target="worksheets/items.xml" Id="i"/></Relationships>'
    );
    const xml = (rows: string[][]) =>
      "<worksheet><sheetData>" +
      rows
        .map(
          (row, index) =>
            '<row r="' +
            (index + 1) +
            '">' +
            row
              .map(
                (cell, col) =>
                  '<c r="' +
                  String.fromCharCode(65 + col) +
                  (index + 1) +
                  '" t="inlineStr"><is><t>' +
                  cell +
                  "</t></is></c>"
              )
              .join("") +
            "</row>"
        )
        .join("") +
      "</sheetData></worksheet>";
    workbook.file(
      "xl/worksheets/notes.xml",
      xml([["Notes"], ["Do not import this sheet"]])
    );
    workbook.file(
      "xl/worksheets/items.xml",
      xml([["Supplier: Example"], [], ...matrix])
    );
    const xlsx = await parseStaffImportFile({
      filename: "stock.xlsx",
      buffer: await workbook.generateAsync({ type: "nodebuffer" }),
    });
    const identity = (rows: typeof csv) =>
      rows.map(
        ({
          title,
          quantity,
          receivedQuantity,
          manufacturer,
          manufacturerPartNumber,
        }) => ({
          title,
          quantity: receivedQuantity ?? quantity,
          manufacturer,
          manufacturerPartNumber,
        })
      );
    expect(xlsx).toHaveLength(20);
    expect(identity(xlsx)).toEqual(identity(csv));
    const pdf = await parseStaffImportFile({
      filename: "stock.pdf",
      buffer: makePdfFromPages([
        { text: matrix.map((row) => row.join("|")).join("\n") },
      ]),
    });
    expect(identity(pdf)).toEqual(identity(csv));
  });
});

describe("spreadsheet proposal enrichment", () => {
  it("carries equivalent CSV and XLSX quantities into the 20-row proposal", async () => {
    // why: use the real file preparation path while replacing network and database boundaries.
    vi.clearAllMocks();
    mockStaffAccess.mockResolvedValue({
      organizationId: "org-1",
      userId: "staff-1",
    });
    database.asset.findMany.mockResolvedValue([]);
    database.assetModel.findMany.mockResolvedValue([]);
    database.category.findMany.mockResolvedValue([]);
    database.location.findMany.mockResolvedValue([]);
    database.location.count.mockResolvedValue(0);
    database.ioioWriteOperation.findUnique.mockResolvedValue(null);
    database.ioioWriteOperation.findFirst.mockResolvedValue({ id: "proposal" });
    database.ioioWriteOperation.create.mockResolvedValue({});
    database.ioioImportItem.createMany.mockResolvedValue({ count: 20 });
    database.ioioImportItem.findMany.mockResolvedValue([]);
    mockGetCategories.mockResolvedValue([
      { id: "electronics", name: "Electronics" },
    ]);
    mockRequestImportHelperProposal.mockResolvedValue({
      status: "manual",
      reason: "helper_not_configured",
    });

    const products = [
      "Seeed Studio XIAO ESP32-S3 Sense",
      "Arduino Nano",
      "ESP32 DevKit",
      "Raspberry Pi Pico",
      "USB-C Cable",
      "HDMI Adapter",
      "JST Connector",
      "NEMA 17 Motor",
      "Micro Servo",
      "Motor Driver",
      "Temperature Sensor",
      "Distance Sensor",
      "IMU Module",
      "Pressure Sensor",
      "Breadboard",
      "Resistor Kit",
      "LED Strip",
      "Bench Power Supply",
      "Digital Multimeter",
      "Soldering Iron",
    ];
    const table = [
      ["Product", "Qty", "Manufacturer", "MPN", "Category"],
      ...products.map((name, index) => [
        name,
        String(index + 1),
        "Maker",
        `MPN-${index + 1}`,
        "Electronics",
      ]),
    ];
    const csvText = table.map((row) => row.join(",")).join("\n");
    const csvPrepared = await prepareStaffInventoryImport({
      context: { getSession: () => ({ userId: "staff-1" }) } as never,
      request: new Request("http://localhost/staff/import"),
      file: new File([csvText], "inventory.csv", { type: "text/csv" }),
    });

    const workbook = new JSZip();
    workbook.file(
      "xl/workbook.xml",
      '<workbook><sheets><sheet name="Notes" r:id="n"/><sheet name="Inventory" r:id="i"/></sheets></workbook>'
    );
    workbook.file(
      "xl/_rels/workbook.xml.rels",
      '<Relationships><Relationship Id="n" Target="worksheets/notes.xml"/><Relationship Id="i" Target="worksheets/inventory.xml"/></Relationships>'
    );
    const xml = (rows: string[][]) =>
      `<worksheet><sheetData>${rows
        .map(
          (row, rowIndex) =>
            `<row r="${rowIndex + 1}">${row
              .map((cell, columnIndex) => {
                const reference = `${String.fromCharCode(65 + columnIndex)}${
                  rowIndex + 1
                }`;
                if (rowIndex > 2 && columnIndex === 1) {
                  return `<c r="${reference}"><v>${cell}</v></c>`;
                }
                return `<c r="${reference}" t="inlineStr"><is><t>${cell}</t></is></c>`;
              })
              .join("")}</row>`
        )
        .join("")}</sheetData></worksheet>`;
    workbook.file(
      "xl/worksheets/notes.xml",
      xml([["Notes"], ["Not an inventory table"]])
    );
    workbook.file(
      "xl/worksheets/inventory.xml",
      xml([["Supplier: Example"], [], ...table, []])
    );
    const xlsxBytes = await workbook.generateAsync({ type: "nodebuffer" });
    const xlsxPrepared = await prepareStaffInventoryImport({
      context: { getSession: () => ({ userId: "staff-1" }) } as never,
      request: new Request("http://localhost/staff/import"),
      file: new File(
        [new Uint8Array(xlsxBytes).buffer as ArrayBuffer],
        "inventory.xlsx",
        {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        }
      ),
    });

    expect(csvPrepared.status).toBe("PREPARED");
    expect(xlsxPrepared.status).toBe("PREPARED");
    if (
      csvPrepared.status !== "PREPARED" ||
      xlsxPrepared.status !== "PREPARED"
    ) {
      throw new Error("Expected both spreadsheet proposals");
    }
    const logicalRows = (proposal: StaffImportProposal) =>
      proposal.rows.map((row) => ({
        title: row.title,
        quantity: row.receivedQuantity ?? row.quantity ?? row.proposedQuantity,
        manufacturer: row.manufacturer,
        mpn: row.manufacturerPartNumber,
        categoryId: row.categoryId,
        suggestedLocationId: row.suggestedLocationId,
      }));
    expect(csvPrepared.proposal.rows).toHaveLength(20);
    expect(xlsxPrepared.proposal.rows).toHaveLength(20);
    expect(logicalRows(csvPrepared.proposal)).toEqual(
      logicalRows(xlsxPrepared.proposal)
    );
    expect(logicalRows(csvPrepared.proposal)).toEqual(
      products.map((title, index) => ({
        title,
        quantity: index + 1,
        manufacturer: "Maker",
        mpn: `MPN-${index + 1}`,
        categoryId: "electronics",
        suggestedLocationId: null,
      }))
    );
  });

  it("asks staff to choose when multiple XLSX sheets contain inventory", async () => {
    const workbook = new JSZip();
    workbook.file(
      "xl/workbook.xml",
      '<workbook><sheets><sheet name="Cables" r:id="c"/><sheet name="Boards" r:id="b"/></sheets></workbook>'
    );
    workbook.file(
      "xl/_rels/workbook.xml.rels",
      '<Relationships><Relationship Target="worksheets/cables.xml" Id="c"/><Relationship Target="worksheets/boards.xml" Id="b"/></Relationships>'
    );
    const sheetXml = (name: string, product: string) =>
      `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Product</t></is></c><c r="B1" t="inlineStr"><is><t>Qty</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>${name} ${product}</t></is></c><c r="B2"><v>2</v></c></row></sheetData></worksheet>`;
    workbook.file("xl/worksheets/cables.xml", sheetXml("USB", "Cable"));
    workbook.file("xl/worksheets/boards.xml", sheetXml("Arduino", "Nano"));
    const buffer = await workbook.generateAsync({ type: "nodebuffer" });
    const file = {
      filename: "stock.xlsx",
      buffer: Buffer.from(buffer),
    };

    await expect(parseStaffImportFile(file)).rejects.toThrow(
      "multiple_inventory_sheets: More than one worksheet contains an inventory table"
    );
    const selectedRows = await parseStaffImportFile({
      ...file,
      filename: "stock",
      contentType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      spreadsheetSheet: "Cables",
    });
    expect(selectedRows).toHaveLength(1);
    expect(selectedRows[0]).toMatchObject({
      title: "USB Cable",
      quantity: 2,
      sourceSheet: "Cables",
    });
  });

  it("batches 65 rows and retains them safely when the helper is unavailable", async () => {
    // why: external persistence and helper transport are replaced to inspect the proposal boundary.
    vi.clearAllMocks();
    mockStaffAccess.mockResolvedValue({
      organizationId: "org-1",
      userId: "staff-1",
    });
    database.asset.findMany.mockResolvedValue([]);
    database.location.findMany.mockResolvedValue([]);
    mockGetCategories.mockResolvedValue([{ id: "boards", name: "Boards" }]);
    database.ioioWriteOperation.findUnique.mockResolvedValue(null);
    database.ioioWriteOperation.findFirst.mockResolvedValue({
      id: "spreadsheet-operation",
    });
    database.ioioImportItem.createMany.mockResolvedValue({ count: 65 });
    database.ioioImportItem.findMany.mockResolvedValue([]);
    mockRequestImportHelperProposal.mockResolvedValue({
      status: "manual",
      reason: "helper_not_configured",
    });
    const text =
      "Name,Quantity,Category\n" +
      Array.from({ length: 65 }, (_, index) => `Board ${index},2,Boards`).join(
        "\n"
      );
    const prepared = await prepareStaffInventoryImport({
      context: { getSession: () => ({ userId: "staff-1" }) } as never,
      request: new Request("http://localhost/staff/import"),
      file: new File([text], "inventory.csv", { type: "text/csv" }),
    });
    expect(prepared.status).toBe("PREPARED");
    if (prepared.status !== "PREPARED") throw new Error("Expected proposal");
    expect(prepared.proposal.rows).toHaveLength(65);
    expect(
      mockRequestImportHelperProposal.mock.calls.map(
        ([request]) => request.document.pages.length
      )
    ).toEqual([30, 30, 5]);
    expect(prepared.proposal.rows[0].sourceNotes).toContain(
      "helper_unavailable"
    );
    expect(mockCreateAsset).not.toHaveBeenCalled();
  });
  it("joins semantic cleanup by source identity while preserving received quantities", async () => {
    // why: isolate helper transport and database persistence while exercising shared proposal resolution.
    vi.clearAllMocks();
    mockStaffAccess.mockResolvedValue({
      organizationId: "org-1",
      userId: "staff-1",
    });
    database.asset.findMany.mockResolvedValue([]);
    database.location.findMany.mockResolvedValue([
      { id: "boards-shelf", name: "Board Shelf", parentId: null },
    ]);
    mockGetCategories.mockResolvedValue([{ id: "boards", name: "Boards" }]);
    database.ioioWriteOperation.findUnique.mockResolvedValue(null);
    database.ioioWriteOperation.findFirst.mockResolvedValue({
      id: "semantic-sheet",
    });
    database.ioioImportItem.createMany.mockResolvedValue({ count: 1 });
    database.ioioImportItem.findMany.mockResolvedValue([]);
    const response = makeGenericHelperReadyResult({
      pageText: "",
      items: [
        {
          productName: "Seeed Studio XIAO ESP32-S3 Sense",
          quantity: 99,
          evidenceText: "development tool",
        },
      ],
    });
    response.proposal.rows[0].sourceRef = "spreadsheet-row-2";
    response.proposal.rows[0].evidence[0].sourceRef = "spreadsheet-row-2";
    response.proposal.rows[0].categorySuggestion = {
      categoryId: "boards",
      proposedName: null,
      confidence: 0.95,
    } as never;
    mockRequestImportHelperProposal.mockResolvedValue(response);
    const prepared = await prepareStaffInventoryImport({
      context: { getSession: () => ({ userId: "staff-1" }) } as never,
      request: new Request("http://localhost/staff/import"),
      file: new File(
        ["Name,Received,MPN\ndevelopment tool,2,ESP32-S3\n"],
        "inventory.csv",
        { type: "text/csv" }
      ),
    });
    expect(prepared.status).toBe("PREPARED");
    if (prepared.status !== "PREPARED") throw new Error("Expected proposal");
    expect(prepared.proposal.rows[0]).toMatchObject({
      title: "Seeed Studio XIAO ESP32-S3 Sense",
      quantity: 2,
      manufacturerPartNumber: "ESP32-S3",
      category: "Boards",
    });
    expect(mockCreateAsset).not.toHaveBeenCalled();
  });
  it("uses formula cached values and rejects only cells without cached values", async () => {
    const zip = new JSZip();
    zip.file(
      "xl/workbook.xml",
      '<workbook><sheet name="Inventory" r:id="i"/></workbook>'
    );
    zip.file(
      "xl/_rels/workbook.xml.rels",
      '<Relationships><Relationship Id="i" Target="worksheets/data.xml"/></Relationships>'
    );
    zip.file(
      "xl/worksheets/data.xml",
      '<worksheet><row r="1"><c r="A1" t="inlineStr"><is><t>Name</t></is></c><c r="B1" t="inlineStr"><is><t>Qty</t></is></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>Board</t></is></c><c r="B3"><f>1+2</f><v>3</v></c></row><row r="4"><c r="A4" t="inlineStr"><is><t>Motor</t></is></c><c r="B4"><f>EXTERNAL()</f></c></row></worksheet>'
    );
    const rows = await parseStaffImportFile({
      filename: "stock.xlsx",
      buffer: await zip.generateAsync({ type: "nodebuffer" }),
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      title: "Board",
      quantity: 3,
      sourceRow: 3,
    });
    expect(rows[1].uncertainFields).toContain("Spreadsheet row");
  });
});

describe("spreadsheet manual table selection", () => {
  it("accepts an explicit header row and preserves partial rejection", async () => {
    const rows = await parseStaffImportFile({
      filename: "stock.csv",
      spreadsheetHeaderRow: 3,
      buffer: Buffer.from("Notes\nExample\nName,Qty\nBoard,3\nMotor,1.5\n"),
    });
    expect(rows[0]).toMatchObject({
      title: "Board",
      quantity: 3,
      sourceRow: 4,
    });
    expect(rows[1].uncertainFields).toContain("Spreadsheet row");
  });
});

describe("spreadsheet canonical category fallback", () => {
  it.each(["csv", "xlsx"])(
    "assigns obvious and source-hinted categories for %s when Claude returns null",
    async (format) => {
      // why: database and helper transport are external boundaries; actual parsers/resolvers build the proposal.
      vi.clearAllMocks();
      mockStaffAccess.mockResolvedValue({
        organizationId: "org-1",
        userId: "staff-1",
      });
      database.asset.findMany.mockResolvedValue([]);
      database.location.findMany.mockResolvedValue([]);
      mockGetCategories.mockResolvedValue([
        { id: "cables", name: "Cables & adapters" },
        { id: "electronics", name: "Electronics" },
      ]);
      database.ioioWriteOperation.findUnique.mockResolvedValue(null);
      database.ioioWriteOperation.findFirst.mockResolvedValue({
        id: "category-fallback",
      });
      database.ioioImportItem.createMany.mockResolvedValue({ count: 3 });
      database.ioioImportItem.findMany.mockResolvedValue([]);
      mockRequestImportHelperProposal.mockResolvedValue({
        status: "manual",
        reason: "helper_not_configured",
      });
      const matrix = [
        ["Name", "Quantity", "Category"],
        ["USB-C Cable", "20", ""],
        ["Arduino Nano", "5", ""],
        ["Part 42", "2", "Cables"],
      ];
      let buffer: Buffer<ArrayBufferLike> = Buffer.from(
        matrix.map((row) => row.join(",")).join("\n")
      );
      if (format === "xlsx") {
        const zip = new JSZip();
        zip.file(
          "xl/workbook.xml",
          '<workbook><sheet name="Inventory" r:id="i"/></workbook>'
        );
        zip.file(
          "xl/_rels/workbook.xml.rels",
          '<Relationships><Relationship Id="i" Target="worksheets/data.xml"/></Relationships>'
        );
        zip.file(
          "xl/worksheets/data.xml",
          "<worksheet>" +
            matrix
              .map(
                (row, index) =>
                  "<row>" +
                  row
                    .map(
                      (value, col) =>
                        `<c r="${String.fromCharCode(65 + col)}${
                          index + 1
                        }" t="inlineStr"><is><t>${value}</t></is></c>`
                    )
                    .join("") +
                  "</row>"
              )
              .join("") +
            "</worksheet>"
        );
        buffer = await zip.generateAsync({ type: "nodebuffer" });
      }
      const prepared = await prepareStaffInventoryImport({
        context: { getSession: () => ({ userId: "staff-1" }) } as never,
        request: new Request("http://localhost/staff/import"),
        file: new File([Uint8Array.from(buffer).buffer], `stock.${format}`),
      });
      if (prepared.status !== "PREPARED") throw new Error("Expected proposal");
      expect(prepared.proposal.rows.map((row) => row.categoryId)).toEqual([
        "cables",
        "electronics",
        "cables",
      ]);
      expect(mockCreateAsset).not.toHaveBeenCalled();
    }
  );
});

describe("staff inventory import revert", () => {
  const createProposal = (action: "CREATE" | "INCREASE_QUANTITY") => {
    const content = {
      version: 1 as const,
      operationId: "revert-operation",
      organizationId: "org-1",
      source: { filename: "inventory.csv", size: 42, sha256: "sha" },
      rows: [
        {
          rowNumber: 1,
          title: "Arduino Nano",
          action,
          assetId: action === "CREATE" ? null : "asset-1",
          categoryId: null,
          locationId: null,
          currentQuantity: action === "CREATE" ? null : 2,
          currentCategoryId: null,
          currentLocationId: null,
          quantity: 3,
          receivedQuantity: 3,
          type: "QUANTITY_TRACKED" as const,
          reason: "Imported inventory",
        },
      ],
      counts: {} as StaffImportProposal["counts"],
      createdAt: new Date().toISOString(),
    };
    return {
      ...content,
      proposalHash: getStaffImportProposalHash(content),
    } as StaffImportProposal;
  };

  const setupOperation = (
    proposal: StaffImportProposal,
    ledgerItem: Record<string, unknown>,
    status = "SUCCEEDED"
  ) => {
    const operation = {
      id: proposal.operationId,
      status,
      createdAt: new Date(),
      description: JSON.stringify({
        proposal,
        reviewDraft: [{ rowNumber: 1, decision: "APPROVE" }],
      }),
    };
    database.ioioWriteOperation.findFirst.mockImplementation(() => ({
      ...operation,
    }));
    database.ioioWriteOperation.updateMany.mockImplementation(
      ({ where, data }) => {
        if (where.status !== operation.status) return { count: 0 };
        Object.assign(operation, data);
        return { count: 1 };
      }
    );
    database.ioioImportItem.findMany.mockResolvedValue([ledgerItem]);
    database.ioioImportItem.updateMany.mockImplementation(({ where, data }) => {
      if (
        where.operationId === operation.id &&
        where.rowKey === ledgerItem.rowKey &&
        where.status === ledgerItem.status
      ) {
        Object.assign(ledgerItem, data);
        if (data.writtenState) ledgerItem.writtenState = null;
        return { count: 1 };
      }
      return { count: 0 };
    });
    return operation;
  };

  const revert = (rowNumber = 1) =>
    revertStaffInventoryImportRow({
      context: { getSession: () => ({ userId: "staff-1" }) } as never,
      request: new Request("http://localhost/staff/import"),
      operationId: "revert-operation",
      rowNumber,
    });

  it("reopens a completed import as a read-only proposal with implemented rows", async () => {
    const proposal = createProposal("CREATE");
    const ledgerItem = {
      id: "ledger-1",
      rowKey: "row-1",
      unitIndex: null,
      status: "DONE",
      expectedPrior: { kind: "CREATE", rowKey: "row-1" },
      writtenState: { outcome: "created", assetId: "asset-1" },
    };
    const operation = {
      id: proposal.operationId,
      status: "SUCCEEDED",
      createdAt: new Date(),
      description: JSON.stringify({
        proposal,
        reviewDraft: [],
        revertedRowNumbers: [1],
      }),
    };
    database.ioioWriteOperation.findFirst.mockResolvedValue(operation);
    database.ioioImportItem.findMany.mockResolvedValue([ledgerItem]);

    const reopened = await getStaffInventoryImportProposal({
      context: { getSession: () => ({ userId: "staff-1" }) } as never,
      request: new Request("http://localhost/staff/import"),
      operationId: proposal.operationId,
    });

    expect(reopened).toMatchObject({
      reviewClosed: true,
      appliedRowNumbers: [1],
      revertibleRowNumbers: [1],
      revertedRowNumbers: [],
    });
  });

  it("reverts a newly created asset through Shelf's audited delete service", async () => {
    const proposal = createProposal("CREATE");
    const timestamp = new Date();
    const ledgerItem = {
      id: "ledger-1",
      rowKey: "row-1",
      unitIndex: null,
      status: "DONE",
      updatedAt: timestamp,
      expectedPrior: { kind: "CREATE", rowKey: "row-1" },
      writtenState: { outcome: "created", assetId: "asset-1" },
    };
    const operation = setupOperation(proposal, ledgerItem, "PREPARED");
    database.asset.findFirst.mockResolvedValue({
      id: "asset-1",
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    await expect(revert()).resolves.toEqual({
      operationId: "revert-operation",
      rowNumber: 1,
      reverted: true,
    });

    expect(mockDeleteAsset).toHaveBeenCalledWith({
      id: "asset-1",
      organizationId: "org-1",
      actorUserId: "staff-1",
    });
    expect(mockUpdateAsset).not.toHaveBeenCalled();
    expect(ledgerItem).toMatchObject({ status: "PENDING", writtenState: null });
    expect(JSON.parse(operation.description)).toMatchObject({
      revertedRowNumbers: [1],
      reviewDraft: [{ rowNumber: 1, decision: null }],
      revertHistory: [
        {
          rowNumber: 1,
          ledgerItems: [
            {
              status: "DONE",
              writtenState: { outcome: "created", assetId: "asset-1" },
            },
          ],
        },
      ],
    });
    expect(operation.status).toBe("PREPARED");

    const proposalAfterRevert = await getStaffInventoryImportProposal({
      context: { getSession: () => ({ userId: "staff-1" }) } as never,
      request: new Request("http://localhost/staff/import"),
      operationId: proposal.operationId,
    });
    expect(proposalAfterRevert).toMatchObject({
      appliedRowNumbers: [],
      revertedRowNumbers: [1],
      reviewClosed: false,
      savedReviewDecisions: [{ rowNumber: 1, decision: null }],
    });

    await expect(revert()).rejects.toThrow("already been reverted");
    expect(mockDeleteAsset).toHaveBeenCalledTimes(1);
  });

  it("restores an updated asset only when the imported value is still current", async () => {
    const proposal = createProposal("INCREASE_QUANTITY");
    const updatedAt = new Date();
    const snapshot = {
      kind: "ASSET_UPDATE",
      action: "INCREASE_QUANTITY",
      assetId: "asset-1",
      before: { quantity: 2, categoryId: null, manualLocationIds: [] },
      target: { quantity: 5 },
    };
    setupOperation(proposal, {
      id: "ledger-1",
      rowKey: "row-1",
      unitIndex: null,
      status: "DONE",
      updatedAt,
      expectedPrior: snapshot,
      writtenState: {
        outcome: "updated",
        assetId: "asset-1",
        action: "INCREASE_QUANTITY",
      },
    });
    database.asset.findFirst.mockResolvedValue({
      id: "asset-1",
      quantity: 5,
      categoryId: null,
      updatedAt,
      assetLocations: [],
    });

    await revert();

    expect(mockUpdateAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "asset-1",
        quantity: 2,
        organizationId: "org-1",
        userId: "staff-1",
      })
    );
    expect(mockDeleteAsset).not.toHaveBeenCalled();
  });

  it("refuses to delete a created asset after it has changed", async () => {
    const proposal = createProposal("CREATE");
    const operation = setupOperation(proposal, {
      id: "ledger-1",
      rowKey: "row-1",
      unitIndex: null,
      status: "DONE",
      updatedAt: new Date("2026-01-01T00:00:00.500Z"),
      expectedPrior: { kind: "CREATE", rowKey: "row-1" },
      writtenState: { outcome: "created", assetId: "asset-1" },
    });
    database.asset.findFirst.mockResolvedValue({
      id: "asset-1",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:01.000Z"),
    });

    await expect(revert()).rejects.toThrow("changed after it was created");

    expect(mockDeleteAsset).not.toHaveBeenCalled();
    expect(operation.status).toBe("SUCCEEDED");
  });
});
