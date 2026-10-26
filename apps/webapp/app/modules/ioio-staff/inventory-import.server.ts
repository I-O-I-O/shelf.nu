import { createHash, randomUUID } from "node:crypto";
import { inflateRawSync, inflateSync } from "node:zlib";
import { AssetType, ConsumptionType, type Prisma } from "@prisma/client";
import { parse as parseCsv } from "csv-parse/sync";
import JSZip from "jszip";
import { db } from "~/database/db.server";
import {
  BULK_CREATE_MAX,
  createAsset,
  updateAsset,
} from "~/modules/asset/service.server";
import {
  createCategory,
  getActiveCategoriesForOrganization,
} from "~/modules/category/service.server";
import { getConfiguredBrokenSection } from "~/modules/ioio-lab-information/broken-section.server";
import { getIoioArchivedCategoryIds } from "~/modules/ioio-staff/archive.server";
import { PICKUP_ZONE_NAME } from "~/modules/ioio-staff/pickup-zone.server";
import { getConfiguredReportReturnArea } from "~/modules/ioio-student/report-return-location.server";
import { ShelfError } from "~/utils/error";
import { getRandomColor } from "~/utils/get-random-color";
import { id } from "~/utils/id/id.server";
import { Logger } from "~/utils/logger";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";
import { requireIoioStaffAccess } from "./access.server";
import {
  ImportAssetModelConflictError,
  resolveImportAssetModel,
} from "./import-asset-model.server";
import { requestImportHelperProposal } from "./import-helper-client.server";
import {
  createImportHelperRequest,
  type ImportHelperCandidateRow,
  type ImportHelperRequest,
} from "./import-helper-contract.server";
import {
  claimImportLedgerItem,
  ensureImportLedgerItems,
  findStaleImportLedgerItems,
  getImportLedgerItem,
  getImportLedgerItems,
  heartbeatImportLedgerItem,
  markImportLedgerItemConflict,
  markImportLedgerItemDone,
  markImportLedgerItemFailed,
  markImportLedgerItemSkipped,
  reconcileStaleImportLedgerItem,
  recordImportLedgerExpectedPrior,
  STAFF_IMPORT_LEDGER_STALE_AFTER_MS,
} from "./import-ledger.server";
import {
  chunkImportUnitWork,
  planIndividualUnitWork,
  planStaffInventoryImport,
  resolveIndividualUnitTitles,
} from "./import-planner";
import {
  getImportLocationPath,
  getOperationalImportLocationIds,
  matchesReviewedImportLocationPath,
  normalizeImportLabel,
  resolveImportCategory,
  resolveImportLocation,
} from "./import-resolution";
import {
  resolveImportReviewState,
  type StaffImportReviewState,
} from "./import-review";

export const STAFF_IMPORT_OPERATION = "INVENTORY_IMPORT";
export const STAFF_IMPORT_MAX_BYTES = 5 * 1024 * 1024;
export const STAFF_IMPORT_MAX_ROWS = 1000;
export const STAFF_IMPORT_MAX_PAGES = 50;
export const STAFF_IMPORT_REVIEW_RETENTION_MS = 24 * 60 * 60 * 1000;
export const MAX_INDIVIDUAL_UNITS_PER_SOURCE_ROW = BULK_CREATE_MAX;
export const MAX_INDIVIDUAL_UNITS_PER_IMPORT = 500;
export const INDIVIDUAL_UNIT_IMPORT_BATCH_SIZE = BULK_CREATE_MAX;

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
  helperCandidate?: ImportHelperCandidateRow;
  sourceEvidence?: Array<{
    sourceRef: string;
    page: number;
    text: string;
  }>;
};

export type StaffImportPdfSummary = {
  validItemRows: number;
  needsReview: number;
  ignoredRows: number;
};

export type StaffImportProposalRow = StaffImportRow & {
  action: StaffImportAction;
  reviewState?: StaffImportReviewState;
  minQuantity?: number | null;
  unitOfMeasure?: string | null;
  consumptionType?: "ONE_WAY" | "TWO_WAY" | null;
  assetId: string | null;
  categoryId: string | null;
  locationId: string | null;
  currentQuantity: number | null;
  currentCategoryId: string | null;
  currentLocationId: string | null;
  expectedAssetState?: ImportExpectedAssetState;
  proposedQuantity?: number | null;
  suggestedCategory?: IoioProcurementCategory;
  categoryConfidence?: "High" | "Medium" | "Low";
  categoryReason?: string;
  categoryLabel?: string | null;
  categoryResolution?:
    | "ACTIVE_MATCH"
    | "ARCHIVED_MATCH"
    | "NEW_PROPOSED"
    | "AMBIGUOUS";
  locationResolution?:
    | "MATCH"
    | "MISSING"
    | "AMBIGUOUS"
    | "OPERATIONAL"
    | "UNMATCHED";
  proposedCategoryName?: string | null;
  reviewConflictReason?: string | null;
  locationLabel?: string;
  locationContext?: {
    currentUnits: number;
    proposedUnits: number;
    capacity: null;
    operational: boolean;
  };
  matchCandidates?: Array<{
    id: string;
    title: string;
    quantity: number | null;
    type: AssetType;
    category: string | null;
    location: string | null;
    expectedAssetState: ImportExpectedAssetState;
  }>;
  reason: string;
};

export type StaffImportProposal = {
  version: 1;
  proposalHash: string;
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
  categoryOptions?: Array<NamedRecord & { archived?: boolean }>;
  locationOptions?: ImportLocationOption[];
  pdfSummary?: StaffImportPdfSummary;
};

export type StaffImportResult = {
  operationId: string;
  createdIds: string[];
  updatedIds: string[];
  reusedIds: string[];
  failedRows: Array<{ rowNumber: number; reason: string; unitIndex?: number }>;
  conflictRows: Array<{
    rowNumber: number;
    reason: string;
    unitIndex?: number;
  }>;
  ignoredRows: number;
  reviewedRows: number;
  totalRows: number;
  succeededRows: number;
  failedRowsCount: number;
  conflictedRowsCount: number;
  skippedRows: number;
};

export type StaffInventoryImportPreparation =
  | { status: "PREPARED"; proposal: StaffImportProposal }
  | { status: "SUCCEEDED" | "PARTIAL"; result: StaffImportResult };

export type StaffImportDuplicateResult = {
  status: "DUPLICATE";
  code: "SAME_PROPOSAL" | "SAME_FILE_DIFFERENT_PROPOSAL";
  message: string;
  existingOperationId: string;
  canOverride: boolean;
};

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function getStaffImportProposalHash(
  proposal: Omit<StaffImportProposal, "proposalHash"> | StaffImportProposal
) {
  const {
    operationId: _operationId,
    createdAt: _createdAt,
    proposalHash: _proposalHash,
    ...content
  } = proposal as StaffImportProposal;
  return createHash("sha256").update(stableJson(content)).digest("hex");
}

export function getStaffImportExecutionHash(
  proposal: StaffImportProposal,
  reviewedRows: StaffImportProposalRow[]
) {
  return createHash("sha256")
    .update(
      stableJson({
        version: proposal.version,
        fileSha256: proposal.source.sha256,
        rows: reviewedRows,
      })
    )
    .digest("hex");
}

export type StaffImportAggregateCounts = {
  succeededRows: number;
  failedRows: number;
  conflictedRows: number;
  skippedRows: number;
  pendingRows?: number;
  inFlightRows?: number;
};

export type StaffImportLedgerStatus =
  | "PENDING"
  | "IN_FLIGHT"
  | "DONE"
  | "FAILED"
  | "CONFLICT"
  | "SKIPPED";

/** Import-only parent aggregation. Other IoioWriteOperation workflows keep their own statuses. */
export function getStaffImportAggregateStatus({
  succeededRows,
  failedRows,
  conflictedRows,
  pendingRows = 0,
  inFlightRows = 0,
}: StaffImportAggregateCounts):
  | "APPLYING"
  | "SUCCEEDED"
  | "PARTIAL"
  | "FAILED" {
  if (pendingRows > 0 || inFlightRows > 0) return "APPLYING";
  if (failedRows === 0 && conflictedRows === 0) return "SUCCEEDED";
  return succeededRows > 0 ? "PARTIAL" : "FAILED";
}

export function summarizeStaffImportRows(
  statuses: readonly StaffImportLedgerStatus[]
) {
  const succeededRows = statuses.filter((status) => status === "DONE").length;
  const failedRowsCount = statuses.filter(
    (status) => status === "FAILED"
  ).length;
  const conflictedRowsCount = statuses.filter(
    (status) => status === "CONFLICT"
  ).length;
  const skippedRows = statuses.filter((status) => status === "SKIPPED").length;
  const pendingRows = statuses.filter((status) => status === "PENDING").length;
  const inFlightRows = statuses.filter(
    (status) => status === "IN_FLIGHT"
  ).length;

  return {
    totalRows: statuses.length,
    succeededRows,
    failedRowsCount,
    conflictedRowsCount,
    skippedRows,
    status: getStaffImportAggregateStatus({
      succeededRows,
      failedRows: failedRowsCount,
      conflictedRows: conflictedRowsCount,
      skippedRows,
      pendingRows,
      inFlightRows,
    }),
  };
}

type ExistingAsset = {
  id: string;
  title: string;
  type: AssetType;
  quantity: number | null;
  description?: string | null;
  categoryId: string | null;
  assetModelId?: string | null;
  assetLocations: Array<{
    locationId: string;
    quantity: number;
    assetKitId: string | null;
  }>;
};

type ImportExpectedAssetState = {
  assetId: string;
  title: string;
  type: AssetType;
  quantity: number | null;
  categoryId: string | null;
  locationIds: string[];
  assetModelId: string | null;
};

function getExpectedAssetState(asset: ExistingAsset): ImportExpectedAssetState {
  return {
    assetId: asset.id,
    title: asset.title,
    type: asset.type,
    quantity: asset.quantity,
    categoryId: asset.categoryId,
    locationIds: asset.assetLocations
      .filter((assetLocation) => assetLocation.assetKitId === null)
      .map((assetLocation) => assetLocation.locationId)
      .sort(),
    assetModelId: asset.assetModelId ?? null,
  };
}

function matchesExpectedAssetState(
  expected: ImportExpectedAssetState,
  actual: ExistingAsset
) {
  const current = getExpectedAssetState(actual);
  return (
    expected.assetId === current.assetId &&
    expected.title === current.title &&
    expected.type === current.type &&
    expected.quantity === current.quantity &&
    expected.categoryId === current.categoryId &&
    expected.assetModelId === current.assetModelId &&
    stableJson(expected.locationIds) === stableJson(current.locationIds)
  );
}

type NamedRecord = { id: string; name: string };
type ImportLocationOption = NamedRecord & {
  parentId: string | null;
  pathLabel: string;
  operational: boolean;
  currentUnits: number;
};

async function isReviewedImportLocationCurrent({
  organizationId,
  locationId,
  expectedPath,
}: {
  organizationId: string;
  locationId: string;
  expectedPath?: string | null;
}) {
  const locations = await db.location.findMany({
    where: { organizationId },
    select: { id: true, name: true, parentId: true },
  });
  const current = locations.find((location) => location.id === locationId);
  if (!current) return false;
  const currentPath = getImportLocationPath(locationId, locations);
  return matchesReviewedImportLocationPath({
    expectedPath,
    currentPath,
    currentName: current.name,
  });
}

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

type ExtractedPdfPage = ImportHelperRequest["document"]["pages"][number];

function extractPdfObjectText(objectBody: string) {
  const strings: string[] = [];
  for (const stream of objectBody.matchAll(
    /stream\r?\n([\s\S]*?)\r?\nendstream/g
  )) {
    const streamStart = stream.index ?? 0;
    const header = objectBody.slice(
      Math.max(0, streamStart - 1200),
      streamStart
    );
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
  return strings.join("\n").trim();
}

function extractPdfPages(buffer: Buffer): ExtractedPdfPage[] {
  if (!buffer.subarray(0, 5).toString("ascii").startsWith("%PDF-")) {
    throw importError("The uploaded file is not a valid PDF.");
  }

  const source = buffer.toString("latin1");
  const objects = new Map<number, string>();
  for (const object of source.matchAll(
    /(?:^|\s)(\d+)\s+\d+\s+obj\b([\s\S]*?)endobj/g
  )) {
    objects.set(Number(object[1]), object[2]);
  }
  const pageObjects = [...objects.entries()].filter(([, body]) =>
    /\/Type\s*\/Page\b/.test(body)
  );
  const pageCount = pageObjects.length || 1;
  if (pageCount > STAFF_IMPORT_MAX_PAGES) {
    throw importError(
      `The PDF contains more than ${STAFF_IMPORT_MAX_PAGES} pages.`
    );
  }

  const streamTextByObjectId = new Map<number, string>();
  for (const [objectId, body] of objects) {
    const text = extractPdfObjectText(body);
    if (text) streamTextByObjectId.set(objectId, text);
  }

  const pages = pageObjects.map(([objectId, body], index) => {
    const referencedObjectIds = [
      ...body.matchAll(/\/(?:Contents)\s+(\d+)\s+\d+\s+R/g),
      ...[
        ...(body.match(/\/Contents\s*\[([^\]]*)\]/)?.[1] ?? "").matchAll(
          /(\d+)\s+\d+\s+R/g
        ),
      ],
    ].map((reference) => Number(reference[1]));
    const content = referencedObjectIds.length
      ? referencedObjectIds
          .map((reference) => streamTextByObjectId.get(reference) ?? "")
          .filter(Boolean)
          .join("\n")
      : extractPdfObjectText(body) || streamTextByObjectId.get(objectId) || "";
    return {
      sourceRef: `pdf-page-${index + 1}`,
      page: index + 1,
      text: content
        .split("\0")
        .join(" ")
        .split("\v")
        .join(" ")
        .split("\f")
        .join(" ")
        .trim(),
    };
  });

  // Some simple text PDFs omit page/content references. Keep their source
  // addressable as page 1 while retaining a stable sourceRef.
  if (!pageObjects.length) {
    const text = [...streamTextByObjectId.values()].join("\n").trim();
    if (text) {
      pages.push({ sourceRef: "pdf-page-1", page: 1, text });
    }
  }
  const readablePages = pages.filter((page) => page.text.length > 0);
  if (!readablePages.length) {
    throw importError(
      "This PDF appears to be scanned. Scanned-PDF OCR is not supported yet."
    );
  }
  return readablePages;
}

