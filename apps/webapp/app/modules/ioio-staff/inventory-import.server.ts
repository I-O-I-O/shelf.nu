import { createHash, randomUUID } from "node:crypto";
import { inflateRawSync, inflateSync } from "node:zlib";
import { AssetType, ConsumptionType, type Prisma } from "@prisma/client";
import JSZip from "jszip";
import { db } from "~/database/db.server";
import {
  BULK_CREATE_MAX,
  createAsset,
  updateAssetMainImage,
  updateAsset,
} from "~/modules/asset/service.server";
import {
  updateAssetModelDescriptionIfUnchanged,
  updateAssetModelImage,
} from "~/modules/asset-model/service.server";
import {
  createCategory,
  getActiveCategoriesForOrganization,
} from "~/modules/category/service.server";
import { getConfiguredBrokenSection } from "~/modules/ioio-lab-information/broken-section.server";
import { getIoioArchivedCategoryIds } from "~/modules/ioio-staff/archive.server";
import { PICKUP_ZONE_NAME } from "~/modules/ioio-staff/pickup-zone.server";
import { getConfiguredReportReturnArea } from "~/modules/ioio-student/report-return-location.server";
import { getLocations } from "~/modules/location/service.server";
import { PUBLIC_BUCKET } from "~/utils/constants";
import { ShelfError } from "~/utils/error";
import { getRandomColor } from "~/utils/get-random-color";
import { id } from "~/utils/id/id.server";
import { detectImageFormat } from "~/utils/image-format.server";
import { Logger } from "~/utils/logger";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";
import { resolveStorageImageUrl } from "~/utils/storage.server";
import { requireIoioStaffAccess } from "./access.server";
import {
  getImportAssetModelIdentity,
  ImportAssetModelConflictError,
  resolveImportAssetModel,
} from "./import-asset-model.server";
import { requestImportHelperProposal } from "./import-helper-client.server";
import {
  createMouserEnrichmentRequest,
  createImportHelperRequest,
  MOUSER_ENRICHMENT_BATCH_SIZE,
  type ImportHelperCandidateRow,
  type MouserEnrichmentResponse,
  type MouserLineItemInput,
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
  buildImportLocationAffinities,
  buildImportLocationRepresentativeProducts,
  getImportLocationPath,
  getOperationalImportLocationIds,
  matchesReviewedImportLocationPath,
  normalizeImportLabel,
  resolveImportCategory,
  resolveImportCategorySuggestion,
  resolveImportLocation,
  resolveImportLocationSuggestion,
  selectImportLocationCandidates,
  type ImportLocationDiagnosticReason,
  type ImportLocationSuggestionStatus,
  type ImportProductEvidence,
  type ImportSuggestionMethod,
} from "./import-resolution";
import {
  resolveImportReviewState,
  type StaffImportReviewState,
} from "./import-review";
import { PDF_OCR_MAX_PAGES, PdfOcrError, ocrPdfPages } from "./pdf-ocr.server";
import { pdfjsResourceUrl } from "./pdfjs-runtime.server";
import {
  enrichImportProductRows,
  type ExistingImportAssetModel,
  type ImportProductDescriptionSource,
  type ImportProductImageProposal,
  type ProductEnrichmentDiagnostics,
} from "./product-enrichment.server";
import {
  detectSpreadsheetHeader,
  isSpreadsheetNonProduct,
  MISSING_FORMULA_VALUE,
  normalizeSpreadsheetHeader,
  readSpreadsheetCsv,
  SPREADSHEET_BATCH_SIZE,
} from "./spreadsheet-normalization.server";

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

export type ImportRowDiagnosticReasonCode =
  | "QUANTITY_EXTRACTED"
  | "QUANTITY_AMBIGUOUS"
  | "QUANTITY_INVALID"
  | ImportLocationDiagnosticReason;

export type StaffImportDiagnostics = {
  rowsParsed: number;
  rowsWithQuantity: number;
  quantityNeedsReview: number;
  rowsWithSuggestedLocation: number;
  locationFallbackUsed: number;
  locationUnresolved: number;
  imageLookupAttempted?: number;
  imageCandidatesConsidered?: number;
  imageAccepted?: number;
  imageRejectedReason?: Record<string, number>;
  descriptionGenerated?: number;
  descriptionSource?: Record<ImportProductDescriptionSource, number>;
};

