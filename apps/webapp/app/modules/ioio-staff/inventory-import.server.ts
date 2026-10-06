import { randomUUID } from "node:crypto";
import { inflateRawSync, inflateSync } from "node:zlib";
import { AssetType, ConsumptionType } from "@prisma/client";
import { parse as parseCsv } from "csv-parse/sync";
import JSZip from "jszip";
import { z } from "zod";
import { db } from "~/database/db.server";
import { createAsset, updateAsset } from "~/modules/asset/service.server";
import { getActiveCategoriesForOrganization } from "~/modules/category/service.server";
import {
  callOpenRouter,
  OpenRouterProviderError,
  OPENROUTER_MODEL,
  type OpenRouterMessage,
} from "~/modules/ioio-student/openrouter.server";
import { OPENROUTER_API_KEY } from "~/utils/env";
import { ShelfError } from "~/utils/error";
import { Logger } from "~/utils/logger";
import { requireIoioStaffAccess } from "./access.server";

export const STAFF_IMPORT_OPERATION = "INVENTORY_IMPORT";
export const STAFF_IMPORT_MAX_BYTES = 5 * 1024 * 1024;
export const STAFF_IMPORT_MAX_ROWS = 1000;
export const STAFF_IMPORT_MAX_PAGES = 50;
export const STAFF_IMPORT_REVIEW_RETENTION_MS = 24 * 60 * 60 * 1000;

export type StaffImportFormat = "CSV" | "XLSX" | "PDF";

export type StaffImportAction =
  | "CREATE"
  | "INCREASE_QUANTITY"
  | "NO_CHANGE"
  | "POSSIBLE_DUPLICATE"
  | "NEEDS_REVIEW"
  | "IGNORE"
  | "UPDATE_QUANTITY"
  | "UPDATE_LOCATION"
  | "UPDATE_CATEGORY"
  | "AMBIGUOUS"
  | "REJECT";

/**
 * Historical/import normalization vocabulary. Live category selectors use
 * organization records from getActiveCategoriesForOrganization instead.
 */
export const IOIO_PROCUREMENT_CATEGORIES = [
  "Boards & Embedded Systems",
  "Components & Prototyping",
  "Motors, Power & Actuation",
  "Cables & Connectivity",
  "Tools & Fabrication",
  "Measurement & Lab Equipment",
  "Computing, AV & Imaging",
  "Kits & Complete Sets",
  "Old Projects / Legacy / Unknown",
  "Storage Infrastructure",
] as const;

export type IoioProcurementCategory =
  (typeof IOIO_PROCUREMENT_CATEGORIES)[number];

export type ProcurementQuantityStatus =
  | "RECEIVED"
  | "SHIPPED"
  | "ORDERED"
  | "UNKNOWN";

export type StaffImportRow = {
  rowNumber: number;
  title: string;
  quantity: number | null;
  category: string | null;
  location: string | null;
  type: "INDIVIDUAL" | "QUANTITY_TRACKED" | null;
  sourceDescription?: string | null;
  manufacturer?: string | null;
  manufacturerPartNumber?: string | null;
  supplierPartNumber?: string | null;
  unitDescription?: string | null;
  sourceNotes?: string | null;
  orderedQuantity?: number | null;
  receivedQuantity?: number | null;
  quantityStatus?: ProcurementQuantityStatus;
  categoryConfidence?: "High" | "Medium" | "Low";
  categoryReason?: string;
  reviewRequired?: boolean;
  uncertainFields?: string[];
  pdfClassification?: "VALID_ITEM" | "PARTIAL";
};

export type StaffImportPdfSummary = {
  validItemRows: number;
  needsReview: number;
  ignoredRows: number;
};

export type StaffImportProposalRow = StaffImportRow & {
  action: StaffImportAction;
  assetId: string | null;
  categoryId: string | null;
  locationId: string | null;
  currentQuantity: number | null;
  currentCategoryId: string | null;
  currentLocationId: string | null;
  proposedQuantity?: number | null;
  suggestedCategory?: IoioProcurementCategory;
  categoryConfidence?: "High" | "Medium" | "Low";
  categoryReason?: string;
  locationLabel?: string;
  matchCandidates?: Array<{
    id: string;
    title: string;
    quantity: number | null;
    type: AssetType;
    category: string | null;
    location: string | null;
  }>;
  reason: string;
};

export type StaffImportProposal = {
  version: 1;
  operationId: string;
  organizationId: string;
  source: {
    filename: string;
    size: number;
    sha256: string;
    format?: StaffImportFormat;
    extractionProvider?: string;
  };
  rows: StaffImportProposalRow[];
  counts: Record<StaffImportAction, number>;
  createdAt: string;
  categoryOptions?: NamedRecord[];
  locationOptions?: NamedRecord[];
  pdfSummary?: StaffImportPdfSummary;
};

type ExistingAsset = {
  id: string;
  title: string;
  type: AssetType;
  quantity: number | null;
  description?: string | null;
  categoryId: string | null;
  assetLocations: Array<{ locationId: string; quantity: number }>;
};

type NamedRecord = { id: string; name: string };

const HEADER_ALIASES: Record<string, keyof StaffImportRow> = {
  title: "title",
  name: "title",
  item: "title",
  "item name": "title",
  quantity: "quantity",
  qty: "quantity",
  count: "quantity",
  category: "category",
  location: "location",
  "tracking type": "type",
  type: "type",
  description: "sourceDescription",
  "product description": "sourceDescription",
  "unit description": "unitDescription",
  manufacturer: "manufacturer",
  "manufacturer name": "manufacturer",
  mpn: "manufacturerPartNumber",
  "manufacturer part number": "manufacturerPartNumber",
  "manufacturer part no": "manufacturerPartNumber",
  "supplier part number": "supplierPartNumber",
  "supplier part no": "supplierPartNumber",
  spn: "supplierPartNumber",
  "quantity ordered": "orderedQuantity",
  "ordered quantity": "orderedQuantity",
  "qty ordered": "orderedQuantity",
  "quantity shipped": "receivedQuantity",
  "shipped quantity": "receivedQuantity",
  "quantity received": "receivedQuantity",
  "received quantity": "receivedQuantity",
  "delivered quantity": "receivedQuantity",
  notes: "sourceNotes",
  "line notes": "sourceNotes",
};

const PRIVATE_HEADER =
  /borrower|borrowed by|email|e-mail|student|phone|contact|lending.?id|user.?id|auth|role/i;
const IGNORED_HEADER =
  /price|value|vat|tax|invoice|subtotal|total|address|payment|currency|account|page/i;

function importError(message: string) {
  return new ShelfError({
    cause: null,
    message,
    label: "Assets",
    status: 400,
    shouldBeCaptured: false,
  });
}

function isStaffImportExpired(createdAt: Date, now = new Date()) {
  return (
    now.getTime() - createdAt.getTime() >= STAFF_IMPORT_REVIEW_RETENTION_MS
  );
}

function staffImportUnavailableError() {
  return importError("This import proposal is no longer available.");
}

function decodeXml(value: string) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCodePoint(Number(code))
    )
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) =>
      String.fromCodePoint(parseInt(code, 16))
    );
}

function safeCell(value: unknown, field: string) {
  const text = [...String(value ?? "")]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code > 31 && code !== 127;
    })
    .join("")
    .trim();
  if (text.length > 500) throw importError(`${field} is too long.`);
  if (/^[=+@]/.test(text)) {
    throw importError(`${field} contains an unsupported formula-like value.`);
  }
  return text;
}

function columnIndex(reference: string) {
  const letters = reference.match(/^[A-Z]+/i)?.[0].toUpperCase() ?? "A";
  return (
    [...letters].reduce(
      (total, letter) => total * 26 + letter.charCodeAt(0) - 64,
      0
    ) - 1
  );
}

function parseSheetXml(xml: string, sharedStrings: string[]) {
  if (/<f(?:\s|>)/i.test(xml)) {
    throw importError(
      "Formula cells are not accepted. Export the file as values and try again."
    );
  }
  const rows: string[][] = [];
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/gi)) {
    const cells: string[] = [];
    for (const cellMatch of rowMatch[1].matchAll(
      /<c\b([^>]*)>([\s\S]*?)<\/c>/gi
    )) {
      const attributes = cellMatch[1];
      const body = cellMatch[2];
      const index = columnIndex(
        attributes.match(/\br="([A-Z]+\d+)"/i)?.[1] ?? "A1"
      );
      const type = attributes.match(/\bt="([^"]+)"/i)?.[1];
      const raw =
        type === "inlineStr"
          ? [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)]
              .map((match) => decodeXml(match[1]))
              .join("")
          : decodeXml(body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/i)?.[1] ?? "");
      const value = type === "s" ? sharedStrings[Number(raw)] ?? "" : raw;
      cells[index] = value;
    }
    rows.push(cells.map((cell) => cell ?? ""));
  }
  return rows;
}