function extractPdfText(buffer: Buffer) {
  return extractPdfPages(buffer)
    .map(({ text }) => text)
    .join("\n")
    .trim();
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
  pdfPages?: ImportHelperRequest["document"]["pages"];
  pdfParseError?: string;
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
    const pdfPages = extractPdfPages(buffer);
    const text = pdfPages.map((page) => page.text).join("\n");
    try {
      const parsed = parsePdfRowsFromText(text);
      const rows = parsed.rows.map((row) => {
        const sourcePage =
          pdfPages.find((page) =>
            page.text
              .split(/\r?\n/)
              .some((line) =>
                line.toLocaleLowerCase().includes(row.title.toLocaleLowerCase())
              )
          ) ?? pdfPages[0];
        const sourceLine = sourcePage.text
          .split(/\r?\n/)
          .find((line) =>
            line.toLocaleLowerCase().includes(row.title.toLocaleLowerCase())
          );
        return {
          ...row,
          sourceEvidence: sourceLine
            ? [
                {
                  sourceRef: sourcePage.sourceRef,
                  page: sourcePage.page,
                  text: sourceLine.trim(),
                },
              ]
            : [],
        };
      });
      return { ...parsed, rows, pdfPages };
    } catch (cause) {
      return {
        rows: [],
        pdfPages,
        pdfParseError:
          cause instanceof Error
            ? cause.message
            : "The PDF text could not be parsed into inventory rows.",
      };
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
  const parsed = await parseStaffImportFileWithSummary(args);
  if (parsed.pdfParseError && parsed.rows.length === 0) {
    throw importError(parsed.pdfParseError);
  }
  return parsed.rows;
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

function requestedIndividualUnitQuantity(row: StaffImportProposalRow) {
  if (
    row.type !== "INDIVIDUAL" ||
    row.assetId ||
    (row.action !== "CREATE" && row.action !== "NEEDS_REVIEW")
  ) {
    return null;
  }
  const quantity =
    row.receivedQuantity ??
    (effectiveQuantityStatus(row) === "RECEIVED" ||
    effectiveQuantityStatus(row) === "SHIPPED"
      ? row.quantity
      : null);
  return quantity && quantity > 0 ? quantity : null;
}

/** Return a validation message before the parent apply claim or any writes. */
export function getIndividualUnitImportLimitError(
  rows: readonly StaffImportProposalRow[]
): string | null {
  let totalUnits = 0;
  for (const row of rows) {
    const quantity = requestedIndividualUnitQuantity(row);
    if (quantity === null) continue;
    if (quantity > MAX_INDIVIDUAL_UNITS_PER_SOURCE_ROW) {
      return `A single source row cannot create more than ${MAX_INDIVIDUAL_UNITS_PER_SOURCE_ROW} individual units.`;
    }
    totalUnits += quantity;
  }
  if (totalUnits > MAX_INDIVIDUAL_UNITS_PER_IMPORT) {
    return `An import cannot create more than ${MAX_INDIVIDUAL_UNITS_PER_IMPORT} individual units.`;
  }
  return null;
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
          expectedAssetState: getExpectedAssetState(asset),
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
  locations: ImportLocationOption[]
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
  const categoryName = row.category ?? categorySuggestion.category;
  const categoryResolution = resolveImportCategory(categoryName, categories);
  const category =
    categoryResolution.status === "ACTIVE_MATCH"
      ? categoryResolution.category
      : null;
  const locationResolution = resolveImportLocation(
    row.location,
    locations.map((item) => ({
      ...item,
      pathLabel: item.pathLabel || item.name,
    }))
  );
  const location =
    locationResolution.status === "MATCH" ? locationResolution.location : null;
  const base: Omit<StaffImportProposalRow, "action" | "reason"> = {
    ...row,
    assetId: null,
    categoryId: category?.id ?? null,
    locationId: location?.id ?? null,
    locationResolution: locationResolution.status,
    currentQuantity: null,
    currentCategoryId: null,
    currentLocationId: null,
    suggestedCategory: categorySuggestion.category,
    categoryConfidence: categorySuggestion.confidence,
    categoryReason: categorySuggestion.reason,
    categoryLabel: category?.name ?? null,
    categoryResolution:
      categoryResolution.status === "MISSING"
        ? undefined
        : categoryResolution.status,
    proposedCategoryName:
      categoryResolution.status === "NEW_PROPOSED"
        ? categoryResolution.name
        : categoryResolution.status === "ARCHIVED_MATCH"
        ? categoryResolution.category.name
        : null,
    locationLabel: location?.pathLabel ?? "Unassigned",
    locationContext: location
      ? {
          currentUnits: location.currentUnits ?? 0,
          proposedUnits: row.quantity ?? 0,
          capacity: null,
          operational: location.operational ?? false,
        }
      : undefined,
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
        ? categoryResolution.status === "ARCHIVED_MATCH"
          ? `A matching category (“${categoryResolution.category.name}”) is archived. Choose an active category or review its archive status.`
          : categoryResolution.status === "AMBIGUOUS"
          ? "Multiple categories match this normalized name. Choose an active category by ID."
          : `Proposed new category: ${categorySuggestion.category}. Staff approval and category:create permission are required.`
        : categoryResolution.status === "ARCHIVED_MATCH"
        ? `The matching category (“${categoryResolution.category.name}”) is archived.`
        : categoryResolution.status === "AMBIGUOUS"
        ? "Multiple categories match this normalized name. Choose an active category by ID."
        : "Category is not a known Shelf category.",
    };
  }
  if (row.location && !location) {
    return {
      ...base,
      action: isProcurementRow ? "NEEDS_REVIEW" : "REJECT",
      reason: isProcurementRow
        ? locationResolution.status === "AMBIGUOUS"
          ? "Multiple locations match this name. Choose the correct location by its full path."
          : locationResolution.status === "OPERATIONAL"
          ? "This is an operational location. Choose a normal storage location or select it manually if appropriate."
          : "The source location is not a known Shelf location. Choose one during review."
        : locationResolution.status === "AMBIGUOUS"
        ? "Multiple locations match this name. Choose by full path."
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
    expectedAssetState: getExpectedAssetState(asset),
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
  locations: ImportLocationOption[];
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

function sha256(buffer: Buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function buildStaffImportHelperRequest({
  pdfPages,
  fileSha256,
  assets,
  productModels,
  categories,
  locations,
}: {
  pdfPages: NonNullable<StaffImportParseResult["pdfPages"]>;
  fileSha256: string;
  assets: ExistingAsset[];
  productModels: Array<{ id: string; name: string }>;
  categories: NamedRecord[];
  locations: ImportLocationOption[];
}) {
  const occupancyByLocation = new Map<string, number>();
  for (const asset of assets) {
    for (const placement of asset.assetLocations) {
      if (placement.assetKitId !== null) continue;
      occupancyByLocation.set(
        placement.locationId,
        (occupancyByLocation.get(placement.locationId) ?? 0) +
          placement.quantity
      );
    }
  }
  return createImportHelperRequest({
    document: { sha256: fileSha256, pages: pdfPages },
    activeCategories: categories.slice(0, 500).map(({ id, name }) => ({
      id,
      name,
    })),
    relevantLocations: locations
      .filter((location) => !location.operational)
      .slice(0, 1_000)
      .map(({ id, pathLabel, currentUnits }) => ({
        id,
        pathLabel,
        occupancy: {
          currentUnits: currentUnits || occupancyByLocation.get(id) || 0,
          proposedUnits: 0,
          capacity: null,
          context: null,
        },
      })),
    productCandidates: productModels.slice(0, 50).map(({ id, name }) => ({
      id,
      name,
      manufacturer: null,
      mpn: null,
    })),
    allowedTrackingModes: ["INDIVIDUAL", "QUANTITY_TRACKED"],
    // The current importer does not apply configurable product settings.
    allowedSettings: [],
  });
}

function mapHelperProposalToRows({
  candidates,
  pdfPages,
  categories,
  locations,
}: {
  candidates: ImportHelperCandidateRow[];
  pdfPages: NonNullable<StaffImportParseResult["pdfPages"]>;
  categories: NamedRecord[];
  locations: ImportLocationOption[];
}): { rows: StaffImportRow[]; pdfSummary: StaffImportPdfSummary } {
  const pagesByRef = new Map(pdfPages.map((page) => [page.sourceRef, page]));
  const categoriesById = new Map(
    categories.map((category) => [category.id, category])
  );
  const locationsById = new Map(
    locations.map((location) => [location.id, location])
  );
  const rows = candidates.map((candidate, index): StaffImportRow => {
    const category = candidate.categorySuggestion.categoryId
      ? categoriesById.get(candidate.categorySuggestion.categoryId)?.name ??
        null
      : candidate.categorySuggestion.proposedName;
    const selectedLocation = candidate.locationSuggestions[0]
      ? locationsById.get(candidate.locationSuggestions[0].locationId)
      : undefined;
    const sourceEvidence = candidate.evidence.flatMap((evidence) => {
      const page = pagesByRef.get(evidence.sourceRef);
      return page
        ? [
            {
              sourceRef: evidence.sourceRef,
              page: page.page,
              text: evidence.text,
            },
          ]
        : [];
    });
    return {
      rowNumber: index + 2,
      title: candidate.productName,
      quantity: candidate.quantity,
      category,
      location: selectedLocation?.pathLabel ?? null,
      type: candidate.trackingSuggestion.mode,
      sourceDescription: candidate.description,
      manufacturer: candidate.manufacturer,
      manufacturerPartNumber: candidate.mpn,
      receivedQuantity: null,
      quantityStatus: "UNKNOWN",
      reviewRequired: true,
      pdfClassification: "PARTIAL",
      // Every helper candidate must receive an explicit staff review, even if
      // the helper reports high confidence. This marker is removed only when
      // an authenticated staff decision is reapplied for Apply.
      uncertainFields: ["Helper proposal"],
      helperCandidate: candidate,
      sourceEvidence,
    };
  });
  return {
    rows,
    pdfSummary: {
      validItemRows: rows.length,
      needsReview: rows.length,
      ignoredRows: 0,
    },
  };
}

export async function prepareStaffInventoryImport({
  context,
  request,
  file,
}: Pick<Parameters<typeof requireIoioStaffAccess>[0], "context" | "request"> & {
  file: File;
}): Promise<StaffInventoryImportPreparation> {
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
  const fileSha256 = sha256(buffer);
  const archivedCategoryIds = await getIoioArchivedCategoryIds({
    organizationId,
  });
  const [
    assets,
    categories,
    rawLocations,
    archivedCategories,
    brokenSection,
    reportReturnPath,
  ] = await Promise.all([
    db.asset.findMany({
      where: { organizationId },
      select: {
        id: true,
        title: true,
        type: true,
        quantity: true,
        description: true,
        categoryId: true,
        assetModelId: true,
        assetLocations: {
          select: { locationId: true, quantity: true, assetKitId: true },
        },
      },
    }),
    getActiveCategoriesForOrganization({ organizationId }),
    db.location.findMany({
      where: { organizationId },
      select: { id: true, name: true, parentId: true },
    }),
    db.category.findMany({
      where: { organizationId, id: { in: archivedCategoryIds } },
      select: { id: true, name: true },
    }),
    getConfiguredBrokenSection(organizationId),
    getConfiguredReportReturnArea(organizationId),
  ]);
  const occupancyByLocation = new Map<string, number>();
  for (const asset of assets) {
    for (const placement of asset.assetLocations) {
      if (placement.assetKitId !== null) continue;
      occupancyByLocation.set(
        placement.locationId,
        (occupancyByLocation.get(placement.locationId) ?? 0) +
          placement.quantity
      );
    }
  }
  const operationalLocationIds = getOperationalImportLocationIds({
    locations: rawLocations,
    brokenSectionId: brokenSection?.id,
    pickupZoneName: PICKUP_ZONE_NAME,
    reportReturnPath,
  });
  const locations: ImportLocationOption[] = rawLocations.map((location) => ({
    ...location,
    pathLabel: getImportLocationPath(location.id, rawLocations),
    operational: operationalLocationIds.has(location.id),
    currentUnits: occupancyByLocation.get(location.id) ?? 0,
  }));
  const archivedCategoryCandidates = archivedCategories.map((category) => ({
    ...category,
    archived: true,
  }));
  const allCategoryCandidates = [
    ...categories.map((category) => ({ ...category, archived: false })),
    ...archivedCategoryCandidates,
  ];
  let rows = parsed.rows;
  let pdfSummary = parsed.pdfSummary;
  let extractionProvider = parsed.provider ?? "deterministic";
  if (parsed.pdfPages) {
    const productModels =
      (await db.assetModel.findMany({
        where: { organizationId },
        orderBy: { name: "asc" },
        take: 50,
        select: { id: true, name: true },
      })) ?? [];
    const helperRequest = buildStaffImportHelperRequest({
      pdfPages: parsed.pdfPages,
      fileSha256,
      assets,
      productModels,
      categories,
      locations,
    });
    const helperResult = await requestImportHelperProposal(helperRequest);
    if (helperResult.status === "ready" && helperResult.proposal.rows.length) {
      const mapped = mapHelperProposalToRows({
        candidates: helperResult.proposal.rows,
        pdfPages: parsed.pdfPages,
        categories,
        locations,
      });
      rows = mapped.rows;
      pdfSummary = mapped.pdfSummary;
      extractionProvider = "import-helper:v1";
    } else if (rows.length === 0) {
      const fallbackMessage =
        helperResult.status === "ready"
          ? "The helper returned no inventory candidates, and no deterministic inventory rows were found. Upload a structured CSV or XLSX instead."
          : helperResult.reason === "invalid-response"
          ? "The helper response could not be validated, and no deterministic inventory rows were found. Upload a structured CSV or XLSX instead."
          : "The helper is unavailable and no deterministic inventory rows were found. Upload a structured CSV or XLSX instead.";
      throw importError(parsed.pdfParseError ?? fallbackMessage);
    }
  }
  const classifiedRows = classifyStaffImportRows({
    rows,
    assets,
    categories,
    locations,
  });
  const proposalRows = classifiedRows.map((classifiedRow, index) => {
    const categoryName =
      classifiedRow.category ?? classifiedRow.suggestedCategory ?? null;
    const categoryResolution = resolveImportCategory(
      categoryName,
      allCategoryCandidates
    );
    const row =
      categoryResolution.status === "ACTIVE_MATCH"
        ? classifiedRow
        : {
            ...classifiedRow,
            categoryId: null,
            categoryLabel: null,
            categoryResolution:
              categoryResolution.status === "MISSING"
                ? undefined
                : categoryResolution.status,
            proposedCategoryName:
              categoryResolution.status === "NEW_PROPOSED"
                ? categoryResolution.name
                : categoryResolution.status === "ARCHIVED_MATCH"
                ? categoryResolution.category.name
                : null,
            action: "NEEDS_REVIEW" as const,
            reason:
              categoryResolution.status === "ARCHIVED_MATCH"
                ? `A matching category (“${categoryResolution.category.name}”) is archived. Choose an active category or review its archive status.`
                : categoryResolution.status === "AMBIGUOUS"
                ? "Multiple categories match this normalized name. Choose an active category by ID."
                : `Proposed new category: ${
                    categoryName ?? "(unnamed)"
                  }. Explicit approval and category:create permission are required.`,
          };
    const helperCandidate = rows[index]?.helperCandidate;
    if (!helperCandidate) return row;
    const helperCategoryId =
      helperCandidate.categorySuggestion.categoryId ?? null;
    const helperLocationId =
      helperCandidate.locationSuggestions[0]?.locationId ?? null;
    const helperCategory = categories.find(
      (category) => category.id === helperCategoryId
    );
    const helperLocation = locations.find(
      (location) => location.id === helperLocationId
    );
    return {
      ...row,
      categoryId: helperCategoryId ?? row.categoryId,
      categoryLabel: helperCategory?.name ?? row.categoryLabel,
      locationId: helperLocationId ?? row.locationId,
      locationLabel: helperLocation?.pathLabel ?? row.locationLabel,
      locationContext: helperLocation
        ? {
            currentUnits: helperLocation.currentUnits,
            proposedUnits: row.quantity ?? 0,
            capacity: null,
            operational: helperLocation.operational,
          }
        : row.locationContext,
    };
  });
  const operationId = randomUUID();
  const proposalContent: Omit<StaffImportProposal, "proposalHash"> = {
    version: 1,
    operationId,
    organizationId,
    source: {
      filename: file.name.slice(0, 200),
      size: buffer.length,
      sha256: fileSha256,
      format: getStaffImportFormat(file.name),
      extractionProvider,
    },
    rows: proposalRows,
    counts: countActions(proposalRows),
    createdAt: new Date().toISOString(),
    categoryOptions: allCategoryCandidates,
    locationOptions: locations,
    pdfSummary,
  };
  const proposal: StaffImportProposal = {
    ...proposalContent,
    proposalHash: getStaffImportProposalHash(proposalContent),
  };
  const idempotencyKey = `staff-import:${proposal.source.sha256}:${organizationId}:${userId}`;
  const existingOperation = await db.ioioWriteOperation.findUnique({
    where: { idempotencyKey },
    select: { status: true, description: true, createdAt: true },
  });
  if (existingOperation?.status === "PREPARED") {
    if (!isStaffImportExpired(existingOperation.createdAt)) {
      const storedProposal = readStoredProposal(existingOperation.description);
      await ensureProposalLedger(storedProposal);
      return { status: "PREPARED", proposal: storedProposal };
    }
    await db.ioioWriteOperation.updateMany({
      where: { idempotencyKey, status: "PREPARED" },
      data: { status: "EXPIRED", completedAt: new Date() },
    });
  }
  if (existingOperation?.status === "SUCCEEDED") {
    return {
      status: "SUCCEEDED",
      result: readStoredImportResult(existingOperation.description),
    };
  }
  if (existingOperation?.status === "PARTIAL") {
    return {
      status: "PARTIAL",
      result: readStoredImportResult(existingOperation.description),
    };
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
      fileSha256: proposal.source.sha256,
      description: JSON.stringify({ kind: "STAFF_INVENTORY_IMPORT", proposal }),
    },
  });
  await ensureProposalLedger(proposal);
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
  return { status: "PREPARED", proposal };
}

async function ensureProposalLedger(proposal: StaffImportProposal) {
  await ensureImportLedgerItems({
    operationId: proposal.operationId,
    organizationId: proposal.organizationId,
    items: planStaffInventoryImport(proposal),
  });
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
    const computedHash = getStaffImportProposalHash(value.proposal);
    if (
      value.proposal.proposalHash &&
      value.proposal.proposalHash !== computedHash
    )
      throw new Error();
    return { ...value.proposal, proposalHash: computedHash };
  } catch {
    throw importError("The saved import proposal is invalid.");
  }
}

function readStoredImportResult(description: string): StaffImportResult {
  try {
    const value = JSON.parse(description) as {
      result?: Partial<StaffImportResult> &
        Pick<
          StaffImportResult,
          | "operationId"
          | "createdIds"
          | "updatedIds"
          | "reusedIds"
          | "failedRows"
        >;
    };
    if (
      !value.result ||
      typeof value.result.operationId !== "string" ||
      !Array.isArray(value.result.createdIds) ||
      !Array.isArray(value.result.updatedIds) ||
      !Array.isArray(value.result.reusedIds) ||
      !Array.isArray(value.result.failedRows) ||
      (value.result.conflictRows !== undefined &&
        !Array.isArray(value.result.conflictRows)) ||
      [
        value.result.totalRows,
        value.result.succeededRows,
        value.result.failedRowsCount,
        value.result.conflictedRowsCount,
        value.result.skippedRows,
      ].some(
        (count) =>
          count !== undefined && (!Number.isInteger(count) || count < 0)
      )
    ) {
      throw new Error();
    }
    const conflictRows = value.result.conflictRows ?? [];
    const ignoredRows = value.result.ignoredRows ?? 0;
    const succeededRows =
      value.result.succeededRows ??
      value.result.createdIds.length +
        value.result.updatedIds.length +
        value.result.reusedIds.length;
    const failedRowsCount =
      value.result.failedRowsCount ?? value.result.failedRows.length;
    const conflictedRowsCount =
      value.result.conflictedRowsCount ?? conflictRows.length;
    const skippedRows = value.result.skippedRows ?? ignoredRows;
    return {
      ...value.result,
      conflictRows,
      ignoredRows,
      reviewedRows: value.result.reviewedRows ?? 0,
      succeededRows,
      failedRowsCount,
      conflictedRowsCount,
      skippedRows,
      totalRows:
        value.result.totalRows ??
        succeededRows + failedRowsCount + conflictedRowsCount + skippedRows,
    };
  } catch {
    throw importError("The saved import result is invalid.");
  }
}

type StaffImportReviewDecision = {
  rowNumber: number;
  decision: "APPROVE" | "IGNORE";
  title?: string;
  assetId?: string | null;
  categoryId?: string | null;
  newCategoryName?: string | null;
  approveNewCategory?: boolean;
  locationId?: string | null;
  quantity?: number | null;
  type?: "INDIVIDUAL" | "QUANTITY_TRACKED" | null;
  productChoice?: "EXISTING" | "NEW" | null;
  minQuantity?: number | null;
  unitOfMeasure?: string | null;
  consumptionType?: "ONE_WAY" | "TWO_WAY" | null;
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
    const newCategoryName =
      decision.newCategoryName === null ||
      decision.newCategoryName === undefined
        ? decision.newCategoryName ?? undefined
        : safeCell(decision.newCategoryName, "New category name");
    const approveNewCategory = decision.approveNewCategory;
    if (
      approveNewCategory !== undefined &&
      typeof approveNewCategory !== "boolean"
    ) {
      throw importError("New category approval must be explicit.");
    }
    const type = decision.type;
    if (
      type !== undefined &&
      type !== null &&
      type !== "INDIVIDUAL" &&
      type !== "QUANTITY_TRACKED"
    ) {
      throw importError("The selected tracking mode is not supported.");
    }
    const productChoice = decision.productChoice;
    if (
      productChoice !== undefined &&
      productChoice !== null &&
      productChoice !== "EXISTING" &&
      productChoice !== "NEW"
    ) {
      throw importError("The selected product decision is not supported.");
    }
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
    const minQuantity = decision.minQuantity;
    if (
      minQuantity !== undefined &&
      minQuantity !== null &&
      (typeof minQuantity !== "number" ||
        !Number.isInteger(minQuantity) ||
        minQuantity < 0)
    ) {
      throw importError(
        "Minimum quantity must be a non-negative whole number."
      );
    }
    const unitOfMeasure =
      decision.unitOfMeasure === undefined || decision.unitOfMeasure === null
        ? decision.unitOfMeasure ?? undefined
        : safeCell(decision.unitOfMeasure, "Unit of measure");
    const consumptionType = decision.consumptionType;
    if (
      consumptionType !== undefined &&
      consumptionType !== null &&
      consumptionType !== "ONE_WAY" &&
      consumptionType !== "TWO_WAY"
    ) {
      throw importError("The selected consumption type is not supported.");
    }
    return {
      rowNumber,
      decision: action,
      ...(title !== undefined ? { title } : {}),
      ...(assetId !== undefined ? { assetId } : {}),
      ...(categoryId !== undefined ? { categoryId } : {}),
      ...(newCategoryName !== undefined ? { newCategoryName } : {}),
      ...(approveNewCategory !== undefined ? { approveNewCategory } : {}),
      ...(locationId !== undefined ? { locationId } : {}),
      ...(quantity !== undefined ? { quantity } : {}),
      ...(type !== undefined ? { type } : {}),
      ...(productChoice !== undefined ? { productChoice } : {}),
      ...(minQuantity !== undefined ? { minQuantity } : {}),
      ...(unitOfMeasure !== undefined ? { unitOfMeasure } : {}),
      ...(consumptionType !== undefined ? { consumptionType } : {}),
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

type ImportExecutionPlan = {
  rows: StaffImportProposalRow[];
  reviewedRows: number;
};

type ImportAssetRecoverySnapshot = {
  kind: "ASSET_UPDATE";
  action:
    | "INCREASE_QUANTITY"
    | "UPDATE_QUANTITY"
    | "UPDATE_CATEGORY"
    | "UPDATE_LOCATION";
  assetId: string;
  before: {
    quantity: number | null;
    categoryId: string | null;
    manualLocationIds: string[];
  };
  target: {
    quantity?: number | null;
    categoryId?: string | null;
    manualLocationIds?: string[];
  };
};

type ImportLedgerItem = Awaited<
  ReturnType<typeof getImportLedgerItems>
>[number];

export type StaffImportApplyResponse =
  | StaffImportResult
  | { status: "IN_PROGRESS"; operationId: string }
  | StaffImportDuplicateResult;

function readStoredExecutionPlan(
  description: string
): ImportExecutionPlan | null {
  try {
    const parsed = JSON.parse(description) as {
      executionPlan?: ImportExecutionPlan;
    };
    const plan = parsed.executionPlan;
    if (
      !plan ||
      !Array.isArray(plan.rows) ||
      !Number.isInteger(plan.reviewedRows)
    ) {
      return null;
    }
    return plan;
  } catch {
    return null;
  }
}

function isImportItemStale(item: ImportLedgerItem, staleBefore: Date) {
  return (item.heartbeatAt ?? item.updatedAt) < staleBefore;
}

function readImportAssetRecoverySnapshot(
  value: Prisma.JsonValue | null
): ImportAssetRecoverySnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const snapshot = value as unknown as ImportAssetRecoverySnapshot;
  if (
    snapshot.kind !== "ASSET_UPDATE" ||
    typeof snapshot.assetId !== "string" ||
    !snapshot.before ||
    !snapshot.target ||
    ![
      "INCREASE_QUANTITY",
      "UPDATE_QUANTITY",
      "UPDATE_CATEGORY",
      "UPDATE_LOCATION",
    ].includes(snapshot.action)
  ) {
    return null;
  }
  return snapshot;
}

function getSnapshotValue(
  snapshot: ImportAssetRecoverySnapshot,
  value:
    | ImportAssetRecoverySnapshot["before"]
    | ImportAssetRecoverySnapshot["target"]
) {
  switch (snapshot.action) {
    case "INCREASE_QUANTITY":
    case "UPDATE_QUANTITY":
      return value.quantity;
    case "UPDATE_CATEGORY":
      return value.categoryId;
    case "UPDATE_LOCATION":
      return value.manualLocationIds;
  }
}

function recoveryValueMatches(left: unknown, right: unknown) {
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())
    );
  }
  return left === right;
}