export type StaffImportRow = {
  rowNumber: number;
  sourceSheet?: string;
  sourceRow?: number;
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
  enrichmentConfidence?: number;
  assetModelDescription?: string | null;
  existingAssetModelDescription?: string | null;
  existingAssetModelId?: string | null;
  existingAssetModelImageUrl?: string | null;
  existingAssetModelThumbnailUrl?: string | null;
  assetModelDescriptionSource?: ImportProductDescriptionSource;
  productImageProposal?: ImportProductImageProposal;
  acceptSuggestedImage?: boolean;
  suggestedCategoryId?: string | null;
  categorySuggestionConfidence?: number;
  suggestedLocationId?: string | null;
  locationSuggestionConfidence?: number;
  categorySuggestionMethod?: ImportSuggestionMethod | "unresolved";
  locationSuggestionMethod?: ImportSuggestionMethod | "unresolved";
  locationSuggestionStatus?: ImportLocationSuggestionStatus;
  diagnosticReasonCodes?: ImportRowDiagnosticReasonCode[];
  categoryConfidence?: "High" | "Medium" | "Low";
  categoryReason?: string;
  reviewRequired?: boolean;
  uncertainFields?: string[];
  pdfClassification?: "VALID_ITEM" | "PARTIAL";
  helperCandidate?: ImportHelperCandidateRow;
  mouserLineItem?: true;
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
  unresolvedLines?: number;
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
  categoryOptions?: Array<NamedRecord & { color?: string; archived?: boolean }>;
  locationOptions?: ImportLocationOption[];
  pdfSummary?: StaffImportPdfSummary;
  diagnostics?: StaffImportDiagnostics;
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

type NamedRecord = {
  id: string;
  name: string;
  description?: string | null;
  color?: string | null;
};
type ImportLocationOption = NamedRecord & {
  parentId: string | null;
  pathLabel: string;
  operational: boolean;
  currentUnits: number;
  categoryAffinities?: Array<{
    categoryId: string;
    categoryName: string;
    assetCount: number;
    units: number;
  }>;
  representativeProducts?: string[];
};

function formatLocationPlacementContext(
  categoryAffinities: ImportLocationOption["categoryAffinities"]
) {
  const summaries = (categoryAffinities ?? [])
    .slice(0, 5)
    .map(
      ({ categoryName, assetCount, units }) =>
        `${categoryName}: ${assetCount} ${
          assetCount === 1 ? "asset" : "assets"
        }, ${units} ${units === 1 ? "unit" : "units"}`
    );
  return summaries.length
    ? `Existing category placement: ${summaries.join("; ")}`.slice(0, 1_000)
    : null;
}

function getLocationHelperDescription(
  location: Pick<
    ImportLocationOption,
    "description" | "categoryAffinities" | "representativeProducts"
  >
) {
  const context = formatLocationPlacementContext(location.categoryAffinities);
  const representativeProducts = location.representativeProducts?.length
    ? `Similar stored products: ${location.representativeProducts
        .slice(0, 4)
        .join("; ")}`
    : null;
  return (
    [location.description, context, representativeProducts]
      .filter(Boolean)
      .join(" | ")
      .slice(0, 500) || null
  );
}

function getImportLocationCandidatesForEvidence({
  evidence,
  locations,
  limit = 20,
}: {
  evidence: {
    evidence: ImportProductEvidence;
    category?: NamedRecord | null;
  }[];
  locations: ImportLocationOption[];
  limit?: number;
}) {
  return selectImportLocationCandidates({
    products: evidence,
    locations,
    limit,
    perProductLimit: 5,
  });
}

function getImportCandidateDiagnostics(
  categories: NamedRecord[],
  locations: ImportLocationOption[]
) {
  const categoryCandidates = categories.slice(0, 500).map((category) => ({
    id: category.id,
    name: category.name,
    // Shelf categories are flat records in the current schema.
    hierarchyDepth: 0,
    descriptionPresent: Boolean(category.description?.trim()),
  }));
  const locationCandidates = locations
    .filter((location) => !location.operational)
    .slice(0, 1_000)
    .map((location) => ({
      id: location.id,
      name: location.name,
      pathDepth: location.pathLabel.split(" · ").filter(Boolean).length,
      descriptionPresent: Boolean(location.description?.trim()),
      assignable: !location.operational,
    }));
  const nonAssignableLocations = locations
    .filter((location) => location.operational)
    .slice(0, 1_000)
    .map((location) => ({
      id: location.id,
      name: location.name,
      pathDepth: location.pathLabel.split(" · ").filter(Boolean).length,
      descriptionPresent: Boolean(location.description?.trim()),
      assignable: false,
    }));
  return {
    categoryCandidateCount: categoryCandidates.length,
    categoryCandidates,
    locationCandidateCount: locationCandidates.length,
    loadedLocationCount: locations.length,
    locationCandidates,
    nonAssignableLocationCount: locations.filter(
      (location) => location.operational
    ).length,
    nonAssignableLocations,
  };
}

async function getAllImportLocations(organizationId: string) {
  const pageSize = 500;
  const locations: Array<{
    id: string;
    name: string;
    parentId: string | null;
    description: string | null;
    color: string | null;
  }> = [];
  let page = 1;
  let totalLocations = 0;
  do {
    const result = await getLocations({
      organizationId,
      page,
      perPage: pageSize,
      orderBy: "name",
      orderDirection: "asc",
    });
    totalLocations = result.totalLocations;
    locations.push(
      ...result.locations.map(({ id, name, parentId, description, color }) => ({
        id,
        name,
        parentId,
        description,
        color,
      }))
    );
    page += 1;
  } while (locations.length < totalLocations);
  return locations;
}

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

type StaffImportInputField =
  | keyof StaffImportRow
  | "shippedQuantityInput"
  | "deliveredQuantityInput"
  | "backorderedQuantityInput";

const HEADER_ALIASES: Record<string, StaffImportInputField> = {
  model: "title",
  "model name": "title",
  product: "title",
  "product name": "title",
  article: "title",
  artikel: "title",
  "item description": "sourceDescription",
  brand: "manufacturer",
  vendor: "manufacturer",
  maker: "manufacturer",
  tillverkare: "manufacturer",
  sku: "supplierPartNumber",
  "supplier sku": "supplierPartNumber",
  "article number": "supplierPartNumber",
  artikelnummer: "supplierPartNumber",
  "part number": "supplierPartNumber",
  "item number": "supplierPartNumber",
  "mfr part no": "manufacturerPartNumber",
  "manufacturer pn": "manufacturerPartNumber",
  stock: "quantity",
  antal: "quantity",
  received: "receivedQuantity",
  shipped: "shippedQuantityInput",
  delivered: "deliveredQuantityInput",
  backordered: "backorderedQuantityInput",
  backorder: "backorderedQuantityInput",
  "back order": "backorderedQuantityInput",
  ordered: "orderedQuantity",
  group: "category",
  class: "category",
  storage: "location",
  bin: "location",
  shelf: "location",
  container: "location",
  room: "location",
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
  "quantity shipped": "shippedQuantityInput",
  "shipped quantity": "shippedQuantityInput",
  "qty shipped": "shippedQuantityInput",
  "quantity delivered": "deliveredQuantityInput",
  "delivered quantity": "deliveredQuantityInput",
  "qty delivered": "deliveredQuantityInput",
  "delivery quantity": "deliveredQuantityInput",
  "quantity backordered": "backorderedQuantityInput",
  "backordered quantity": "backorderedQuantityInput",
  "qty backordered": "backorderedQuantityInput",
  "back order quantity": "backorderedQuantityInput",
  "quantity received": "receivedQuantity",
  "received quantity": "receivedQuantity",
  "qty received": "receivedQuantity",
  notes: "sourceNotes",
  "line notes": "sourceNotes",
};

const PRIVATE_HEADER =
  /borrower|borrowed by|email|e-mail|student|phone|contact|lending.?id|user.?id|auth|role/i;
const IGNORED_HEADER =
  /price|value|vat|tax|invoice|subtotal|total|address|payment|currency|account|page/i;
const PDF_AI_ANALYSIS_REQUIRED_MESSAGE =
  "This PDF contains readable text, but AI-assisted document analysis is required to identify product line items.";
const PDF_OCR_REQUIRED_MESSAGE =
  "This PDF requires OCR before it can be analyzed.";
const PDF_OCR_UNRECOVERABLE_MESSAGE =
  "Readable text could not be recovered from this PDF.";
const PDF_OCR_PAGE_LIMIT_MESSAGE = `This PDF exceeds the ${PDF_OCR_MAX_PAGES}-page limit for OCR analysis.`;
const PDF_OCR_BUSY_MESSAGE =
  "PDF analysis is busy. Please try again in a moment.";

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
  const rows: string[][] = [];
  for (const rowMatch of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/gi)) {
    const cells: string[] = [];
    for (const cellMatch of rowMatch[2].matchAll(
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
      const value =
        /<f(?:\s|>)/i.test(body) && !/<v\b/i.test(body)
          ? MISSING_FORMULA_VALUE
          : type === "s"
          ? sharedStrings[Number(raw)] ?? ""
          : raw;
      cells[index] = value;
    }
    const rowIndex =
      Number(rowMatch[1].match(/\br="(\d+)"/)?.[1] ?? rows.length + 1) - 1;
    if (rowIndex > STAFF_IMPORT_MAX_ROWS + 40) {
      if (cells.some((cell) => cell.trim()))
        throw importError("Workbook data range exceeds the import row limit.");
      continue;
    }
    while (rows.length < rowIndex) rows.push([]);
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
  const strings: string[] = [];
  for (const match of value.matchAll(/\(((?:\\.|[^\\()])*)\)\s*Tj/g)) {
    strings.push(decodePdfLiteral(match[1]).trim());
  }
  for (const match of value.matchAll(/<([\da-f\s]+)>\s*Tj/gi)) {
    strings.push(decodePdfHexString(match[1]).trim());
  }
  for (const match of value.matchAll(/\(((?:\\.|[^\\()])*)\)\s*['"]/g)) {
    strings.push(decodePdfLiteral(match[1]).trim());
  }
  for (const match of value.matchAll(/<([\da-f\s]+)>\s*['"]/gi)) {
    strings.push(decodePdfHexString(match[1]).trim());
  }
  for (const match of value.matchAll(/\[((?:\\.|[^\]])*)\]\s*TJ/g)) {
    const operands = match[1];
    for (const literal of operands.matchAll(/\(((?:\\.|[^\\()])*)\)/g)) {
      strings.push(decodePdfLiteral(literal[1]));
    }
    for (const hexadecimal of operands.matchAll(/<([\da-f\s]+)>/gi)) {
      strings.push(decodePdfHexString(hexadecimal[1]));
    }
  }
  return strings.map((text) => text.trim()).filter(Boolean);
}

type ExtractedPdfPage = ImportHelperRequest["document"]["pages"][number];

type PositionedPdfTextItem = {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  page: number;
};

type PositionedPdfPage = {
  sourceRef: string;
  page: number;
  items: PositionedPdfTextItem[];
};

type PdfExtractorName = "primary" | "pdfjs" | "ocr";

type PdfTextMetrics = {
  pageCount: number;
  extractedCharsPerPage: number[];
  totalExtractedChars: number;
  meaningfulText: boolean;
  hasTextLayerEvidence: boolean;
};

type PdfExtractorAttempt = PdfTextMetrics & {
  extractor: PdfExtractorName;
  status:
    | "readable"
    | "empty"
    | "error"
    | "unavailable"
    | "page-limit"
    | "timeout"
    | "busy";
};

type PdfTextDiagnostics = PdfTextMetrics & {
  selectedExtractor: PdfExtractorName | null;
  extractorAttempts: PdfExtractorAttempt[];
  ocrPagesAttempted: number;
  ocrPagesSuccessful: number;
};

type PdfPageExtraction = {
  pages: ExtractedPdfPage[];
  positionedPages?: PositionedPdfPage[];
  positionedExtractor?: "pdfjs" | "ocr";
  diagnostics: PdfTextDiagnostics;
};

function decodePdfHexString(value: string) {
  const compact = value.replace(/\s+/g, "");
  const evenLength = compact.length % 2 === 0 ? compact : `${compact}0`;
  const bytes = Buffer.from(evenLength, "hex");
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const utf16be = Buffer.from(bytes.subarray(2));
    for (let index = 0; index + 1 < utf16be.length; index += 2) {
      const firstByte = utf16be[index];
      utf16be[index] = utf16be[index + 1] ?? 0;
      utf16be[index + 1] = firstByte ?? 0;
    }
    return utf16be.toString("utf16le");
  }
  if (
    bytes.length >= 4 &&
    bytes.length % 2 === 0 &&
    bytes.every((byte, index) => (index % 2 === 0 ? byte === 0 : byte !== 0))
  ) {
    const utf16be = Buffer.from(bytes);
    for (let index = 0; index + 1 < utf16be.length; index += 2) {
      const firstByte = utf16be[index];
      utf16be[index] = utf16be[index + 1] ?? 0;
      utf16be[index + 1] = firstByte ?? 0;
    }
    return utf16be.toString("utf16le");
  }
  return bytes.toString("utf8").replace(/\0/g, "");
}

function getPdfTextDiagnostics(
  pages: readonly ExtractedPdfPage[],
  pageCount = pages.length,
  hasTextLayerEvidence = false
): PdfTextMetrics {
  const diagnosticPageCount = pageCount || pages.length;
  const extractedCharsPerPage = Array.from(
    { length: diagnosticPageCount },
    (_, index) => pages[index]?.text.length ?? 0
  );
  return {
    pageCount: diagnosticPageCount,
    extractedCharsPerPage,
    totalExtractedChars: extractedCharsPerPage.reduce(
      (total, count) => total + count,
      0
    ),
    meaningfulText:
      pageCount > 0 &&
      pages.reduce(
        (total, { text }) =>
          total + (text.match(/[\p{L}\p{N}]/gu)?.length ?? 0),
        0
      ) >= 3,
    hasTextLayerEvidence,
  };
}

function isMeaningfulPdfText(diagnostics: PdfTextMetrics) {
  return diagnostics.pageCount > 0 && diagnostics.meaningfulText;
}

function extractPdfObjectText(objectBody: string) {
  const strings: string[] = [];
  let hasTextLayerEvidence = false;
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
    const streamText = decoded.toString("utf8");
    if (/\bTj\b|\bTJ\b|(?:\)|>)\s*['"]/.test(streamText)) {
      hasTextLayerEvidence = true;
    }
    strings.push(...extractPdfStrings(streamText));
  }
  return {
    text: strings.join("\n").trim(),
    hasTextLayerEvidence,
  };
}

function extractPdfPagesPrimary(buffer: Buffer): {
  pages: ExtractedPdfPage[];
  diagnostics: PdfTextMetrics;
} {
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
  const pageTreeCount = [...objects.values()]
    .find((body) => /\/Type\s*\/Pages\b/.test(body))
    ?.match(/\/Count\s+(\d+)\b/)?.[1];
  const pageCount = pageObjects.length || Number(pageTreeCount ?? 0);
  if (pageCount > STAFF_IMPORT_MAX_PAGES) {
    throw importError(
      `The PDF contains more than ${STAFF_IMPORT_MAX_PAGES} pages.`
    );
  }

  const streamTextByObjectId = new Map<number, string>();
  let hasTextLayerEvidence = false;
  for (const [objectId, body] of objects) {
    const extracted = extractPdfObjectText(body);
    if (extracted.text) streamTextByObjectId.set(objectId, extracted.text);
    hasTextLayerEvidence ||= extracted.hasTextLayerEvidence;
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
      : extractPdfObjectText(body).text ||
        streamTextByObjectId.get(objectId) ||
        "";
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
  let extractionPages = pages;
  if (!extractionPages.some((page) => page.text.length > 0)) {
    // Keep text that was decoded from content streams even if this PDF's page
    // objects do not expose their Contents references in the expected form.
    // Lack of a structured inventory table is handled later and must not be
    // confused with lack of a text layer.
    const recoveredText = [...streamTextByObjectId.values()].join("\n").trim();
    if (recoveredText) {
      extractionPages = [
        { sourceRef: "pdf-page-1", page: 1, text: recoveredText },
      ];
    }
  }
  const diagnostics = getPdfTextDiagnostics(
    extractionPages,
    pageCount || extractionPages.length,
    hasTextLayerEvidence
  );
  return {
    pages: extractionPages,
    diagnostics,
  };
}

type PdfJsTextItem = {
  str?: string;
  transform?: number[];
  width?: number;
  height?: number;
  hasEOL?: boolean;
};

function normalizePdfJsPageText(value: string) {
  return value
    .split("\u0000")
    .join("")
    .replace(/[\u00a0\u2007\u202f]/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function reconstructPdfJsText(items: readonly PdfJsTextItem[]) {
  let text = "";
  let previous: PdfJsTextItem | null = null;
  let previousXEnd: number | null = null;
  let previousY: number | null = null;

  for (const item of items) {
    const value = item.str ?? "";
    if (!value) continue;

    const x = item.transform?.[4];
    const y = item.transform?.[5];
    const itemHeight = Math.abs(item.height ?? item.transform?.[3] ?? 12);
    const previousHeight = Math.abs(
      previous?.height ?? previous?.transform?.[3] ?? itemHeight
    );
    const isNewLine =
      previous !== null &&
      (previous.hasEOL === true ||
        (typeof y === "number" &&
          typeof previousY === "number" &&
          Math.abs(y - previousY) > Math.max(2, itemHeight * 0.45)));

    if (isNewLine) {
      text += "\n";
    } else if (
      text.length > 0 &&
      typeof x === "number" &&
      previousXEnd !== null &&
      x - previousXEnd >
        Math.max(1.5, Math.min(itemHeight, previousHeight) * 0.16)
    ) {
      text += " ";
    } else if (
      text.length > 0 &&
      (typeof x !== "number" || previousXEnd === null) &&
      !/[\s]$/.test(text) &&
      !/^[\s]/.test(value)
    ) {
      text += " ";
    }

    text += value;
    previousXEnd =
      typeof x === "number" && typeof item.width === "number"
        ? x + item.width
        : null;
    previousY = typeof y === "number" ? y : null;
    previous = item;
  }

  return normalizePdfJsPageText(text);
}

async function extractPdfPagesWithPdfJs(buffer: Buffer) {
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

  let pageCount = 0;
  let hasTextLayerEvidence = false;
  try {
    const document = await loadingTask.promise;
    pageCount = document.numPages;
    if (pageCount > STAFF_IMPORT_MAX_PAGES) {
      throw importError(
        `The PDF contains more than ${STAFF_IMPORT_MAX_PAGES} pages.`
      );
    }

    const pages: ExtractedPdfPage[] = [];
    const positionedPages: PositionedPdfPage[] = [];
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const items = content.items as PdfJsTextItem[];
      hasTextLayerEvidence ||= items.some((item) => Boolean(item.str));
      positionedPages.push({
        sourceRef: `pdf-page-${pageNumber}`,
        page: pageNumber,
        items: items.flatMap((item) => {
          const text = item.str?.trim();
          const x = item.transform?.[4];
          const y = item.transform?.[5];
          if (
            !text ||
            typeof x !== "number" ||
            typeof y !== "number" ||
            !Number.isFinite(x) ||
            !Number.isFinite(y)
          ) {
            return [];
          }
          return [
            {
              text,
              x,
              y,
              width: Math.abs(item.width ?? 0),
              height: Math.abs(item.height ?? item.transform?.[3] ?? 0),
              page: pageNumber,
            },
          ];
        }),
      });
      pages.push({
        sourceRef: `pdf-page-${pageNumber}`,
        page: pageNumber,
        text: reconstructPdfJsText(items),
      });
    }

    return {
      pages,
      positionedPages,
      diagnostics: getPdfTextDiagnostics(
        pages,
        pageCount,
        hasTextLayerEvidence
      ),
    };
  } finally {
    await loadingTask.destroy();
  }
}

function createPdfExtractorAttempt(
  extractor: PdfExtractorName,
  diagnostics: PdfTextMetrics,
  status?: PdfExtractorAttempt["status"]
): PdfExtractorAttempt {
  return {
    extractor,
    ...diagnostics,
    status: status ?? (diagnostics.meaningfulText ? "readable" : "empty"),
  };
}

async function extractPdfPages(buffer: Buffer): Promise<PdfPageExtraction> {
  const primary = extractPdfPagesPrimary(buffer);
  const primaryAttempt = createPdfExtractorAttempt(
    "primary",
    primary.diagnostics
  );
  if (isMeaningfulPdfText(primary.diagnostics)) {
    return {
      pages: primary.pages,
      diagnostics: {
        ...primary.diagnostics,
        selectedExtractor: "primary",
        extractorAttempts: [primaryAttempt],
        ocrPagesAttempted: 0,
        ocrPagesSuccessful: 0,
      },
    };
  }

  let secondary: Awaited<ReturnType<typeof extractPdfPagesWithPdfJs>> | null =
    null;
  let secondaryAttempt: PdfExtractorAttempt;
  try {
    secondary = await extractPdfPagesWithPdfJs(buffer);
    secondaryAttempt = createPdfExtractorAttempt(
      "pdfjs",
      secondary.diagnostics
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes("more than")) {
      throw error;
    }
    secondaryAttempt = createPdfExtractorAttempt(
      "pdfjs",
      getPdfTextDiagnostics(
        [],
        primary.diagnostics.pageCount,
        primary.diagnostics.hasTextLayerEvidence
      ),
      "error"
    );
  }

  const secondaryDiagnostics = secondary?.diagnostics;
  const pageCount = Math.max(
    primary.diagnostics.pageCount,
    secondaryDiagnostics?.pageCount ?? 0
  );
  const hasTextLayerEvidence =
    primary.diagnostics.hasTextLayerEvidence ||
    Boolean(secondaryDiagnostics?.hasTextLayerEvidence);
  const pages = secondary?.pages ?? primary.pages;
  const finalMetrics = getPdfTextDiagnostics(
    pages,
    pageCount || pages.length,
    hasTextLayerEvidence
  );
  const diagnostics: PdfTextDiagnostics = {
    ...finalMetrics,
    selectedExtractor: secondaryDiagnostics?.meaningfulText ? "pdfjs" : null,
    extractorAttempts: [primaryAttempt, secondaryAttempt],
    ocrPagesAttempted: 0,
    ocrPagesSuccessful: 0,
  };

  if (isMeaningfulPdfText(finalMetrics)) {
    return {
      pages,
      ...(secondary?.positionedPages?.length
        ? {
            positionedPages: secondary.positionedPages,
            positionedExtractor: "pdfjs" as const,
          }
        : {}),
      diagnostics,
    };
  }

  if (!diagnostics.pageCount) {
    Logger.info({
      event: "ioio_staff_import_pdf_text_extracted",
      ...diagnostics,
      classification: "unreadable",
      detectedVendorParser: null,
      genericClaudeFallbackInvoked: false,
    });
    throw importError(
      "This PDF's page structure could not be read. Export it again as a standard PDF and retry."
    );
  }

  let ocrResult: Awaited<ReturnType<typeof ocrPdfPages>> | null = null;
  let ocrFailure: PdfOcrError | null = null;
  try {
    ocrResult = await ocrPdfPages(buffer);
  } catch (error) {
    ocrFailure =
      error instanceof PdfOcrError ? error : new PdfOcrError("failed");
  }

  const recoveredOcrPages = ocrResult?.pages ?? [];
  const recoveredPages: ExtractedPdfPage[] = recoveredOcrPages.map(
    ({ sourceRef, page, text }) => ({ sourceRef, page, text })
  );
  const recoveredPageCount = Math.max(
    pageCount,
    ocrResult?.pageCount ?? ocrFailure?.pageCount ?? 0
  );
  const recoveredMetrics = getPdfTextDiagnostics(
    recoveredPages,
    recoveredPageCount,
    hasTextLayerEvidence
  );
  const ocrAttempt = createPdfExtractorAttempt(
    "ocr",
    recoveredMetrics,
    (ocrFailure?.code === "failed" ? "error" : ocrFailure?.code) ??
      (recoveredMetrics.meaningfulText ? "readable" : "empty")
  );
  const finalDiagnostics: PdfTextDiagnostics = {
    ...recoveredMetrics,
    selectedExtractor: recoveredMetrics.meaningfulText ? "ocr" : null,
    extractorAttempts: [primaryAttempt, secondaryAttempt, ocrAttempt],
    ocrPagesAttempted:
      ocrResult?.ocrPagesAttempted ?? ocrFailure?.ocrPagesAttempted ?? 0,
    ocrPagesSuccessful:
      ocrResult?.ocrPagesSuccessful ?? ocrFailure?.ocrPagesSuccessful ?? 0,
  };

  if (isMeaningfulPdfText(recoveredMetrics)) {
    return {
      pages: recoveredPages,
      positionedPages: recoveredOcrPages.map(
        ({ sourceRef, page, positionedItems = [] }) => ({
          sourceRef,
          page,
          items: positionedItems,
        })
      ),
      positionedExtractor: "ocr",
      diagnostics: finalDiagnostics,
    };
  }

  const classification = ocrFailure
    ? `ocr-${ocrFailure.code}`
    : "ocr-no-readable-text";
  Logger.info({
    event: "ioio_staff_import_pdf_text_extracted",
    ...finalDiagnostics,
    classification,
    detectedVendorParser: null,
    genericClaudeFallbackInvoked: false,
  });

  if (ocrFailure?.code === "unavailable") {
    throw importError(PDF_OCR_REQUIRED_MESSAGE);
  }
  if (ocrFailure?.code === "page-limit") {
    throw importError(PDF_OCR_PAGE_LIMIT_MESSAGE);
  }
  if (ocrFailure?.code === "busy") {
    throw importError(PDF_OCR_BUSY_MESSAGE);
  }
  throw importError(PDF_OCR_UNRECOVERABLE_MESSAGE);
}

export type MouserInvoiceLineItem = MouserLineItemInput & {
  lineNumber: number;
  orderedQuantity: number;
  shippedQuantity: number;
  pendingQuantity: number;
  sourceEvidence: string;
};

export type MouserInvoiceParseResult = {
  detected: boolean;
  lineItems: MouserInvoiceLineItem[];
  unresolvedLines: number;
  detectedLineNumbers: number[];
  detectedSupplierSkus: string[];
  positionSource: "pdfjs" | "ocr" | "text";
};

const MOUSER_SKU_PATTERN = /\b\d{3}-[A-Z0-9][A-Z0-9_-]{5,}\b/i;
const MOUSER_SKU_GLOBAL_PATTERN = /\b\d{3}-[A-Z0-9][A-Z0-9_-]{5,}\b/gi;
const MOUSER_MPN_LABEL_PATTERN =
  /^(?:kundens\s*\/\s*t\s*illv|t\s*illv|manufacturer\s+part(?:\s+(?:number|no\.?))?|mfg\s+part(?:\s+(?:number|no\.?))?|mpn)\s*\.?\s*artikelnr?\s*[:#-]?\s*(.*)$/i;
const MOUSER_GENERAL_MPN_LABEL_PATTERN =
  /^(?:manufacturer\s+part(?:\s+(?:number|no\.?))?|mfg\s+part(?:\s+(?:number|no\.?))?|mpn)\s*[:#-]?\s*(.*)$/i;
const MOUSER_MPN_FIELD_PATTERN =
  /(?:\b(?:kundens\s*\/\s*)?t\s*illv\s*\.?\s*(?:artikelnr?\.?|artikelnummer)|\bmanufacturer\s+part(?:\s+(?:number|no\.?))?|\bmfg\s+part(?:\s+(?:number|no\.?))?|\bmpn)\s*[:#-]?\s*((?=[A-Z0-9./_-]{3,})(?=[A-Z0-9./_-]*(?:\d|[./_-]))[A-Z0-9][A-Z0-9./_-]*)?/i;
const MOUSER_HEADER_LABELS = new Set([
  "radnr",
  "line no",
  "line number",
  "mousers artikelnummer",
  "mouser artikelnummer",
  "mouser part number",
  "mouser part no",
  "kundens/tillv. artikelnr",
  "kundens/tillv artikelnr",
  "beskrivning",
  "description",
  "ordered",
  "quantity ordered",
  "shipped",
  "quantity shipped",
  "pending",
  "quantity pending",
  "price",
  "unit price",
  "total",
  "extended price",
  "continued",
  "fortsätter",
]);
const MOUSER_REGULATORY_PREFIX_PATTERN =
  /^\s*(?:US\s+HTS|HTS(?:\s+code)?|TARIC|ECCN|COO|Country\s+of\s+Origin|ACO|COD|VAT|Tax|Freight)\s*[:#-]?/i;

type MouserLineAnchor = {
  lineNumber: number;
  supplierProductNumber: string;
  page: number;
  sourceRef: string;
  lineIndex: number;
  skuIndex: number;
  y?: number;
  skuX?: number;
  lineItems?: PositionedPdfTextItem[];
};

type MouserPositionedLine = {
  y: number;
  items: PositionedPdfTextItem[];
  text: string;
};

type MouserHeaderCenters = {
  lineNumber: number | null;
  supplier: number | null;
  ordered: number | null;
  shipped: number | null;
  pending: number | null;
  price: number | null;
};

function normalizeMouserLabel(value: string) {
  return value
    .trim()
    .toLocaleLowerCase("en")
    .replace(/\s*([.:])\s*/g, "$1")
    .replace(/\s+/g, " ");
}

function compactMouserLabel(value: string) {
  return normalizeMouserLabel(value).replace(/[^a-z0-9]/g, "");
}

const MOUSER_HEADER_LABELS_COMPACT = new Set(
  [...MOUSER_HEADER_LABELS].map(compactMouserLabel)
);

function isMouserHeaderLine(value: string) {
  return MOUSER_HEADER_LABELS_COMPACT.has(compactMouserLabel(value));
}

function isMouserRegulatoryLine(value: string) {
  return MOUSER_REGULATORY_PREFIX_PATTERN.test(value.trim());
}

function isMouserNoiseFragment(value: string) {
  const normalized = normalizeMouserLabel(value);
  return (
    !normalized ||
    isMouserHeaderLine(value) ||
    /^(?:page\s+)?\d+\s*(?:of|\/)\s*\d+$/i.test(normalized) ||
    isMouserRegulatoryLine(value) ||
    /^continued\b|^fortsätter\b/i.test(normalized) ||
    /^[€$£]?\s*\d{1,3}(?:[,.]\d{2,4})\s*[€$£]?$/u.test(value.trim())
  );
}

function parseMouserQuantity(fragment: string) {
  const text = fragment.trim();
  if (!/^(?:\d{1,7}|\d{1,3}(?:,\d{3})+)$/.test(text)) return null;
  const quantity = Number(text.replace(/,/g, ""));
  return Number.isSafeInteger(quantity) && quantity <= 1_000_000
    ? quantity
    : null;
}

function findMouserQuantityTriple(lines: string[]) {
  for (let index = 1; index <= lines.length - 3; index += 1) {
    const ordered = parseMouserQuantity(lines[index] ?? "");
    const shipped = parseMouserQuantity(lines[index + 1] ?? "");
    const pending = parseMouserQuantity(lines[index + 2] ?? "");
    if (ordered !== null && shipped !== null && pending !== null) {
      return { index, ordered, shipped, pending };
    }
  }
  for (let index = 1; index < lines.length; index += 1) {
    const quantities = (lines[index] ?? "")
      .trim()
      .split(/\s+/)
      .map(parseMouserQuantity);
    if (
      quantities.length === 3 &&
      quantities.every((value) => value !== null)
    ) {
      return {
        index,
        ordered: quantities[0]!,
        shipped: quantities[1]!,
        pending: quantities[2]!,
      };
    }
  }
  return null;
}

function parseMouserMpnValue(value: string) {
  return /^([A-Z0-9][A-Z0-9./_-]{2,})/i.exec(value.trim())?.[1] ?? null;
}

function extractMouserDescription(
  lines: readonly string[],
  supplierSku: string
) {
  let mpn: string | null = null;
  const sourceText = lines
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line && !isMouserNoiseFragment(line))
    .join(" ")
    .replace(/\s+([.:])/g, "$1")
    .replace(MOUSER_SKU_GLOBAL_PATTERN, " ");
  const mpnField = MOUSER_MPN_FIELD_PATTERN.exec(sourceText);
  let descriptionText = sourceText;
  if (mpnField?.[0]) {
    mpn = parseMouserMpnValue(mpnField[1] ?? "");
    descriptionText = `${sourceText.slice(
      0,
      mpnField.index
    )} ${sourceText.slice(mpnField.index + mpnField[0].length)}`;
  }
  const rawDescription = cleanMouserDescription(
    descriptionText
      .split(/\s+/)
      .filter((fragment) => fragment && !/^\d+$/u.test(fragment))
      .join(" ")
  );
  const metadataLeaked =
    MOUSER_MPN_LABEL_PATTERN.test(rawDescription) ||
    MOUSER_GENERAL_MPN_LABEL_PATTERN.test(rawDescription) ||
    isMouserRegulatoryLine(rawDescription);
  if (
    rawDescription.length < 3 ||
    metadataLeaked ||
    normalizeMouserLabel(rawDescription) ===
      normalizeMouserLabel(supplierSku) ||
    (mpn && normalizeMouserLabel(rawDescription) === normalizeMouserLabel(mpn))
  ) {
    return { mpn, rawDescription: "" };
  }
  return { mpn, rawDescription };
}

function cleanMouserDescription(value: string) {
  return value
    .replace(
      /\s*[,;|–—-]?\s*\b(?:US\s+HTS|HTS(?:\s+code)?|TARIC|ECCN|COO|Country\s+of\s+Origin|ACO|COD|VAT|Tax|Freight)\s*[:#-]?\s*[A-Z0-9./-]+(?:\s+.*)?$/i,
      ""
    )
    .replace(/\s+/g, " ")
    .trim();
}

function cleanMouserProductTitle(
  value: string,
  lineItem: MouserInvoiceLineItem
) {
  let title = cleanMouserDescription(value)
    .replace(/\s+([.:])/g, "$1")
    .trim();
  for (const identifier of [lineItem.supplierProductNumber, lineItem.mpn]) {
    if (!identifier) continue;
    const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    title = title.replace(new RegExp(`^${escaped}\\s*[-:|]?\\s*`, "i"), "");
  }
  if (
    title.length < 3 ||
    isMouserNoiseFragment(title) ||
    MOUSER_MPN_LABEL_PATTERN.test(title) ||
    MOUSER_GENERAL_MPN_LABEL_PATTERN.test(title) ||
    /\bt\s*illv\s*\.?\s*artikelnr\b/i.test(title) ||
    /\b(?:TARIC|US\s+HTS|HTS|ECCN|COO|ACO|COD)\s*[:#-]?/i.test(title) ||
    normalizeMouserLabel(title) ===
      normalizeMouserLabel(lineItem.supplierProductNumber) ||
    (lineItem.mpn &&
      normalizeMouserLabel(title) === normalizeMouserLabel(lineItem.mpn))
  ) {
    return null;
  }
  return normalizeMouserTitleText(title);
}

function normalizeMouserTitleText(value: string) {
  let title = value
    // Mouser often places a translated description after a slash. Keep the
    // source-language product identity before that procurement translation.
    .split(/\s+\/\s+/u, 1)[0]!
    .replace(/\s+\((?:pre-soldered)\)\s*$/i, "")
    .replace(
      /\s+(?:(?:multi[- ]?protocol|ARM)\s+)?development\s+(?:tool|board)\s*$/i,
      ""
    )
    .replace(/\s+/g, " ")
    .trim();

  // Some Mouser descriptions repeat the manufacturer before the family name.
  // Collapse only an identical repeated leading phrase.
  while (/^(.+?)\s+\1(?=\s|$)/i.test(title)) {
    title = title.replace(/^(.+?)\s+\1(?=\s|$)/i, "$1");
  }
  return title;
}

function getMouserIdentityTokens(value: string) {
  const patterns = [
    /\bSeeed\s+Studio\b/gi,
    /\bXIAO\s+ES\b/gi,
    /\bXIAO\b/gi,
    /\b(?:nRF\s*-?\s*\d{4,}|ESP32\s*-?\s*[SC]\d{1,2}|MR\d{2}[A-Z]{2,}\d+)\b/gi,
    /\b\d{2}\s*GHz\b/gi,
    /\bmmWave\b/gi,
    /\bSense\b/gi,
    /\bHuman\s+Presence\b/gi,
    /\bBreathing\b/gi,
    /\bHeartbeat\b/gi,
    /\bFall\s+Detection\b/gi,
    /\bSensors?\b/gi,
  ];
  return patterns.flatMap((pattern) =>
    Array.from(value.matchAll(pattern), ([token]) =>
      token.toLocaleLowerCase().replace(/[^a-z0-9]/g, "")
    )
  );
}

function getMouserSourceManufacturer(value: string) {
  if (/^Seeed\s+Studio\b/i.test(value.trim())) return "Seeed Studio";
  const firstIdentityIndex = value.search(
    /\b(?:XIAO|nRF\s*-?\s*\d{4,}|ESP32\s*-?\s*[SC]\d{1,2}|MR\d{2}[A-Z]{2,}\d+|\d{2}\s*GHz)\b/i
  );
  if (firstIdentityIndex <= 0) return null;
  const leadingName = normalizeMouserTitleText(
    value.slice(0, firstIdentityIndex).trim()
  );
  return leadingName && leadingName.split(/\s+/u).length <= 4
    ? leadingName
    : null;
}

function preservesMouserProductIdentity(
  candidate: string,
  lineItem: MouserInvoiceLineItem,
  manufacturer: string | null
) {
  const normalizedCandidate = candidate
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]/g, "");
  const sourceTokens = getMouserIdentityTokens(lineItem.rawDescription);
  const candidateTokens = getMouserIdentityTokens(candidate);
  if (
    sourceTokens.some((token) => !normalizedCandidate.includes(token)) ||
    candidateTokens.some((token) => !sourceTokens.includes(token))
  ) {
    return false;
  }

  if (
    manufacturer &&
    !normalizedCandidate.startsWith(
      manufacturer.toLocaleLowerCase().replace(/[^a-z0-9]/g, "")
    )
  ) {
    return false;
  }
  return true;
}

function resolveMouserProductName(
  enrichedName: string | null,
  lineItem: MouserInvoiceLineItem,
  manufacturer: string | null
) {
  const sourceName = cleanMouserProductTitle(lineItem.rawDescription, lineItem);
  if (!sourceName) return lineItem.rawDescription;

  const cleanedEnrichedName = enrichedName
    ? cleanMouserProductTitle(enrichedName, lineItem)
    : null;
  return cleanedEnrichedName &&
    preservesMouserProductIdentity(cleanedEnrichedName, lineItem, manufacturer)
    ? cleanedEnrichedName
    : sourceName;
}

function buildMouserTextLines(pages: readonly ExtractedPdfPage[]) {
  return pages.flatMap((page) =>
    page.text.split(/\r?\n/).map((text, index) => ({
      text: text.trim(),
      page: page.page,
      sourceRef: page.sourceRef,
      index,
    }))
  );
}

function collectMouserTextAnchors(pages: readonly ExtractedPdfPage[]) {
  const lines = buildMouserTextLines(pages);
  const anchors: MouserLineAnchor[] = [];
  const detectedSkus: string[] = [];
  lines.forEach((line, index) => {
    const sameLine = /^(\d{1,4})\s+/.exec(line.text);
    const skuMatch = line.text.match(MOUSER_SKU_PATTERN);
    if (!skuMatch) return;
    detectedSkus.push(skuMatch[0]);
    let lineNumber = sameLine ? Number(sameLine[1]) : null;
    let lineIndex = index;
    if (lineNumber === null) {
      const previous = lines[index - 1]?.text ?? "";
      const numericLine = /^(\d{1,4})$/.exec(previous);
      if (numericLine) {
        lineNumber = Number(numericLine[1]);
        lineIndex = index - 1;
      }
    }
    if (lineNumber === null || lineNumber < 1 || lineNumber > 9999) return;
    anchors.push({
      lineNumber,
      supplierProductNumber: skuMatch[0],
      page: line.page,
      sourceRef: line.sourceRef,
      lineIndex,
      skuIndex: index,
    });
  });
  return { anchors, detectedSkus, lines };
}

function parseMouserTextRows(pages: readonly ExtractedPdfPage[]) {
  const { anchors, detectedSkus, lines } = collectMouserTextAnchors(pages);
  const lineItems: MouserInvoiceLineItem[] = [];
  const orderedAnchors = [...anchors].sort(
    (left, right) => left.page - right.page || left.lineIndex - right.lineIndex
  );
  orderedAnchors.forEach((anchor, anchorIndex) => {
    const nextAnchor = orderedAnchors[anchorIndex + 1];
    const sectionEnd = nextAnchor?.lineIndex ?? lines.length;
    const section = lines
      .slice(anchor.skuIndex, sectionEnd)
      .map(({ text }) => text);
    const quantity = findMouserQuantityTriple(section);
    if (!quantity || quantity.shipped <= 0) return;
    const { mpn, rawDescription } = extractMouserDescription(
      section.slice(0, quantity.index),
      anchor.supplierProductNumber
    );
    if (!rawDescription) return;
    const sourceEvidence = [
      String(anchor.lineNumber),
      ...section.slice(0, quantity.index + 3),
    ]
      .filter((line) => line.trim())
      .join("\n")
      .slice(0, 2_000);
    lineItems.push({
      sourceRef: `mouser-p${anchor.page}-line${anchor.lineNumber}`,
      sourcePage: anchor.page,
      lineNumber: anchor.lineNumber,
      supplierProductNumber: anchor.supplierProductNumber,
      mpn,
      rawDescription,
      quantity: quantity.shipped,
      orderedQuantity: quantity.ordered,
      shippedQuantity: quantity.shipped,
      pendingQuantity: quantity.pending,
      sourceEvidence,
    });
  });
  return {
    anchors: orderedAnchors,
    detectedSkus,
    lineItems,
    detectedLineNumbers: orderedAnchors.map(({ lineNumber }) => lineNumber),
  };
}

function groupMouserPositionedItems(page: PositionedPdfPage) {
  const sorted = [...page.items].sort((left, right) => left.y - right.y);
  const groups: MouserPositionedLine[] = [];
  for (const item of sorted) {
    const current = groups.at(-1);
    const groupHeight = current?.items.length
      ? current.items.reduce((sum, row) => sum + row.height, 0) /
        current.items.length
      : item.height;
    const tolerance = Math.max(
      2.5,
      Math.min(item.height || 10, groupHeight || 10) * 0.55
    );
    if (current && Math.abs(current.y - item.y) <= tolerance) {
      current.items.push(item);
      current.y =
        current.items.reduce((sum, row) => sum + row.y, 0) /
        current.items.length;
      current.text = current.items
        .slice()
        .sort((left, right) => left.x - right.x)
        .map(({ text }) => text)
        .join(" ");
    } else {
      groups.push({ y: item.y, items: [item], text: item.text });
    }
  }
  return groups;
}

function positionedItemCenter(item: PositionedPdfTextItem) {
  return item.x + item.width / 2;
}

function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? null;
}

function findMouserHeaderCenters(
  items: readonly PositionedPdfTextItem[]
): MouserHeaderCenters {
  const groupedLines = groupMouserPositionedItems({
    sourceRef: "mouser-header",
    page: items[0]?.page ?? 1,
    items: [...items],
  });
  const getCenter = (
    lineMatches: (text: string) => boolean,
    itemMatches: (text: string) => boolean
  ) => {
    const headerLines = groupedLines.filter((line) =>
      lineMatches(compactMouserLabel(line.text))
    );
    const headerItems = headerLines.flatMap((line) =>
      line.items.filter((item) => itemMatches(compactMouserLabel(item.text)))
    );
    return median(headerItems.map(positionedItemCenter));
  };
  return {
    lineNumber: getCenter(
      (text) => /radnr|lineno|linenumber/.test(text),
      (text) => /^(?:radnr|line|no|linenumber)$/.test(text)
    ),
    supplier: getCenter(
      (text) =>
        /mouser.*artikelnummer|artikelnummer.*mouser|kundens.*artikelnr|beskrivning|description/.test(
          text
        ),
      (text) =>
        /mouser|artikelnummer|artikelnr|beskrivning|description/.test(text)
    ),
    ordered: getCenter(
      (text) => /ordered|orderquantity/.test(text),
      (text) => /ordered/.test(text)
    ),
    shipped: getCenter(
      (text) => /shipped|received|delivered/.test(text),
      (text) => /shipped|received|delivered/.test(text)
    ),
    pending: getCenter(
      (text) => /pending/.test(text),
      (text) => /pending/.test(text)
    ),
    price: getCenter(
      (text) => /unitprice|extendedprice|price|total/.test(text),
      (text) => /unitprice|extendedprice|price|total/.test(text)
    ),
  };
}

function collectMouserPositionedAnchors(pages: readonly PositionedPdfPage[]) {
  const anchors: MouserLineAnchor[] = [];
  for (const page of pages) {
    const lines = groupMouserPositionedItems(page);
    const headerCenters = findMouserHeaderCenters(page.items);
    for (const line of lines) {
      const compactText = line.text.replace(/\s+/g, "");
      const skuMatch =
        line.text.match(MOUSER_SKU_PATTERN) ??
        compactText.match(MOUSER_SKU_PATTERN);
      if (!skuMatch) continue;
      const supplierProductNumber = skuMatch[0];
      const skuItem = line.items.find((item) =>
        MOUSER_SKU_PATTERN.test(item.text)
      );
      const skuX = skuItem
        ? positionedItemCenter(skuItem)
        : line.items.find(
            (item) => item.x > (headerCenters.lineNumber ?? -Infinity)
          )?.x ?? Math.min(...line.items.map((item) => item.x));
      const possibleLineNumbers = line.items.flatMap((item) => {
        const value = /^(\d{1,4})$/.exec(item.text.trim());
        if (!value || positionedItemCenter(item) >= skuX) return [];
        return [{ number: Number(value[1]), x: positionedItemCenter(item) }];
      });
      const lineNumberFromText = /^(\d{1,4})\s+/.exec(line.text.trim());
      const lineNumberCandidate =
        possibleLineNumbers.sort((left, right) =>
          headerCenters.lineNumber === null
            ? left.x - right.x
            : Math.abs(left.x - headerCenters.lineNumber) -
              Math.abs(right.x - headerCenters.lineNumber)
        )[0]?.number ??
        (lineNumberFromText ? Number(lineNumberFromText[1]) : null);
      if (
        lineNumberCandidate === null ||
        lineNumberCandidate < 1 ||
        lineNumberCandidate > 9999
      ) {
        continue;
      }
      anchors.push({
        lineNumber: lineNumberCandidate,
        supplierProductNumber,
        page: page.page,
        sourceRef: page.sourceRef,
        lineIndex: lines.indexOf(line),
        skuIndex: lines.indexOf(line),
        y: line.y,
        skuX,
        lineItems: line.items,
      });
    }
  }
  return anchors.sort(
    (left, right) =>
      left.page - right.page || left.lineNumber - right.lineNumber
  );
}

function extractMouserPositionedQuantities(
  region: readonly MouserPositionedLine[],
  centers: MouserHeaderCenters,
  anchorY: number
) {
  if (
    centers.ordered === null ||
    centers.shipped === null ||
    centers.pending === null
  ) {
    return null;
  }
  const orderedCenter = centers.ordered;
  const shippedCenter = centers.shipped;
  const pendingCenter = centers.pending;
  if (
    orderedCenter === null ||
    shippedCenter === null ||
    pendingCenter === null
  ) {
    return null;
  }
  const pageLeft = centers.supplier ?? centers.lineNumber ?? 0;
  const orderedLower = (pageLeft + orderedCenter) / 2;
  const orderedRange: [number, number] = [
    orderedLower,
    (orderedCenter + shippedCenter) / 2,
  ];
  const shippedRange: [number, number] = [
    orderedRange[1],
    (shippedCenter + pendingCenter) / 2,
  ];
  const pendingRange: [number, number] = [
    shippedRange[1],
    centers.price === null
      ? pendingCenter + (pendingCenter - shippedCenter) / 2
      : (pendingCenter + centers.price) / 2,
  ];
  const rows = region
    .map((line) => {
      const valueInColumn = (range: [number, number], center: number) =>
        line.items
          .flatMap((item) => {
            const quantity = parseMouserQuantity(item.text);
            const x = positionedItemCenter(item);
            if (quantity === null || x < range[0] || x >= range[1]) return [];
            return [{ quantity, distance: Math.abs(x - center) }];
          })
          .sort((left, right) => left.distance - right.distance)[0]?.quantity ??
        null;
      const ordered = valueInColumn(orderedRange, orderedCenter);
      const shipped = valueInColumn(shippedRange, shippedCenter);
      const pending = valueInColumn(pendingRange, pendingCenter);
      return {
        ordered,
        shipped,
        pending,
        valuesPresent: [ordered, shipped, pending].filter(
          (value) => value !== null
        ).length,
        distanceFromAnchor: Math.abs(line.y - anchorY),
      };
    })
    .filter(({ valuesPresent }) => valuesPresent === 3)
    .sort((left, right) => left.distanceFromAnchor - right.distanceFromAnchor);
  const selected = rows[0];
  const ordered = selected?.ordered ?? null;
  const shipped = selected?.shipped ?? null;
  const pending = selected?.pending ?? null;
  return ordered === null || shipped === null || pending === null
    ? null
    : { ordered, shipped, pending };
}

function parseMouserPositionedRows(
  pages: readonly PositionedPdfPage[],
  source: "pdfjs" | "ocr"
) {
  const anchors = collectMouserPositionedAnchors(pages);
  const lineItems: MouserInvoiceLineItem[] = [];
  for (const page of pages) {
    const pageLines = groupMouserPositionedItems(page);
    const headerCenters = findMouserHeaderCenters(page.items);
    const pageAnchors = anchors
      .filter((anchor) => anchor.page === page.page)
      .sort((left, right) => (left.y ?? 0) - (right.y ?? 0));
    const readingDirection = (() => {
      const lineOrdered = [...pageAnchors].sort(
        (left, right) => left.lineNumber - right.lineNumber
      );
      const first = lineOrdered[0]?.y;
      const second = lineOrdered[1]?.y;
      return first !== undefined && second !== undefined && second < first
        ? -1
        : 1;
    })();

    pageAnchors.forEach((anchor, anchorIndex) => {
      const anchorY = anchor.y ?? 0;
      const previousY = pageAnchors[anchorIndex - 1]?.y;
      const nextY = pageAnchors[anchorIndex + 1]?.y;
      const previousGap =
        previousY === undefined ? undefined : Math.abs(anchorY - previousY);
      const nextGap =
        nextY === undefined ? undefined : Math.abs(nextY - anchorY);
      const lower =
        previousY === undefined
          ? anchorY - (nextGap ?? 80) / 2
          : (previousY + anchorY) / 2;
      const upper =
        nextY === undefined
          ? anchorY + (previousGap ?? 80) / 2
          : (anchorY + nextY) / 2;
      const region = pageLines.filter(
        (line) => line.y >= lower && line.y <= upper
      );
      const orderedRegion = [...region].sort(
        (left, right) => readingDirection * (left.y - right.y)
      );
      const quantity = extractMouserPositionedQuantities(
        orderedRegion,
        headerCenters,
        anchorY
      );
      if (!quantity || quantity.shipped <= 0) return;

      const descriptionStart =
        headerCenters.lineNumber === null
          ? (anchor.skuX ?? 0) - 40
          : headerCenters.lineNumber +
            Math.max(
              5,
              ((anchor.skuX ?? headerCenters.lineNumber + 80) -
                headerCenters.lineNumber) *
                0.2
            );
      const descriptionEnd =
        headerCenters.ordered === null
          ? Infinity
          : headerCenters.shipped === null
          ? headerCenters.ordered + 10
          : headerCenters.ordered -
            Math.max(8, (headerCenters.shipped - headerCenters.ordered) * 0.35);
      const descriptionLines = orderedRegion.flatMap((line) => {
        const text = line.items
          .filter((item) => {
            const x = positionedItemCenter(item);
            return (
              x >= descriptionStart &&
              x < descriptionEnd &&
              parseMouserQuantity(item.text) === null
            );
          })
          .sort((left, right) => left.x - right.x)
          .map(({ text }) => text)
          .join(" ")
          .trim();
        return text ? [text] : [];
      });
      const { mpn, rawDescription } = extractMouserDescription(
        descriptionLines,
        anchor.supplierProductNumber
      );
      if (!rawDescription) return;
      const sourceEvidence = orderedRegion
        .flatMap((line) => (line.text.trim() ? [line.text.trim()] : []))
        .join("\n")
        .slice(0, 2_000);
      lineItems.push({
        sourceRef: `mouser-p${anchor.page}-line${anchor.lineNumber}`,
        sourcePage: anchor.page,
        lineNumber: anchor.lineNumber,
        supplierProductNumber: anchor.supplierProductNumber,
        mpn,
        rawDescription,
        quantity: quantity.shipped,
        orderedQuantity: quantity.ordered,
        shippedQuantity: quantity.shipped,
        pendingQuantity: quantity.pending,
        sourceEvidence,
      });
    });
  }
  return { anchors, lineItems, positionSource: source };
}

function createMouserParseResult({
  detected,
  lineItems,
  detectedLineNumbers,
  detectedSupplierSkus,
  positionSource,
}: {
  detected: boolean;
  lineItems: MouserInvoiceLineItem[];
  detectedLineNumbers: number[];
  detectedSupplierSkus: string[];
  positionSource: "pdfjs" | "ocr" | "text";
}): MouserInvoiceParseResult {
  const identifiableLines = Math.max(
    detectedLineNumbers.length,
    detectedSupplierSkus.length
  );
  return {
    detected,
    lineItems,
    unresolvedLines:
      identifiableLines > 0
        ? Math.max(0, identifiableLines - lineItems.length)
        : detected
        ? 1
        : 0,
    detectedLineNumbers,
    detectedSupplierSkus,
    positionSource,
  };
}

export function parseMouserInvoicePages(
  pages: readonly ExtractedPdfPage[],
  positionedPages: readonly PositionedPdfPage[] = [],
  positionedExtractor: "pdfjs" | "ocr" = "pdfjs"
): MouserInvoiceParseResult {
  const documentText = pages.map((page) => page.text).join("\n");
  const hasMouserHeader =
    /mousers?\s+artikelnummer|mouser(?:\s+electronics)?\s+part\s+(?:number|no\.?)/i.test(
      documentText
    );
  const hasFulfilmentColumns =
    /\b(?:ordered|quantity\s+ordered)\b/i.test(documentText) &&
    /\b(?:shipped|quantity\s+shipped)\b/i.test(documentText) &&
    /\bpending\b/i.test(documentText);
  if (!hasMouserHeader || !hasFulfilmentColumns) {
    return createMouserParseResult({
      detected: false,
      lineItems: [],
      detectedLineNumbers: [],
      detectedSupplierSkus: [],
      positionSource: "text",
    });
  }

  const textParse = parseMouserTextRows(pages);
  const positionedParse = positionedPages.length
    ? parseMouserPositionedRows(positionedPages, positionedExtractor)
    : null;
  const usePositioned = Boolean(
    positionedParse &&
      positionedParse.lineItems.length >= textParse.lineItems.length
  );
  const lineItems = usePositioned
    ? positionedParse?.lineItems ?? []
    : textParse.lineItems;
  const detectedSkus = textParse.detectedSkus.length
    ? textParse.detectedSkus
    : positionedParse?.anchors.map(
        ({ supplierProductNumber }) => supplierProductNumber
      ) ?? [];
  const detectedLineNumbers = usePositioned
    ? positionedParse?.anchors.map(({ lineNumber }) => lineNumber) ?? []
    : textParse.detectedLineNumbers;
  return createMouserParseResult({
    detected: true,
    lineItems,
    detectedLineNumbers,
    detectedSupplierSkus: detectedSkus,
    positionSource: usePositioned ? positionedExtractor : "text",
  });
}

async function extractPdfText(buffer: Buffer) {
  return (await extractPdfPages(buffer)).pages
    .map(({ text }) => text)
    .join("\n")
    .trim();
}

/** Best-effort local text extraction for receipt review. No document data is
 * sent to an external provider; unreadable/scanned files use manual entry. */
export async function extractPdfTextForReceiptReview(buffer: Buffer) {
  try {
    return await extractPdfText(buffer);
  } catch {
    return "";
  }
}

function isPdfHeaderRow(cells: string[]) {
  const normalized = cells.map((cell) => cell.trim().toLocaleLowerCase());
  const text = normalized.join(" ");
  const hasNameHeader =
    normalized.some((cell) =>
      [
        "name",
        "item",
        "item name",
        "title",
        "asset",
        "product",
        "product name",
      ].includes(cell)
    ) || /\b(?:item|name|asset|inventory|product)\b/.test(text);
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
        "quantity delivered",
        "delivered quantity",
        "quantity backordered",
        "backordered quantity",
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
    /\b(?:quantity|qty|count|ordered|shipped|delivered|received|backordered|category|location|description|manufacturer|part number)\b/.test(
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
  const delimiter = ["|", "\t"]
    .map((candidate) => ({
      candidate,
      count: lines.reduce(
        (total, line) => total + (line.split(candidate).length - 1),
        0
      ),
    }))
    .sort((left, right) => right.count - left.count)[0];

  if (!delimiter || delimiter.count < 2) {
    throw importError(
      "The PDF text was readable, but no clearly delimited inventory table was found."
    );
  }

  const matrix = lines.map((line) =>
    line.split(delimiter.candidate).map((cell) => cell.trim())
  );
  const headerIndex = matrix.findIndex((cells) => isPdfHeaderRow(cells));
  if (headerIndex < 0 || matrix.length <= headerIndex + 1) {
    throw importError(
      "The PDF text was readable, but no clearly delimited inventory table with a recognized header was found."
    );
  }
  const sourceMatrix = matrix.slice(headerIndex);
  const firstRow = sourceMatrix[0];
  const header = firstRow.map((cell) => cell.trim().toLocaleLowerCase());
  const filteredMatrix = sourceMatrix.filter(
    (cells, index) => index === 0 || !isPdfNoiseRow(cells, header)
  );
  const parsedRows = parseRows(filteredMatrix, {
    allowMissingTitle: true,
    ignoreUnsupportedColumns: true,
    tolerateInvalidValues: true,
  });
  const rows = parsedRows.map((row) => {
    const uncertainFields = [
      ...(row.uncertainFields ?? []),
      row.quantity === null ? "Quantity" : null,
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

function parsePdfTablePages(pdfPages: readonly ExtractedPdfPage[]) {
  const parsed = parsePdfRowsFromText(
    pdfPages.map(({ text }) => text).join("\n")
  );
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
  return { ...parsed, rows };
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
  const relationships = await zip
    .file("xl/_rels/workbook.xml.rels")
    ?.async("string");
  const sheets: Array<{ name: string; matrix: string[][] }> = [];
  for (const match of workbook?.matchAll(/<sheet\b([^>]+)>/gi) ?? []) {
    const attrs = match[1];
    const name = decodeXml(attrs.match(/\bname="([^"]+)"/)?.[1] ?? "Sheet");
    const relationId = attrs.match(/\br:id="([^"]+)"/)?.[1];
    const relation = [
      ...(relationships?.matchAll(/<Relationship\b([^>]+)>/gi) ?? []),
    ].find((entry) => entry[1].match(/\bId="([^"]+)"/)?.[1] === relationId);
    const target = relation?.[1].match(/\bTarget="([^"]+)"/)?.[1];
    if (!target || target.includes("..")) continue;
    const path = target.startsWith("/")
      ? target.slice(1)
      : `xl/${target.replace(/^\.\//, "")}`;
    const xml = await zip.file(path)?.async("string");
    if (xml) sheets.push({ name, matrix: parseSheetXml(xml, sharedStrings) });
  }
  if (!sheets.length)
    throw importError("workbook_unreadable: No readable worksheets.");
  return sheets;
}

function headerMap(
  headers: string[],
  options: { ignoreUnsupportedColumns?: boolean } = {}
) {
  const map = new Map<number, StaffImportInputField>();
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
    ![...map.values()].includes("sourceDescription") &&
    ![...map.values()].includes("manufacturerPartNumber") &&
    ![...map.values()].includes("supplierPartNumber")
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

function parseImportQuantity(value: string | undefined) {
  const text = value?.trim();
  if (!text) return { value: null, invalid: false };
  // Accept only an unadorned whole number. Prices, formatted currency,
  // fractions, and unsafe integers must be reviewed instead of coerced.
  if (!/^(?:\d{1,7}|\d{1,3}(?:,\d{3})+)$/.test(text)) {
    return { value: null, invalid: true };
  }
  const quantity = Number(text.replace(/,/g, ""));
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1_000_000) {
    return { value: null, invalid: true };
  }
  return { value: quantity, invalid: false };
}

function parseRows(matrix: string[][], options: ParseRowsOptions = {}) {
  if (matrix.length < 2) throw importError("The file has no data rows.");
  if (matrix.length - 1 > STAFF_IMPORT_MAX_ROWS) {
    throw importError(
      `The file contains more than ${STAFF_IMPORT_MAX_ROWS} data rows.`
    );
  }
  const mapping = headerMap(matrix[0], options);
  return matrix.slice(1).map((cells, rowIndex) => {
    const values: Partial<Record<StaffImportInputField, string>> = {};
    mapping.forEach((field, index) => {
      values[field] = safeCell(cells[index], field);
    });
    const uncertainFields: string[] = [];
    const sourceDescription = values.sourceDescription?.trim() || null;
    const title =
      values.title?.trim() ||
      sourceDescription ||
      [
        values.manufacturer,
        values.manufacturerPartNumber || values.supplierPartNumber,
      ]
        .filter(Boolean)
        .join(" ")
        .trim();
    if (!title) {
      if (!options.allowMissingTitle) {
        throw importError(`Row ${rowIndex + 2} has no item name.`);
      }
      uncertainFields.push("Item name");
    }
    const parsedQuantity = parseImportQuantity(values.quantity);
    let quantity = parsedQuantity.value;
    if (parsedQuantity.invalid) {
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
      const parsed = parseImportQuantity(value);
      if (parsed.invalid || parsed.value === null) {
        if (!options.tolerateInvalidValues) {
          throw importError(`Row ${rowIndex + 2} has an invalid ${field}.`);
        }
        uncertainFields.push(field);
        return null;
      }
      return parsed.value;
    };
    const orderedQuantity = parseOptionalQuantity(
      values.orderedQuantity,
      "ordered quantity"
    );
    const receivedQuantityInput = parseOptionalQuantity(
      values.receivedQuantity,
      "received quantity"
    );
    const deliveredQuantity = parseOptionalQuantity(
      values.deliveredQuantityInput,
      "delivered quantity"
    );
    const shippedQuantity = parseOptionalQuantity(
      values.shippedQuantityInput,
      "shipped quantity"
    );
    const backorderedQuantity = parseOptionalQuantity(
      values.backorderedQuantityInput,
      "backordered quantity"
    );
    const invalidQuantityConcept = uncertainFields.some((field) =>
      [
        "received quantity",
        "delivered quantity",
        "shipped quantity",
        "ordered quantity",
        "backordered quantity",
      ].includes(field)
    );
    const invalidOrderedQuantity = uncertainFields.includes("ordered quantity");
    const actualQuantityInput = [
      {
        raw: values.receivedQuantity,
        value: receivedQuantityInput,
        status: "RECEIVED" as const,
      },
      {
        raw: values.deliveredQuantityInput,
        value: deliveredQuantity,
        status: "RECEIVED" as const,
      },
      {
        raw: values.shippedQuantityInput,
        value: shippedQuantity,
        status: "SHIPPED" as const,
      },
    ].find(({ raw }) => Boolean(raw?.trim()));
    const actualQuantity = actualQuantityInput?.value ?? null;
    const hasActualQuantityEvidence = Boolean(actualQuantityInput);
    const orderedOnly = orderedQuantity !== null && !hasActualQuantityEvidence;
    if (actualQuantity !== null) quantity = actualQuantity;
    else if (
      orderedOnly ||
      backorderedQuantity !== null ||
      invalidQuantityConcept
    ) {
      quantity = null;
    }
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
      ...(actualQuantity !== null ? { receivedQuantity: actualQuantity } : {}),
      ...(actualQuantity !== null
        ? {
            quantityStatus:
              actualQuantityInput?.status ?? ("RECEIVED" as const),
          }
        : orderedOnly
        ? { quantityStatus: "ORDERED" as const }
        : quantity !== null
        ? { quantityStatus: "RECEIVED" as const }
        : invalidQuantityConcept || invalidOrderedQuantity
        ? { quantityStatus: "UNKNOWN" as const }
        : {}),
      ...(parsedQuantity.invalid ||
      uncertainFields.some((field) =>
        [
          "ordered quantity",
          "received quantity",
          "delivered quantity",
          "shipped quantity",
          "backordered quantity",
        ].includes(field)
      )
        ? { diagnosticReasonCodes: ["QUANTITY_INVALID"] as const }
        : quantity !== null
        ? { diagnosticReasonCodes: ["QUANTITY_EXTRACTED"] as const }
        : { diagnosticReasonCodes: ["QUANTITY_AMBIGUOUS"] as const }),
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
  positionedPdfPages?: PositionedPdfPage[];
  pdfDiagnostics?: PdfTextDiagnostics;
  mouserInvoice?: MouserInvoiceParseResult;
  pdfParseError?: string;
};

async function parseStaffImportFileWithSummary({
  filename,
  contentType,
  buffer,
  spreadsheetSheet,
  spreadsheetHeaderRow,
}: {
  spreadsheetSheet?: string;
  spreadsheetHeaderRow?: number;
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
    const {
      pages: pdfPages,
      diagnostics,
      positionedPages = [],
      positionedExtractor = "pdfjs",
    } = await extractPdfPages(buffer);
    let mouserInvoice = parseMouserInvoicePages(
      pdfPages,
      positionedPages,
      positionedExtractor
    );

    // The primary safe extractor preserves readable text but has no glyph
    // coordinates. For detected Mouser invoices only, supplement it with
    // PDF.js positioned items so row and quantity columns can be reconstructed.
    if (
      mouserInvoice.detected &&
      !positionedPages.some((page) => page.items.length > 0)
    ) {
      try {
        const positionedExtraction = await extractPdfPagesWithPdfJs(buffer);
        if (
          positionedExtraction.positionedPages.some(
            (page) => page.items.length > 0
          )
        ) {
          const positionedParse = parseMouserInvoicePages(
            positionedExtraction.pages,
            positionedExtraction.positionedPages,
            "pdfjs"
          );
          if (
            positionedParse.detected &&
            positionedParse.lineItems.length >= mouserInvoice.lineItems.length
          ) {
            mouserInvoice = positionedParse;
          }
        }
      } catch {
        // Keep the line-number-anchored text parser as a deterministic fallback.
      }
    }
    Logger.info({
      event: "ioio_staff_import_pdf_text_extracted",
      ...diagnostics,
      detectedVendorParser: mouserInvoice.detected ? "mouser" : null,
    });
    if (mouserInvoice.detected) {
      for (const lineItem of mouserInvoice.lineItems) {
        Logger.info({
          event: "ioio_staff_import_mouser_line_reconstructed",
          lineNumber: lineItem.lineNumber,
          supplierSku: lineItem.supplierProductNumber,
          mpnPresent: Boolean(lineItem.mpn),
          descriptionCharCount: lineItem.rawDescription.length,
          ordered: lineItem.orderedQuantity,
          shipped: lineItem.shippedQuantity,
          pending: lineItem.pendingQuantity,
        });
      }
      Logger.info({
        event: "ioio_staff_import_mouser_parse_summary",
        detectedLineNumbers: mouserInvoice.detectedLineNumbers,
        detectedSupplierSkus: mouserInvoice.detectedSupplierSkus,
        reconstructedRowCount: mouserInvoice.lineItems.length,
        unresolvedLines: mouserInvoice.unresolvedLines,
        positionSource: mouserInvoice.positionSource,
      });
      if (mouserInvoice.unresolvedLines > 0) {
        Logger.warn({
          event: "ioio_staff_import_mouser_reconstruction_incomplete",
          detectedLineNumbers: mouserInvoice.detectedLineNumbers,
          detectedSupplierSkus: mouserInvoice.detectedSupplierSkus,
          reconstructedRowCount: mouserInvoice.lineItems.length,
          unresolvedLines: mouserInvoice.unresolvedLines,
        });
      }
    }
    // Keep PDFs as page-level evidence until the semantic helper has had the
    // first chance to group generic documents. Detected Mouser invoices use
    // the deterministic commercial-line parser before any helper request.
    return {
      rows: [],
      pdfPages,
      positionedPdfPages: positionedPages,
      pdfDiagnostics: diagnostics,
      ...(mouserInvoice.detected ? { mouserInvoice } : {}),
    };
  }
  let sheets: Array<{ name: string; matrix: string[][] }>;
  try {
    sheets =
      extension === "csv"
        ? [{ name: "CSV", matrix: readSpreadsheetCsv(buffer) }]
        : await parseXlsx(buffer);
  } catch (cause) {
    throw importError(
      `${extension === "csv" ? "csv_parse_failed" : "workbook_unreadable"}: ${
        cause instanceof Error ? cause.message : "Cannot read file"
      }`
    );
  }
  const rows: StaffImportRow[] = [];
  const diagnostics = {
    fileType: extension,
    sheetCount: sheets.length,
    tables: 0,
    rowsParsed: 0,
    rowsAccepted: 0,
    rowsRejected: 0,
  };
  if (
    spreadsheetSheet &&
    !sheets.some((sheet) => sheet.name === spreadsheetSheet)
  )
    throw importError(
      "no_inventory_table_found: Selected sheet does not exist."
    );
  if (
    spreadsheetHeaderRow != null &&
    (!Number.isInteger(spreadsheetHeaderRow) ||
      spreadsheetHeaderRow < 1 ||
      spreadsheetHeaderRow > 1000)
  )
    throw importError(
      "header_not_found: Header row must be between 1 and 1000."
    );
  for (const sheet of sheets) {
    if (spreadsheetSheet && sheet.name !== spreadsheetSheet) continue;
    if (
      !spreadsheetSheet &&
      /^(notes?|instructions?|read\s*me|information)$/i.test(sheet.name.trim())
    )
      continue;
    if (
      sheet.matrix
        .slice(0, 40)
        .some(
          (cells) =>
            cells.some((cell) =>
              ["title", "sourceDescription"].includes(
                HEADER_ALIASES[normalizeSpreadsheetHeader(cell)]
              )
            ) && cells.some((cell) => PRIVATE_HEADER.test(cell))
        )
    )
      throw importError(
        "Personal borrower or account columns are not accepted."
      );
    const header = spreadsheetHeaderRow
      ? { index: spreadsheetHeaderRow - 1, ambiguous: false }
      : detectSpreadsheetHeader(sheet.matrix, HEADER_ALIASES);
    if (!header) continue;
    diagnostics.tables++;
    const headers = sheet.matrix[header.index];
    if (!headers)
      throw importError("header_not_found: Selected row does not exist.");
    try {
      headerMap(headers, { ignoreUnsupportedColumns: true });
    } catch {
      rows.push({
        rowNumber: rows.length + 2,
        title: `Sheet ${sheet.name} needs column review`,
        quantity: null,
        category: null,
        location: null,
        type: null,
        reviewRequired: true,
        uncertainFields: ["Spreadsheet row"],
        sourceNotes: `unsupported_column_layout: sheet ${
          sheet.name
        }, header row ${
          header.index + 1
        }. Export a table with one column per concept.`,
      });
      diagnostics.rowsRejected++;
      continue;
    }
    Logger.info({
      event: "ioio_spreadsheet_table_detected",
      selectedSheet: sheet.name.slice(0, 100),
      detectedHeaderRow: header.index + 1,
      headerAmbiguous: header.ambiguous,
    });
    const identityColumn = headers.findIndex((cell) =>
      [
        "title",
        "sourceDescription",
        "manufacturerPartNumber",
        "supplierPartNumber",
      ].includes(HEADER_ALIASES[normalizeSpreadsheetHeader(cell)])
    );
    for (let index = header.index + 1; index < sheet.matrix.length; index++) {
      const cells = sheet.matrix[index];
      if (isSpreadsheetNonProduct(cells, cells[identityColumn] ?? "")) continue;
      if (++diagnostics.rowsParsed > STAFF_IMPORT_MAX_ROWS)
        throw importError(
          `The file contains more than ${STAFF_IMPORT_MAX_ROWS} data rows.`
        );
      let row: StaffImportRow;
      try {
        if (header.ambiguous)
          throw new Error("ambiguous header mapping; select/export one table");
        if (
          cells.some(
            (value, column) =>
              value === MISSING_FORMULA_VALUE &&
              Boolean(
                HEADER_ALIASES[
                  normalizeSpreadsheetHeader(headers[column] ?? "")
                ]
              )
          )
        )
          throw new Error("Formula has no stored value; export as values");
        const normalizedCells = cells.map((value, column) =>
          /quantity/i.test(
            HEADER_ALIASES[normalizeSpreadsheetHeader(headers[column] ?? "")] ??
              ""
          )
            ? value.replace(/^(\d+),0+$/, "$1")
            : value
        );
        const effectiveHeaders = headers.map((name, column) =>
          normalizeSpreadsheetHeader(name) === "type" &&
          !["INDIVIDUAL", "QUANTITY_TRACKED"].includes(
            (cells[column] ?? "").trim().toUpperCase()
          )
            ? headers.some(
                (cell) =>
                  HEADER_ALIASES[normalizeSpreadsheetHeader(cell)] ===
                  "category"
              )
              ? "source class"
              : "category"
            : name
        );
        row = parseRows([effectiveHeaders, normalizedCells], {
          ignoreUnsupportedColumns: true,
        })[0];
        if (row.receivedQuantity != null) {
          row.quantity = row.receivedQuantity;
          row.quantityStatus = "RECEIVED";
        }
        if (row.orderedQuantity != null && row.receivedQuantity == null) {
          row.quantity = null;
          row.quantityStatus = "ORDERED";
        }
        diagnostics.rowsAccepted++;
      } catch (cause) {
        diagnostics.rowsRejected++;
        row = {
          rowNumber: 0,
          title: (cells[identityColumn] || "Unresolved spreadsheet row").slice(
            0,
            200
          ),
          quantity: null,
          category: null,
          location: null,
          type: null,
          reviewRequired: true,
          uncertainFields: ["Spreadsheet row"],
          sourceNotes: `row_validation_failed: ${
            cause instanceof Error ? cause.message : "Unsupported row"
          }`,
        };
      }
      row.rowNumber = rows.length + 2;
      row.sourceSheet = sheet.name;
      row.sourceRow = index + 1;
      row.sourceNotes = [
        row.sourceNotes,
        `Source sheet: ${sheet.name}; source row: ${index + 1}; header row: ${
          header.index + 1
        }`,
      ]
        .filter(Boolean)
        .join("; ");
      rows.push(row);
    }
  }
  const identities = new Map<string, StaffImportRow[]>();
  for (const row of rows) {
    const key = row.manufacturerPartNumber
      ? `mpn:${row.manufacturer ?? ""}:${row.manufacturerPartNumber}`
      : row.supplierPartNumber
      ? `sku:${row.supplierPartNumber}`
      : null;
    if (!key) continue;
    const identity = key.toLowerCase().replace(/\s+/g, " ").trim();
    identities.set(identity, [...(identities.get(identity) ?? []), row]);
  }
  for (const group of identities.values())
    if (group.length > 1)
      for (const row of group) {
        row.reviewRequired = true;
        row.uncertainFields = [
          ...(row.uncertainFields ?? []),
          "Duplicate spreadsheet identity",
        ];
      }
  Logger.info({ event: "ioio_spreadsheet_parsed", ...diagnostics });
  if (!diagnostics.tables)
    throw importError(
      "no_inventory_table_found: header_not_found. Export an inventory sheet with product and quantity headers."
    );
  if (!rows.length)
    throw importError("zero_valid_rows: No product rows found.");
  return {
    rows,
    provider: "spreadsheet-normalized:v1",
  } satisfies StaffImportParseResult;
}

export async function parseStaffImportFile(args: {
  spreadsheetSheet?: string;
  spreadsheetHeaderRow?: number;
  filename: string;
  contentType?: string | null;
  buffer: Buffer;
}) {
  const parsed = await parseStaffImportFileWithSummary(args);
  if (parsed.mouserInvoice) {
    return mapMouserInvoiceRows({
      lineItems: parsed.mouserInvoice.lineItems,
      enrichedRows: null,
      categories: [],
      locations: [],
    });
  }
  if (parsed.pdfPages && parsed.rows.length === 0) {
    try {
      return parsePdfTablePages(parsed.pdfPages).rows;
    } catch {
      throw importError(PDF_AI_ANALYSIS_REQUIRED_MESSAGE);
    }
  }
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
  const inferredCategory = inferProcurementCategory(row);
  const categorySuggestion =
    row.mouserLineItem ||
    (row.helperCandidate && !row.category) ||
    inferredCategory.confidence === "Low"
      ? undefined
      : inferredCategory;
  const categoryName = row.category ?? categorySuggestion?.category ?? null;
  const categoryResolution = categoryName
    ? resolveImportCategory(categoryName, categories)
    : { status: "MISSING" as const };
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
    ...(categorySuggestion
      ? {
          suggestedCategory: categorySuggestion.category,
          categoryConfidence: categorySuggestion.confidence,
          categoryReason: categorySuggestion.reason,
        }
      : {}),
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
  if (row.uncertainFields?.includes("Spreadsheet row"))
    return {
      ...base,
      action: "REJECT",
      reason: row.sourceNotes ?? "row_validation_failed",
    };
  if (row.uncertainFields?.includes("Duplicate spreadsheet identity"))
    return {
      ...base,
      action: "POSSIBLE_DUPLICATE",
      reason:
        "This product identity occurs more than once in the file. Review variants and quantities before approving.",
    };
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
          : categorySuggestion
          ? `Proposed new category: ${categorySuggestion.category}. Staff approval and category:create permission are required.`
          : "Choose an active Shelf category during review."
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
      (isProcurementRow && quantityStatus === "ORDERED")
    ) {
      return {
        ...base,
        action: isProcurementRow ? "NEEDS_REVIEW" : "REJECT",
        reason: isProcurementRow
          ? quantityStatus === "ORDERED"
            ? "Ordered quantity is known, but received quantity is unknown."
            : "A positive received quantity is required."
          : "Quantity-tracked new items need a positive quantity.",
      };
    }
    return {
      ...base,
      action:
        category || row.mouserLineItem
          ? "CREATE"
          : isProcurementRow
          ? "NEEDS_REVIEW"
          : "CREATE",
      proposedQuantity: receivedQuantity,
      reason:
        category || row.mouserLineItem
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

function resolvePdfRowLocations({
  rows,
  categories,
  locations,
}: {
  rows: StaffImportRow[];
  categories: NamedRecord[];
  locations: ImportLocationOption[];
}) {
  return rows.map((row) => {
    if (!row.title.trim()) return row;
    const evidence = {
      productName: row.title,
      manufacturer: row.manufacturer,
      mpn: row.manufacturerPartNumber,
      rawDescription: row.sourceDescription,
      description: row.sourceDescription,
      supplierDescription: row.supplierPartNumber,
      categoryText: row.category,
    };
    const category =
      categories.find(({ id }) => id === row.suggestedCategoryId) ??
      resolveImportCategorySuggestion({
        claudeCategoryId: null,
        claudeConfidence: 0,
        evidence,
        categories,
      }).category;
    const canonicalLocations = locations.map((location) => ({
      ...location,
      pathLabel: location.pathLabel || location.name,
    }));
    const explicitLocation = resolveImportLocation(
      row.location,
      canonicalLocations
    );
    const existingSuggestion = row.suggestedLocationId
      ? locations.find(
          (location) =>
            location.id === row.suggestedLocationId && !location.operational
        )
      : null;
    const trustedExplicitLocation =
      explicitLocation.status === "MATCH" ? explicitLocation.location : null;
    const locationSelection =
      existingSuggestion || trustedExplicitLocation
        ? {
            location: existingSuggestion ?? trustedExplicitLocation,
            method: existingSuggestion
              ? row.locationSuggestionMethod
              : "claude",
            status: row.locationSuggestionStatus ?? "SUGGESTED",
            reasonCodes: (row.diagnosticReasonCodes ?? []).filter((code) =>
              code.startsWith("LOCATION_")
            ) as ImportLocationDiagnosticReason[],
          }
        : resolveImportLocationSuggestion({
            claudeLocationId: null,
            claudeConfidence: 0,
            evidence,
            category,
            locations,
          });
    const selectedLocation = locationSelection.location;
    return {
      ...row,
      location: selectedLocation?.pathLabel ?? row.location,
      suggestedLocationId: selectedLocation?.id ?? null,
      locationSuggestionConfidence: selectedLocation
        ? locationSelection.method === "claude"
          ? row.locationSuggestionConfidence ?? 1
          : locationSelection.status === "SUGGESTED"
          ? 0.9
          : 0.4
        : 0,
      locationSuggestionMethod: locationSelection.method,
      locationSuggestionStatus: locationSelection.status,
      diagnosticReasonCodes: [
        ...(row.diagnosticReasonCodes ?? []).filter(
          (code) => !code.startsWith("LOCATION_")
        ),
        ...locationSelection.reasonCodes,
      ],
    };
  });
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
    activeCategories: categories
      .slice(0, 500)
      .map(({ id, name, description }) => ({
        id,
        name,
        description: description?.slice(0, 500) ?? null,
      })),
    relevantLocations: getImportLocationCandidatesForEvidence({
      evidence: pdfPages
        .flatMap(({ text }) => text.split(/\r?\n/))
        .map((line) => line.trim())
        .filter((line) => line.length >= 4)
        .slice(0, 100)
        .map((line) => {
          const evidence = { productName: line, rawDescription: line };
          return {
            evidence,
            category: resolveImportCategorySuggestion({
              evidence,
              categories,
            }).category,
          };
        }),
      locations,
      limit: 20,
    }).map((location) => {
      const { id, name, pathLabel, parentId, currentUnits } = location;
      return {
        id,
        name,
        pathLabel,
        parentId,
        description: getLocationHelperDescription(location),
        hasChildren: locations.some((location) => location.parentId === id),
        occupancy: {
          currentUnits: currentUnits || occupancyByLocation.get(id) || 0,
          proposedUnits: 0,
          capacity: null,
          context: getLocationHelperDescription(location),
        },
      };
    }),
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

function matchPdfTableRow(
  candidate: ImportHelperCandidateRow,
  tableRows: StaffImportRow[]
) {
  const identifiers = [candidate.supplierProductNumber, candidate.mpn]
    .filter(Boolean)
    .map((value) => normalizedProductText(value));
  const identifierMatches = tableRows.filter((row) =>
    [row.supplierPartNumber, row.manufacturerPartNumber]
      .filter(Boolean)
      .some((value) => identifiers.includes(normalizedProductText(value)))
  );
  if (identifierMatches.length === 1) return identifierMatches[0];
  if (identifierMatches.length > 1) return undefined;

  const candidateName = normalizedProductText(candidate.productName);
  const nameMatches = tableRows.filter((row) =>
    [row.title, row.sourceDescription]
      .filter(Boolean)
      .some((value) => normalizedProductText(value) === candidateName)
  );
  return nameMatches.length === 1 ? nameMatches[0] : undefined;
}

function mapHelperProposalToRows({
  candidates,
  pdfPages,
  categories,
  locations,
  allowedLocationIds,
  sourceTableRows,
}: {
  candidates: ImportHelperCandidateRow[];
  pdfPages: NonNullable<StaffImportParseResult["pdfPages"]>;
  categories: NamedRecord[];
  locations: ImportLocationOption[];
  allowedLocationIds?: Set<string>;
  sourceTableRows?: StaffImportRow[];
}): { rows: StaffImportRow[]; pdfSummary: StaffImportPdfSummary } {
  const pagesByRef = new Map(pdfPages.map((page) => [page.sourceRef, page]));
  const rows = candidates.map((candidate, index): StaffImportRow => {
    const tableRow = sourceTableRows
      ? matchPdfTableRow(candidate, sourceTableRows)
      : undefined;
    const quantity = sourceTableRows
      ? tableRow?.quantity ?? null
      : candidate.quantityStatus === "RECEIVED" ||
        candidate.quantityStatus === "SHIPPED"
      ? candidate.quantity
      : null;
    const quantityStatus = sourceTableRows
      ? tableRow?.quantityStatus ?? "UNKNOWN"
      : candidate.quantityStatus;
    const quantityReasonCode = sourceTableRows
      ? tableRow?.diagnosticReasonCodes?.find((code) =>
          code.startsWith("QUANTITY_")
        ) ?? "QUANTITY_AMBIGUOUS"
      : candidate.quantity !== null &&
        (candidate.quantityStatus === "RECEIVED" ||
          candidate.quantityStatus === "SHIPPED")
      ? "QUANTITY_EXTRACTED"
      : "QUANTITY_AMBIGUOUS";
    const evidence = {
      manufacturer: candidate.manufacturer,
      productName: candidate.productName,
      rawDescription: candidate.evidence.map(({ text }) => text).join(" "),
      description: candidate.description,
      supplierDescription: candidate.description,
      mpn: candidate.mpn,
    };
    const categorySelection = resolveImportCategorySuggestion({
      claudeCategoryId: candidate.categorySuggestion.categoryId,
      claudeConfidence: candidate.categorySuggestion.confidence,
      evidence,
      categories,
    });
    const category = categorySelection.category;
    const firstLocationSuggestion = candidate.locationSuggestions[0];
    const locationSelection = resolveImportLocationSuggestion({
      claudeLocationId:
        firstLocationSuggestion &&
        (!allowedLocationIds ||
          allowedLocationIds.has(firstLocationSuggestion.locationId))
          ? firstLocationSuggestion.locationId
          : null,
      claudeConfidence: firstLocationSuggestion?.confidence,
      evidence,
      category,
      locations,
    });
    const selectedLocation = locationSelection.location;
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
      quantity,
      category: category?.name ?? null,
      location: selectedLocation?.pathLabel ?? null,
      suggestedCategoryId: category?.id ?? null,
      categorySuggestionConfidence:
        categorySelection.method === "claude"
          ? candidate.categorySuggestion.confidence
          : category
          ? 0.9
          : 0,
      suggestedLocationId: selectedLocation?.id ?? null,
      locationSuggestionConfidence:
        locationSelection.method === "claude"
          ? firstLocationSuggestion?.confidence ?? 0
          : selectedLocation
          ? locationSelection.status === "SUGGESTED"
            ? 0.9
            : 0.4
          : 0,
      categorySuggestionMethod: categorySelection.method,
      locationSuggestionMethod: locationSelection.method,
      locationSuggestionStatus: locationSelection.status,
      diagnosticReasonCodes: [
        quantityReasonCode,
        ...locationSelection.reasonCodes,
      ],
      type: candidate.trackingSuggestion.mode,
      supplierPartNumber: candidate.supplierProductNumber,
      sourceDescription: candidate.description,
      manufacturer: candidate.manufacturer,
      manufacturerPartNumber: candidate.mpn,
      assetModelDescription: candidate.assetModelDescription ?? null,
      enrichmentConfidence:
        candidate.productMatch.matchType === "UNCERTAIN"
          ? 0
          : candidate.productMatch.confidence,
      receivedQuantity:
        quantityStatus === "RECEIVED" || quantityStatus === "SHIPPED"
          ? quantity
          : null,
      quantityStatus,
      ...((tableRow?.orderedQuantity ??
        (quantityStatus === "ORDERED" ? candidate.quantity : null)) !== null
        ? {
            orderedQuantity:
              tableRow?.orderedQuantity ??
              (quantityStatus === "ORDERED" ? candidate.quantity : null),
          }
        : {}),
      reviewRequired: true,
      pdfClassification: "PARTIAL",
      // Every helper candidate must receive an explicit staff review, even if
      // the helper reports high confidence. This marker is removed only when
      // an authenticated staff decision is reapplied for Apply.
      uncertainFields: [
        "Helper proposal",
        ...(quantity === null ||
        quantityStatus === "ORDERED" ||
        quantityStatus === "UNKNOWN"
          ? ["Quantity"]
          : []),
        ...(candidate.trackingSuggestion.mode ? [] : ["Tracking mode"]),
      ],
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

function mapMouserInvoiceRows({
  lineItems,
  enrichedRows,
  categories,
  locations,
  allowedLocationIds,
}: {
  lineItems: MouserInvoiceLineItem[];
  enrichedRows: MouserEnrichmentResponse["rows"] | null;
  categories: NamedRecord[];
  locations: ImportLocationOption[];
  allowedLocationIds?: Set<string>;
}): StaffImportRow[] {
  const enrichedBySourceRef = new Map(
    (enrichedRows ?? []).map((row) => [row.sourceRef, row])
  );
  return lineItems.map((lineItem, index) => {
    const enriched = enrichedBySourceRef.get(lineItem.sourceRef);
    const sourceManufacturer = getMouserSourceManufacturer(
      lineItem.rawDescription
    );
    const enrichedManufacturer =
      enriched &&
      enriched.confidence >= 0.7 &&
      enriched.manufacturer &&
      lineItem.rawDescription
        .toLocaleLowerCase()
        .includes(enriched.manufacturer.toLocaleLowerCase())
        ? enriched.manufacturer
        : null;
    const manufacturer = enrichedManufacturer ?? sourceManufacturer;
    const title = resolveMouserProductName(
      enriched && enriched.confidence >= 0.5 ? enriched.productName : null,
      lineItem,
      manufacturer
    );
    const evidence = {
      manufacturer,
      productName: enriched?.productName ?? title,
      rawDescription: lineItem.rawDescription,
      description: enriched?.description,
      supplierDescription: lineItem.rawDescription,
      mpn: lineItem.mpn,
    };
    const categorySelection = resolveImportCategorySuggestion({
      claudeCategoryId: enriched?.categoryId,
      claudeConfidence: enriched?.categoryConfidence ?? enriched?.confidence,
      evidence,
      categories,
    });
    const category = categorySelection.category;
    const locationSelection = resolveImportLocationSuggestion({
      claudeLocationId:
        enriched?.locationId &&
        (!allowedLocationIds || allowedLocationIds.has(enriched.locationId))
          ? enriched.locationId
          : null,
      claudeConfidence: enriched?.locationConfidence,
      evidence,
      category,
      locations,
    });
    const selectedLocation = locationSelection.location;
    return {
      rowNumber: index + 2,
      title,
      quantity: lineItem.shippedQuantity,
      category: category?.name ?? null,
      location: selectedLocation?.pathLabel ?? null,
      suggestedCategoryId: category?.id ?? null,
      categorySuggestionConfidence:
        categorySelection.method === "claude"
          ? enriched?.categoryConfidence ?? enriched?.confidence ?? 0
          : category
          ? 0.9
          : 0,
      suggestedLocationId: selectedLocation?.id ?? null,
      locationSuggestionConfidence:
        locationSelection.method === "claude"
          ? enriched?.locationConfidence ?? 0
          : selectedLocation
          ? locationSelection.status === "SUGGESTED"
            ? 0.9
            : 0.4
          : 0,
      categorySuggestionMethod: categorySelection.method,
      locationSuggestionMethod: locationSelection.method,
      locationSuggestionStatus: locationSelection.status,
      diagnosticReasonCodes: [
        "QUANTITY_EXTRACTED",
        ...locationSelection.reasonCodes,
      ],
      // Shelf resolves the default tracking type at Apply (quantity tracked
      // above one unit; individual for one unit). Staff can override in Edit.
      type: null,
      sourceDescription: lineItem.rawDescription,
      manufacturer,
      manufacturerPartNumber: lineItem.mpn,
      assetModelDescription: enriched?.assetModelDescription ?? null,
      supplierPartNumber: lineItem.supplierProductNumber,
      orderedQuantity: lineItem.orderedQuantity,
      receivedQuantity: lineItem.shippedQuantity,
      quantityStatus: "SHIPPED",
      ...(enriched ? { enrichmentConfidence: enriched.confidence } : {}),
      mouserLineItem: true,
      sourceEvidence: [
        {
          sourceRef: lineItem.sourceRef,
          page: lineItem.sourcePage,
          text: lineItem.sourceEvidence,
        },
      ],
    };
  });
}

async function enrichMouserLineItems({
  fileSha256,
  lineItems,
  categories,
  locations,
}: {
  fileSha256: string;
  lineItems: MouserInvoiceLineItem[];
  categories: NamedRecord[];
  locations: ImportLocationOption[];
}): Promise<{
  rows: MouserEnrichmentResponse["rows"];
  allowedLocationIds: Set<string>;
} | null> {
  const enrichedRows: MouserEnrichmentResponse["rows"] = [];
  const activeCategories = categories
    .slice(0, 500)
    .map(({ id, name, description }) => ({
      id,
      name,
      description: description?.slice(0, 500) ?? null,
    }));
  const relevantLocations = getImportLocationCandidatesForEvidence({
    evidence: lineItems.map((lineItem) => {
      const evidence = {
        productName: lineItem.rawDescription,
        rawDescription: lineItem.rawDescription,
        mpn: lineItem.mpn,
      };
      return {
        evidence,
        category: resolveImportCategorySuggestion({
          evidence,
          categories,
        }).category,
      };
    }),
    locations,
    limit: 20,
  }).map((location) => ({
    id: location.id,
    name: location.name,
    pathLabel: location.pathLabel,
    parentId: location.parentId,
    description: getLocationHelperDescription(location),
    hasChildren: locations.some(
      (candidate) => candidate.parentId === location.id
    ),
  }));
  for (
    let start = 0;
    start < lineItems.length;
    start += MOUSER_ENRICHMENT_BATCH_SIZE
  ) {
    const lineItemBatch = lineItems
      .slice(start, start + MOUSER_ENRICHMENT_BATCH_SIZE)
      .map((lineItem) => ({
        sourceRef: lineItem.sourceRef,
        sourcePage: lineItem.sourcePage,
        supplierProductNumber: lineItem.supplierProductNumber,
        mpn: lineItem.mpn,
        rawDescription: lineItem.rawDescription,
        quantity: lineItem.shippedQuantity,
      }));
    const helperRequest = createMouserEnrichmentRequest({
      fileSha256,
      lineItems: lineItemBatch,
      activeCategories,
      relevantLocations,
    });
    const helperResult = await requestImportHelperProposal(helperRequest);
    if (helperResult.status !== "ready") {
      return null;
    }
    if (
      !("mode" in helperResult.proposal) ||
      helperResult.proposal.mode !== "MOUSER_LINE_ITEM_ENRICHMENT"
    ) {
      return null;
    }
    enrichedRows.push(...helperResult.proposal.rows);
  }
  return {
    rows: enrichedRows,
    allowedLocationIds: new Set(relevantLocations.map(({ id }) => id)),
  };
}

export async function prepareStaffInventoryImport({
  context,
  request,
  file,
  spreadsheetSheet,
  spreadsheetHeaderRow,
}: Pick<Parameters<typeof requireIoioStaffAccess>[0], "context" | "request"> & {
  file: File;
  spreadsheetSheet?: string;
  spreadsheetHeaderRow?: number;
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
    spreadsheetSheet,
    spreadsheetHeaderRow,
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
        assetModel: { select: { name: true, defaultCategoryId: true } },
        assetLocations: {
          select: { locationId: true, quantity: true, assetKitId: true },
        },
      },
    }),
    getActiveCategoriesForOrganization({ organizationId }),
    getAllImportLocations(organizationId),
    db.category.findMany({
      where: { organizationId, id: { in: archivedCategoryIds } },
      select: { id: true, name: true, color: true },
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
  const locationsWithoutAffinity: ImportLocationOption[] = rawLocations.map(
    (location) => ({
      ...location,
      pathLabel: getImportLocationPath(location.id, rawLocations),
      operational: operationalLocationIds.has(location.id),
      currentUnits: occupancyByLocation.get(location.id) ?? 0,
      categoryAffinities: [],
    })
  );
  const categoryAffinitiesByLocation = buildImportLocationAffinities({
    assets: assets.map((asset) => ({
      ...asset,
      modelDefaultCategoryId: asset.assetModel?.defaultCategoryId,
    })),
    categories,
    locations: locationsWithoutAffinity,
  });
  const representativeProductsByLocation =
    buildImportLocationRepresentativeProducts({
      assets: assets.map((asset) => ({
        ...asset,
        modelName: asset.assetModel?.name,
      })),
      locations: locationsWithoutAffinity,
    });
  const locations = locationsWithoutAffinity.map((location) => ({
    ...location,
    categoryAffinities: categoryAffinitiesByLocation.get(location.id) ?? [],
    representativeProducts:
      representativeProductsByLocation.get(location.id) ?? [],
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
  if (parsed.mouserInvoice) {
    const enrichment = parsed.mouserInvoice.lineItems.length
      ? await enrichMouserLineItems({
          fileSha256,
          lineItems: parsed.mouserInvoice.lineItems,
          categories,
          locations,
        })
      : null;
    Logger.info({
      event: "ioio_staff_import_pdf_analysis_selected",
      ...parsed.pdfDiagnostics,
      detectedVendorParser: "mouser",
      genericClaudeFallbackInvoked: false,
      mouserEnrichmentInvoked: parsed.mouserInvoice.lineItems.length > 0,
      enrichmentAvailable: enrichment !== null,
    });
    rows = mapMouserInvoiceRows({
      lineItems: parsed.mouserInvoice.lineItems,
      enrichedRows: enrichment?.rows ?? null,
      allowedLocationIds: enrichment?.allowedLocationIds,
      categories,
      locations,
    });
    Logger.info({
      event: "ioio_staff_import_mouser_suggestion_resolution",
      ...getImportCandidateDiagnostics(categories, locations),
      rows: rows.map((row, index) => {
        const claudeRow = enrichment?.rows[index];
        return {
          rowNumber: row.rowNumber,
          claudeCategoryIdPresent: Boolean(claudeRow?.categoryId),
          claudeCategoryIdAllowed: Boolean(
            claudeRow?.categoryId &&
              categories.some(
                (category) => category.id === claudeRow.categoryId
              )
          ),
          categoryConfidence: claudeRow?.categoryConfidence ?? 0,
          claudeLocationIdPresent: Boolean(claudeRow?.locationId),
          claudeLocationIdAssignable: Boolean(
            claudeRow?.locationId &&
              locations.some(
                (location) =>
                  location.id === claudeRow.locationId && !location.operational
              )
          ),
          locationConfidence: claudeRow?.locationConfidence ?? 0,
          resolvedCategory: Boolean(row.suggestedCategoryId),
          resolvedLocation: Boolean(row.suggestedLocationId),
          categorySelectionMethod: row.categorySuggestionMethod,
          locationSelectionMethod: row.locationSuggestionMethod,
        };
      }),
    });
    pdfSummary = {
      validItemRows: rows.length,
      needsReview: rows.filter((row) => !row.category).length,
      ignoredRows: 0,
      unresolvedLines: parsed.mouserInvoice.unresolvedLines,
    };
    extractionProvider = enrichment
      ? "mouser-deterministic+claude-enrichment:v2"
      : "mouser-deterministic:v1";
  } else if (parsed.pdfPages) {
    let fallbackPdfTable: ReturnType<typeof parsePdfTablePages> | null = null;
    try {
      fallbackPdfTable = parsePdfTablePages(parsed.pdfPages);
    } catch {
      // A readable PDF may not contain a simple delimited table. Claude remains
      // the line item extractor, with quantities marked for review when its
      // row cannot be joined safely to structured table evidence.
    }
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
    const allowedLocationIds = new Set(
      helperRequest.relevantLocations.map(({ id }) => id)
    );
    const helperResult = await requestImportHelperProposal(helperRequest);
    Logger.info({
      event: "ioio_staff_import_pdf_analysis_selected",
      ...parsed.pdfDiagnostics,
      detectedVendorParser: null,
      genericClaudeFallbackInvoked: true,
      genericClaudeResult:
        helperResult.status === "ready"
          ? "rows" in helperResult.proposal &&
            helperResult.proposal.rows.length > 0
            ? "line-items-found"
            : "no-line-items"
          : helperResult.reason,
    });
    if (
      helperResult.status === "ready" &&
      !("mode" in helperResult.proposal) &&
      helperResult.proposal.rows.length
    ) {
      const helperRows = helperResult.proposal.rows;
      const mapped = mapHelperProposalToRows({
        candidates: helperRows,
        pdfPages: parsed.pdfPages,
        categories,
        locations,
        allowedLocationIds,
        sourceTableRows: fallbackPdfTable?.rows,
      });
      Logger.info({
        event: "ioio_staff_import_generic_suggestion_resolution",
        ...getImportCandidateDiagnostics(categories, locations),
        rows: mapped.rows.map((row, index) => {
          const claudeRow = helperRows[index];
          return {
            rowNumber: row.rowNumber,
            claudeCategoryIdPresent: Boolean(
              claudeRow?.categorySuggestion.categoryId
            ),
            claudeCategoryIdAllowed: Boolean(
              claudeRow?.categorySuggestion.categoryId &&
                categories.some(
                  (category) =>
                    category.id === claudeRow.categorySuggestion.categoryId
                )
            ),
            categoryConfidence: claudeRow?.categorySuggestion.confidence ?? 0,
            claudeLocationIdPresent: Boolean(
              claudeRow?.locationSuggestions[0]?.locationId
            ),
            claudeLocationIdAssignable: Boolean(
              claudeRow?.locationSuggestions[0]?.locationId &&
                locations.some(
                  (location) =>
                    location.id ===
                      claudeRow.locationSuggestions[0]?.locationId &&
                    !location.operational
                )
            ),
            locationConfidence:
              claudeRow?.locationSuggestions[0]?.confidence ?? 0,
            resolvedCategory: Boolean(row.suggestedCategoryId),
            resolvedLocation: Boolean(row.suggestedLocationId),
            categorySelectionMethod: row.categorySuggestionMethod,
            locationSelectionMethod: row.locationSuggestionMethod,
          };
        }),
      });
      rows = mapped.rows;
      pdfSummary = mapped.pdfSummary;
      extractionProvider = "import-helper:v1";
    } else if (
      helperResult.status === "ready" &&
      !("mode" in helperResult.proposal)
    ) {
      throw importError(
        "Claude could not confidently identify product line items in this document."
      );
    } else {
      if (fallbackPdfTable) {
        rows = fallbackPdfTable.rows;
        pdfSummary = fallbackPdfTable.pdfSummary;
      } else {
        throw importError(PDF_AI_ANALYSIS_REQUIRED_MESSAGE);
      }
    }
  }
  if (getStaffImportFormat(file.name) !== "PDF") {
    const normalized: StaffImportRow[] = [];
    for (
      let offset = 0;
      offset < rows.length;
      offset += SPREADSHEET_BATCH_SIZE
    ) {
      const batch = rows.slice(offset, offset + SPREADSHEET_BATCH_SIZE);
      const valid = batch.filter(
        (row) => !row.uncertainFields?.includes("Spreadsheet row")
      );
      const pages = valid.map((row) => ({
        sourceRef: `spreadsheet-row-${row.rowNumber}`,
        page: row.rowNumber,
        text: JSON.stringify({
          productName: row.title,
          manufacturer: row.manufacturer,
          description: row.sourceDescription,
          mpn: row.manufacturerPartNumber,
          supplierSku: row.supplierPartNumber,
          quantity: row.quantity,
          category: row.category,
          location: row.location,
        }),
      }));
      const helperRequest = pages.length
        ? buildStaffImportHelperRequest({
            pdfPages: pages,
            fileSha256,
            assets,
            productModels: [],
            categories,
            locations,
          })
        : null;
      const allowedLocationIds = new Set(
        helperRequest?.relevantLocations.map(({ id }) => id) ?? []
      );
      const result = helperRequest
        ? await requestImportHelperProposal(helperRequest)
        : null;
      const candidates =
        result?.status === "ready" && !("mode" in result.proposal)
          ? result.proposal.rows
          : [];
      for (const original of batch) {
        const matches = candidates.filter(
          (candidate) =>
            candidate.sourceRef === `spreadsheet-row-${original.rowNumber}`
        );
        if (matches.length === 1) {
          const enriched = mapHelperProposalToRows({
            candidates: matches,
            pdfPages: pages,
            categories,
            locations,
            allowedLocationIds,
          }).rows[0];
          normalized.push({
            ...original,
            title: enriched.title || original.title,
            sourceDescription: original.sourceDescription || original.title,
            category: enriched.category || original.category,
            location: enriched.location || original.location,
            manufacturer: enriched.manufacturer || original.manufacturer,
            supplierPartNumber:
              original.supplierPartNumber || enriched.supplierPartNumber,
            manufacturerPartNumber:
              original.manufacturerPartNumber ||
              enriched.manufacturerPartNumber,
            suggestedCategoryId: enriched.suggestedCategoryId,
            categorySuggestionConfidence: enriched.categorySuggestionConfidence,
            suggestedLocationId: enriched.suggestedLocationId,
            locationSuggestionConfidence: enriched.locationSuggestionConfidence,
            categorySuggestionMethod: enriched.categorySuggestionMethod,
            locationSuggestionMethod: enriched.locationSuggestionMethod,
            locationSuggestionStatus: enriched.locationSuggestionStatus,
            diagnosticReasonCodes: [
              ...(original.diagnosticReasonCodes ?? []),
              ...(enriched.diagnosticReasonCodes ?? []).filter((code) =>
                code.startsWith("LOCATION_")
              ),
            ],
            helperCandidate: enriched.helperCandidate,
            reviewRequired: true,
          });
        } else {
          const evidence = {
            productName: original.title,
            manufacturer: original.manufacturer,
            mpn: original.manufacturerPartNumber,
            description: [
              original.sourceDescription,
              original.category,
              original.location,
            ]
              .filter(Boolean)
              .join(" "),
          };
          const categoryChoice = resolveImportCategorySuggestion({
            claudeCategoryId: null,
            claudeConfidence: 0,
            evidence,
            categories,
          });
          const locationChoice = resolveImportLocationSuggestion({
            claudeLocationId: null,
            claudeConfidence: 0,
            evidence,
            category: categoryChoice.category,
            locations,
          });
          normalized.push({
            ...original,
            category:
              original.category || categoryChoice.category?.name || null,
            location:
              original.location || locationChoice.location?.name || null,
            suggestedCategoryId: categoryChoice.category?.id ?? null,
            suggestedLocationId: locationChoice.location?.id ?? null,
            locationSuggestionMethod: locationChoice.method,
            locationSuggestionStatus: locationChoice.status,
            diagnosticReasonCodes: [
              ...(original.diagnosticReasonCodes ?? []),
              ...locationChoice.reasonCodes,
            ],
            reviewRequired: true,
            sourceNotes: [
              original.sourceNotes,
              result?.status === "ready"
                ? "helper_invalid_response: no unique source-row correspondence"
                : "helper_unavailable: deterministic row retained for review",
            ]
              .filter(Boolean)
              .join("; "),
          });
        }
      }
      Logger.info({
        event: "ioio_spreadsheet_semantic_batch",
        rows: batch.length,
        acceptedResponses: candidates.length,
        status: result?.status ?? "no_valid_rows",
      });
    }
    rows = normalized.map((row, index) => {
      if (row.uncertainFields?.includes("Spreadsheet row")) return row;
      const original = parsed.rows[index];
      const selection = resolveImportCategorySuggestion({
        claudeCategoryId: row.helperCandidate?.categorySuggestion.categoryId,
        claudeConfidence: row.helperCandidate?.categorySuggestion.confidence,
        evidence: {
          productName: row.title,
          rawDescription: original.sourceDescription,
          manufacturer: row.manufacturer,
          mpn: row.manufacturerPartNumber,
          categoryText: original.category,
        },
        categories,
      });
      Logger.info({
        event: "ioio_import_category_resolved",
        rowNumber: row.rowNumber,
        ...selection.diagnostics,
      });
      return {
        ...row,
        category: selection.category?.name ?? null,
        suggestedCategoryId: selection.category?.id ?? null,
        categorySuggestionMethod: selection.method,
      };
    });
  }
  if (getStaffImportFormat(file.name) === "PDF") {
    rows = resolvePdfRowLocations({ rows, categories, locations });
  }
  const classifiedRows = classifyStaffImportRows({
    rows,
    assets,
    categories,
    locations,
  });
  const normalizedProposalRows = classifiedRows.map((classifiedRow) => {
    const categoryName =
      classifiedRow.category ?? classifiedRow.suggestedCategory ?? null;
    const categoryResolution = resolveImportCategory(
      categoryName,
      allCategoryCandidates
    );
    const row =
      categoryResolution.status === "ACTIVE_MATCH" ||
      (classifiedRow.mouserLineItem && categoryResolution.status === "MISSING")
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
    return row;
  });
  const existingModelNames = [
    ...new Set(
      normalizedProposalRows.map((row) => row.title.trim()).filter(Boolean)
    ),
  ].slice(0, 200);
  const existingModelIdentityKeys = [
    ...new Set(
      normalizedProposalRows.map(
        (row) =>
          getImportAssetModelIdentity({
            name: row.title,
            manufacturer: row.manufacturer,
            manufacturerPartNumber: row.manufacturerPartNumber,
          }).key
      )
    ),
  ];
  const attachedModelIds = [
    ...new Set(
      assets
        .map((asset) => asset.assetModelId)
        .filter((id): id is string => typeof id === "string" && id.length > 0)
    ),
  ];
  const existingModelOr: Prisma.AssetModelWhereInput[] = [
    ...existingModelNames.map(
      (name): Prisma.AssetModelWhereInput => ({
        name: { equals: name, mode: "insensitive" },
      })
    ),
    ...(existingModelIdentityKeys.length
      ? [{ importIdentityKey: { in: existingModelIdentityKeys } }]
      : []),
    ...(attachedModelIds.length ? [{ id: { in: attachedModelIds } }] : []),
  ];
  const existingModels =
    existingModelNames.length ||
    existingModelIdentityKeys.length ||
    attachedModelIds.length
      ? await db.assetModel.findMany({
          where: {
            organizationId,
            OR: existingModelOr,
          },
          take: 500,
          select: {
            id: true,
            name: true,
            description: true,
            image: true,
            thumbnailImage: true,
            imageStoragePath: true,
            thumbnailImageStoragePath: true,
            importIdentityKey: true,
          },
        })
      : [];
  const existingImportModels: ExistingImportAssetModel[] = await Promise.all(
    existingModels.map(async (model) => {
      const [imageUrl, thumbnailUrl] = await Promise.all([
        resolveStorageImageUrl({
          bucketName: PUBLIC_BUCKET,
          objectPath: model.imageStoragePath,
          legacyUrl: model.image,
          isPublic: true,
        }),
        resolveStorageImageUrl({
          bucketName: PUBLIC_BUCKET,
          objectPath: model.thumbnailImageStoragePath,
          legacyUrl: model.thumbnailImage,
          isPublic: true,
        }),
      ]);
      return {
        id: model.id,
        name: model.name,
        description: model.description,
        imageUrl,
        thumbnailUrl,
        importIdentityKey: model.importIdentityKey,
      };
    })
  );
  let productEnrichment: {
    rows: typeof normalizedProposalRows;
    diagnostics: ProductEnrichmentDiagnostics;
  };
  try {
    productEnrichment = await enrichImportProductRows(
      normalizedProposalRows,
      existingImportModels,
      (row) =>
        getImportAssetModelIdentity({
          name: row.title,
          manufacturer: row.manufacturer,
          manufacturerPartNumber: row.manufacturerPartNumber,
        }).key
    );
  } catch (cause) {
    Logger.info({
      event: "ioio_staff_import_product_enrichment_failed",
      rowCount: normalizedProposalRows.length,
      errorType: cause instanceof Error ? cause.name : "unknown",
    });
    productEnrichment = {
      rows: normalizedProposalRows.map((row) => ({
        ...row,
        assetModelDescription: row.sourceDescription ?? null,
        assetModelDescriptionSource: row.sourceDescription ? "SOURCE" : "NONE",
        productImageProposal: { status: "IMAGE_FETCH_FAILED" as const },
      })),
      diagnostics: {
        imageLookupAttempted: 0,
        imageCandidatesConsidered: 0,
        imageAccepted: 0,
        imageRejectedReason: {
          IMAGE_FETCH_FAILED: normalizedProposalRows.length,
        },
        descriptionGenerated: 0,
        descriptionSource: {
          SOURCE: normalizedProposalRows.filter((row) => row.sourceDescription)
            .length,
          SHELF_EXISTING: 0,
          GENERATED: 0,
          NONE: normalizedProposalRows.filter((row) => !row.sourceDescription)
            .length,
        },
      },
    };
  }
  const proposalRows = productEnrichment.rows;
  const operationId = randomUUID();
  const diagnostics: StaffImportDiagnostics = {
    rowsParsed: proposalRows.length,
    rowsWithQuantity: proposalRows.filter(
      (row) =>
        (row.quantityStatus === "RECEIVED" ||
          row.quantityStatus === "SHIPPED") &&
        Number.isSafeInteger(row.receivedQuantity ?? row.quantity) &&
        (row.receivedQuantity ?? row.quantity ?? 0) > 0
    ).length,
    quantityNeedsReview: proposalRows.filter(
      (row) =>
        row.diagnosticReasonCodes?.some((code) =>
          ["QUANTITY_AMBIGUOUS", "QUANTITY_INVALID"].includes(code)
        )
    ).length,
    rowsWithSuggestedLocation: proposalRows.filter((row) =>
      locations.some(
        (location) =>
          location.id === row.suggestedLocationId && !location.operational
      )
    ).length,
    locationFallbackUsed: proposalRows.filter(
      (row) =>
        row.diagnosticReasonCodes?.includes("LOCATION_DETERMINISTIC_FALLBACK")
    ).length,
    locationUnresolved: proposalRows.filter(
      (row) =>
        !row.suggestedLocationId ||
        row.locationSuggestionStatus === "UNRESOLVED"
    ).length,
    imageLookupAttempted: productEnrichment.diagnostics.imageLookupAttempted,
    imageCandidatesConsidered:
      productEnrichment.diagnostics.imageCandidatesConsidered,
    imageAccepted: productEnrichment.diagnostics.imageAccepted,
    imageRejectedReason: productEnrichment.diagnostics.imageRejectedReason,
    descriptionGenerated: productEnrichment.diagnostics.descriptionGenerated,
    descriptionSource: productEnrichment.diagnostics.descriptionSource,
  };
  Logger.info({
    event: "ioio_staff_import_diagnostics",
    format: getStaffImportFormat(file.name),
    ...diagnostics,
  });
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
    diagnostics,
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
  assetModelDescription?: string | null;
  acceptSuggestedImage?: boolean;
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
    const rawAssetModelDescription = decision.assetModelDescription;
    if (
      rawAssetModelDescription !== undefined &&
      rawAssetModelDescription !== null &&
      typeof rawAssetModelDescription !== "string"
    ) {
      throw importError(
        "AssetModel descriptions must be 600 characters or less."
      );
    }
    const assetModelDescription =
      typeof rawAssetModelDescription === "string"
        ? [...rawAssetModelDescription]
            .filter((character) => {
              const code = character.charCodeAt(0);
              return code > 31 && code !== 127;
            })
            .join("")
            .trim()
        : rawAssetModelDescription ?? undefined;
    if (assetModelDescription && assetModelDescription.length > 600) {
      throw importError(
        "AssetModel descriptions must be 600 characters or less."
      );
    }
    const acceptSuggestedImage = decision.acceptSuggestedImage;
    if (
      acceptSuggestedImage !== undefined &&
      typeof acceptSuggestedImage !== "boolean"
    ) {
      throw importError("Suggested image approval must be explicit.");
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
      ...(assetModelDescription !== undefined ? { assetModelDescription } : {}),
      ...(acceptSuggestedImage !== undefined ? { acceptSuggestedImage } : {}),
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

function makeSuggestedImageRequest(row: StaffImportProposalRow) {
  const proposal = row.productImageProposal;
  if (
    !row.acceptSuggestedImage ||
    proposal?.status !== "IMAGE_FOUND" ||
    proposal.mimeType !== "image/webp" ||
    !proposal.dataBase64 ||
    proposal.dataBase64.length > 180_000 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(proposal.dataBase64)
  ) {
    return null;
  }
  const imageBytes = Buffer.from(proposal.dataBase64, "base64");
  if (
    imageBytes.byteLength === 0 ||
    imageBytes.byteLength > 128 * 1024 ||
    imageBytes.toString("base64") !== proposal.dataBase64 ||
    detectImageFormat(imageBytes) !== "image/webp"
  ) {
    return null;
  }
  const formData = new FormData();
  formData.append(
    "image",
    new File([imageBytes], "product-image.webp", { type: "image/webp" })
  );
  return new Request("http://shelf.local/import-product-image", {
    method: "POST",
    body: formData,
  });
}

async function applyImportAssetModelEnrichment({
  assetModelId,
  organizationId,
  row,
}: {
  assetModelId: string;
  organizationId: string;
  row: StaffImportProposalRow;
}) {
  const description = row.assetModelDescription?.trim();
  if (
    description &&
    description !== row.existingAssetModelDescription?.trim()
  ) {
    try {
      await updateAssetModelDescriptionIfUnchanged({
        assetModelId,
        organizationId,
        expectedDescription: row.existingAssetModelDescription ?? null,
        description,
      });
    } catch (cause) {
      Logger.info({
        event: "ioio_staff_import_description_save_failed",
        rowNumber: row.rowNumber,
        errorType: cause instanceof Error ? cause.name : "unknown",
      });
    }
  }

  if (!row.acceptSuggestedImage) return;
  const request = makeSuggestedImageRequest(row);
  if (!request) {
    Logger.info({
      event: "ioio_staff_import_image_save_failed",
      rowNumber: row.rowNumber,
      status: "IMAGE_INVALID_TYPE",
    });
    return;
  }
  try {
    await updateAssetModelImage({
      request,
      assetModelId,
      organizationId,
      onlyIfMissing: true,
    });
  } catch (cause) {
    Logger.info({
      event: "ioio_staff_import_image_save_failed",
      rowNumber: row.rowNumber,
      status: "IMAGE_FETCH_FAILED",
      errorType: cause instanceof Error ? cause.name : "unknown",
    });
  }
}

async function applyImportQuantityTrackedAssetImage({
  assetId,
  userId,
  organizationId,
  row,
}: {
  assetId: string;
  userId: string;
  organizationId: string;
  row: StaffImportProposalRow;
}) {
  if (!row.acceptSuggestedImage) return;
  const request = makeSuggestedImageRequest(row);
  if (!request) {
    Logger.info({
      event: "ioio_staff_import_image_save_failed",
      rowNumber: row.rowNumber,
      status: "IMAGE_INVALID_TYPE",
    });
    return;
  }
  try {
    await updateAssetMainImage({
      request,
      assetId,
      userId,
      organizationId,
      isNewAsset: true,
    });
  } catch (cause) {
    Logger.info({
      event: "ioio_staff_import_image_save_failed",
      rowNumber: row.rowNumber,
      status: "IMAGE_FETCH_FAILED",
      errorType: cause instanceof Error ? cause.name : "unknown",
    });
  }
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
}: {
  operationId: string;
  row: StaffImportProposalRow;
  organizationId: string;
  userId: string;
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
    description: row.assetModelDescription ?? null,
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
  applyEnrichment = false,
}: {
  plan: IndividualUnitImportPlan;
  row: StaffImportProposalRow;
  organizationId: string;
  userId: string;
  applyEnrichment?: boolean;
}) {
  const resolution = await resolveImportAssetModel({
    organizationId,
    userId,
    name: row.title,
    manufacturer: row.manufacturer,
    manufacturerPartNumber: row.manufacturerPartNumber,
    description: row.assetModelDescription ?? null,
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
  if (applyEnrichment) {
    await applyImportAssetModelEnrichment({
      assetModelId: resolution.assetModelId,
      organizationId,
      row,
    });
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
      if (
        decision.acceptSuggestedImage &&
        row.productImageProposal?.status !== "IMAGE_FOUND"
      ) {
        throw importError(
          "A product image can be accepted only from this proposal's validated suggestion."
        );
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
        assetModelDescription:
          resolvedDecision.assetModelDescription !== undefined
            ? resolvedDecision.assetModelDescription
            : row.assetModelDescription ?? null,
        acceptSuggestedImage: resolvedDecision.acceptSuggestedImage === true,
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
    "NO_CHANGE",
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

    if (row.action === "NO_CHANGE") {
      if (row.existingAssetModelId) {
        await applyImportAssetModelEnrichment({
          assetModelId: row.existingAssetModelId,
          organizationId,
          row,
        });
      }
      const markedDone = await markImportLedgerItemDone({
        operationId,
        organizationId,
        itemId,
        targetAssetId: row.assetId,
        writtenState: row.assetId
          ? { outcome: "reused", assetId: row.assetId }
          : { outcome: "no_change" },
      });
      if (!markedDone) return { status: "IN_PROGRESS", operationId };
      if (row.assetId) reusedIds.push(row.assetId);
      continue;
    }

    if (row.assetId && row.existingAssetModelId) {
      await applyImportAssetModelEnrichment({
        assetModelId: row.existingAssetModelId,
        organizationId,
        row,
      });
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
              applyEnrichment: true,
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
          description:
            type === "QUANTITY_TRACKED" && row.assetModelDescription?.trim()
              ? row.assetModelDescription.trim()
              : buildImportedDescription(proposal.source.filename, row),
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
        if (type === "QUANTITY_TRACKED" && row.acceptSuggestedImage) {
          await applyImportQuantityTrackedAssetImage({
            assetId: asset.id,
            userId,
            organizationId,
            row,
          });
        }
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
