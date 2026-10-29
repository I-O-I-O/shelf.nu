import sharp from "sharp";
import { detectImageFormat } from "~/utils/image-format.server";
import { safeFetch } from "~/utils/ssrf.server";

export const IMPORT_IMAGE_SOURCE_MAX_BYTES = 2 * 1024 * 1024;
const IMAGE_PREVIEW_MAX_BYTES = 128 * 1024;
const OPENVERSE_RESPONSE_MAX_BYTES = 256 * 1024;
const IMAGE_LOOKUP_TIMEOUT_MS = 5_000;
const MAX_IMAGE_LOOKUPS_PER_IMPORT = 12;
const MAX_OPENVERSE_CANDIDATES = 5;

export type ImportProductImageStatus =
  | "IMAGE_FOUND"
  | "IMAGE_NOT_FOUND"
  | "IMAGE_TOO_LARGE"
  | "IMAGE_INVALID_TYPE"
  | "IMAGE_FETCH_FAILED"
  | "IMAGE_AMBIGUOUS"
  | "IMAGE_PRESERVED";

export type ImportProductDescriptionSource =
  | "SOURCE"
  | "SHELF_EXISTING"
  | "GENERATED"
  | "NONE";

export type ImportProductImageProposal = {
  status: ImportProductImageStatus;
  mimeType?: "image/webp";
  dataBase64?: string;
  sourceName?: string;
  sourceUrl?: string;
  license?: string;
};

export type ImportProductEnrichmentRow = {
  rowNumber: number;
  title: string;
  manufacturer?: string | null;
  manufacturerPartNumber?: string | null;
  supplierPartNumber?: string | null;
  sourceDescription?: string | null;
  enrichmentConfidence?: number;
  assetModelDescription?: string | null;
  existingAssetModelDescription?: string | null;
  existingAssetModelId?: string | null;
  existingAssetModelImageUrl?: string | null;
  existingAssetModelThumbnailUrl?: string | null;
  assetModelDescriptionSource?: ImportProductDescriptionSource;
  productImageProposal?: ImportProductImageProposal;
};

export type ExistingImportAssetModel = {
  id: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  thumbnailUrl: string | null;
  importIdentityKey: string | null;
};

type OpenverseImageResult = {
  url?: unknown;
  title?: unknown;
  creator?: unknown;
  license?: unknown;
  foreign_landing_url?: unknown;
  width?: unknown;
  height?: unknown;
  tags?: unknown;
};

type OpenverseResponse = { results?: unknown };

export type ProductEnrichmentDiagnostics = {
  imageLookupAttempted: number;
  imageCandidatesConsidered: number;
  imageAccepted: number;
  imageRejectedReason: Record<string, number>;
  descriptionGenerated: number;
  descriptionSource: Record<ImportProductDescriptionSource, number>;
};

export function normalizeProductEvidence(value: string | null | undefined) {
  return (value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function isUsableDescription(value: string | null | undefined) {
  const description = (value ?? "")
    .replace(/<[^>]*>/g, " ")
    .split("")
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code > 31 && code !== 127;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  if (
    description.length < 20 ||
    description.length > 600 ||
    !/[a-z]{3}/i.test(description) ||
    /(?:\$|€|£|\b(?:usd|eur|gbp|vat|tax|unit price|line total|invoice|order number|quantity)\b)/i.test(
      description
    ) ||
    /\b\d+(?:[.,]\d{2})\b/.test(description)
  ) {
    return null;
  }
  const sentences = description.match(/[^.!?]+(?:[.!?]+|$)/g) ?? [description];
  return sentences.slice(0, 3).join("").trim();
}

function matchExistingModel(
  row: ImportProductEnrichmentRow,
  models: ExistingImportAssetModel[],
  identityKey?: string
) {
  if (identityKey) {
    const identityMatches = models.filter(
      (model) => model.importIdentityKey === identityKey
    );
    if (identityMatches.length === 1) return identityMatches[0];
    if (identityMatches.length > 1) return null;
  }
  const name = normalizeProductEvidence(row.title);
  if (!name) return null;
  const exactNameMatches = models.filter(
    (model) => normalizeProductEvidence(model.name) === name
  );
  return exactNameMatches.length === 1 ? exactNameMatches[0] : null;
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.hostname.endsWith(".")
    );
  } catch {
    return false;
  }
}