async function inspectAssetRecoverySnapshot({
  snapshot,
  organizationId,
}: {
  snapshot: ImportAssetRecoverySnapshot;
  organizationId: string;
}): Promise<"TARGET" | "BEFORE" | "UNKNOWN"> {
  const asset = await db.asset.findFirst({
    where: { id: snapshot.assetId, organizationId },
    select: {
      id: true,
      quantity: true,
      categoryId: true,
      assetLocations: {
        where: { assetKitId: null },
        select: { locationId: true },
      },
    },
  });
  if (!asset) return "UNKNOWN";

  const current = {
    quantity: asset.quantity,
    categoryId: asset.categoryId,
    manualLocationIds: asset.assetLocations.map(({ locationId }) => locationId),
  };
  const currentValue = getSnapshotValue(snapshot, current);
  if (
    recoveryValueMatches(
      currentValue,
      getSnapshotValue(snapshot, snapshot.target)
    )
  ) {
    return "TARGET";
  }
  return recoveryValueMatches(
    currentValue,
    getSnapshotValue(snapshot, snapshot.before)
  )
    ? "BEFORE"
    : "UNKNOWN";
}

type IndividualUnitImportPlan = {
  kind: "INDIVIDUAL_UNIT_IMPORT";
  assetModelId: string;
  importIdentityKey: string;
  units: Array<{ unitIndex: number; title: string }>;
};

function readIndividualUnitImportPlan(
  value: Prisma.JsonValue | null
): IndividualUnitImportPlan | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, Prisma.JsonValue>;
  if (
    record.kind !== "INDIVIDUAL_UNIT_IMPORT" ||
    typeof record.assetModelId !== "string" ||
    typeof record.importIdentityKey !== "string" ||
    !Array.isArray(record.units)
  ) {
    return null;
  }
  const units = record.units.flatMap((unit) => {
    if (!unit || typeof unit !== "object" || Array.isArray(unit)) return [];
    const candidate = unit as Record<string, Prisma.JsonValue>;
    if (
      typeof candidate.unitIndex !== "number" ||
      !Number.isInteger(candidate.unitIndex) ||
      typeof candidate.title !== "string"
    ) {
      return [];
    }
    return [{ unitIndex: candidate.unitIndex, title: candidate.title }];
  });
  if (units.length !== record.units.length) return null;
  return {
    kind: "INDIVIDUAL_UNIT_IMPORT",
    assetModelId: record.assetModelId,
    importIdentityKey: record.importIdentityKey,
    units,
  };
}

type IndividualUnitWriteEvidence = "WRITTEN" | "NOT_WRITTEN" | "UNKNOWN";