function decodePdfLiteral(value: string) {
  return value
    .replace(/\\([nrtbf\\()])/g, (_, character: string) => {
      const escapes: Record<string, string> = {
        n: "\n",
        r: "\r",
        t: "\t",
        b: "\b",
        f: "\f",
        "\\": "\\",
        "(": "(",
        ")": ")",
      };
      return escapes[character] ?? character;
    })
    .replace(/\\([0-7]{1,3})/g, (_, octal: string) =>
      String.fromCharCode(parseInt(octal, 8))
    );
}

function extractPdfStrings(value: string) {
  const textShowOperators = [
    ...value.matchAll(/\(((?:\\.|[^\\()])*)\)\s*T[Jj]/g),
    ...value.matchAll(/\[((?:\\.|[^\\\]])*)\]\s*TJ/g),
  ];
  return textShowOperators
    .flatMap((match) =>
      match[0].startsWith("[")
        ? [...match[1].matchAll(/\(((?:\\.|[^\\()])*)\)/g)].map(
            (literal) => literal[1]
          )
        : [match[1]]
    )
    .map((literal) => decodePdfLiteral(literal).trim())
    .filter(Boolean);
}

function extractPdfText(buffer: Buffer) {
  if (!buffer.subarray(0, 5).toString("ascii").startsWith("%PDF-")) {
    throw importError("The uploaded file is not a valid PDF.");
  }

  const source = buffer.toString("latin1");
  const pageCount = (source.match(/\/Type\s*\/Page\b/g) ?? []).length;
  if (pageCount > STAFF_IMPORT_MAX_PAGES) {
    throw importError(
      `The PDF contains more than ${STAFF_IMPORT_MAX_PAGES} pages.`
    );
  }

  const strings: string[] = [];
  for (const stream of source.matchAll(
    /stream\r?\n([\s\S]*?)\r?\nendstream/g
  )) {
    const streamStart = stream.index ?? 0;
    const header = source.slice(Math.max(0, streamStart - 1200), streamStart);
    const encoded = Buffer.from(stream[1], "latin1");
    let decoded = encoded;
    if (/\/FlateDecode/.test(header)) {
      try {
        decoded = inflateSync(encoded);
      } catch {
        try {
          decoded = inflateRawSync(encoded);
        } catch {
          continue;
        }
      }
    }
    strings.push(...extractPdfStrings(decoded.toString("utf8")));
  }

  if (strings.length === 0) strings.push(...extractPdfStrings(source));
  const text = strings
    .join("\n")
    .split("\0")
    .join(" ")
    .split("\v")
    .join(" ")
    .split("\f")
    .join(" ")
    .trim();
  if (!text) {
    throw importError(
      "The PDF contains no readable inventory text. Upload a text-based PDF for review."
    );
  }
  return text;
}

/** Best-effort local text extraction for receipt review. No document data is
 * sent to an external provider; unreadable/scanned files use manual entry. */
export function extractPdfTextForReceiptReview(buffer: Buffer) {
  try {
    return extractPdfText(buffer);
  } catch {
    return "";
  }
}

const procurementAiItemSchema = z.object({
  productName: z.string().trim().max(300),
  originalDescription: z.string().trim().max(500).nullable().optional(),
  manufacturer: z.string().trim().max(200).nullable().optional(),
  manufacturerPartNumber: z.string().trim().max(200).nullable().optional(),
  supplierPartNumber: z.string().trim().max(200).nullable().optional(),
  orderedQuantity: z.number().int().positive().nullable().optional(),
  receivedQuantity: z.number().int().positive().nullable().optional(),
  quantityStatus: z
    .enum(["RECEIVED", "SHIPPED", "ORDERED", "UNKNOWN"])
    .optional(),
  unitDescription: z.string().trim().max(200).nullable().optional(),
  notes: z.string().trim().max(300).nullable().optional(),
  category: z.enum(IOIO_PROCUREMENT_CATEGORIES).nullable().optional(),
  categoryConfidence: z.enum(["High", "Medium", "Low"]).optional(),
  categoryReason: z.string().trim().max(240).optional(),
  ignore: z.boolean().optional(),
});

const procurementAiResponseSchema = z.object({
  items: z.array(procurementAiItemSchema).max(STAFF_IMPORT_MAX_ROWS),
});

function sanitizeProcurementText(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter(
      (line) =>
        !/\b(?:invoice|vat|tax|subtotal|total|payment|bank|account|bill to|ship to|delivery address|due date)\b/i.test(
          line
        )
    )
    .map((line) =>
      line
        .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[redacted email]")
        .replace(/\+?\d[\d ()-]{7,}\d/g, "[redacted phone]")
        .replace(/(?:[$€£]\s?\d[\d,.]*|\d[\d,.]*\s?(?:USD|EUR|GBP))/gi, "")
        .trim()
    )
    .filter(Boolean)
    .slice(0, 4000)
    .join("\n");
}