function textForIdentity(result: OpenverseImageResult) {
  const tags = Array.isArray(result.tags)
    ? result.tags
        .slice(0, 30)
        .flatMap((tag) =>
          tag && typeof tag === "object" && "name" in tag
            ? [String(tag.name)]
            : []
        )
    : [];
  return normalizeProductEvidence(
    [result.title, result.creator, ...tags]
      .filter((value): value is string => typeof value === "string")
      .join(" ")
  );
}

function identityMatchScore(
  row: ImportProductEnrichmentRow,
  result: OpenverseImageResult
) {
  const metadata = textForIdentity(result);
  const name = normalizeProductEvidence(row.title);
  const manufacturer = normalizeProductEvidence(row.manufacturer);
  const mpn = normalizeProductEvidence(row.manufacturerPartNumber);
  if (!metadata || !name) return 0;

  const hasMpn = mpn.length >= 3 && metadata.includes(mpn);
  const hasManufacturer = Boolean(
    manufacturer && metadata.includes(manufacturer)
  );
  if (mpn) return hasMpn && (!manufacturer || hasManufacturer) ? 1 : 0;
  if (manufacturer) {
    return metadata.includes(name) && hasManufacturer ? 0.9 : 0;
  }
  return metadata.includes(name) ? 0.82 : 0;
}

function getFailureStatus(error: unknown): ImportProductImageStatus {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (
    message.includes("size") &&
    (message.includes("large") || message.includes("exceeds"))
  ) {
    return "IMAGE_TOO_LARGE";
  }
  return "IMAGE_FETCH_FAILED";
}

async function getOpenverseCandidates(row: ImportProductEnrichmentRow) {
  const supplierSku = row.supplierPartNumber?.trim() ?? "";
  const meaningfulSupplierSku =
    supplierSku.length >= 4 &&
    supplierSku.length <= 40 &&
    /[a-z]/i.test(supplierSku) &&
    /\d/.test(supplierSku)
      ? supplierSku
      : null;
  const identity = [
    row.manufacturer,
    row.title,
    row.manufacturerPartNumber,
    meaningfulSupplierSku,
  ]
    .filter((value): value is string => Boolean(value?.trim()))
    .join(" ");
  if (!identity.trim() || normalizeProductEvidence(row.title).length < 3) {
    return [];
  }

  const url = new URL("https://api.openverse.org/v1/images/");
  url.searchParams.set("q", identity.slice(0, 300));
  url.searchParams.set("license", "cc0,pdm");
  url.searchParams.set("page_size", String(MAX_OPENVERSE_CANDIDATES));
  const response = await safeFetch(url.href, {
    maxBytes: OPENVERSE_RESPONSE_MAX_BYTES,
    timeoutMs: IMAGE_LOOKUP_TIMEOUT_MS,
  });
  if (!/^application\/json(?:;|$)/i.test(response.contentType)) {
    throw new Error("Image search returned an unsupported content type.");
  }
  let body: OpenverseResponse;
  try {
    body = JSON.parse(response.buffer.toString("utf8")) as OpenverseResponse;
  } catch {
    throw new Error("Image search returned invalid JSON.");
  }
  if (!Array.isArray(body.results)) return [];
  return body.results
    .slice(0, MAX_OPENVERSE_CANDIDATES)
    .filter(
      (candidate): candidate is OpenverseImageResult =>
        Boolean(candidate) &&
        typeof candidate === "object" &&
        (candidate.license === "cc0" || candidate.license === "pdm")
    );
}