async function inspectIndividualUnitWrite({
  item,
  organizationId,
}: {
  item: ImportLedgerItem;
  organizationId: string;
}): Promise<IndividualUnitWriteEvidence> {
  if (!item.targetAssetId || !item.qrId) return "UNKNOWN";
  const prior = item.expectedPrior;
  if (!prior || typeof prior !== "object" || Array.isArray(prior))
    return "UNKNOWN";
  const record = prior as Record<string, Prisma.JsonValue>;
  if (
    record.kind !== "INDIVIDUAL_UNIT" ||
    typeof record.title !== "string" ||
    typeof record.assetModelId !== "string"
  ) {
    return "UNKNOWN";
  }
  const asset = await db.asset.findFirst({
    where: { id: item.targetAssetId, organizationId },
    select: {
      id: true,
      title: true,
      assetModelId: true,
      qrCodes: {
        where: { id: item.qrId },
        select: { id: true, organizationId: true },
      },
    },
  });
  if (asset) {
    return asset.title === record.title &&
      asset.assetModelId === record.assetModelId &&
      asset.qrCodes.some(
        (qr) => qr.id === item.qrId && qr.organizationId === organizationId
      )
      ? "WRITTEN"
      : "UNKNOWN";
  }
  const qr = await db.qr.findFirst({
    // eslint-disable-next-line local-rules/require-org-scope-on-id-queries -- idor-safe: global lookup proves a reserved QR ID is occupied even when another organization owns it, preventing an unsafe NOT_WRITTEN retry.
    where: { id: item.qrId },
    select: { id: true, organizationId: true, assetId: true },
  });
  return qr ? "UNKNOWN" : "NOT_WRITTEN";
}

async function reconcileStaleImportItem({
  item,
  organizationId,
  staleBefore,
}: {
  item: ImportLedgerItem;
  organizationId: string;
  staleBefore: Date;
}) {
  const scope = {
    operationId: item.operationId,
    organizationId,
    itemId: item.id,
    staleBefore,
  };
  const prior = item.expectedPrior;
  if (prior && typeof prior === "object" && !Array.isArray(prior)) {
    const record = prior as Record<string, Prisma.JsonValue>;
    if (record.kind === "REUSED" && typeof record.assetId === "string") {
      return reconcileStaleImportLedgerItem({
        ...scope,
        status: "DONE",
        targetAssetId: record.assetId,
        writtenState: { outcome: "reused", assetId: record.assetId },
      });
    }
    if (record.kind === "INDIVIDUAL_UNIT") {
      const evidence = await inspectIndividualUnitWrite({
        item,
        organizationId,
      });
      if (evidence === "WRITTEN") {
        return reconcileStaleImportLedgerItem({
          ...scope,
          status: "DONE",
          targetAssetId: item.targetAssetId,
          qrId: item.qrId,
          writtenState: {
            outcome: "created",
            assetId: item.targetAssetId,
            qrId: item.qrId,
          },
        });
      }
      if (evidence === "NOT_WRITTEN") {
        return reconcileStaleImportLedgerItem({
          ...scope,
          status: "PENDING",
          errorCode: null,
          errorMessage: null,
        });
      }
      return reconcileStaleImportLedgerItem({
        ...scope,
        status: "CONFLICT",
        errorCode: "STALE_UNIT_STATE_UNVERIFIABLE",
        errorMessage:
          "The interrupted individual unit and QR state could not be proven.",
      });
    }
    if (record.kind === "INDIVIDUAL_UNIT_IMPORT") {
      const children = (
        await getImportLedgerItems({
          operationId: item.operationId,
          organizationId,
        })
      ).filter(
        (entry) => entry.rowKey === item.rowKey && entry.unitIndex !== null
      );
      for (const child of children) {
        if (
          child.status === "IN_FLIGHT" &&
          isImportItemStale(child, staleBefore)
        ) {
          await reconcileStaleImportItem({
            item: child,
            organizationId,
            staleBefore,
          });
        }
      }
      const refreshedChildren = (
        await getImportLedgerItems({
          operationId: item.operationId,
          organizationId,
        })
      ).filter(
        (entry) => entry.rowKey === item.rowKey && entry.unitIndex !== null
      );
      if (refreshedChildren.length === 0) {
        return reconcileStaleImportLedgerItem({
          ...scope,
          status: "PENDING",
          errorCode: null,
          errorMessage: null,
        });
      }
      if (refreshedChildren.some((child) => child.status === "PENDING")) {
        return reconcileStaleImportLedgerItem({
          ...scope,
          status: "PENDING",
          errorCode: null,
          errorMessage: null,
        });
      }
      if (refreshedChildren.some((child) => child.status === "IN_FLIGHT")) {
        return false;
      }
      const unitAssetIds = refreshedChildren
        .filter((child) => child.status === "DONE" && child.targetAssetId)
        .map((child) => child.targetAssetId!);
      const failedCount = refreshedChildren.filter(
        (child) => child.status === "FAILED"
      ).length;
      const conflictCount = refreshedChildren.filter(
        (child) => child.status === "CONFLICT"
      ).length;
      const writtenState = {
        outcome: "individual_units",
        assetModelId: record.assetModelId,
        assetIds: unitAssetIds,
        unitCount: refreshedChildren.length,
        failedCount,
        conflictCount,
      };
      if (conflictCount > 0) {
        return reconcileStaleImportLedgerItem({
          ...scope,
          status: "CONFLICT",
          writtenState,
          errorCode: "INDIVIDUAL_UNIT_CONFLICT",
          errorMessage: `${conflictCount} physical unit(s) need manual review.`,
        });
      }
      if (failedCount > 0) {
        return reconcileStaleImportLedgerItem({
          ...scope,
          status: "FAILED",
          writtenState,
          errorCode: "INDIVIDUAL_UNIT_FAILURE",
          errorMessage: `${failedCount} physical unit(s) failed.`,
        });
      }
      return reconcileStaleImportLedgerItem({
        ...scope,
        status: "DONE",
        writtenState,
      });
    }
  }

  const snapshot = readImportAssetRecoverySnapshot(item.expectedPrior);
  if (!snapshot) {
    return reconcileStaleImportLedgerItem({
      ...scope,
      status: "CONFLICT",
      errorCode: "STALE_WRITE_UNVERIFIABLE",
      errorMessage: "The interrupted row has no safe reconciliation evidence.",
    });
  }

  const observed = await inspectAssetRecoverySnapshot({
    snapshot,
    organizationId,
  });
  if (observed === "UNKNOWN") {
    const assetExists = await db.asset.findFirst({
      where: { id: snapshot.assetId, organizationId },
      select: { id: true },
    });
    if (!assetExists) {
      return reconcileStaleImportLedgerItem({
        ...scope,
        status: "CONFLICT",
        errorCode: "STALE_ASSET_MISSING",
        errorMessage: "The interrupted row's asset can no longer be verified.",
      });
    }
    return reconcileStaleImportLedgerItem({
      ...scope,
      status: "CONFLICT",
      errorCode: "STALE_ASSET_STATE_CHANGED",
      errorMessage: "The asset changed during the interrupted import.",
    });
  }
  if (observed === "TARGET") {
    return reconcileStaleImportLedgerItem({
      ...scope,
      status: "DONE",
      targetAssetId: snapshot.assetId,
      writtenState: {
        outcome: "updated",
        assetId: snapshot.assetId,
        action: snapshot.action,
        target: snapshot.target,
      },
    });
  }
  if (observed === "BEFORE") {
    return reconcileStaleImportLedgerItem({
      ...scope,
      status: "PENDING",
      errorCode: null,
      errorMessage: null,
    });
  }
  return false;
}

async function buildIndividualUnitImportPlan({
  operationId,
  row,
  organizationId,
  userId,
  filename,
}: {
  operationId: string;
  row: StaffImportProposalRow;
  organizationId: string;
  userId: string;
  filename: string;
}): Promise<IndividualUnitImportPlan> {
  const quantity = requestedIndividualUnitQuantity(row);
  if (quantity === null) {
    throw importError(
      "A positive received quantity is required for individual units."
    );
  }
  const modelResolution = await resolveImportAssetModel({
    organizationId,
    userId,
    name: row.title,
    manufacturer: row.manufacturer,
    manufacturerPartNumber: row.manufacturerPartNumber,
    description: buildImportedDescription(filename, row),
    defaultCategoryId: row.categoryId,
    defaultValuation: null,
    preferredModelId: id(),
  });
  if (modelResolution.status === "CONFLICT") {
    throw new ImportAssetModelConflictError(
      modelResolution.code,
      modelResolution.reason
    );
  }
  const existingTitleRows = await db.asset.findMany({
    where: { organizationId, title: { startsWith: row.title } },
    select: { title: true },
  });
  const units = resolveIndividualUnitTitles({
    productTitle: row.title,
    quantity,
    rowNumber: row.rowNumber,
    operationId,
    existingTitles: new Set(existingTitleRows.map(({ title }) => title)),
  });
  return {
    kind: "INDIVIDUAL_UNIT_IMPORT",
    assetModelId: modelResolution.assetModelId,
    importIdentityKey: modelResolution.importIdentityKey,
    units,
  };
}

async function ensureIndividualAssetModel({
  plan,
  row,
  organizationId,
  userId,
  filename,
}: {
  plan: IndividualUnitImportPlan;
  row: StaffImportProposalRow;
  organizationId: string;
  userId: string;
  filename: string;
}) {
  const resolution = await resolveImportAssetModel({
    organizationId,
    userId,
    name: row.title,
    manufacturer: row.manufacturer,
    manufacturerPartNumber: row.manufacturerPartNumber,
    description: buildImportedDescription(filename, row),
    defaultCategoryId: row.categoryId,
    defaultValuation: null,
    preferredModelId: plan.assetModelId,
  });
  if (resolution.status === "CONFLICT") {
    throw new ImportAssetModelConflictError(resolution.code, resolution.reason);
  }
  if (
    resolution.assetModelId !== plan.assetModelId ||
    resolution.importIdentityKey !== plan.importIdentityKey
  ) {
    throw new ImportAssetModelConflictError(
      "IMPORT_ASSET_MODEL_PLAN_CHANGED",
      "The canonical AssetModel identity changed after this import was prepared."
    );
  }
  return resolution.assetModelId;
}

function summarizeDoneItem(
  item: ImportLedgerItem,
  summary: Pick<StaffImportResult, "createdIds" | "updatedIds" | "reusedIds">
) {
  const value = item.writtenState;
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const written = value as Record<string, Prisma.JsonValue>;
  if (
    written.outcome === "individual_units" &&
    Array.isArray(written.assetIds)
  ) {
    for (const assetId of written.assetIds) {
      if (typeof assetId === "string") summary.createdIds.push(assetId);
    }
    return;
  }
  if (typeof written.assetId !== "string") return;
  if (written.outcome === "created") summary.createdIds.push(written.assetId);
  if (written.outcome === "updated") summary.updatedIds.push(written.assetId);
  if (written.outcome === "reused") summary.reusedIds.push(written.assetId);
}