function parseJsonObject(content: string) {
  const withoutFence = content
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  const start = withoutFence.indexOf("{");
  const end = withoutFence.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(withoutFence.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
}

async function parseProcurementPdfWithAi(text: string) {
  if (!OPENROUTER_API_KEY) {
    throw importError(
      "The PDF was readable, but no structured inventory rows were found. Use a table with columns for Name, Quantity, Category, or Location."
    );
  }

  const sanitized = sanitizeProcurementText(text);
  if (!sanitized) {
    throw importError(
      "No inventory items could be reliably extracted from this document."
    );
  }

  const lines = sanitized.split("\n");
  const chunks: string[][] = [];
  for (let index = 0; index < lines.length; index += 30) {
    chunks.push(lines.slice(index, index + 30));
  }
  const items: z.infer<typeof procurementAiItemSchema>[] = [];
  for (const chunk of chunks) {
    const messages: OpenRouterMessage[] = [
      {
        role: "system",
        content: `You extract physical inventory lines from supplier documents.
Return JSON only in the shape {"items":[...]}. Do not include invoice numbers,
prices, VAT, totals, addresses, payment details, page markers, or people.
Each item must use one of these exact categories when category evidence exists:
${IOIO_PROCUREMENT_CATEGORIES.join(", ")}.
Use category null and Low confidence when uncertain. Never invent part numbers
or quantities. If a line is not a physical inventory item, set ignore true.
If the document says only ordered, set quantityStatus to ORDERED and leave
receivedQuantity null. Use RECEIVED or SHIPPED only when the document supports
that physical quantity. Keep categoryReason concise.`,
      },
      {
        role: "user",
        content: `Extract supplier inventory lines from this document excerpt:\n${chunk.join(
          "\n"
        )}`,
      },
    ];
    let completion;
    try {
      completion = await callOpenRouter({
        apiKey: OPENROUTER_API_KEY,
        messages,
        tools: [],
        toolChoice: "auto",
      });
    } catch (cause) {
      if (cause instanceof OpenRouterProviderError) {
        throw importError(
          "The document could not be reliably extracted for review. You can upload a structured CSV or XLSX instead."
        );
      }
      throw cause;
    }
    const parsed = procurementAiResponseSchema.safeParse(
      parseJsonObject(completion.content)
    );
    if (parsed.success) items.push(...parsed.data.items);
  }

  if (!items.length) {
    throw importError(
      "No inventory items could be reliably extracted from this document."
    );
  }

  const rows = items.slice(0, STAFF_IMPORT_MAX_ROWS).map((item, index) => {
    const receivedQuantity = item.receivedQuantity ?? null;
    const orderedQuantity = item.orderedQuantity ?? null;
    const quantity = receivedQuantity ?? orderedQuantity;
    const title = item.productName.trim();
    const partial =
      item.ignore === true ||
      !title ||
      quantity === null ||
      item.quantityStatus === "ORDERED" ||
      !item.category;
    return {
      rowNumber: index + 2,
      title,
      quantity,
      category: item.category ?? null,
      location: null,
      type: quantity && quantity > 1 ? "QUANTITY_TRACKED" : "INDIVIDUAL",
      sourceDescription: item.originalDescription ?? title,
      manufacturer: item.manufacturer ?? null,
      manufacturerPartNumber: item.manufacturerPartNumber ?? null,
      supplierPartNumber: item.supplierPartNumber ?? null,
      unitDescription: item.unitDescription ?? null,
      sourceNotes: item.notes ?? null,
      orderedQuantity,
      receivedQuantity,
      quantityStatus:
        item.quantityStatus ?? (receivedQuantity ? "RECEIVED" : "UNKNOWN"),
      reviewRequired: partial,
      pdfClassification: partial ? "PARTIAL" : "VALID_ITEM",
      uncertainFields: [
        ...(quantity === null ? ["Quantity"] : []),
        ...(item.quantityStatus === "ORDERED" ? ["Received quantity"] : []),
        ...(!item.category ? ["Category"] : []),
        ...(item.ignore === true ? ["Not an inventory item"] : []),
      ],
      ...(item.categoryConfidence
        ? { categoryConfidence: item.categoryConfidence }
        : {}),
      ...(item.categoryReason ? { categoryReason: item.categoryReason } : {}),
    } satisfies StaffImportRow;
  });
  return {
    rows,
    pdfSummary: {
      validItemRows: rows.filter(
        (row) => row.pdfClassification === "VALID_ITEM"
      ).length,
      needsReview: rows.filter((row) => row.pdfClassification === "PARTIAL")
        .length,
      ignoredRows: rows.filter(
        (row) => row.uncertainFields?.includes("Not an inventory item")
      ).length,
    } satisfies StaffImportPdfSummary,
    provider: `openrouter:${OPENROUTER_MODEL}`,
  };
}

function isPdfHeaderRow(cells: string[]) {
  const normalized = cells.map((cell) => cell.trim().toLocaleLowerCase());
  const text = normalized.join(" ");
  const hasNameHeader =
    normalized.some((cell) =>
      ["name", "item", "item name", "title", "asset"].includes(cell)
    ) || /\b(?:item|name|asset|inventory)\b/.test(text);
  const hasInventoryHeader =
    normalized.some((cell) =>
      [
        "quantity",
        "qty",
        "count",
        "quantity ordered",
        "ordered quantity",
        "quantity shipped",
        "shipped quantity",
        "quantity received",
        "received quantity",
        "category",
        "location",
        "tracking type",
        "type",
        "description",
        "manufacturer",
        "mpn",
        "manufacturer part number",
        "supplier part number",
      ].includes(cell)
    ) ||
    /\b(?:quantity|qty|count|ordered|shipped|received|category|location|description|manufacturer|part number)\b/.test(
      text
    );
  return hasNameHeader && hasInventoryHeader;
}

function isPdfNoiseRow(cells: string[], header: string[] | null) {
  const values = cells.map((cell) => cell.trim()).filter(Boolean);
  if (values.length === 0) return true;

  if (
    header &&
    cells.length === header.length &&
    cells.every(
      (cell, index) => cell.trim().toLocaleLowerCase() === header[index]
    )
  ) {
    return true;
  }

  if (isPdfHeaderRow(cells)) return true;

  const compact = values.join(" ").replace(/\s+/g, " ").trim();
  if (
    /^page\s+\d+(?:\s+of\s+\d+)?$/i.test(compact) ||
    /^\d+\s*\/\s*\d+$/.test(compact) ||
    /^\d+$/.test(compact) ||
    /^(?:generated on|confidential|inventory report)\b/i.test(compact)
  ) {
    return true;
  }
  return values.every((value) => /^[-_.]+$/.test(value));
}

function parsePdfRowsFromText(text: string) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const delimiter = ["|", "\t", ";", ","]
    .map((candidate) => ({
      candidate,
      count: lines.reduce(
        (total, line) => total + (line.split(candidate).length - 1),
        0
      ),
    }))
    .sort((left, right) => right.count - left.count)[0];

  if (!delimiter || delimiter.count === 0) {
    throw importError(
      "The PDF text was readable, but no structured inventory rows were found. Use a table with columns for Name, Quantity, Category, or Location."
    );
  }

  const matrix = lines.map((line) =>
    line.split(delimiter.candidate).map((cell) => cell.trim())
  );
  const headerIndex = matrix.findIndex((cells) => isPdfHeaderRow(cells));
  const sourceMatrix =
    headerIndex >= 0
      ? matrix.slice(headerIndex)
      : matrix.filter((cells) => !isPdfNoiseRow(cells, null));
  if (sourceMatrix.length === 0) {
    throw importError(
      "The PDF was readable, but no recoverable inventory rows were found."
    );
  }
  const firstRow = sourceMatrix[0];
  const header =
    headerIndex >= 0
      ? firstRow.map((cell) => cell.trim().toLocaleLowerCase())
      : null;
  const filteredMatrix = sourceMatrix.filter(
    (cells, index) => index === 0 || !isPdfNoiseRow(cells, header)
  );
  const parsedRows = parseRows(
    header
      ? filteredMatrix
      : [
          ["Name", "Quantity", "Category", "Location"].slice(
            0,
            firstRow.length
          ),
          ...filteredMatrix,
        ],
    {
      allowMissingTitle: true,
      ignoreUnsupportedColumns: true,
      tolerateInvalidValues: true,
    }
  );
  const rows = parsedRows.map((row) => {
    const uncertainFields = [
      ...(row.uncertainFields ?? []),
      row.category === null ? "Category" : null,
      row.location === null ? "Location" : null,
    ].filter((field): field is string => Boolean(field));
    const sourceClassification =
      row.title &&
      !uncertainFields.some((field) =>
        ["Item name", "Quantity", "Tracking type"].includes(field)
      )
        ? "VALID_ITEM"
        : "PARTIAL";
    return {
      ...row,
      reviewRequired: true,
      pdfClassification: sourceClassification,
      uncertainFields,
    } satisfies StaffImportRow;
  });
  const ignoredRows = matrix.length - filteredMatrix.length + (header ? 1 : 0);
  if (rows.length === 0) {
    throw importError(
      "The PDF was readable, but no recoverable inventory rows were found."
    );
  }
  return {
    rows,
    pdfSummary: {
      validItemRows: rows.filter(
        (row) => row.pdfClassification === "VALID_ITEM"
      ).length,
      needsReview: rows.filter((row) => row.pdfClassification === "PARTIAL")
        .length,
      ignoredRows,
    } satisfies StaffImportPdfSummary,
  };
}

async function parseXlsx(buffer: Buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const filenames = Object.keys(zip.files);
  if (
    filenames.some(
      (filename) =>
        filename.toLowerCase().includes("externallinks/") ||
        filename.toLowerCase().endsWith("vbaproject.bin")
    )
  ) {
    throw importError("Macros and external workbook links are not accepted.");
  }

  const sharedStringsXml = await zip
    .file("xl/sharedStrings.xml")
    ?.async("string");
  const sharedStrings = sharedStringsXml
    ? [...sharedStringsXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi)].map(
        (match) =>
          [...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)]
            .map((textMatch) => decodeXml(textMatch[1]))
            .join("")
      )
    : [];

  const workbook = await zip.file("xl/workbook.xml")?.async("string");
  const firstSheetId = workbook?.match(/<sheet\b[^>]*r:id="([^"]+)"/i)?.[1];
  const relationships = await zip
    .file("xl/_rels/workbook.xml.rels")
    ?.async("string");
  const target = firstSheetId
    ? relationships?.match(
        new RegExp(
          `<Relationship\\b[^>]*Id="${firstSheetId}"[^>]*Target="([^"]+)"`,
          "i"
        )
      )?.[1]
    : null;
  const sheetPath = target
    ? target.startsWith("/")
      ? target.slice(1)
      : `xl/${target.replace(/^\.\//, "")}`
    : "xl/worksheets/sheet1.xml";
  const sheetXml = await zip.file(sheetPath)?.async("string");
  if (!sheetXml)
    throw importError("The XLSX workbook has no readable first worksheet.");
  return parseSheetXml(sheetXml, sharedStrings);
}