async function validateAndNormalizeImage(candidate: OpenverseImageResult) {
  if (!isHttpUrl(candidate.url)) {
    return { status: "IMAGE_INVALID_TYPE" as const };
  }
  if (
    typeof candidate.width !== "number" ||
    typeof candidate.height !== "number" ||
    candidate.width < 100 ||
    candidate.height < 100 ||
    candidate.width * candidate.height > 40_000_000
  ) {
    return { status: "IMAGE_AMBIGUOUS" as const };
  }

  let fetched: Awaited<ReturnType<typeof safeFetch>>;
  try {
    fetched = await safeFetch(candidate.url, {
      maxBytes: IMPORT_IMAGE_SOURCE_MAX_BYTES,
      timeoutMs: IMAGE_LOOKUP_TIMEOUT_MS,
    });
  } catch (error) {
    return { status: getFailureStatus(error) };
  }
  if (fetched.buffer.byteLength > IMPORT_IMAGE_SOURCE_MAX_BYTES) {
    return { status: "IMAGE_TOO_LARGE" as const };
  }
  const detectedMime = detectImageFormat(fetched.buffer);
  const contentMime = fetched.contentType.split(";")[0]?.trim().toLowerCase();
  if (
    !contentMime?.startsWith("image/") ||
    !detectedMime ||
    detectedMime !== contentMime ||
    detectedMime === "image/svg+xml"
  ) {
    return { status: "IMAGE_INVALID_TYPE" as const };
  }

  try {
    const image = sharp(fetched.buffer, {
      limitInputPixels: 40_000_000,
      animated: false,
    });
    const metadata = await image.metadata();
    if (
      !metadata.width ||
      !metadata.height ||
      metadata.width < 100 ||
      metadata.height < 100
    ) {
      return { status: "IMAGE_AMBIGUOUS" as const };
    }
    const preview = await image
      .resize({
        width: 640,
        height: 640,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: 75, effort: 3 })
      .toBuffer();
    if (preview.byteLength > IMAGE_PREVIEW_MAX_BYTES) {
      return { status: "IMAGE_TOO_LARGE" as const };
    }
    return {
      status: "IMAGE_FOUND" as const,
      mimeType: "image/webp" as const,
      dataBase64: preview.toString("base64"),
      sourceName:
        typeof candidate.title === "string"
          ? candidate.title.slice(0, 200)
          : "Openverse image",
      sourceUrl: isHttpUrl(candidate.foreign_landing_url)
        ? candidate.foreign_landing_url.slice(0, 2_000)
        : undefined,
      license:
        typeof candidate.license === "string"
          ? candidate.license.slice(0, 40)
          : undefined,
    };
  } catch {
    return { status: "IMAGE_INVALID_TYPE" as const };
  }
}

async function lookupProductImage(row: ImportProductEnrichmentRow) {
  let candidates: OpenverseImageResult[];
  try {
    candidates = await getOpenverseCandidates(row);
  } catch {
    return { status: "IMAGE_FETCH_FAILED" as const, candidatesConsidered: 0 };
  }
  const likelyMatches = candidates
    .map((candidate) => ({
      candidate,
      score: identityMatchScore(row, candidate),
    }))
    .filter(({ score }) => score >= 0.82)
    .sort((a, b) => b.score - a.score);
  if (!candidates.length) {
    return { status: "IMAGE_NOT_FOUND" as const, candidatesConsidered: 0 };
  }
  if (
    !likelyMatches.length ||
    (likelyMatches[1]?.score ?? 0) === likelyMatches[0]?.score
  ) {
    return {
      status: "IMAGE_AMBIGUOUS" as const,
      candidatesConsidered: candidates.length,
    };
  }
  const result = await validateAndNormalizeImage(likelyMatches[0].candidate);
  return { ...result, candidatesConsidered: candidates.length };
}

export async function enrichImportProductRows<
  TRow extends ImportProductEnrichmentRow,