export async function applyStaffInventoryImport({
  context,
  request,
  operationId,
  proposalHash,
  allowSameFileReimport = false,
  pdfDecisions,
  reviewDecisions,
}: Pick<Parameters<typeof requireIoioStaffAccess>[0], "context" | "request"> & {
  operationId: string;
  proposalHash: string;
  allowSameFileReimport?: boolean;
  pdfDecisions?: string | null;
  reviewDecisions?: string | null;
}): Promise<StaffImportApplyResponse> {
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
  if (operation.status === "SUCCEEDED" || operation.status === "PARTIAL")
    return readStoredImportResult(operation.description);
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
  if (operation.status !== "PREPARED" && operation.status !== "APPLYING") {
    throw staffImportUnavailableError();
  }

  const isResume = operation.status === "APPLYING";
  const proposal = readStoredProposal(operation.description);
  if (proposalHash !== proposal.proposalHash) {
    throw importError(
      "The import proposal changed after review. Reload it and review the current proposal before applying."
    );
  }
  const fileSha256 = operation.fileSha256 ?? proposal.source.sha256;
  if (fileSha256 !== proposal.source.sha256) {
    throw importError(
      "The saved file hash does not match the reviewed proposal."
    );
  }
  const storedExecutionPlan = isResume
    ? readStoredExecutionPlan(operation.description)
    : null;
  const decisions = isResume
    ? []
    : reviewDecisions
    ? readReviewDecisions(reviewDecisions)
    : readLegacyPdfDecisions(pdfDecisions);
  const hasFullReviewDecisions = Boolean(reviewDecisions);
  const decisionsByRow = new Map(
    decisions.map((decision) => [decision.rowNumber, decision])
  );
  let rowsToApply = storedExecutionPlan?.rows ?? proposal.rows;
  if (!isResume) {
    if (!reviewDecisions) {
      throw importError(
        "Staff confirmation is required before applying an import proposal."
      );
    }
    const reviewedRowNumbers = new Set(
      decisions.map(({ rowNumber }) => rowNumber)
    );
    const unresolvedRow = proposal.rows.find(
      (row) => !reviewedRowNumbers.has(row.rowNumber)
    );
    if (unresolvedRow) {
      throw importError(
        `Row ${unresolvedRow.rowNumber} has not been explicitly reviewed.`
      );
    }
  }
  if (!isResume && decisions.length > 0) {
    if (
      decisions.some(
        (decision) =>
          !proposal.rows.some((row) => row.rowNumber === decision.rowNumber)
      )
    ) {
      throw importError("The PDF review decisions do not match this proposal.");
    }
  }
  if (!isResume) {
    let preflightBlockState: StaffImportReviewState = "NEEDS_REVIEW";
    const preflightBlock = proposal.rows.find((row) => {
      const decision = decisionsByRow.get(row.rowNumber);
      const resolvedDecision = decision
        ? {
            ...decision,
            type: decision.type !== undefined ? decision.type : row.type,
            quantity:
              decision.quantity !== undefined
                ? decision.quantity
                : row.receivedQuantity ?? row.quantity,
            minQuantity:
              decision.minQuantity !== undefined ? decision.minQuantity : null,
            unitOfMeasure:
              decision.unitOfMeasure !== undefined
                ? decision.unitOfMeasure
                : row.type === "QUANTITY_TRACKED"
                ? "pcs"
                : null,
            consumptionType:
              decision.consumptionType !== undefined
                ? decision.consumptionType
                : row.type === "QUANTITY_TRACKED"
                ? "TWO_WAY"
                : null,
          }
        : undefined;
      const state = resolveImportReviewState({
        row,
        decision: resolvedDecision,
        categoryAvailable: Boolean(
          (resolvedDecision?.categoryId &&
            proposal.categoryOptions?.some(
              (category) =>
                category.id === resolvedDecision.categoryId &&
                !category.archived
            )) ||
            (resolvedDecision?.approveNewCategory &&
              resolvedDecision.newCategoryName)
        ),
        locationAvailable:
          !resolvedDecision?.locationId ||
          Boolean(
            proposal.locationOptions?.some(
              (location) => location.id === resolvedDecision.locationId
            )
          ),
      });
      preflightBlockState = state;
      return state !== "READY" && state !== "SKIPPED";
    });
    if (preflightBlock) {
      throw importError(
        `Row ${preflightBlock.rowNumber} is ${preflightBlockState}. Approve does not resolve missing product, category, location, tracking, or quantity decisions.`
      );
    }
  }
  if (!isResume && decisions.length > 0) {
    const [assets, categories, rawLocations] = await Promise.all([
      db.asset.findMany({
        where: { organizationId },
        select: {
          id: true,
          title: true,
          type: true,
          quantity: true,
          description: true,
          categoryId: true,
          assetModelId: true,
          assetLocations: {
            select: { locationId: true, quantity: true, assetKitId: true },
          },
        },
      }),
      getActiveCategoriesForOrganization({ organizationId }),
      db.location.findMany({
        where: { organizationId },
        select: { id: true, name: true, parentId: true },
      }),
    ]);
    const [brokenSection, reportReturnPath] = await Promise.all([
      getConfiguredBrokenSection(organizationId),
      getConfiguredReportReturnArea(organizationId),
    ]);
    const operationalLocationIds = getOperationalImportLocationIds({
      locations: rawLocations,
      brokenSectionId: brokenSection?.id,
      pickupZoneName: PICKUP_ZONE_NAME,
      reportReturnPath,
    });
    const locations: ImportLocationOption[] = rawLocations.map((location) => ({
      ...location,
      pathLabel: getImportLocationPath(location.id, rawLocations),
      operational: operationalLocationIds.has(location.id),
      currentUnits: 0,
    }));
    let applyCategories: NamedRecord[] = [...categories];
    if (
      decisions.some(
        (decision) =>
          decision.decision === "APPROVE" && decision.approveNewCategory
      )
    ) {
      await requirePermission({
        userId,
        request,
        entity: PermissionEntity.category,
        action: PermissionAction.create,
      });
    }
    const archivedCategoryIds = await getIoioArchivedCategoryIds({
      organizationId,
    });
    const archivedCategories = await db.category.findMany({
      where: { organizationId, id: { in: archivedCategoryIds } },
      select: { id: true, name: true },
    });
    const reviewConflict = proposal.rows.find((row) => {
      const decision = decisionsByRow.get(row.rowNumber);
      if (!decision || decision.decision === "IGNORE") return false;
      const categoryId =
        decision.categoryId !== undefined
          ? decision.categoryId
          : row.categoryId;
      if (categoryId) {
        const currentCategory = categories.find(
          (category) => category.id === categoryId
        );
        const reviewedCategory = proposal.categoryOptions?.find(
          (category) => category.id === categoryId && !category.archived
        );
        if (
          !currentCategory ||
          !reviewedCategory ||
          normalizeImportLabel(currentCategory.name) !==
            normalizeImportLabel(reviewedCategory.name)
        ) {
          return true;
        }
      }
      if (decision.approveNewCategory && decision.newCategoryName) {
        const normalizedName = normalizeImportLabel(decision.newCategoryName);
        if (
          categories.some(
            (category) => normalizeImportLabel(category.name) === normalizedName
          ) ||
          archivedCategories.some(
            (category) => normalizeImportLabel(category.name) === normalizedName
          )
        ) {
          return true;
        }
      }
      const locationId =
        decision.locationId !== undefined
          ? decision.locationId
          : row.locationId;
      if (locationId) {
        const currentLocation = locations.find(
          (location) => location.id === locationId
        );
        const reviewedLocation = proposal.locationOptions?.find(
          (location) => location.id === locationId
        );
        if (
          !currentLocation ||
          !reviewedLocation ||
          !matchesReviewedImportLocationPath({
            expectedPath: reviewedLocation.pathLabel,
            currentPath: currentLocation.pathLabel,
            currentName: currentLocation.name,
          })
        ) {
          return true;
        }
      }
      const selectedAssetId =
        decision.assetId !== undefined ? decision.assetId : row.assetId;
      if (selectedAssetId) {
        const currentAsset = assets.find(
          (asset) => asset.id === selectedAssetId
        );
        const expectedAssetState =
          selectedAssetId === row.assetId
            ? row.expectedAssetState
            : row.matchCandidates?.find(
                (candidate) => candidate.id === selectedAssetId
              )?.expectedAssetState;
        if (
          !currentAsset ||
          !expectedAssetState ||
          !matchesExpectedAssetState(expectedAssetState, currentAsset)
        ) {
          return true;
        }
      }
      return false;
    });
    if (reviewConflict) {
      throw importError(
        `Row ${reviewConflict.rowNumber} is CONFLICT because its reviewed product, category, or location changed. Reload and review the current data before Apply.`
      );
    }
    const createdCategoryByNormalizedName = new Map<string, NamedRecord>();
    const archivedCategoryNames = new Set(
      archivedCategories.map((category) => normalizeImportLabel(category.name))
    );
    const resolveReviewedRow = async (
      row: StaffImportProposalRow
    ): Promise<StaffImportProposalRow> => {
      const decision = decisionsByRow.get(row.rowNumber);
      if (!hasFullReviewDecisions && row.pdfClassification !== "PARTIAL") {
        return row;
      }
      if (!decision || decision.decision === "IGNORE") {
        return {
          ...row,
          action: "IGNORE",
          reviewState:
            decision?.decision === "IGNORE" ? "SKIPPED" : "NEEDS_REVIEW",
          reason: !decision
            ? "Not approved during staff review."
            : "Ignored by staff during review.",
        };
      }
      const resolvedDecision: StaffImportReviewDecision = {
        ...decision,
        type: decision.type !== undefined ? decision.type : row.type,
        quantity:
          decision.quantity !== undefined
            ? decision.quantity
            : row.receivedQuantity ?? row.quantity,
        minQuantity: decision.minQuantity ?? null,
        unitOfMeasure:
          decision.unitOfMeasure !== undefined
            ? decision.unitOfMeasure
            : row.type === "QUANTITY_TRACKED"
            ? "pcs"
            : null,
        consumptionType:
          decision.consumptionType !== undefined
            ? decision.consumptionType
            : row.type === "QUANTITY_TRACKED"
            ? "TWO_WAY"
            : null,
      };
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
      const selectedAssetId =
        decision.assetId !== undefined ? decision.assetId : row.assetId;
      const expectedAssetState = selectedAssetId
        ? selectedAssetId === row.assetId
          ? row.expectedAssetState
          : row.matchCandidates?.find(
              (candidate) => candidate.id === selectedAssetId
            )?.expectedAssetState
        : undefined;
      let reviewConflictReason: string | null = null;
      if (selectedAssetId) {
        const currentAsset = assets.find(
          (asset) => asset.id === selectedAssetId
        );
        if (
          !currentAsset ||
          !expectedAssetState ||
          !matchesExpectedAssetState(expectedAssetState, currentAsset)
        ) {
          reviewConflictReason =
            "The selected asset changed after review. Re-review its quantity, category, location, or product before applying.";
        }
      }
      let selectedCategoryId =
        decision.categoryId !== undefined
          ? decision.categoryId
          : row.categoryId;
      let newlyCreatedCategory: NamedRecord | undefined;
      if (resolvedDecision.approveNewCategory) {
        const newCategoryName = decision.newCategoryName?.trim();
        if (!newCategoryName || newCategoryName.length < 3) {
          throw importError(
            "Enter a category name of at least three characters."
          );
        }
        if (decision.categoryId) {
          throw importError(
            "Choose an existing category or approve a new one, not both."
          );
        }
        const normalizedName = normalizeImportLabel(newCategoryName);
        const archivedMatches = archivedCategories.filter(
          (category) => normalizeImportLabel(category.name) === normalizedName
        );
        if (archivedMatches.length > 1) {
          throw importError(
            "Multiple archived categories match this name. Choose an active category by ID."
          );
        }
        if (archivedCategoryNames.has(normalizedName)) {
          const archivedMatch = archivedMatches[0];
          if (!archivedMatch) {
            throw importError("The archived category could not be verified.");
          }
          selectedCategoryId = archivedMatch?.id ?? null;
          reviewConflictReason =
            "A matching category is archived or became archived after review. Resolve the archived category before importing.";
        }
        const createdForThisImport =
          createdCategoryByNormalizedName.get(normalizedName);
        const currentNameMatches = applyCategories.filter(
          (category) => normalizeImportLabel(category.name) === normalizedName
        );
        if (currentNameMatches.length > 1) {
          throw importError(
            "Multiple active categories match this name. Choose an existing category by ID."
          );
        }
        const currentNameMatch = currentNameMatches[0];
        if (
          !reviewConflictReason &&
          currentNameMatch &&
          !createdForThisImport
        ) {
          selectedCategoryId = currentNameMatch.id;
          reviewConflictReason =
            "A category with this name appeared after review. Review the category choice again.";
        }
        newlyCreatedCategory = createdForThisImport ?? currentNameMatch;
        if (!reviewConflictReason && !newlyCreatedCategory) {
          const created = await createCategory({
            name: newCategoryName,
            description: "",
            color: getRandomColor(),
            userId,
            organizationId,
          });
          newlyCreatedCategory = { id: created.id, name: created.name };
          createdCategoryByNormalizedName.set(
            normalizedName,
            newlyCreatedCategory
          );
          applyCategories = [...applyCategories, newlyCreatedCategory];
        }
        if (newlyCreatedCategory && !reviewConflictReason) {
          selectedCategoryId = newlyCreatedCategory.id;
        }
      }
      const selectedLocationId =
        decision.locationId !== undefined
          ? decision.locationId
          : row.locationId;
      const selectedCategoryLabel = selectedCategoryId
        ? proposal.categoryOptions?.find(
            (category) => category.id === selectedCategoryId
          )?.name ??
          newlyCreatedCategory?.name ??
          (reviewConflictReason ? decision.newCategoryName : null) ??
          row.categoryLabel
        : null;
      const selectedLocationLabel = selectedLocationId
        ? proposal.locationOptions?.find(
            (location) => location.id === selectedLocationId
          )?.pathLabel ?? row.locationLabel
        : "Unassigned";
      const selectedCategory = applyCategories.find(
        (category) => category.id === selectedCategoryId
      );
      if (
        selectedCategoryId &&
        !selectedCategory &&
        !newlyCreatedCategory &&
        !reviewConflictReason
      ) {
        reviewConflictReason =
          "The approved category changed or is no longer active in this organization.";
      }
      const reviewedCategorySnapshot = proposal.categoryOptions?.find(
        (category) => category.id === selectedCategoryId && !category.archived
      );
      const categoriesForClassification =
        selectedCategoryId && !selectedCategory && reviewedCategorySnapshot
          ? [...applyCategories, reviewedCategorySnapshot]
          : applyCategories;
      const selectedLocation = locations.find(
        (location) => location.id === selectedLocationId
      );
      const reviewedLocationSnapshot = proposal.locationOptions?.find(
        (location) => location.id === selectedLocationId
      );
      if (
        selectedLocationId &&
        (!selectedLocation ||
          !reviewedLocationSnapshot ||
          !matchesReviewedImportLocationPath({
            expectedPath: reviewedLocationSnapshot.pathLabel,
            currentPath: selectedLocation.pathLabel,
            currentName: selectedLocation.name,
          })) &&
        !reviewConflictReason
      ) {
        reviewConflictReason =
          "The approved location changed or no longer exists in this organization.";
      }
      const title = resolvedDecision.title ?? row.title;
      const resolvedReviewFields = new Set([
        ...(title.trim() ? ["Item name"] : []),
        ...(selectedAssetId || resolvedDecision.productChoice
          ? ["Product match"]
          : []),
        ...(selectedCategoryId || resolvedDecision.approveNewCategory
          ? ["Category"]
          : []),
        ...(decision.locationId !== undefined ? ["Location"] : []),
        ...(resolvedDecision.quantity ? ["Quantity", "Received quantity"] : []),
        ...(resolvedDecision.type ? ["Tracking type", "Tracking mode"] : []),
        "Helper proposal",
      ]);
      const uncertainFields = (row.uncertainFields ?? []).filter(
        (field) => !resolvedReviewFields.has(field)
      );
      const classified = classifyStaffImportRows({
        rows: [
          {
            ...row,
            title,
            ...(resolvedDecision.type !== undefined
              ? { type: resolvedDecision.type }
              : {}),
            ...(resolvedDecision.quantity !== undefined
              ? {
                  quantity: resolvedDecision.quantity,
                  receivedQuantity: resolvedDecision.quantity,
                  quantityStatus: "RECEIVED" as const,
                }
              : {}),
            ...(selectedCategory || newlyCreatedCategory
              ? {
                  category:
                    selectedCategory?.name ?? newlyCreatedCategory?.name,
                }
              : {}),
            ...(decision.locationId !== undefined ? { location: null } : {}),
            pdfClassification: uncertainFields.length
              ? "PARTIAL"
              : "VALID_ITEM",
            uncertainFields,
          },
        ],
        assets,
        categories: categoriesForClassification,
        locations,
      })[0];
      return {
        ...classified,
        ...(resolvedDecision.productChoice === "NEW"
          ? { action: "CREATE" as const }
          : {}),
        minQuantity: resolvedDecision.minQuantity ?? null,
        unitOfMeasure: resolvedDecision.unitOfMeasure ?? null,
        consumptionType: resolvedDecision.consumptionType ?? null,
        ...(resolvedDecision.assetId !== undefined
          ? { assetId: resolvedDecision.assetId }
          : {}),
        expectedAssetState,
        categoryLabel: selectedCategoryLabel,
        reviewConflictReason,
        locationLabel: selectedLocationLabel,
        locationContext: selectedLocation
          ? {
              currentUnits:
                reviewedLocationSnapshot?.currentUnits ??
                selectedLocation.currentUnits,
              proposedUnits: row.quantity ?? 0,
              capacity: null,
              operational:
                reviewedLocationSnapshot?.operational ??
                selectedLocation.operational,
            }
          : undefined,
        categoryId: selectedCategoryId ?? null,
        reviewState: resolveImportReviewState({
          row: {
            ...classified,
            categoryResolution:
              selectedCategoryId && selectedCategory
                ? "ACTIVE_MATCH"
                : row.categoryResolution,
            locationResolution:
              !selectedLocationId || selectedLocation
                ? selectedLocationId
                  ? "MATCH"
                  : row.locationResolution
                : "UNMATCHED",
            reviewConflictReason,
          },
          decision: resolvedDecision,
          categoryAvailable: Boolean(
            (selectedCategoryId && selectedCategory) ||
              (decision.approveNewCategory && newlyCreatedCategory)
          ),
          locationAvailable: !selectedLocationId || Boolean(selectedLocation),
        }),
        ...(decision.locationId !== undefined
          ? { locationId: decision.locationId }
          : {}),
      };
    };
    rowsToApply = [];
    for (const row of proposal.rows) {
      rowsToApply.push(await resolveReviewedRow(row));
    }
  }
  const blockedReviewRow = rowsToApply.find((row) => {
    const state =
      row.reviewState ??
      (isResume
        ? resolveImportReviewState({
            row,
            decision: {
              decision: row.action === "IGNORE" ? "IGNORE" : "APPROVE",
              title: row.title,
              assetId: row.assetId,
              categoryId: row.categoryId,
              newCategoryName: null,
              approveNewCategory: false,
              locationId: row.locationId,
              quantity: row.receivedQuantity ?? row.quantity,
              type: row.type,
              minQuantity: row.minQuantity,
              unitOfMeasure:
                row.unitOfMeasure ??
                (row.type === "QUANTITY_TRACKED" ? "pcs" : null),
              consumptionType:
                row.consumptionType ??
                (row.type === "QUANTITY_TRACKED" ? "TWO_WAY" : null),
            },
            categoryAvailable: Boolean(row.categoryId),
            locationAvailable: true,
          })
        : "NEEDS_REVIEW");
    return state !== "READY" && state !== "SKIPPED";
  });
  if (blockedReviewRow) {
    throw importError(
      `Row ${blockedReviewRow.rowNumber} is ${
        blockedReviewRow.reviewState ?? "NEEDS_REVIEW"
      }. Resolve its required review decisions before Apply.`
    );
  }
  const individualUnitLimitError =
    getIndividualUnitImportLimitError(rowsToApply);
  if (individualUnitLimitError) throw importError(individualUnitLimitError);
  const unresolvedHelperRow = rowsToApply.find(
    (row) =>
      row.helperCandidate &&
      (row.type === null ||
        row.action === "AMBIGUOUS" ||
        row.action === "REJECT" ||
        (row.action === "POSSIBLE_DUPLICATE" && !row.assetId))
  );
  if (unresolvedHelperRow) {
    throw importError(
      `Helper row ${unresolvedHelperRow.rowNumber} still has unresolved required fields. Review its quantity, tracking mode, category, and product match before applying.`
    );
  }
  const unresolvedCategoryRow = rowsToApply.find(
    (row) => row.action !== "IGNORE" && !row.categoryId
  );
  if (unresolvedCategoryRow) {
    throw importError(
      `Row ${unresolvedCategoryRow.rowNumber} needs an active category or an explicitly approved new category before Apply.`
    );
  }

  const executionHash = getStaffImportExecutionHash(proposal, rowsToApply);
  if (
    isResume &&
    operation.proposalSha256 &&
    operation.proposalSha256 !== executionHash
  ) {
    throw importError(
      "The saved approved proposal hash does not match the interrupted apply plan."
    );
  }
  if (!isResume) {
    const sameProposal = await db.ioioWriteOperation.findFirst({
      where: {
        organizationId,
        operationType: STAFF_IMPORT_OPERATION,
        proposalSha256: executionHash,
        id: { not: operationId },
      },
      select: { id: true, status: true },
    });
    if (sameProposal) {
      if (sameProposal.status === "APPLYING") {
        return { status: "IN_PROGRESS", operationId: sameProposal.id };
      }
      return {
        status: "DUPLICATE",
        code: "SAME_PROPOSAL",
        message:
          "An equivalent reviewed import already exists in this organization. No inventory changes were repeated.",
        existingOperationId: sameProposal.id,
        canOverride: false,
      };
    }

    const sameSuccessfulFile = await db.ioioWriteOperation.findFirst({
      where: {
        organizationId,
        operationType: STAFF_IMPORT_OPERATION,
        fileSha256,
        status: { in: ["SUCCEEDED", "PARTIAL"] },
        id: { not: operationId },
      },
      select: { id: true, status: true, proposalSha256: true },
      orderBy: { completedAt: "desc" },
    });
    if (sameSuccessfulFile && !allowSameFileReimport) {
      return {
        status: "DUPLICATE",
        code: "SAME_FILE_DIFFERENT_PROPOSAL",
        message:
          sameSuccessfulFile.proposalSha256 === executionHash
            ? "This PDF has already been applied. No inventory changes were repeated."
            : "This PDF was already used for a different reviewed proposal. Confirm explicitly if you intend to apply the changed proposal.",
        existingOperationId: sameSuccessfulFile.id,
        canOverride: sameSuccessfulFile.proposalSha256 !== executionHash,
      };
    }
  }

  await ensureProposalLedger(proposal);
  const now = new Date();
  const staleBefore = new Date(
    now.getTime() - STAFF_IMPORT_LEDGER_STALE_AFTER_MS
  );
  if (isResume) {
    const existingItems = await getImportLedgerItems({
      operationId,
      organizationId,
    });
    if (
      existingItems.some(
        (item) =>
          item.status === "IN_FLIGHT" && !isImportItemStale(item, staleBefore)
      ) ||
      operation.updatedAt >= staleBefore
    ) {
      return { status: "IN_PROGRESS", operationId };
    }
    const resumeClaim = await db.ioioWriteOperation.updateMany({
      where: {
        id: operationId,
        organizationId,
        userId,
        status: "APPLYING",
        updatedAt: { lt: staleBefore },
      },
      data: { updatedAt: now },
    });
    if (resumeClaim.count !== 1) return { status: "IN_PROGRESS", operationId };

    const staleItems = await findStaleImportLedgerItems({
      operationId,
      organizationId,
      now,
    });
    for (const item of staleItems) {
      await reconcileStaleImportItem({ item, organizationId, staleBefore });
    }
  } else {
    let claimed;
    try {
      claimed = await db.ioioWriteOperation.updateMany({
        where: { id: operationId, organizationId, userId, status: "PREPARED" },
        data: {
          status: "APPLYING",
          fileSha256,
          proposalSha256: executionHash,
          description: JSON.stringify({
            kind: "STAFF_INVENTORY_IMPORT",
            proposal,
            executionPlan: {
              rows: rowsToApply,
              reviewedRows: decisions.length,
            },
          }),
        },
      });
    } catch (cause) {
      if (
        cause &&
        typeof cause === "object" &&
        "code" in cause &&
        cause.code === "P2002"
      ) {
        const winner = await db.ioioWriteOperation.findFirst({
          where: {
            organizationId,
            operationType: STAFF_IMPORT_OPERATION,
            proposalSha256: executionHash,
            id: { not: operationId },
          },
          select: { id: true, status: true },
        });
        if (winner?.status === "APPLYING") {
          return { status: "IN_PROGRESS", operationId: winner.id };
        }
        if (winner) {
          return {
            status: "DUPLICATE",
            code: "SAME_PROPOSAL",
            message:
              "An equivalent reviewed import already exists in this organization. No inventory changes were repeated.",
            existingOperationId: winner.id,
            canOverride: false,
          };
        }
      }
      throw cause;
    }
    if (claimed.count !== 1) return { status: "IN_PROGRESS", operationId };
  }
  const createdIds: string[] = [];
  const updatedIds: string[] = [];
  const reusedIds: string[] = [];
  const failedRows: StaffImportResult["failedRows"] = [];
  const conflictRows: StaffImportResult["conflictRows"] = [];
  const initialLedgerItems = await getImportLedgerItems({
    operationId,
    organizationId,
  });
  const ledgerByRowKey = new Map(
    initialLedgerItems
      .filter((item) => item.unitIndex === null)
      .map((item) => [item.rowKey, item])
  );
  const applicableActions = new Set([
    "CREATE",
    "INCREASE_QUANTITY",
    "POSSIBLE_DUPLICATE",
    "NEEDS_REVIEW",
    "UPDATE_QUANTITY",
    "UPDATE_CATEGORY",
    "UPDATE_LOCATION",
  ]);

  for (const row of rowsToApply) {
    const itemId = ledgerByRowKey.get(`row-${row.rowNumber}`)?.id;
    if (!itemId) {
      throw importError("An import row is missing its ledger entry.");
    }

    const parentHeartbeat = await db.ioioWriteOperation.updateMany({
      where: { id: operationId, organizationId, userId, status: "APPLYING" },
      data: { updatedAt: new Date() },
    });
    if (parentHeartbeat.count !== 1)
      return { status: "IN_PROGRESS", operationId };

    let ledgerItem = ledgerByRowKey.get(`row-${row.rowNumber}`)!;
    if (ledgerItem.status === "DONE") {
      summarizeDoneItem(ledgerItem, { createdIds, updatedIds, reusedIds });
      continue;
    }
    if (ledgerItem.status === "FAILED") {
      summarizeDoneItem(ledgerItem, { createdIds, updatedIds, reusedIds });
      if (
        !initialLedgerItems.some(
          (item) => item.rowKey === ledgerItem.rowKey && item.unitIndex !== null
        )
      ) {
        failedRows.push({
          rowNumber: row.rowNumber,
          reason: ledgerItem.errorMessage ?? "Shelf rejected the change.",
        });
      }
      continue;
    }
    if (ledgerItem.status === "CONFLICT") {
      summarizeDoneItem(ledgerItem, { createdIds, updatedIds, reusedIds });
      if (
        !initialLedgerItems.some(
          (item) => item.rowKey === ledgerItem.rowKey && item.unitIndex !== null
        )
      ) {
        conflictRows.push({
          rowNumber: row.rowNumber,
          reason: ledgerItem.errorMessage ?? "This row needs manual review.",
        });
      }
      continue;
    }
    if (ledgerItem.status === "SKIPPED") {
      continue;
    }
    if (ledgerItem.status === "IN_FLIGHT") {
      const currentStaleBefore = new Date(
        Date.now() - STAFF_IMPORT_LEDGER_STALE_AFTER_MS
      );
      if (!isImportItemStale(ledgerItem, currentStaleBefore)) {
        return { status: "IN_PROGRESS", operationId };
      }
      const freshStaleBefore = new Date(
        Date.now() - STAFF_IMPORT_LEDGER_STALE_AFTER_MS
      );
      await reconcileStaleImportItem({
        item: ledgerItem,
        organizationId,
        staleBefore: freshStaleBefore,
      });
      ledgerItem = (
        await getImportLedgerItems({ operationId, organizationId })
      ).find((entry) => entry.rowKey === `row-${row.rowNumber}`)!;
      if (ledgerItem.status !== "PENDING") {
        if (ledgerItem.status === "DONE") {
          summarizeDoneItem(ledgerItem, { createdIds, updatedIds, reusedIds });
        } else if (ledgerItem.status === "CONFLICT") {
          summarizeDoneItem(ledgerItem, { createdIds, updatedIds, reusedIds });
          conflictRows.push({
            rowNumber: row.rowNumber,
            reason: ledgerItem.errorMessage ?? "This row needs manual review.",
          });
        } else if (ledgerItem.status === "FAILED") {
          summarizeDoneItem(ledgerItem, { createdIds, updatedIds, reusedIds });
          failedRows.push({
            rowNumber: row.rowNumber,
            reason: ledgerItem.errorMessage ?? "Shelf rejected the change.",
          });
        }
        continue;
      }
    }

    const claimedItem = await claimImportLedgerItem({
      operationId,
      organizationId,
      itemId,
    });
    if (!claimedItem) {
      const currentItem = await getImportLedgerItem({
        operationId,
        organizationId,
        itemId,
      });
      if (currentItem?.status === "DONE") {
        summarizeDoneItem(currentItem, { createdIds, updatedIds, reusedIds });
        continue;
      }
      if (currentItem?.status === "FAILED") {
        summarizeDoneItem(currentItem, { createdIds, updatedIds, reusedIds });
        failedRows.push({
          rowNumber: row.rowNumber,
          reason: currentItem.errorMessage ?? "Shelf rejected the change.",
        });
        continue;
      }
      if (currentItem?.status === "CONFLICT") {
        summarizeDoneItem(currentItem, { createdIds, updatedIds, reusedIds });
        conflictRows.push({
          rowNumber: row.rowNumber,
          reason: currentItem.errorMessage ?? "This row needs manual review.",
        });
        continue;
      }
      if (currentItem?.status === "SKIPPED") {
        continue;
      }
      return { status: "IN_PROGRESS", operationId };
    }
    if (row.reviewConflictReason) {
      const markedConflict = await markImportLedgerItemConflict({
        operationId,
        organizationId,
        itemId,
        errorCode: "CATEGORY_CHANGED_AFTER_REVIEW",
        errorMessage: row.reviewConflictReason,
      });
      if (!markedConflict) return { status: "IN_PROGRESS", operationId };
      conflictRows.push({
        rowNumber: row.rowNumber,
        reason: row.reviewConflictReason,
      });
      continue;
    }
    if (!storedExecutionPlan && isResume) {
      await markImportLedgerItemConflict({
        operationId,
        organizationId,
        itemId,
        errorCode: "LEGACY_APPLY_PLAN_MISSING",
        errorMessage:
          "The prior APPLYING operation has no saved row plan, so its write status cannot be proven.",
      });
      conflictRows.push({
        rowNumber: row.rowNumber,
        reason:
          "The prior APPLYING operation has no saved row plan, so its write status cannot be proven.",
      });
      continue;
    }
    if (!applicableActions.has(row.action)) {
      const skipped = await markImportLedgerItemSkipped({
        operationId,
        organizationId,
        itemId,
      });
      if (!skipped) return { status: "IN_PROGRESS", operationId };
      continue;
    }

    let writeStarted = false;
    let recoverySnapshot: ImportAssetRecoverySnapshot | null = null;
    try {
      if (
        !(await heartbeatImportLedgerItem({
          operationId,
          organizationId,
          itemId,
        }))
      ) {
        return { status: "IN_PROGRESS", operationId };
      }
      const createLike =
        !row.assetId &&
        (row.action === "CREATE" || row.action === "NEEDS_REVIEW");
      if (createLike) {
        const existing = await db.asset.findMany({
          where: { organizationId, title: row.title },
          select: { id: true },
        });
        if (existing.length > 0) {
          const reason =
            "An exact-title asset appeared after review. Re-review this row before applying it.";
          const markedConflict = await markImportLedgerItemConflict({
            operationId,
            organizationId,
            itemId,
            errorCode: "CREATE_TARGET_CHANGED_AFTER_REVIEW",
            errorMessage: reason,
          });
          if (!markedConflict) return { status: "IN_PROGRESS", operationId };
          conflictRows.push({ rowNumber: row.rowNumber, reason });
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
          const activeCategories = await getActiveCategoriesForOrganization({
            organizationId,
          });
          const category = activeCategories.find(
            (candidate) => candidate.id === row.categoryId
          );
          if (
            !category ||
            (row.categoryLabel && category.name !== row.categoryLabel)
          ) {
            const reason =
              "The approved category changed or is no longer active in this organization.";
            const markedConflict = await markImportLedgerItemConflict({
              operationId,
              organizationId,
              itemId,
              errorCode: "CATEGORY_CHANGED_AFTER_REVIEW",
              errorMessage: reason,
            });
            if (!markedConflict) return { status: "IN_PROGRESS", operationId };
            conflictRows.push({ rowNumber: row.rowNumber, reason });
            continue;
          }
        }
        if (row.locationId) {
          if (
            !(await isReviewedImportLocationCurrent({
              organizationId,
              locationId: row.locationId,
              expectedPath: row.locationLabel,
            }))
          ) {
            const reason =
              "The approved location changed or no longer exists in this organization.";
            const markedConflict = await markImportLedgerItemConflict({
              operationId,
              organizationId,
              itemId,
              errorCode: "LOCATION_CHANGED_AFTER_REVIEW",
              errorMessage: reason,
            });
            if (!markedConflict) return { status: "IN_PROGRESS", operationId };
            conflictRows.push({ rowNumber: row.rowNumber, reason });
            continue;
          }
        }
        if (row.type === "INDIVIDUAL") {
          const quantity = requestedIndividualUnitQuantity(row);
          if (quantity === null) {
            throw importError(
              "A positive received quantity is required for individual units."
            );
          }
          let unitPlan = readIndividualUnitImportPlan(ledgerItem.expectedPrior);
          if (!unitPlan) {
            try {
              unitPlan = await buildIndividualUnitImportPlan({
                operationId,
                row,
                organizationId,
                userId,
                filename: proposal.source.filename,
              });
            } catch (cause) {
              if (cause instanceof ImportAssetModelConflictError) {
                const markedConflict = await markImportLedgerItemConflict({
                  operationId,
                  organizationId,
                  itemId,
                  errorCode: cause.code,
                  errorMessage: cause.message,
                });
                if (!markedConflict)
                  return { status: "IN_PROGRESS", operationId };
                conflictRows.push({
                  rowNumber: row.rowNumber,
                  reason: cause.message,
                });
                continue;
              }
              throw cause;
            }
            const recorded = await recordImportLedgerExpectedPrior({
              operationId,
              organizationId,
              itemId,
              expectedPrior: unitPlan as unknown as Prisma.InputJsonValue,
            });
            if (!recorded) return { status: "IN_PROGRESS", operationId };
          }
          if (unitPlan.units.length !== quantity) {
            const reason =
              "The saved physical-unit plan does not match the approved quantity.";
            const markedConflict = await markImportLedgerItemConflict({
              operationId,
              organizationId,
              itemId,
              errorCode: "INDIVIDUAL_UNIT_PLAN_MISMATCH",
              errorMessage: reason,
            });
            if (!markedConflict) return { status: "IN_PROGRESS", operationId };
            conflictRows.push({ rowNumber: row.rowNumber, reason });
            continue;
          }

          try {
            await ensureIndividualAssetModel({
              plan: unitPlan,
              row,
              organizationId,
              userId,
              filename: proposal.source.filename,
            });
          } catch (cause) {
            if (cause instanceof ImportAssetModelConflictError) {
              const markedConflict = await markImportLedgerItemConflict({
                operationId,
                organizationId,
                itemId,
                errorCode: cause.code,
                errorMessage: cause.message,
              });
              if (!markedConflict)
                return { status: "IN_PROGRESS", operationId };
              conflictRows.push({
                rowNumber: row.rowNumber,
                reason: cause.message,
              });
              continue;
            }
            Logger.error({
              event: "ioio_staff_import_model_prepare_failed",
              operationId,
              organizationId,
              rowNumber: row.rowNumber,
              error: cause instanceof Error ? cause.message : String(cause),
            });
            return { status: "IN_PROGRESS", operationId };
          }

          let unitItems: ImportLedgerItem[];
          try {
            await ensureImportLedgerItems({
              operationId,
              organizationId,
              items: planIndividualUnitWork({
                operationId,
                rowNumber: row.rowNumber,
                assetModelId: unitPlan.assetModelId,
                units: unitPlan.units,
              }),
            });
            unitItems = (
              await getImportLedgerItems({
                operationId,
                organizationId,
              })
            ).filter(
              (entry) =>
                entry.rowKey === `row-${row.rowNumber}` &&
                entry.unitIndex !== null
            );
          } catch (cause) {
            Logger.error({
              event: "ioio_staff_import_unit_ledger_prepare_failed",
              operationId,
              organizationId,
              rowNumber: row.rowNumber,
              error: cause instanceof Error ? cause.message : String(cause),
            });
            return { status: "IN_PROGRESS", operationId };
          }
          if (unitItems.length !== quantity) {
            const reason = "The physical-unit ledger is incomplete.";
            const markedConflict = await markImportLedgerItemConflict({
              operationId,
              organizationId,
              itemId,
              errorCode: "INDIVIDUAL_UNIT_LEDGER_INCOMPLETE",
              errorMessage: reason,
            });
            if (!markedConflict) return { status: "IN_PROGRESS", operationId };
            conflictRows.push({ rowNumber: row.rowNumber, reason });
            continue;
          }

          const unitsByIndex = new Map(
            unitItems.map((unit) => [unit.unitIndex!, unit])
          );
          const orderedUnits = unitPlan.units.map((unit) => {
            const ledgerUnit = unitsByIndex.get(unit.unitIndex);
            if (!ledgerUnit)
              throw importError("A physical unit is missing its ledger entry.");
            return ledgerUnit;
          });
          for (const chunk of chunkImportUnitWork(
            orderedUnits as Array<ImportLedgerItem & { unitIndex: number }>,
            INDIVIDUAL_UNIT_IMPORT_BATCH_SIZE
          )) {
            for (let unitItem of chunk) {
              const unitIndex = unitItem.unitIndex!;
              const addFailure = (reason: string) =>
                failedRows.push({
                  rowNumber: row.rowNumber,
                  reason,
                  unitIndex,
                });
              const addConflict = (reason: string) =>
                conflictRows.push({
                  rowNumber: row.rowNumber,
                  reason,
                  unitIndex,
                });
              if (unitItem.status === "IN_FLIGHT") {
                const currentStaleBefore = new Date(
                  Date.now() - STAFF_IMPORT_LEDGER_STALE_AFTER_MS
                );
                if (!isImportItemStale(unitItem, currentStaleBefore)) {
                  return { status: "IN_PROGRESS", operationId };
                }
                await reconcileStaleImportItem({
                  item: unitItem,
                  organizationId,
                  staleBefore: new Date(
                    Date.now() - STAFF_IMPORT_LEDGER_STALE_AFTER_MS
                  ),
                });
                const refreshed = await getImportLedgerItem({
                  operationId,
                  organizationId,
                  itemId: unitItem.id,
                });
                if (!refreshed) return { status: "IN_PROGRESS", operationId };
                unitItem = refreshed as typeof unitItem;
              }
              if (unitItem.status === "DONE") {
                if (unitItem.targetAssetId)
                  createdIds.push(unitItem.targetAssetId);
                continue;
              }
              if (unitItem.status === "FAILED") {
                addFailure(
                  unitItem.errorMessage ?? "Shelf rejected this physical unit."
                );
                continue;
              }
              if (unitItem.status === "CONFLICT") {
                addConflict(
                  unitItem.errorMessage ?? "This physical unit needs review."
                );
                continue;
              }
              if (unitItem.status === "SKIPPED") continue;

              const claimedUnit = await claimImportLedgerItem({
                operationId,
                organizationId,
                itemId: unitItem.id,
              });
              if (!claimedUnit) {
                const currentUnit = await getImportLedgerItem({
                  operationId,
                  organizationId,
                  itemId: unitItem.id,
                });
                if (currentUnit?.status === "DONE") {
                  if (currentUnit.targetAssetId)
                    createdIds.push(currentUnit.targetAssetId);
                  continue;
                }
                if (currentUnit?.status === "FAILED") {
                  addFailure(
                    currentUnit.errorMessage ??
                      "Shelf rejected this physical unit."
                  );
                  continue;
                }
                if (currentUnit?.status === "CONFLICT") {
                  addConflict(
                    currentUnit.errorMessage ??
                      "This physical unit needs review."
                  );
                  continue;
                }
                return { status: "IN_PROGRESS", operationId };
              }
              if (!unitItem.targetAssetId || !unitItem.qrId) {
                const reason =
                  "The physical unit is missing its reserved Asset or QR ID.";
                const markedConflict = await markImportLedgerItemConflict({
                  operationId,
                  organizationId,
                  itemId: unitItem.id,
                  errorCode: "INDIVIDUAL_UNIT_ID_MISSING",
                  errorMessage: reason,
                });
                if (!markedConflict)
                  return { status: "IN_PROGRESS", operationId };
                addConflict(reason);
                continue;
              }
              if (
                !(await heartbeatImportLedgerItem({
                  operationId,
                  organizationId,
                  itemId: unitItem.id,
                }))
              ) {
                return { status: "IN_PROGRESS", operationId };
              }

              try {
                await ensureIndividualAssetModel({
                  plan: unitPlan,
                  row,
                  organizationId,
                  userId,
                  filename: proposal.source.filename,
                });
              } catch (cause) {
                if (!(cause instanceof ImportAssetModelConflictError)) {
                  return { status: "IN_PROGRESS", operationId };
                }
                const markedConflict = await markImportLedgerItemConflict({
                  operationId,
                  organizationId,
                  itemId: unitItem.id,
                  errorCode: cause.code,
                  errorMessage: cause.message,
                });
                if (!markedConflict)
                  return { status: "IN_PROGRESS", operationId };
                addConflict(cause.message);
                continue;
              }

              if (row.categoryId) {
                const activeCategory = (
                  await getActiveCategoriesForOrganization({ organizationId })
                ).find((category) => category.id === row.categoryId);
                if (
                  !activeCategory ||
                  (row.categoryLabel &&
                    activeCategory.name !== row.categoryLabel)
                ) {
                  const reason =
                    "The approved category changed or is no longer active in this organization.";
                  const markedConflict = await markImportLedgerItemConflict({
                    operationId,
                    organizationId,
                    itemId: unitItem.id,
                    errorCode: "CATEGORY_CHANGED_AFTER_REVIEW",
                    errorMessage: reason,
                  });
                  if (!markedConflict)
                    return { status: "IN_PROGRESS", operationId };
                  addConflict(reason);
                  continue;
                }
              }
              if (row.locationId) {
                if (
                  !(await isReviewedImportLocationCurrent({
                    organizationId,
                    locationId: row.locationId,
                    expectedPath: row.locationLabel,
                  }))
                ) {
                  const reason =
                    "The approved location changed or no longer exists in this organization.";
                  const markedConflict = await markImportLedgerItemConflict({
                    operationId,
                    organizationId,
                    itemId: unitItem.id,
                    errorCode: "LOCATION_CHANGED_AFTER_REVIEW",
                    errorMessage: reason,
                  });
                  if (!markedConflict)
                    return { status: "IN_PROGRESS", operationId };
                  addConflict(reason);
                  continue;
                }
              }

              try {
                writeStarted = true;
                await createAsset({
                  title: unitPlan.units[unitIndex].title,
                  description: buildImportedDescription(
                    proposal.source.filename,
                    row
                  ),
                  userId,
                  organizationId,
                  valuation: null,
                  categoryId: row.categoryId,
                  locationId: row.locationId ?? undefined,
                  assetModelId: unitPlan.assetModelId,
                  id: unitItem.targetAssetId,
                  newQrId: unitItem.qrId,
                  type: AssetType.INDIVIDUAL,
                  quantity: null,
                });
                const markedDone = await markImportLedgerItemDone({
                  operationId,
                  organizationId,
                  itemId: unitItem.id,
                  targetAssetId: unitItem.targetAssetId,
                  qrId: unitItem.qrId,
                  writtenState: {
                    outcome: "created",
                    assetId: unitItem.targetAssetId,
                    qrId: unitItem.qrId,
                  },
                });
                if (!markedDone) return { status: "IN_PROGRESS", operationId };
                createdIds.push(unitItem.targetAssetId);
              } catch (cause) {
                let evidence: IndividualUnitWriteEvidence;
                try {
                  evidence = await inspectIndividualUnitWrite({
                    item: claimedUnit,
                    organizationId,
                  });
                } catch {
                  return { status: "IN_PROGRESS", operationId };
                }
                if (evidence === "WRITTEN") {
                  const markedDone = await markImportLedgerItemDone({
                    operationId,
                    organizationId,
                    itemId: unitItem.id,
                    targetAssetId: unitItem.targetAssetId,
                    qrId: unitItem.qrId,
                    writtenState: {
                      outcome: "created",
                      assetId: unitItem.targetAssetId,
                      qrId: unitItem.qrId,
                    },
                  });
                  if (!markedDone)
                    return { status: "IN_PROGRESS", operationId };
                  createdIds.push(unitItem.targetAssetId);
                } else if (evidence === "NOT_WRITTEN") {
                  const reason =
                    cause instanceof Error
                      ? cause.message.slice(0, 200)
                      : "Shelf rejected this physical unit.";
                  const markedFailed = await markImportLedgerItemFailed({
                    operationId,
                    organizationId,
                    itemId: unitItem.id,
                    errorCode: "INDIVIDUAL_UNIT_CREATE_FAILED",
                    errorMessage: reason,
                  });
                  if (!markedFailed)
                    return { status: "IN_PROGRESS", operationId };
                  addFailure(reason);
                } else {
                  const reason =
                    "The Asset and atomic QR creation result could not be proven.";
                  const markedConflict = await markImportLedgerItemConflict({
                    operationId,
                    organizationId,
                    itemId: unitItem.id,
                    errorCode: "INDIVIDUAL_UNIT_WRITE_UNVERIFIABLE",
                    errorMessage: reason,
                  });
                  if (!markedConflict)
                    return { status: "IN_PROGRESS", operationId };
                  addConflict(reason);
                }
              }
            }
          }

          const finalUnitItems = (
            await getImportLedgerItems({
              operationId,
              organizationId,
            })
          ).filter(
            (entry) =>
              entry.rowKey === `row-${row.rowNumber}` &&
              entry.unitIndex !== null
          );
          if (
            finalUnitItems.some(
              (unit) => unit.status === "PENDING" || unit.status === "IN_FLIGHT"
            )
          ) {
            return { status: "IN_PROGRESS", operationId };
          }
          const unitAssetIds = finalUnitItems
            .filter((unit) => unit.status === "DONE" && unit.targetAssetId)
            .map((unit) => unit.targetAssetId!);
          const failedCount = finalUnitItems.filter(
            (unit) => unit.status === "FAILED"
          ).length;
          const conflictCount = finalUnitItems.filter(
            (unit) => unit.status === "CONFLICT"
          ).length;
          const rowWrittenState: Prisma.InputJsonValue = {
            outcome: "individual_units",
            assetModelId: unitPlan.assetModelId,
            assetIds: unitAssetIds,
            unitCount: finalUnitItems.length,
            failedCount,
            conflictCount,
          };
          if (conflictCount > 0) {
            const markedConflict = await markImportLedgerItemConflict({
              operationId,
              organizationId,
              itemId,
              errorCode: "INDIVIDUAL_UNIT_CONFLICT",
              errorMessage: `${conflictCount} physical unit(s) need manual review.`,
              writtenState: rowWrittenState,
            });
            if (!markedConflict) return { status: "IN_PROGRESS", operationId };
          } else if (failedCount > 0) {
            const markedFailed = await markImportLedgerItemFailed({
              operationId,
              organizationId,
              itemId,
              errorCode: "INDIVIDUAL_UNIT_FAILURE",
              errorMessage: `${failedCount} physical unit(s) failed.`,
              writtenState: rowWrittenState,
            });
            if (!markedFailed) return { status: "IN_PROGRESS", operationId };
          } else {
            const markedDone = await markImportLedgerItemDone({
              operationId,
              organizationId,
              itemId,
              writtenState: rowWrittenState,
            });
            if (!markedDone) return { status: "IN_PROGRESS", operationId };
          }
          continue;
        }
        const type =
          row.type ??
          (receivedQuantity > 1 ? "QUANTITY_TRACKED" : "INDIVIDUAL");
        await recordImportLedgerExpectedPrior({
          operationId,
          organizationId,
          itemId,
          expectedPrior: {
            kind: "CREATE",
            rowKey: "row-" + row.rowNumber,
          },
        });
        if (
          !(await heartbeatImportLedgerItem({
            operationId,
            organizationId,
            itemId,
          }))
        ) {
          return { status: "IN_PROGRESS", operationId };
        }
        writeStarted = true;
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
            type === "QUANTITY_TRACKED"
              ? row.consumptionType === "ONE_WAY"
                ? ConsumptionType.ONE_WAY
                : ConsumptionType.TWO_WAY
              : null,
          minQuantity:
            type === "QUANTITY_TRACKED" ? row.minQuantity ?? null : null,
          unitOfMeasure:
            type === "QUANTITY_TRACKED" ? row.unitOfMeasure ?? "pcs" : null,
        });
        const markedDone = await markImportLedgerItemDone({
          operationId,
          organizationId,
          itemId,
          targetAssetId: asset.id,
          writtenState: { outcome: "created", assetId: asset.id },
        });
        if (!markedDone) {
          await markImportLedgerItemConflict({
            operationId,
            organizationId,
            itemId,
            errorCode: "ROW_RESULT_NOT_RECORDED",
            errorMessage:
              "The asset was created but its ledger result could not be saved.",
          });
          conflictRows.push({
            rowNumber: row.rowNumber,
            reason:
              "The asset was created but its ledger result could not be saved.",
          });
          continue;
        }
        createdIds.push(asset.id);
        continue;
      }
      if (!row.assetId)
        throw importError("The proposal row has no Shelf asset ID.");
      const asset = await db.asset.findFirst({
        where: { id: row.assetId, organizationId },
        select: {
          id: true,
          title: true,
          type: true,
          quantity: true,
          categoryId: true,
          assetModelId: true,
          assetLocations: {
            select: { locationId: true, quantity: true, assetKitId: true },
          },
        },
      });
      if (!asset)
        throw importError(
          "The referenced Shelf asset is not in this organization."
        );
      if (
        !row.expectedAssetState ||
        !matchesExpectedAssetState(row.expectedAssetState, asset)
      ) {
        const reason =
          "The selected asset changed after review. Re-review its quantity, category, location, or product before applying.";
        const markedConflict = await markImportLedgerItemConflict({
          operationId,
          organizationId,
          itemId,
          errorCode: "ASSET_CHANGED_AFTER_REVIEW",
          errorMessage: reason,
        });
        if (!markedConflict) return { status: "IN_PROGRESS", operationId };
        conflictRows.push({ rowNumber: row.rowNumber, reason });
        continue;
      }
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
      if (!action) {
        const skipped = await markImportLedgerItemSkipped({
          operationId,
          organizationId,
          itemId,
        });
        if (!skipped) return { status: "IN_PROGRESS", operationId };
        continue;
      }
      const before = {
        quantity: asset.quantity,
        categoryId: asset.categoryId,
        manualLocationIds: asset.assetLocations
          .filter((assetLocation) => assetLocation.assetKitId === null)
          .map((assetLocation) => assetLocation.locationId),
      };
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
        recoverySnapshot = {
          kind: "ASSET_UPDATE",
          action,
          assetId: asset.id,
          before,
          target: { quantity: targetQuantity },
        };
        const recorded = await recordImportLedgerExpectedPrior({
          operationId,
          organizationId,
          itemId,
          expectedPrior: recoverySnapshot,
        });
        if (!recorded) return { status: "IN_PROGRESS", operationId };
        if (
          !(await heartbeatImportLedgerItem({
            operationId,
            organizationId,
            itemId,
          }))
        ) {
          return { status: "IN_PROGRESS", operationId };
        }
        writeStarted = true;
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
        recoverySnapshot = {
          kind: "ASSET_UPDATE",
          action,
          assetId: asset.id,
          before,
          target: { quantity: row.quantity },
        };
        const recorded = await recordImportLedgerExpectedPrior({
          operationId,
          organizationId,
          itemId,
          expectedPrior: recoverySnapshot,
        });
        if (!recorded) return { status: "IN_PROGRESS", operationId };
        if (
          !(await heartbeatImportLedgerItem({
            operationId,
            organizationId,
            itemId,
          }))
        ) {
          return { status: "IN_PROGRESS", operationId };
        }
        writeStarted = true;
        await updateAsset({
          id: asset.id,
          userId,
          organizationId,
          request,
          quantity: row.quantity,
        });
      } else if (action === "UPDATE_CATEGORY") {
        if (!row.categoryId) throw importError("The category is missing.");
        const category = (
          await getActiveCategoriesForOrganization({ organizationId })
        ).find((candidate) => candidate.id === row.categoryId);
        if (
          !category ||
          (row.categoryLabel && category.name !== row.categoryLabel)
        ) {
          const reason =
            "The approved category changed or is no longer active in this organization.";
          const markedConflict = await markImportLedgerItemConflict({
            operationId,
            organizationId,
            itemId,
            errorCode: "CATEGORY_CHANGED_AFTER_REVIEW",
            errorMessage: reason,
          });
          if (!markedConflict) return { status: "IN_PROGRESS", operationId };
          conflictRows.push({ rowNumber: row.rowNumber, reason });
          continue;
        }
        recoverySnapshot = {
          kind: "ASSET_UPDATE",
          action,
          assetId: asset.id,
          before,
          target: { categoryId: category.id },
        };
        const recorded = await recordImportLedgerExpectedPrior({
          operationId,
          organizationId,
          itemId,
          expectedPrior: recoverySnapshot,
        });
        if (!recorded) return { status: "IN_PROGRESS", operationId };
        if (
          !(await heartbeatImportLedgerItem({
            operationId,
            organizationId,
            itemId,
          }))
        ) {
          return { status: "IN_PROGRESS", operationId };
        }
        writeStarted = true;
        await updateAsset({
          id: asset.id,
          userId,
          organizationId,
          request,
          categoryId: category.id,
        });
      } else {
        if (!row.locationId) throw importError("The location is missing.");
        if (
          !(await isReviewedImportLocationCurrent({
            organizationId,
            locationId: row.locationId,
            expectedPath: row.locationLabel,
          }))
        ) {
          const reason =
            "The approved location changed or no longer exists in this organization.";
          const markedConflict = await markImportLedgerItemConflict({
            operationId,
            organizationId,
            itemId,
            errorCode: "LOCATION_CHANGED_AFTER_REVIEW",
            errorMessage: reason,
          });
          if (!markedConflict) return { status: "IN_PROGRESS", operationId };
          conflictRows.push({ rowNumber: row.rowNumber, reason });
          continue;
        }
        recoverySnapshot = {
          kind: "ASSET_UPDATE",
          action,
          assetId: asset.id,
          before,
          target: { manualLocationIds: [row.locationId] },
        };
        const recorded = await recordImportLedgerExpectedPrior({
          operationId,
          organizationId,
          itemId,
          expectedPrior: recoverySnapshot,
        });
        if (!recorded) return { status: "IN_PROGRESS", operationId };
        if (
          !(await heartbeatImportLedgerItem({
            operationId,
            organizationId,
            itemId,
          }))
        ) {
          return { status: "IN_PROGRESS", operationId };
        }
        writeStarted = true;
        await updateAsset({
          id: asset.id,
          userId,
          organizationId,
          request,
          newLocationId: row.locationId,
          currentLocationId: asset.assetLocations[0]?.locationId ?? null,
        });
      }
      writeStarted = true;
      const markedDone = await markImportLedgerItemDone({
        operationId,
        organizationId,
        itemId,
        targetAssetId: asset.id,
        writtenState: {
          outcome: "updated",
          assetId: asset.id,
          action,
        },
      });
      if (!markedDone) {
        const markedConflict = await markImportLedgerItemConflict({
          operationId,
          organizationId,
          itemId,
          errorCode: "ROW_RESULT_NOT_RECORDED",
          errorMessage:
            "The asset update completed but its ledger result could not be saved.",
        });
        if (!markedConflict) return { status: "IN_PROGRESS", operationId };
        conflictRows.push({
          rowNumber: row.rowNumber,
          reason:
            "The asset update completed but its ledger result could not be saved.",
        });
        continue;
      }
      updatedIds.push(asset.id);
    } catch (cause) {
      const reason =
        cause instanceof Error
          ? cause.message.slice(0, 200)
          : "Shelf rejected the change.";
      if (writeStarted && recoverySnapshot) {
        const observed = await inspectAssetRecoverySnapshot({
          snapshot: recoverySnapshot,
          organizationId,
        });
        if (observed === "TARGET") {
          const markedDone = await markImportLedgerItemDone({
            operationId,
            organizationId,
            itemId,
            targetAssetId: recoverySnapshot.assetId,
            writtenState: {
              outcome: "updated",
              assetId: recoverySnapshot.assetId,
              action: recoverySnapshot.action,
              target: recoverySnapshot.target,
            },
          });
          if (markedDone) {
            updatedIds.push(recoverySnapshot.assetId);
            continue;
          }
        }
        if (observed === "BEFORE") {
          const markedFailed = await markImportLedgerItemFailed({
            operationId,
            organizationId,
            itemId,
            errorCode: "ROW_WRITE_REJECTED",
            errorMessage: reason,
          });
          if (!markedFailed) return { status: "IN_PROGRESS", operationId };
          failedRows.push({ rowNumber: row.rowNumber, reason });
          continue;
        }
      }
      if (writeStarted) {
        const markedConflict = await markImportLedgerItemConflict({
          operationId,
          organizationId,
          itemId,
          errorCode: "ROW_WRITE_OUTCOME_UNKNOWN",
          errorMessage: reason,
        });
        if (!markedConflict) return { status: "IN_PROGRESS", operationId };
        conflictRows.push({ rowNumber: row.rowNumber, reason });
      } else {
        const markedFailed = await markImportLedgerItemFailed({
          operationId,
          organizationId,
          itemId,
          errorCode: "ROW_REJECTED",
          errorMessage: reason,
        });
        if (!markedFailed) return { status: "IN_PROGRESS", operationId };
        failedRows.push({ rowNumber: row.rowNumber, reason });
      }
    }
  }

  const finalLedgerItems = await getImportLedgerItems({
    operationId,
    organizationId,
  });
  const finalLedgerByRowKey = new Map<string, ImportLedgerItem[]>();
  for (const item of finalLedgerItems) {
    const rowItems = finalLedgerByRowKey.get(item.rowKey) ?? [];
    rowItems.push(item);
    finalLedgerByRowKey.set(item.rowKey, rowItems);
  }
  const rowStatuses: StaffImportLedgerStatus[] = [];
  for (const row of rowsToApply) {
    const rowItems = finalLedgerByRowKey.get(`row-${row.rowNumber}`) ?? [];
    const unitItems = rowItems.filter((item) => item.unitIndex !== null);
    const countedItems = unitItems.length
      ? unitItems
      : rowItems.filter((item) => item.unitIndex === null);
    if (countedItems.length === 0)
      throw importError("An import row is missing its ledger entry.");
    rowStatuses.push(
      ...countedItems.map((item) => item.status as StaffImportLedgerStatus)
    );
    if (unitItems.length > 0) {
      for (const item of unitItems) {
        const detail = {
          rowNumber: row.rowNumber,
          unitIndex: item.unitIndex!,
          reason: item.errorMessage ?? "",
        };
        if (
          item.status === "FAILED" &&
          !failedRows.some(
            (entry) =>
              entry.rowNumber === detail.rowNumber &&
              entry.unitIndex === detail.unitIndex
          )
        ) {
          failedRows.push({
            ...detail,
            reason: detail.reason || "Shelf rejected this physical unit.",
          });
        }
        if (
          item.status === "CONFLICT" &&
          !conflictRows.some(
            (entry) =>
              entry.rowNumber === detail.rowNumber &&
              entry.unitIndex === detail.unitIndex
          )
        ) {
          conflictRows.push({
            ...detail,
            reason: detail.reason || "This physical unit needs review.",
          });
        }
      }
    }
  }
  const { status: aggregateStatus, ...rowSummary } =
    summarizeStaffImportRows(rowStatuses);
  if (aggregateStatus === "APPLYING")
    return { status: "IN_PROGRESS", operationId };

  const result: StaffImportResult = {
    operationId,
    createdIds,
    updatedIds,
    reusedIds,
    failedRows,
    conflictRows,
    ignoredRows: rowSummary.skippedRows,
    reviewedRows: storedExecutionPlan?.reviewedRows ?? decisions.length,
    ...rowSummary,
  };
  const completed = await db.ioioWriteOperation.updateMany({
    where: { id: operationId, organizationId, userId, status: "APPLYING" },
    data: {
      status: aggregateStatus,
      description: JSON.stringify({
        kind: "STAFF_INVENTORY_IMPORT",
        proposal,
        result,
      }),
      failureCode:
        conflictRows.length > 0
          ? "ROW_CONFLICT"
          : failedRows.length > 0
          ? "ROW_FAILURE"
          : null,
      completedAt: new Date(),
    },
  });
  if (completed.count !== 1) return { status: "IN_PROGRESS", operationId };
  Logger.info({
    event: "ioio_staff_import_applied",
    operationId,
    organizationId,
    userId,
    created: createdIds.length,
    updated: updatedIds.length,
    reused: reusedIds.length,
    failed: failedRows.length,
    conflicts: conflictRows.length,
    ignored: result.skippedRows,
    reviewed: result.reviewedRows,
    aggregateStatus,
  });
  return result;
}