function headerMap(
  headers: string[],
  options: { ignoreUnsupportedColumns?: boolean } = {}
) {
  const map = new Map<number, keyof StaffImportRow>();
  const seen = new Set<string>();
  headers.forEach((rawHeader, index) => {
    const header = safeCell(rawHeader, "Column name")
      .toLowerCase()
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!header) return;
    if (PRIVATE_HEADER.test(header)) {
      throw importError(
        "Personal borrower or account columns are not accepted."
      );
    }
    const field = HEADER_ALIASES[header];
    if (!field) {
      if (IGNORED_HEADER.test(header)) return;
      if (options.ignoreUnsupportedColumns) return;
      throw importError(`Unsupported import column: ${rawHeader}.`);
    }
    if (seen.has(field))
      throw importError(`Duplicate import column: ${rawHeader}.`);
    seen.add(field);
    map.set(index, field);
  });
  if (
    ![...map.values()].includes("title") &&
    ![...map.values()].includes("sourceDescription")
  ) {
    throw importError("The file must include a Name, Item, or Title column.");
  }
  return map;
}

type ParseRowsOptions = {
  allowMissingTitle?: boolean;
  ignoreUnsupportedColumns?: boolean;
  tolerateInvalidValues?: boolean;
};

function parseRows(matrix: string[][], options: ParseRowsOptions = {}) {
  if (matrix.length < 2) throw importError("The file has no data rows.");
  if (matrix.length - 1 > STAFF_IMPORT_MAX_ROWS) {
    throw importError(
      `The file contains more than ${STAFF_IMPORT_MAX_ROWS} data rows.`
    );
  }
  const mapping = headerMap(matrix[0], options);
  return matrix.slice(1).map((cells, rowIndex) => {
    const values: Partial<Record<keyof StaffImportRow, string>> = {};
    mapping.forEach((field, index) => {
      values[field] = safeCell(cells[index], field);
    });
    const uncertainFields: string[] = [];
    const sourceDescription = values.sourceDescription?.trim() || null;
    const title = values.title?.trim() || sourceDescription || "";
    if (!title) {
      if (!options.allowMissingTitle) {
        throw importError(`Row ${rowIndex + 2} has no item name.`);
      }
      uncertainFields.push("Item name");
    }
    const quantityText = values.quantity?.trim();
    let quantity = quantityText ? Number(quantityText) : null;
    if (quantity !== null && (!Number.isInteger(quantity) || quantity <= 0)) {
      if (!options.tolerateInvalidValues) {
        throw importError(`Row ${rowIndex + 2} has an invalid quantity.`);
      }
      quantity = null;
      uncertainFields.push("Quantity");
    }
    const parseOptionalQuantity = (
      value: string | undefined,
      field: string
    ) => {
      if (!value?.trim()) return null;
      const parsed = Number(value.trim());
      if (!Number.isInteger(parsed) || parsed <= 0) {
        if (!options.tolerateInvalidValues) {
          throw importError(`Row ${rowIndex + 2} has an invalid ${field}.`);
        }
        uncertainFields.push(field);
        return null;
      }
      return parsed;
    };
    const orderedQuantity = parseOptionalQuantity(
      values.orderedQuantity,
      "ordered quantity"
    );
    const receivedQuantity = parseOptionalQuantity(
      values.receivedQuantity,
      "received quantity"
    );
    const type = values.type?.trim().toUpperCase() as StaffImportRow["type"];
    let normalizedType = type || null;
    if (
      normalizedType &&
      normalizedType !== "INDIVIDUAL" &&
      normalizedType !== "QUANTITY_TRACKED"
    ) {
      if (!options.tolerateInvalidValues) {
        throw importError(`Row ${rowIndex + 2} has an invalid tracking type.`);
      }
      normalizedType = null;
      uncertainFields.push("Tracking type");
    }
    const row = {
      rowNumber: rowIndex + 2,
      title,
      quantity,
      category: values.category?.trim() || null,
      location: values.location?.trim() || null,
      type: normalizedType,
      ...(sourceDescription ? { sourceDescription } : {}),
      ...(values.manufacturer?.trim()
        ? { manufacturer: values.manufacturer.trim() }
        : {}),
      ...(values.manufacturerPartNumber?.trim()
        ? { manufacturerPartNumber: values.manufacturerPartNumber.trim() }
        : {}),
      ...(values.supplierPartNumber?.trim()
        ? { supplierPartNumber: values.supplierPartNumber.trim() }
        : {}),
      ...(values.unitDescription?.trim()
        ? { unitDescription: values.unitDescription.trim() }
        : {}),
      ...(values.sourceNotes?.trim()
        ? { sourceNotes: values.sourceNotes.trim() }
        : {}),
      ...(orderedQuantity !== null ? { orderedQuantity } : {}),
      ...(receivedQuantity !== null ? { receivedQuantity } : {}),
      ...(receivedQuantity !== null
        ? { quantityStatus: "RECEIVED" as const }
        : orderedQuantity !== null
        ? { quantityStatus: "ORDERED" as const }
        : {}),
      ...(uncertainFields.length > 0 ? { uncertainFields } : {}),
    } satisfies StaffImportRow;
    return row;
  });
}

type StaffImportParseResult = {
  rows: StaffImportRow[];
  pdfSummary?: StaffImportPdfSummary;
  provider?: string;
};

async function parseStaffImportFileWithSummary({
  filename,
  contentType,
  buffer,
}: {
  filename: string;
  contentType?: string | null;
  buffer: Buffer;
}): Promise<StaffImportParseResult> {
  if (buffer.length > STAFF_IMPORT_MAX_BYTES) {
    throw importError("The file is too large. The maximum is 5 MB.");
  }
  const extension = filename.toLowerCase().split(".").pop();
  if (extension !== "csv" && extension !== "xlsx" && extension !== "pdf") {
    throw importError("Upload a CSV, XLSX, or PDF file.");
  }
  if (
    contentType?.includes("macro") ||
    filename.toLowerCase().endsWith(".xlsm")
  ) {
    throw importError("Macro-enabled workbooks are not accepted.");
  }
  if (extension === "pdf") {
    const text = extractPdfText(buffer);
    try {
      return parsePdfRowsFromText(text);
    } catch (cause) {
      if (OPENROUTER_API_KEY) return parseProcurementPdfWithAi(text);
      throw cause;
    }
  }
  const matrix =
    extension === "csv"
      ? (parseCsv(buffer.toString("utf8"), {
          bom: true,
          skip_empty_lines: true,
          relax_column_count: false,
        }) as string[][])
      : await parseXlsx(buffer);
  return { rows: parseRows(matrix) } satisfies StaffImportParseResult;
}

export async function parseStaffImportFile(args: {
  filename: string;
  contentType?: string | null;
  buffer: Buffer;
}) {
  return (await parseStaffImportFileWithSummary(args)).rows;
}

export function getStaffImportFormat(filename: string): StaffImportFormat {
  const extension = filename.toLowerCase().split(".").pop();
  return extension === "xlsx" ? "XLSX" : extension === "pdf" ? "PDF" : "CSV";
}

function normalize(value: string | null | undefined) {
  return (value ?? "").trim().toLocaleLowerCase();
}