>(
  rows: TRow[],
  existingModels: ExistingImportAssetModel[],
  getIdentityKey?: (row: TRow) => string | undefined
) {
  const diagnostics: ProductEnrichmentDiagnostics = {
    imageLookupAttempted: 0,
    imageCandidatesConsidered: 0,
    imageAccepted: 0,
    imageRejectedReason: {},
    descriptionGenerated: 0,
    descriptionSource: { SOURCE: 0, SHELF_EXISTING: 0, GENERATED: 0, NONE: 0 },
  };
  const lookupCache = new Map<string, ImportProductImageProposal>();
  const existingModelByRow = rows.map((row) =>
    matchExistingModel(row, existingModels, getIdentityKey?.(row))
  );
  const lookupRows = new Map<string, TRow>();
  for (const [index, row] of rows.entries()) {
    const existingModel = existingModelByRow[index];
    if (
      existingModel?.imageUrl ||
      existingModel?.thumbnailUrl ||
      !normalizeProductEvidence(row.title)
    ) {
      continue;
    }
    const identityKey = [
      row.manufacturer,
      row.title,
      row.manufacturerPartNumber,
    ]
      .map((value) => normalizeProductEvidence(value))
      .join("|");
    if (
      lookupRows.has(identityKey) ||
      lookupRows.size < MAX_IMAGE_LOOKUPS_PER_IMPORT
    ) {
      lookupRows.set(identityKey, lookupRows.get(identityKey) ?? row);
    }
  }
  diagnostics.imageLookupAttempted = lookupRows.size;
  const queuedLookups = [...lookupRows.entries()];
  let nextLookup = 0;
  await Promise.all(
    Array.from({ length: Math.min(3, queuedLookups.length) }, async () => {
      while (nextLookup < queuedLookups.length) {
        const current = queuedLookups[nextLookup++];
        if (!current) continue;
        const [identityKey, row] = current;
        try {
          const result = await lookupProductImage(row);
          diagnostics.imageCandidatesConsidered += result.candidatesConsidered;
          lookupCache.set(identityKey, result);
        } catch {
          lookupCache.set(identityKey, { status: "IMAGE_FETCH_FAILED" });
        }
      }
    })
  );
  const enrichedRows: TRow[] = [];

  for (const [index, row] of rows.entries()) {
    const existingModel = existingModelByRow[index];
    const sourceDescription = isUsableDescription(row.sourceDescription);
    const normalizedTitle = normalizeProductEvidence(row.title);
    const vagueTitle = new Set([
      "electronics",
      "electronic component",
      "component",
      "parts",
      "hardware",
      "cable",
      "adapter",
      "sensor",
    ]).has(normalizedTitle);
    const identityIsClear = Boolean(
      (row.manufacturer && row.manufacturerPartNumber) ||
        (normalizedTitle.split(" ").filter(Boolean).length >= 2 && !vagueTitle)
    );
    const generatedDescription =
      identityIsClear &&
      row.enrichmentConfidence !== undefined &&
      row.enrichmentConfidence >= 0.75
        ? isUsableDescription(row.assetModelDescription)
        : null;
    const existingDescription = existingModel?.description?.trim()
      ? existingModel.description.trim()
      : null;
    const assetModelDescription =
      existingDescription ?? sourceDescription ?? generatedDescription;
    const assetModelDescriptionSource: ImportProductDescriptionSource =
      existingDescription
        ? "SHELF_EXISTING"
        : sourceDescription
        ? "SOURCE"
        : generatedDescription
        ? "GENERATED"
        : "NONE";
    diagnostics.descriptionSource[assetModelDescriptionSource] += 1;
    if (assetModelDescriptionSource === "GENERATED") {
      diagnostics.descriptionGenerated += 1;
    }

    const identityKey = [
      row.manufacturer,
      row.title,
      row.manufacturerPartNumber,
    ]
      .map((value) => normalizeProductEvidence(value))
      .join("|");
    const productImageProposal: ImportProductImageProposal =
      existingModel?.imageUrl || existingModel?.thumbnailUrl
        ? {
            status: "IMAGE_PRESERVED",
          }
        : lookupCache.get(identityKey) ?? {
            status: "IMAGE_NOT_FOUND",
          };
    if (productImageProposal.status === "IMAGE_FOUND") {
      diagnostics.imageAccepted += 1;
    } else if (
      productImageProposal.status !== "IMAGE_PRESERVED" &&
      lookupCache.has(identityKey)
    ) {
      diagnostics.imageRejectedReason[productImageProposal.status] =
        (diagnostics.imageRejectedReason[productImageProposal.status] ?? 0) + 1;
    }

    enrichedRows.push({
      ...row,
      existingAssetModelId: existingModel?.id ?? null,
      existingAssetModelDescription: existingModel?.description ?? null,
      existingAssetModelImageUrl: existingModel?.imageUrl ?? null,
      existingAssetModelThumbnailUrl: existingModel?.thumbnailUrl ?? null,
      assetModelDescription,
      assetModelDescriptionSource,
      productImageProposal,
    });
  }

  return { rows: enrichedRows, diagnostics };
}
