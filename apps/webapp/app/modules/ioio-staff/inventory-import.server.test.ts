import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";

// why: the tests exercise the pure file parsing and row classification logic;
// database and Shelf mutation services must not be initialized for those tests.
vi.mock("~/database/db.server", () => ({
  db: {},
}));

// why: the classification tests must prove they do not accidentally invoke a
// real Shelf write service while constructing a proposal.
vi.mock("~/modules/asset/service.server", () => ({
  createAsset: vi.fn(),
  updateAsset: vi.fn(),
}));

// why: access is only exercised by the request-level prepare/apply functions,
// not by these pure parser and classifier tests.
vi.mock("./access.server", () => ({
  requireIoioStaffAccess: vi.fn(),
}));

import {
  classifyStaffImportRows,
  parseStaffImportFile,
} from "./inventory-import.server";

describe("staff inventory import safety", () => {
  it("parses the supported safe columns and preserves row numbers", async () => {
    const rows = await parseStaffImportFile({
      filename: "inventory.csv",
      contentType: "text/csv",
      buffer: Buffer.from(
        "Name,Quantity,Category,Location\nArduino Nano,8,Boards,B477\n"
      ),
    });

    expect(rows).toEqual([
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

  it("keeps a clear fatal error for an unreadable PDF", async () => {
    await expect(
      parseStaffImportFile({
        filename: "inventory.pdf",
        contentType: "application/pdf",
        buffer: Buffer.from("%PDF-1.4\nnot readable inventory text", "latin1"),
      })
    ).rejects.toThrow("no readable inventory text");
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
});