function normalizedProductText(value: string | null | undefined) {
  return normalize(value)
    .replace(/\b(?:w\/o|without)\s+headers?\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function inferProcurementCategory(row: StaffImportRow) {
  const supplied = row.category?.trim();
  if (
    supplied &&
    IOIO_PROCUREMENT_CATEGORIES.some(
      (category) => normalize(category) === normalize(supplied)
    )
  ) {
    return {
      category: IOIO_PROCUREMENT_CATEGORIES.find(
        (category) => normalize(category) === normalize(supplied)
      ) as IoioProcurementCategory,
      confidence: "High" as const,
      reason: "The source supplied an approved IOIO category.",
    };
  }

  const text = normalizedProductText(
    [
      row.title,
      row.sourceDescription,
      row.manufacturer,
      row.manufacturerPartNumber,
      row.unitDescription,
    ]
      .filter(Boolean)
      .join(" ")
  );
  const rules: Array<{
    category: IoioProcurementCategory;
    pattern: RegExp;
    reason: string;
  }> = [
    {
      category: "Kits & Complete Sets",
      pattern: /\bkit|starter set|development set\b/i,
      reason: "The description identifies a kit or complete set.",
    },
    {
      category: "Measurement & Lab Equipment",
      pattern:
        /oscilloscope|multimeter|voltmeter|ammeter|caliper|sensor meter|probe\b/i,
      reason: "The description identifies measurement or lab equipment.",
    },
    {
      category: "Boards & Embedded Systems",
      pattern:
        /arduino|raspberry pi|teensy|microbit|esp[- ]?\d|development board|microcontroller|atmega|galileo\b/i,
      reason:
        "The description identifies a development board or embedded controller.",
    },
    {
      category: "Motors, Power & Actuation",
      pattern:
        /servo|motor|stepper|battery|power supply|pump|relay|solenoid|actuator\b/i,
      reason:
        "The description identifies power, motor, or actuation equipment.",
    },
    {
      category: "Cables & Connectivity",
      pattern:
        /usb|cable|wire|adapter|connector|ethernet|hdmi|bluetooth|wifi|wireless\b/i,
      reason:
        "The description identifies a cable, adapter, or connectivity part.",
    },
    {
      category: "Tools & Fabrication",
      pattern:
        /solder|screwdriver|pliers|drill|printer|filament|tool|blade|breadboard|perfboard|stripboard\b/i,
      reason: "The description identifies a tool or fabrication material.",
    },
    {
      category: "Computing, AV & Imaging",
      pattern:
        /kinect|camera|monitor|display|screen|computer|projector|speaker|microphone\b/i,
      reason:
        "The description identifies computing, audio, visual, or imaging equipment.",
    },
    {
      category: "Storage Infrastructure",
      pattern: /shelf|box|container|drawer|storage|cabinet\b/i,
      reason: "The description identifies storage infrastructure.",
    },
    {
      category: "Components & Prototyping",
      pattern:
        /resistor|capacitor|led|diode|transistor|sensor|ic|chip|breadboard|pcb|shield|button|switch|potentiometer|mosfet\b/i,
      reason:
        "The description identifies an electronic component or prototyping part.",
    },
  ];
  const match = rules.find((rule) => rule.pattern.test(text));
  if (match) {
    return { ...match, confidence: "Medium" as const };
  }
  return {
    category: "Old Projects / Legacy / Unknown" as const,
    confidence: "Low" as const,
    reason: "No reliable approved-category signal was found.",
  };
}

function effectiveQuantityStatus(
  row: StaffImportRow
): ProcurementQuantityStatus {
  return (
    row.quantityStatus ??
    (row.receivedQuantity !== undefined && row.receivedQuantity !== null
      ? "RECEIVED"
      : row.orderedQuantity !== undefined && row.orderedQuantity !== null
      ? "ORDERED"
      : "RECEIVED")
  );
}

function getMatchCandidates(
  row: StaffImportRow,
  assets: ExistingAsset[],
  categories: NamedRecord[],
  locations: NamedRecord[]
) {
  const sourceText = normalizedProductText(
    [
      row.title,
      row.sourceDescription,
      row.manufacturerPartNumber,
      row.supplierPartNumber,
    ]
      .filter(Boolean)
      .join(" ")
  );
  const titleText = normalizedProductText(row.title);
  const sourceTokens = new Set(
    sourceText.split(" ").filter((token) => token.length > 2)
  );
  return assets
    .map((asset) => {
      const candidateText = normalizedProductText(
        [asset.title, asset.description].filter(Boolean).join(" ")
      );
      const candidateTokens = new Set(candidateText.split(" "));
      const overlap = [...sourceTokens].filter((token) =>
        candidateTokens.has(token)
      ).length;
      const exact = candidateText === titleText || candidateText === sourceText;
      const identifierMatch = [
        row.manufacturerPartNumber,
        row.supplierPartNumber,
      ].some(
        (identifier) =>
          identifier &&
          candidateText.includes(normalizedProductText(identifier))
      );
      const score = exact
        ? 100
        : identifierMatch
        ? 90
        : overlap >= 2
        ? 50 + overlap
        : 0;
      if (score === 0) return null;
      const locationId = asset.assetLocations[0]?.locationId ?? null;
      return {
        asset,
        score,
        candidate: {
          id: asset.id,
          title: asset.title,
          quantity: asset.quantity,
          type: asset.type,
          category:
            categories.find((category) => category.id === asset.categoryId)
              ?.name ?? null,
          location:
            locations.find((location) => location.id === locationId)?.name ??
            null,
        },
      };
    })
    .filter((value): value is NonNullable<typeof value> => Boolean(value))
    .sort((left, right) => right.score - left.score)
    .slice(0, 5);
}

function classifyRow(
  row: StaffImportRow,
  assets: ExistingAsset[],
  categories: NamedRecord[],
  locations: NamedRecord[]
): StaffImportProposalRow {
  const isProcurementRow = Boolean(
    row.sourceDescription ||
      row.manufacturer ||
      row.manufacturerPartNumber ||
      row.supplierPartNumber ||
      row.orderedQuantity !== undefined ||
      row.receivedQuantity !== undefined ||
      row.quantityStatus
  );
  const categorySuggestion = inferProcurementCategory(row);
  const category = row.category
    ? categories.find(
        (item) => normalize(item.name) === normalize(row.category)
      )
    : categories.find(
        (item) =>
          normalize(item.name) === normalize(categorySuggestion.category)
      ) ?? null;
  const location = row.location
    ? locations.find((item) => normalize(item.name) === normalize(row.location))
    : null;
  const base = {
    ...row,
    assetId: null,
    categoryId: category?.id ?? null,
    locationId: location?.id ?? null,
    currentQuantity: null,
    currentCategoryId: null,
    currentLocationId: null,
    suggestedCategory: categorySuggestion.category,
    categoryConfidence: categorySuggestion.confidence,
    categoryReason: categorySuggestion.reason,
    locationLabel: location?.name ?? "Unassigned",
  };
  const ignored = row.uncertainFields?.includes("Not an inventory item");
  if (ignored) {
    return {
      ...base,
      action: "IGNORE",
      reason: "The extraction marked this line as non-inventory document data.",
    };
  }
  if (row.pdfClassification === "PARTIAL" || !row.title.trim()) {
    return {
      ...base,
      action: isProcurementRow ? "NEEDS_REVIEW" : "AMBIGUOUS",
      reason: "This row needs staff review before it can be matched.",
    };
  }
  if (row.category && !category) {
    return {
      ...base,
      action: isProcurementRow ? "NEEDS_REVIEW" : "REJECT",
      reason: isProcurementRow
        ? `Suggested category: ${categorySuggestion.category}. Choose a Shelf category before applying.`
        : "Category is not a known Shelf category.",
    };
  }
  if (row.location && !location) {
    return {
      ...base,
      action: isProcurementRow ? "NEEDS_REVIEW" : "REJECT",
      reason: isProcurementRow
        ? "The source location is not a known Shelf location. Choose one during review."
        : "Location is not a known Shelf location.",
    };
  }

  const candidates = getMatchCandidates(row, assets, categories, locations);
  const exactCandidates = candidates.filter(
    (candidate) => candidate.score >= 90
  );
  if (exactCandidates.length > 1) {
    return {
      ...base,
      action: isProcurementRow ? "POSSIBLE_DUPLICATE" : "AMBIGUOUS",
      matchCandidates: exactCandidates.map((candidate) => candidate.candidate),
      reason: "More than one likely Shelf asset matches this line.",
    };
  }
  const topCandidate = candidates[0];
  if (topCandidate && topCandidate.score < 90) {
    return {
      ...base,
      action: isProcurementRow ? "POSSIBLE_DUPLICATE" : "AMBIGUOUS",
      matchCandidates: candidates.map((candidate) => candidate.candidate),
      reason: "A similarly named Shelf asset may already exist.",
    };
  }
  const asset = exactCandidates[0]?.asset;
  if (!asset) {
    const quantityStatus = effectiveQuantityStatus(row);
    const receivedQuantity =
      row.receivedQuantity ??
      (quantityStatus === "RECEIVED" || quantityStatus === "SHIPPED"
        ? row.quantity
        : null);
    if (
      !receivedQuantity ||
      (isProcurementRow &&
        (quantityStatus === "ORDERED" ||
          categorySuggestion.confidence === "Low"))
    ) {
      return {
        ...base,
        action: isProcurementRow ? "NEEDS_REVIEW" : "REJECT",
        reason: isProcurementRow
          ? quantityStatus === "ORDERED"
            ? "Ordered quantity is known, but received quantity is unknown."
            : categorySuggestion.confidence === "Low"
            ? categorySuggestion.reason
            : "A positive received quantity is required."
          : "Quantity-tracked new items need a positive quantity.",
      };
    }
    return {
      ...base,
      action: category
        ? "CREATE"
        : isProcurementRow
        ? "NEEDS_REVIEW"
        : "CREATE",
      proposedQuantity: receivedQuantity,
      reason: category
        ? "No likely Shelf asset match was found."
        : "Choose an approved Shelf category before creating this item.",
    };
  }

  const currentLocationId = asset.assetLocations[0]?.locationId ?? null;
  const quantityStatus = effectiveQuantityStatus(row);
  const receivedQuantity =
    row.receivedQuantity ??
    (quantityStatus === "RECEIVED" || quantityStatus === "SHIPPED"
      ? row.quantity
      : null);
  const changes = [
    receivedQuantity !== null &&
    asset.type === AssetType.QUANTITY_TRACKED &&
    receivedQuantity > 0
      ? "quantity"
      : null,
    row.category && category?.id !== asset.categoryId ? "category" : null,
    row.location && location?.id !== currentLocationId ? "location" : null,
  ].filter(Boolean) as string[];
  const details = {
    ...base,
    assetId: asset.id,
    currentQuantity: asset.quantity,
    currentCategoryId: asset.categoryId,
    currentLocationId,
    proposedQuantity:
      asset.type === AssetType.QUANTITY_TRACKED &&
      asset.quantity !== null &&
      receivedQuantity !== null
        ? asset.quantity + receivedQuantity
        : asset.quantity,
    matchCandidates: candidates.map((candidate) => candidate.candidate),
    locationLabel:
      locations.find((location) => location.id === currentLocationId)?.name ??
      "Unassigned",
  };
  if (
    receivedQuantity !== null &&
    asset.type === AssetType.INDIVIDUAL &&
    receivedQuantity !== 1
  ) {
    return {
      ...details,
      action: isProcurementRow ? "NEEDS_REVIEW" : "REJECT",
      reason:
        "Individual Shelf assets cannot receive a quantity greater than one.",
    };
  }
  if (row.type && row.type !== asset.type) {
    return {
      ...details,
      action: isProcurementRow ? "NEEDS_REVIEW" : "AMBIGUOUS",
      reason: "Tracking type differs from the existing Shelf asset.",
    };
  }
  if (
    isProcurementRow &&
    (quantityStatus === "ORDERED" || receivedQuantity === null)
  ) {
    return {
      ...details,
      action: "NEEDS_REVIEW",
      reason:
        "The source does not confirm how many units physically arrived. Review before increasing stock.",
    };
  }
  if (changes.length === 0)
    return {
      ...details,
      action: "NO_CHANGE",
      reason: "The Shelf asset already matches the row.",
    };
  if (changes.length > 1) {
    return {
      ...details,
      action: isProcurementRow ? "NEEDS_REVIEW" : "AMBIGUOUS",
      reason: "The row changes more than one field and needs staff review.",
    };
  }
  const action =
    changes[0] === "quantity"
      ? isProcurementRow
        ? "INCREASE_QUANTITY"
        : "UPDATE_QUANTITY"
      : changes[0] === "category"
      ? "UPDATE_CATEGORY"
      : "UPDATE_LOCATION";
  return {
    ...details,
    action,
    reason: `One controlled ${changes[0]} change is proposed.`,
  };
}

export function classifyStaffImportRows({
  rows,
  assets,
  categories,
  locations,
}: {
  rows: StaffImportRow[];
  assets: ExistingAsset[];
  categories: NamedRecord[];
  locations: NamedRecord[];
}) {
  return rows.map((row) => classifyRow(row, assets, categories, locations));
}

function countActions(rows: StaffImportProposalRow[]) {
  return rows.reduce(
    (counts, row) => ({
      ...counts,
      [row.action]: (counts[row.action] ?? 0) + 1,
    }),
    {
      CREATE: 0,
      INCREASE_QUANTITY: 0,
      POSSIBLE_DUPLICATE: 0,
      NEEDS_REVIEW: 0,
      IGNORE: 0,
      NO_CHANGE: 0,
      UPDATE_QUANTITY: 0,
      UPDATE_LOCATION: 0,
      UPDATE_CATEGORY: 0,
      AMBIGUOUS: 0,
      REJECT: 0,
    } satisfies Record<StaffImportAction, number>
  );
}

async function sha256(buffer: Buffer) {
  const hash = await import("node:crypto");
  return hash.createHash("sha256").update(buffer).digest("hex");
}

export async function prepareStaffInventoryImport({
  context,
  request,
  file,
}: Pick<Parameters<typeof requireIoioStaffAccess>[0], "context" | "request"> & {
  file: File;
}) {
  const { organizationId, userId } = await requireIoioStaffAccess({
    context,
    request,
  });
  if (!file.name) throw importError("The uploaded file has no filename.");
  const buffer = Buffer.from(await file.arrayBuffer());
  const parsed = await parseStaffImportFileWithSummary({
    filename: file.name,
    contentType: file.type,
    buffer,
  });
  const rows = parsed.rows;
  const [assets, categories, locations] = await Promise.all([
    db.asset.findMany({
      where: { organizationId },
      select: {
        id: true,
        title: true,
        type: true,
        quantity: true,
        description: true,
        categoryId: true,
        assetLocations: { select: { locationId: true, quantity: true } },
      },
    }),
    getActiveCategoriesForOrganization({ organizationId }),
    db.location.findMany({
      where: { organizationId },
      select: { id: true, name: true },
    }),
  ]);
  const proposalRows = classifyStaffImportRows({
    rows,
    assets,
    categories,
    locations,
  });
  const operationId = randomUUID();
  const proposal: StaffImportProposal = {
    version: 1,
    operationId,
    organizationId,
    source: {
      filename: file.name.slice(0, 200),
      size: buffer.length,
      sha256: await sha256(buffer),
      format: getStaffImportFormat(file.name),
      extractionProvider: parsed.provider ?? "deterministic",
    },
    rows: proposalRows,
    counts: countActions(proposalRows),
    createdAt: new Date().toISOString(),
    categoryOptions: categories,
    locationOptions: locations,
    pdfSummary: parsed.pdfSummary,
  };
  const idempotencyKey = `staff-import:${proposal.source.sha256}:${organizationId}:${userId}`;
  const existingOperation = await db.ioioWriteOperation.findUnique({
    where: { idempotencyKey },
    select: { status: true, description: true, createdAt: true },
  });
  if (existingOperation?.status === "PREPARED") {
    if (!isStaffImportExpired(existingOperation.createdAt)) {
      return readStoredProposal(existingOperation.description);
    }
    await db.ioioWriteOperation.updateMany({
      where: { idempotencyKey, status: "PREPARED" },
      data: { status: "EXPIRED", completedAt: new Date() },
    });
  }
  if (existingOperation?.status === "SUCCEEDED") {
    return readStoredProposal(existingOperation.description);
  }
  if (existingOperation?.status === "APPLYING") {
    throw importError("This import proposal is already being processed.");
  }
  const nextIdempotencyKey = existingOperation
    ? `${idempotencyKey}:${randomUUID()}`
    : idempotencyKey;
  await db.ioioWriteOperation.create({
    data: {
      id: operationId,
      operationType: STAFF_IMPORT_OPERATION,
      source: "IOIO_STAFF_ASSISTANT",
      status: "PREPARED",
      idempotencyKey: nextIdempotencyKey,
      userId,
      organizationId,
      reportType: STAFF_IMPORT_OPERATION,
      description: JSON.stringify({ kind: "STAFF_INVENTORY_IMPORT", proposal }),
    },
  });
  Logger.info({
    event: "ioio_staff_import_prepared",
    operationId,
    organizationId,
    userId,
    filename: proposal.source.filename,
    bytes: proposal.source.size,
    extractionProvider: proposal.source.extractionProvider,
    counts: proposal.counts,
  });
  return proposal;
}

export async function getStaffInventoryImportProposal({
  context,
  request,
  operationId,
}: Pick<Parameters<typeof requireIoioStaffAccess>[0], "context" | "request"> & {
  operationId: string;
}) {
  const { organizationId, userId } = await requireIoioStaffAccess({
    context,
    request,
  });
  const operation = await db.ioioWriteOperation.findFirst({
    where: {
      id: operationId,
      organizationId,
      userId,
      operationType: STAFF_IMPORT_OPERATION,
    },
    select: { status: true, description: true, createdAt: true },
  });
  if (!operation || operation.status !== "PREPARED") {
    throw staffImportUnavailableError();
  }
  if (isStaffImportExpired(operation.createdAt)) {
    await db.ioioWriteOperation.updateMany({
      where: {
        id: operationId,
        organizationId,
        userId,
        operationType: STAFF_IMPORT_OPERATION,
        status: "PREPARED",
      },
      data: { status: "EXPIRED", completedAt: new Date() },
    });
    throw staffImportUnavailableError();
  }
  return readStoredProposal(operation.description);
}

export async function cancelStaffInventoryImport({
  context,
  request,
  operationId,
}: Pick<Parameters<typeof requireIoioStaffAccess>[0], "context" | "request"> & {
  operationId: string;
}) {
  const { organizationId, userId } = await requireIoioStaffAccess({
    context,
    request,
  });
  const expired = await db.ioioWriteOperation.updateMany({
    where: {
      id: operationId,
      organizationId,
      userId,
      operationType: STAFF_IMPORT_OPERATION,
      status: "PREPARED",
      createdAt: {
        lt: new Date(Date.now() - STAFF_IMPORT_REVIEW_RETENTION_MS),
      },
    },
    data: { status: "EXPIRED", completedAt: new Date() },
  });
  if (expired.count > 0) throw staffImportUnavailableError();
  const cancelled = await db.ioioWriteOperation.updateMany({
    where: {
      id: operationId,
      organizationId,
      userId,
      operationType: STAFF_IMPORT_OPERATION,
      status: "PREPARED",
    },
    data: { status: "CANCELLED", completedAt: new Date() },
  });
  if (cancelled.count !== 1) throw staffImportUnavailableError();
  return { operationId, cancelled: true };
}

function readStoredProposal(description: string): StaffImportProposal {
  try {
    const value = JSON.parse(description) as { proposal?: StaffImportProposal };
    if (value.proposal?.version !== 1 || !value.proposal.operationId)
      throw new Error();
    return value.proposal;
  } catch {
    throw importError("The saved import proposal is invalid.");
  }
}

type StaffImportReviewDecision = {
  rowNumber: number;
  decision: "APPROVE" | "IGNORE";
  title?: string;
  assetId?: string | null;
  categoryId?: string | null;
  locationId?: string | null;
  quantity?: number | null;
};

function readReviewDecisions(value: string | null | undefined) {
  if (!value) return [];
  if (value.length > 100_000) {
    throw importError("The import review decisions are too large.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw importError("The PDF review decisions are invalid.");
  }
  if (!Array.isArray(parsed)) {
    throw importError("The PDF review decisions are invalid.");
  }
  const seen = new Set<number>();
  return parsed.map((entry): StaffImportReviewDecision => {
    if (!entry || typeof entry !== "object") {
      throw importError("The PDF review decisions are invalid.");
    }
    const decision = entry as Record<string, unknown>;
    const rowNumber = decision.rowNumber;
    const action = decision.decision;
    if (
      typeof rowNumber !== "number" ||
      !Number.isInteger(rowNumber) ||
      rowNumber < 1 ||
      seen.has(rowNumber) ||
      (action !== "APPROVE" && action !== "IGNORE")
    ) {
      throw importError("The PDF review decisions are invalid.");
    }
    seen.add(rowNumber);
    if (action === "IGNORE") return { rowNumber, decision: action };
    const title =
      decision.title === undefined
        ? undefined
        : safeCell(decision.title, "Item name");
    const assetId =
      decision.assetId === null || decision.assetId === undefined
        ? decision.assetId ?? undefined
        : safeCell(decision.assetId, "Shelf asset ID");
    const categoryId =
      decision.categoryId === null || decision.categoryId === undefined
        ? decision.categoryId ?? undefined
        : safeCell(decision.categoryId, "Category ID");
    const locationId =
      decision.locationId === null || decision.locationId === undefined
        ? decision.locationId ?? undefined
        : safeCell(decision.locationId, "Location ID");
    const quantity = decision.quantity;
    if (
      quantity !== undefined &&
      quantity !== null &&
      (typeof quantity !== "number" ||
        !Number.isInteger(quantity) ||
        quantity <= 0)
    ) {
      throw importError("Review quantities must be positive whole numbers.");
    }
    return {
      rowNumber,
      decision: action,
      ...(title !== undefined ? { title } : {}),
      ...(assetId !== undefined ? { assetId } : {}),
      ...(categoryId !== undefined ? { categoryId } : {}),
      ...(locationId !== undefined ? { locationId } : {}),
      ...(quantity !== undefined ? { quantity } : {}),
    };
  });
}

function readLegacyPdfDecisions(value: string | null | undefined) {
  if (!value) return [];
  const parsed = readReviewDecisions(value.replace(/"KEEP"/g, '"APPROVE"'));
  return parsed;
}

function buildImportedDescription(
  filename: string,
  row: StaffImportProposalRow
) {
  const parts = [
    `Imported from ${filename}`,
    row.sourceDescription
      ? `Source description: ${row.sourceDescription}`
      : null,
    row.manufacturer ? `Manufacturer: ${row.manufacturer}` : null,
    row.manufacturerPartNumber
      ? `Manufacturer part number: ${row.manufacturerPartNumber}`
      : null,
    row.supplierPartNumber
      ? `Supplier part number: ${row.supplierPartNumber}`
      : null,
    row.unitDescription ? `Unit: ${row.unitDescription}` : null,
    row.sourceNotes ? `Source notes: ${row.sourceNotes}` : null,
  ].filter(Boolean);
  return parts.join(". ").slice(0, 2000);
}

export async function applyStaffInventoryImport({
  context,
  request,
  operationId,
  pdfDecisions,
  reviewDecisions,
}: Pick<Parameters<typeof requireIoioStaffAccess>[0], "context" | "request"> & {
  operationId: string;
  pdfDecisions?: string | null;
  reviewDecisions?: string | null;
}) {
  const { organizationId, userId } = await requireIoioStaffAccess({
    context,
    request,
  });
  const operation = await db.ioioWriteOperation.findFirst({
    where: { id: operationId, organizationId, userId },
  });
  if (
    !operation ||
    operation.organizationId !== organizationId ||
    operation.userId !== userId
  ) {
    throw importError(
      "The import proposal is not available to this staff account."
    );
  }
  if (operation.operationType !== STAFF_IMPORT_OPERATION)
    throw importError("Unsupported operation.");
  if (operation.status === "SUCCEEDED")
    return JSON.parse(operation.description).result;
  if (
    operation.status === "PREPARED" &&
    isStaffImportExpired(operation.createdAt)
  ) {
    await db.ioioWriteOperation.updateMany({
      where: {
        id: operationId,
        organizationId,
        userId,
        operationType: STAFF_IMPORT_OPERATION,
        status: "PREPARED",
      },
      data: { status: "EXPIRED", completedAt: new Date() },
    });
    throw staffImportUnavailableError();
  }
  if (operation.status !== "PREPARED") throw staffImportUnavailableError();

  const proposal = readStoredProposal(operation.description);
  const decisions = reviewDecisions
    ? readReviewDecisions(reviewDecisions)
    : readLegacyPdfDecisions(pdfDecisions);
  const hasFullReviewDecisions = Boolean(reviewDecisions);
  const decisionsByRow = new Map(
    decisions.map((decision) => [decision.rowNumber, decision])
  );
  let rowsToApply = proposal.rows;
  if (decisions.length > 0) {
    if (
      decisions.some(
        (decision) =>
          !proposal.rows.some((row) => row.rowNumber === decision.rowNumber)
      )
    ) {
      throw importError("The PDF review decisions do not match this proposal.");
    }
  }
  if (decisions.length > 0) {
    const [assets, categories, locations] = await Promise.all([
      db.asset.findMany({
        where: { organizationId },
        select: {
          id: true,
          title: true,
          type: true,
          quantity: true,
          description: true,
          categoryId: true,
          assetLocations: { select: { locationId: true, quantity: true } },
        },
      }),
      getActiveCategoriesForOrganization({ organizationId }),
      db.location.findMany({
        where: { organizationId },
        select: { id: true, name: true },
      }),
    ]);
    rowsToApply = proposal.rows.map((row) => {
      const decision = decisionsByRow.get(row.rowNumber);
      if (!hasFullReviewDecisions && row.pdfClassification !== "PARTIAL") {
        return row;
      }
      if (!decision || decision.decision === "IGNORE") {
        return {
          ...row,
          action: "IGNORE",
          reason: !decision
            ? "Not approved during staff review."
            : "Ignored by staff during review.",
        };
      }
      if (
        decision.assetId &&
        decision.assetId !== row.assetId &&
        !(row.matchCandidates ?? []).some(
          (candidate) => candidate.id === decision.assetId
        )
      ) {
        throw importError(
          "The selected Shelf match is not a proposal candidate."
        );
      }
      const title = decision.title ?? row.title;
      const uncertainFields = (row.uncertainFields ?? []).filter(
        (field) => field !== "Item name"
      );
      const classified = classifyStaffImportRows({
        rows: [
          {
            ...row,
            title,
            ...(decision.quantity !== undefined
              ? {
                  quantity: decision.quantity,
                  receivedQuantity: decision.quantity,
                  quantityStatus: "RECEIVED" as const,
                }
              : {}),
            ...(decision.categoryId !== undefined
              ? { category: row.category }
              : {}),
            pdfClassification: uncertainFields.length
              ? "PARTIAL"
              : "VALID_ITEM",
            uncertainFields,
          },
        ],
        assets,
        categories,
        locations,
      })[0];
      return {
        ...classified,
        ...(decision.assetId !== undefined
          ? { assetId: decision.assetId }
          : {}),
        ...(decision.categoryId !== undefined
          ? { categoryId: decision.categoryId }
          : {}),
        ...(decision.locationId !== undefined
          ? { locationId: decision.locationId }
          : {}),
      };
    });
  }
  const claimed = await db.ioioWriteOperation.updateMany({
    where: { id: operationId, organizationId, userId, status: "PREPARED" },
    data: { status: "APPLYING" },
  });
  if (claimed.count !== 1)
    throw importError("This import proposal is already being processed.");
  const createdIds: string[] = [];
  const updatedIds: string[] = [];
  const reusedIds: string[] = [];
  const failedRows: Array<{ rowNumber: number; reason: string }> = [];

  for (const row of rowsToApply) {
    if (
      ![
        "CREATE",
        "INCREASE_QUANTITY",
        "POSSIBLE_DUPLICATE",
        "NEEDS_REVIEW",
        "UPDATE_QUANTITY",
        "UPDATE_CATEGORY",
        "UPDATE_LOCATION",
      ].includes(row.action)
    )
      continue;
    try {
      const createLike =
        !row.assetId &&
        (row.action === "CREATE" || row.action === "NEEDS_REVIEW");
      if (createLike) {
        const existing = await db.asset.findMany({
          where: { organizationId, title: row.title },
          select: { id: true },
        });
        if (existing.length > 1)
          throw importError("A duplicate exact title appeared during apply.");
        if (existing.length === 1) {
          reusedIds.push(existing[0].id);
          continue;
        }
        const receivedQuantity =
          row.receivedQuantity ??
          (effectiveQuantityStatus(row) === "RECEIVED" ||
          effectiveQuantityStatus(row) === "SHIPPED"
            ? row.quantity
            : null);
        if (!receivedQuantity || receivedQuantity <= 0) {
          throw importError(
            "The received quantity is not confirmed for this new item."
          );
        }
        if (row.categoryId) {
          const category = await db.category.findFirst({
            where: { id: row.categoryId, organizationId },
            select: { id: true },
          });
          if (!category)
            throw importError("The category is not in this organization.");
        }
        if (row.locationId) {
          const location = await db.location.findFirst({
            where: { id: row.locationId, organizationId },
            select: { id: true },
          });
          if (!location)
            throw importError("The location is not in this organization.");
        }
        const type =
          row.type ??
          (receivedQuantity > 1 ? "QUANTITY_TRACKED" : "INDIVIDUAL");
        const asset = await createAsset({
          title: row.title,
          description: buildImportedDescription(proposal.source.filename, row),
          userId,
          organizationId,
          valuation: null,
          categoryId: row.categoryId,
          locationId: row.locationId ?? undefined,
          type:
            type === "QUANTITY_TRACKED"
              ? AssetType.QUANTITY_TRACKED
              : AssetType.INDIVIDUAL,
          quantity: type === "QUANTITY_TRACKED" ? receivedQuantity : null,
          consumptionType:
            type === "QUANTITY_TRACKED" ? ConsumptionType.TWO_WAY : null,
          unitOfMeasure: type === "QUANTITY_TRACKED" ? "pcs" : null,
        });
        createdIds.push(asset.id);
        continue;
      }
      if (!row.assetId)
        throw importError("The proposal row has no Shelf asset ID.");
      const asset = await db.asset.findFirst({
        where: { id: row.assetId, organizationId },
        select: {
          id: true,
          type: true,
          quantity: true,
          assetLocations: { select: { locationId: true } },
        },
      });
      if (!asset)
        throw importError(
          "The referenced Shelf asset is not in this organization."
        );
      const receivedQuantity =
        row.receivedQuantity ??
        (effectiveQuantityStatus(row) === "RECEIVED" ||
        effectiveQuantityStatus(row) === "SHIPPED"
          ? row.quantity
          : null);
      const action =
        row.action === "INCREASE_QUANTITY" ||
        ((row.action === "NEEDS_REVIEW" ||
          row.action === "POSSIBLE_DUPLICATE") &&
          receivedQuantity !== null)
          ? "INCREASE_QUANTITY"
          : row.action === "UPDATE_QUANTITY"
          ? "UPDATE_QUANTITY"
          : row.action === "UPDATE_CATEGORY" ||
            (row.action === "NEEDS_REVIEW" && row.categoryId)
          ? "UPDATE_CATEGORY"
          : row.action === "UPDATE_LOCATION" ||
            (row.action === "NEEDS_REVIEW" && row.locationId)
          ? "UPDATE_LOCATION"
          : null;
      if (action === "INCREASE_QUANTITY") {
        if (
          asset.type !== AssetType.QUANTITY_TRACKED ||
          asset.quantity === null ||
          receivedQuantity === null
        )
          throw importError("Quantity update is not valid for this asset.");
        const targetQuantity =
          row.proposedQuantity ?? asset.quantity + receivedQuantity;
        if (targetQuantity < asset.quantity) {
          throw importError("An inventory increase cannot reduce stock.");
        }
        await updateAsset({
          id: asset.id,
          userId,
          organizationId,
          request,
          quantity: targetQuantity,
        });
      } else if (action === "UPDATE_QUANTITY") {
        if (asset.type !== AssetType.QUANTITY_TRACKED || row.quantity === null)
          throw importError("Quantity update is not valid for this asset.");
        await updateAsset({
          id: asset.id,
          userId,
          organizationId,
          request,
          quantity: row.quantity,
        });
      } else if (action === "UPDATE_CATEGORY") {
        if (!row.categoryId) throw importError("The category is missing.");
        const category = await db.category.findFirst({
          where: { id: row.categoryId, organizationId },
          select: { id: true },
        });
        if (!category)
          throw importError("The category is not in this organization.");
        await updateAsset({
          id: asset.id,
          userId,
          organizationId,
          request,
          categoryId: category.id,
        });
      } else if (action === "UPDATE_LOCATION") {
        if (!row.locationId) throw importError("The location is missing.");
        const location = await db.location.findFirst({
          where: { id: row.locationId, organizationId },
          select: { id: true },
        });
        if (!location)
          throw importError("The location is not in this organization.");
        await updateAsset({
          id: asset.id,
          userId,
          organizationId,
          request,
          newLocationId: location.id,
          currentLocationId: asset.assetLocations[0]?.locationId ?? null,
        });
      }
      if (action) updatedIds.push(asset.id);
    } catch (cause) {
      failedRows.push({
        rowNumber: row.rowNumber,
        reason:
          cause instanceof Error
            ? cause.message.slice(0, 200)
            : "Shelf rejected the change.",
      });
    }
  }

  const result = {
    operationId,
    createdIds,
    updatedIds,
    reusedIds,
    failedRows,
    ignoredRows: rowsToApply.filter((row) => row.action === "IGNORE").length,
    reviewedRows: decisions.length,
  };
  await db.ioioWriteOperation.updateMany({
    where: { id: operationId, organizationId, userId, status: "APPLYING" },
    data: {
      status: failedRows.length ? "FAILED" : "SUCCEEDED",
      description: JSON.stringify({
        kind: "STAFF_INVENTORY_IMPORT",
        proposal,
        result,
      }),
      failureCode: failedRows.length ? "ROW_FAILURE" : null,
      completedAt: new Date(),
    },
  });
  Logger.info({
    event: "ioio_staff_import_applied",
    operationId,
    organizationId,
    userId,
    created: createdIds.length,
    updated: updatedIds.length,
    reused: reusedIds.length,
    failed: failedRows.length,
    ignored: result.ignoredRows,
    reviewed: result.reviewedRows,
  });
  return result;
}
