import sharp from "sharp";
import { ASSET_MAX_IMAGE_UPLOAD_SIZE } from "~/utils/constants";
import { detectImageFormat } from "~/utils/image-format.server";
import { assertSafeUrl, safeFetch } from "~/utils/ssrf.server";

// Shelf's canonical asset-image pipeline accepts up to 8 MB and then resizes.
// Keep the external fetch bounded at that same ceiling, then produce a much
// smaller static WebP proposal preview (also the bytes sent to canonical Apply).
export const IMPORT_IMAGE_SOURCE_MAX_BYTES = ASSET_MAX_IMAGE_UPLOAD_SIZE;
const IMAGE_PREVIEW_MAX_BYTES = 128 * 1024;
const MANUAL_IMAGE_PREVIEW_MAX_BYTES = 64 * 1024;
const OPENVERSE_RESPONSE_MAX_BYTES = 256 * 1024;
const PRODUCT_PAGE_MAX_BYTES = 2 * 1024 * 1024;
const PRODUCT_SEARCH_RESPONSE_MAX_BYTES = 512 * 1024;
const IMAGE_LOOKUP_TIMEOUT_MS = 5_000;
const IMAGE_LOOKUP_CONCURRENCY = 6;
const MAX_OPENVERSE_CANDIDATES = 5;
const MAX_PRODUCT_SEARCH_RESULTS = 5;
const MAX_PRODUCT_PAGES_TO_INSPECT = 3;

export type ImportProductImageStatus =
  | "IMAGE_FOUND"
  | "IMAGE_NOT_FOUND"
  | "IMAGE_TOO_LARGE"
  | "IMAGE_INVALID_TYPE"
  | "IMAGE_FETCH_FAILED"
  | "IMAGE_AMBIGUOUS"
  | "IMAGE_SEARCH_PROVIDER_UNAVAILABLE"
  | "IMAGE_PRESERVED"
  | "IMAGE_TOO_LARGE_TO_PROCESS"
  | "IMAGE_UNSUPPORTED_FORMAT";

export type ImportProductImageSource =
  | "SOURCE_DOCUMENT"
  | "MANUFACTURER"
  | "SUPPLIER"
  | "DISTRIBUTOR"
  | "OTHER_PRODUCT_PAGE"
  | "OPENVERSE"
  | "MANUAL_UPLOAD";

export type ImportProductDescriptionSource =
  | "SOURCE"
  | "SHELF_EXISTING"
  | "GENERATED"
  | "NONE";

export type ImportImageFailureReason =
  | "SEARCH_PROVIDER_NOT_CONFIGURED"
  | "SEARCH_FAILED"
  | "SEARCH_NO_RESULTS"
  | "NO_TRUSTED_PRODUCT_MATCH"
  | "NO_PRODUCT_IMAGE_METADATA"
  | "IMAGE_DOWNLOAD_FAILED"
  | "IMAGE_TOO_LARGE"
  | "IMAGE_PROCESSING_FAILED"
  | "PROPOSAL_IMAGE_PERSIST_FAILED"
  | "APPLY_IMAGE_UPLOAD_FAILED"
  | "IDENTITY_MISMATCH";
export type ImportImageAttempt = {
  productIdentityBuilt: boolean;
  searchAttempted: boolean;
  searchProvider: string;
  searchResultCount: number;
  fallbackSearchAttempted?: boolean;
  fallbackSearchResultCount?: number;
  selectedProductPage?: string;
  imageMetadataFound: boolean;
  imageDownloadAttempted: boolean;
  downloadBytes: number;
  imageProcessed: boolean;
  finalBytes: number;
  proposalImageStored?: boolean;
  failureReason?: ImportImageFailureReason;
  identityMismatchFound?: boolean;
};

export type ImportProductImageProposal = {
  status: ImportProductImageStatus;
  mimeType?: "image/webp";
  dataBase64?: string;
  imageId?: string;
  failureReason?: ImportImageFailureReason;
  attempt?: ImportImageAttempt;
  sourceName?: string;
  sourceUrl?: string;
  license?: string;
  source?: ImportProductImageSource;
  sourceDomain?: string;
  identityEvidence?:
    | "EXACT_MPN"
    | "EXACT_SUPPLIER_SKU"
    | "MODEL_AND_MANUFACTURER";
  autoAccepted?: boolean;
};

export type ImportProductEnrichmentRow = {
  rowNumber: number;
  title: string;
  manufacturer?: string | null;
  manufacturerPartNumber?: string | null;
  supplierPartNumber?: string | null;
  supplierName?: string | null;
  productUrl?: string | null;
  productImageUrl?: string | null;
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

type ImageCandidate = {
  url: string;
  title?: string;
  sourceUrl?: string;
  sourceName?: string;
  source?: ImportProductImageSource;
  license?: string;
  width?: number;
  height?: number;
  foreign_landing_url?: string;
  sourceDomain?: string;
  identityEvidence?: ImportProductImageProposal["identityEvidence"];
};

export type ProductSearchPageCandidate = {
  productPageUrl: string;
  title: string;
  description: string;
  sourceDomain: string;
};

export interface ProductSearchProvider {
  readonly name?: string;
  search(query: string, limit: number): Promise<ProductSearchPageCandidate[]>;
}

type OpenverseResponse = { results?: unknown };

export type ProductEnrichmentDiagnostics = {
  newModels: number;
  existingModelsWithImage: number;
  imageLookupAttempted: number;
  imageCandidatesConsidered: number;
  imageAccepted: number;
  imageLookupSucceeded: number;
  imageLookupFailed: number;
  imageSourceDocument: number;
  imageSourceManufacturer: number;
  imageSourceSupplier: number;
  imageProcessed: number;
  imageFinalBytes: number;
  imageMissing: number;
  imageRejectedReason: Record<string, number>;
  descriptionGenerated: number;
  descriptionSource: Record<ImportProductDescriptionSource, number>;
  searchProviderConfigured?: boolean;
};

export async function processStaffImportImageUpload(
  bytes: Buffer,
  contentType: string
): Promise<ImportProductImageProposal> {
  const mime = contentType.split(";")[0]?.trim().toLowerCase();
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > IMPORT_IMAGE_SOURCE_MAX_BYTES ||
    !["image/jpeg", "image/png", "image/webp"].includes(mime ?? "") ||
    detectImageFormat(bytes) !== mime
  ) {
    throw new Error(
      `Choose a JPEG, PNG, or WebP image up to ${
        IMPORT_IMAGE_SOURCE_MAX_BYTES / (1024 * 1024)
      } MB.`
    );
  }
  try {
    const image = sharp(bytes, {
      limitInputPixels: 40_000_000,
      animated: false,
    });
    const metadata = await image.metadata();
    if (
      !metadata.width ||
      !metadata.height ||
      metadata.width < 32 ||
      metadata.height < 32 ||
      metadata.width * metadata.height > 40_000_000
    ) {
      throw new Error("Image dimensions are not supported.");
    }
    for (const [size, quality] of [
      [640, 75],
      [512, 68],
      [384, 60],
      [256, 52],
    ] as const) {
      const processed = await image
        .clone()
        .resize({
          width: size,
          height: size,
          fit: "inside",
          withoutEnlargement: true,
        })
        .webp({ quality, effort: 4 })
        .toBuffer();
      if (processed.byteLength <= MANUAL_IMAGE_PREVIEW_MAX_BYTES) {
        if (processed.byteLength > 2 * 1024 * 1024) {
          throw new Error("Processed image exceeds Shelf's 2 MB image limit.");
        }
        return {
          status: "IMAGE_FOUND",
          mimeType: "image/webp",
          dataBase64: processed.toString("base64"),
          sourceName: "Manual upload",
          source: "MANUAL_UPLOAD",
          autoAccepted: true,
        };
      }
    }
    throw new Error("Image could not be reduced to the import size limit.");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Image "))
      throw error;
    throw new Error("This file could not be processed as an image.");
  }
}

export function normalizeProductEvidence(value: string | null | undefined) {
  return (value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function imageIdentityCacheKey(row: ImportProductEnrichmentRow) {
  return [
    row.manufacturer,
    row.title,
    row.manufacturerPartNumber,
    meaningfulSupplierSku(row),
  ]
    .map((value) => normalizeProductEvidence(value))
    .join("|");
}

function safeDisplayUrl(value: string | undefined) {
  if (!value || !isAllowedProductHost(value)) return undefined;
  const url = new URL(value);
  url.search = "";
  url.hash = "";
  return url.href.slice(0, 2_000);
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
      (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password &&
      !url.hostname.endsWith(".")
    );
  } catch {
    return false;
  }
}

const SOCIAL_HOST =
  /(?:^|\.)(?:facebook|instagram|tiktok|pinterest|x|twitter|threads|youtube|youtu|reddit|snapchat|linkedin)\./i;

function isAllowedProductHost(value: string) {
  try {
    const url = new URL(value);
    if (!isHttpUrl(value) || SOCIAL_HOST.test(url.hostname)) return false;
    assertSafeUrl(value);
    return true;
  } catch {
    return false;
  }
}

function domainsFromEnvironment(name: string) {
  return (process.env[name] ?? "")
    .split(",")
    .map((domain) =>
      domain
        .trim()
        .toLowerCase()
        .replace(/^\.+|\.+$/g, "")
    )
    .filter((domain) => /^[a-z0-9.-]+$/.test(domain));
}

function matchesConfiguredDomain(hostname: string, domain: string) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function configuredManufacturerDomains(
  manufacturer: string | null | undefined
) {
  const raw = process.env.IOIO_PRODUCT_IMAGE_MANUFACTURER_DOMAINS;
  if (!raw || !manufacturer) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return [];
    const record = parsed as Record<string, unknown>;
    const key = normalizeProductEvidence(manufacturer);
    const entry = Object.entries(record).find(
      ([name]) => normalizeProductEvidence(name) === key
    )?.[1];
    const values = typeof entry === "string" ? [entry] : entry;
    return Array.isArray(values)
      ? values
          .filter((value): value is string => typeof value === "string")
          .map((domain) =>
            domain
              .trim()
              .toLowerCase()
              .replace(/^\.+|\.+$/g, "")
          )
          .filter((domain) => /^[a-z0-9.-]+$/.test(domain))
      : [];
  } catch {
    return [];
  }
}

function manufacturerDomainMatches(
  url: string,
  manufacturer: string | null | undefined
) {
  if (!manufacturer) return false;
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    if (
      configuredManufacturerDomains(manufacturer).some((domain) =>
        matchesConfiguredDomain(hostname, domain)
      )
    ) {
      return true;
    }
    const manufacturerSlug = normalizeProductEvidence(manufacturer).replace(
      /\s/g,
      ""
    );
    const domainBrandLabel = hostname.split(".").at(-2);
    return Boolean(
      manufacturerSlug.length >= 3 && domainBrandLabel === manufacturerSlug
    );
  } catch {
    return false;
  }
}

function productPageSource(
  url: string,
  row: ImportProductEnrichmentRow
): ImportProductImageSource {
  if (manufacturerDomainMatches(url, row.manufacturer)) return "MANUFACTURER";
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    if (
      domainsFromEnvironment(
        "IOIO_PRODUCT_IMAGE_TRUSTED_DISTRIBUTOR_DOMAINS"
      ).some((domain) => matchesConfiguredDomain(hostname, domain))
    ) {
      return "DISTRIBUTOR";
    }
    const supplierSlug = normalizeProductEvidence(row.supplierName).replace(
      /\s/g,
      ""
    );
    const domainSupplierLabel = hostname.split(".").at(-2);
    if (supplierSlug.length >= 3 && domainSupplierLabel === supplierSlug) {
      return "SUPPLIER";
    }
  } catch {
    // The URL is checked by `isAllowedProductHost` before classification.
  }
  return "OTHER_PRODUCT_PAGE";
}

function meaningfulSupplierSku(row: ImportProductEnrichmentRow) {
  const value = row.supplierPartNumber?.trim() ?? "";
  return /^[a-z0-9][a-z0-9._/-]{3,39}$/i.test(value) ? value : "";
}

function productNameForSearch(row: ImportProductEnrichmentRow) {
  const name = row.title.trim();
  const manufacturer = row.manufacturer?.trim();
  if (!manufacturer) return name;
  const escapedManufacturer = manufacturer.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );
  return name
    .replace(new RegExp(`^${escapedManufacturer}[\\s:/-]+`, "i"), "")
    .trim();
}

export function buildProductSearchQueries(row: ImportProductEnrichmentRow) {
  const manufacturer = row.manufacturer?.trim() ?? "";
  const productName = productNameForSearch(row);
  const mpn = row.manufacturerPartNumber?.trim() ?? "";
  const supplierSku = meaningfulSupplierSku(row);
  const exactPartNumber = mpn || supplierSku;
  const description = isUsableDescription(row.sourceDescription) ?? "";
  return [
    manufacturer && exactPartNumber ? `${manufacturer} ${exactPartNumber}` : "",
    manufacturer && productName ? `${manufacturer} ${productName}` : "",
    exactPartNumber,
    manufacturer && description ? `${manufacturer} ${description}` : "",
  ]
    .map((query) => query.replace(/\s+/g, " ").trim().slice(0, 300))
    .filter(
      (query, index, values) =>
        Boolean(query) && values.indexOf(query) === index
    );
}

type BraveWebSearchResponse = { web?: { results?: unknown } };

export class BraveProductSearchProvider implements ProductSearchProvider {
  readonly name = "BRAVE_WEB_SEARCH";
  constructor(private readonly apiKey: string) {}

  async search(query: string, limit: number) {
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", query.slice(0, 400));
    url.searchParams.set(
      "count",
      String(Math.min(MAX_PRODUCT_SEARCH_RESULTS, Math.max(1, limit)))
    );
    url.searchParams.set("country", "DK");
    url.searchParams.set("search_lang", "en");
    const response = await safeFetch(url.href, {
      maxBytes: PRODUCT_SEARCH_RESPONSE_MAX_BYTES,
      timeoutMs: IMAGE_LOOKUP_TIMEOUT_MS,
      headers: {
        accept: "application/json",
        "x-subscription-token": this.apiKey,
      },
    });
    if (!/^application\/json(?:;|$)/i.test(response.contentType)) {
      throw new Error("Product search returned an unsupported content type.");
    }
    let body: BraveWebSearchResponse;
    try {
      body = JSON.parse(
        response.buffer.toString("utf8")
      ) as BraveWebSearchResponse;
    } catch {
      throw new Error("Product search returned invalid JSON.");
    }
    const results = body.web?.results;
    if (!Array.isArray(results)) return [];
    return results
      .slice(0, MAX_PRODUCT_SEARCH_RESULTS)
      .flatMap((value): ProductSearchPageCandidate[] => {
        if (!value || typeof value !== "object") return [];
        const result = value as Record<string, unknown>;
        if (
          typeof result.url !== "string" ||
          !isAllowedProductHost(result.url) ||
          typeof result.title !== "string"
        ) {
          return [];
        }
        return [
          {
            productPageUrl: result.url,
            title: result.title.slice(0, 300),
            description:
              typeof result.description === "string"
                ? result.description.slice(0, 600)
                : "",
            sourceDomain: new URL(result.url).hostname.toLowerCase(),
          },
        ];
      });
  }
}

export function createProductSearchProvider(): ProductSearchProvider | null {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY?.trim();
  return apiKey ? new BraveProductSearchProvider(apiKey) : null;
}

function productHostMatchesManufacturer(
  value: string,
  manufacturer?: string | null
) {
  return manufacturerDomainMatches(value, manufacturer);
}

function identityIsClear(row: ImportProductEnrichmentRow) {
  const name = normalizeProductEvidence(row.title);
  const manufacturer = normalizeProductEvidence(row.manufacturer);
  const mpn = normalizeProductEvidence(row.manufacturerPartNumber);
  return Boolean(
    name.length >= 3 &&
      ((manufacturer && name.split(" ").length >= 2) || mpn.length >= 3)
  );
}

function exactIdentityMatch(
  row: ImportProductEnrichmentRow,
  fields: { name?: string; manufacturer?: string; mpn?: string; sku?: string }
) {
  const name = normalizeProductEvidence(row.title);
  const manufacturer = normalizeProductEvidence(row.manufacturer);
  const mpn = normalizeProductEvidence(row.manufacturerPartNumber);
  const supplierSku = normalizeProductEvidence(meaningfulSupplierSku(row));
  const modelName =
    manufacturer && name.startsWith(`${manufacturer} `)
      ? name.slice(manufacturer.length + 1)
      : name;
  const metadata = normalizeProductEvidence(
    [fields.name, fields.manufacturer, fields.mpn, fields.sku]
      .filter(Boolean)
      .join(" ")
  );
  const actualManufacturer = normalizeProductEvidence(fields.manufacturer);
  const actualMpn = normalizeProductEvidence(fields.mpn);
  const actualSku = normalizeProductEvidence(fields.sku);
  const hasManufacturer = Boolean(
    manufacturer && actualManufacturer.includes(manufacturer)
  );
  const hasMpn = Boolean(
    mpn && (actualMpn === mpn || (!actualMpn && actualSku === mpn))
  );
  const hasExactSku = Boolean(supplierSku && actualSku === supplierSku);
  const normalizedFieldName = normalizeProductEvidence(fields.name);
  const hasExactName = Boolean(
    normalizedFieldName &&
      [name, modelName].some(
        (candidate) => candidate && normalizedFieldName === candidate
      )
  );

  const compactModel = modelName.replace(/\s/g, "");
  if (
    (hasMpn || hasExactSku) &&
    normalizedFieldName &&
    compactModel &&
    !normalizedFieldName.replace(/\s/g, "").includes(compactModel)
  )
    return 0;
  if (mpn && actualMpn && actualMpn !== mpn) return 0;
  if (
    mpn &&
    !actualMpn &&
    actualSku &&
    actualSku !== mpn &&
    actualSku !== supplierSku
  )
    return 0;
  if (mpn && hasMpn && (!actualManufacturer || hasManufacturer)) return 1;
  if (hasExactSku && (!actualManufacturer || hasManufacturer)) return 0.98;
  if (hasExactName && manufacturer && hasManufacturer) return 0.95;
  // A source-supplied product URL is already associated with the row, but a
  // fetched page still must independently identify the same model.
  if (hasExactName && !manufacturer && fields.name) return 0.82;
  return metadata &&
    (metadata.includes(name) || metadata.includes(modelName)) &&
    hasManufacturer
    ? 0.9
    : 0;
}

function containsExactProductCode(values: string[], code: string) {
  const escaped = code
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s+");
  if (!escaped) return false;
  return values.some((value) =>
    new RegExp(`(?:^|[^A-Za-z0-9])${escaped}(?![A-Za-z0-9_-])`, "i").test(value)
  );
}

function decodeProductHtml(value: string) {
  return value
    .replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (entity, code: string) => {
      const point =
        code[0].toLowerCase() === "x"
          ? parseInt(code.slice(1), 16)
          : parseInt(code, 10);
      return point > 0 &&
        point <= 0x10ffff &&
        !(point >= 0xd800 && point <= 0xdfff)
        ? String.fromCodePoint(point)
        : entity;
    })
    .replace(
      /&(amp|quot|apos|lt|gt|nbsp);/gi,
      (entity, name: string) =>
        (
          ({
            amp: "&",
            quot: '"',
            apos: "'",
            lt: "<",
            gt: ">",
            nbsp: " ",
          }) as Record<string, string>
        )[name.toLowerCase()] ?? entity
    );
}

/** Escape raw control characters inside JSON strings; never evaluate page scripts. */
function parseProductJsonLd(source: string): unknown {
  let quoted = false;
  let escaped = false;
  let normalized = "";
  for (const char of source) {
    if (quoted && char.charCodeAt(0) < 32)
      normalized += `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
    else normalized += char;
    if (char === '"' && !escaped) quoted = !quoted;
    escaped = char === "\\" && !escaped;
  }
  return JSON.parse(normalized.trim());
}

function readHtmlAttribute(tag: string, attribute: string) {
  const escaped = attribute.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return decodeProductHtml(
    tag
      .match(
        new RegExp(
          `\\b${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
          "i"
        )
      )
      ?.slice(1)
      .find(Boolean) ?? ""
  ).trim();
}

function productImageUrl(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const result = productImageUrl(item);
      if (result) return result;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  return typeof item.url === "string"
    ? item.url
    : typeof item.contentUrl === "string"
    ? item.contentUrl
    : undefined;
}

function parseProductPage(
  html: string,
  pageUrl: string,
  row: ImportProductEnrichmentRow
) {
  const metadata: string[] = [];
  let pageManufacturer = "";
  let pageTitle = "";
  const images: string[] = [];
  for (const tagMatch of html.matchAll(/<(?:meta|link)\b[^>]*>/gi)) {
    const tag = tagMatch[0];
    const property = readHtmlAttribute(tag, "property").toLowerCase();
    const name = readHtmlAttribute(tag, "name").toLowerCase();
    const itemprop = readHtmlAttribute(tag, "itemprop").toLowerCase();
    const content =
      readHtmlAttribute(tag, "content") || readHtmlAttribute(tag, "href");
    if (!content) continue;
    if (["og:title", "twitter:title"].includes(property) || name === "title") {
      pageTitle ||= content;
    }
    if (["product:brand", "brand"].includes(property) || name === "brand") {
      pageManufacturer ||= content;
    }
    if (["name", "brand", "mpn", "sku"].includes(itemprop))
      metadata.push(content);
    if (
      ["og:image", "og:image:url", "twitter:image"].includes(property) ||
      ["image"].includes(itemprop)
    )
      images.push(content);
  }
  const products: Array<{
    name?: string;
    manufacturer?: string;
    mpn?: string;
    sku?: string;
    image?: string;
  }> = [];
  for (const scriptMatch of html.matchAll(
    /<script\b([^>]*)>([\s\S]*?)<\/script>/gi
  )) {
    const tag = scriptMatch[1];
    if (!/application\/ld\+json/i.test(readHtmlAttribute(tag, "type")))
      continue;
    try {
      const parsed: unknown = parseProductJsonLd(scriptMatch[2]);
      const visit = (value: unknown) => {
        if (Array.isArray(value)) return value.forEach(visit);
        if (!value || typeof value !== "object") return;
        const item = value as Record<string, unknown>;
        const types = Array.isArray(item["@type"])
          ? item["@type"]
          : [item["@type"]];
        if (
          types.some(
            (type) =>
              typeof type === "string" && type.toLowerCase() === "product"
          )
        ) {
          const brandValue = item.brand;
          const brand =
            typeof brandValue === "string"
              ? brandValue
              : brandValue &&
                typeof brandValue === "object" &&
                "name" in brandValue
              ? String(brandValue.name)
              : "";
          const image = productImageUrl(item.image);
          products.push({
            name:
              typeof item.name === "string"
                ? decodeProductHtml(item.name)
                : undefined,
            manufacturer: brand
              ? decodeProductHtml(brand)
              : productHostMatchesManufacturer(pageUrl, row.manufacturer)
              ? row.manufacturer ?? undefined
              : undefined,
            mpn: typeof item.mpn === "string" ? item.mpn : undefined,
            sku: typeof item.sku === "string" ? item.sku : undefined,
            image,
          });
        }
        if (item["@graph"]) visit(item["@graph"]);
      };
      visit(parsed);
    } catch {
      // Malformed JSON-LD is ignored; the page is never executed.
    }
  }
  const structured = products.find(
    (product) => exactIdentityMatch(row, product) >= 0.9
  );
  const pageManufacturerEvidence =
    pageManufacturer ||
    (productHostMatchesManufacturer(pageUrl, row.manufacturer)
      ? row.manufacturer ?? ""
      : "");
  const pageIdentityMatches =
    exactIdentityMatch(row, {
      name: pageTitle || metadata.join(" "),
      manufacturer: pageManufacturerEvidence || undefined,
    }) >= 0.9;
  const candidates = [
    ...(structured?.image ? [structured.image] : []),
    ...(pageIdentityMatches ? images : []),
  ].filter((value): value is string => Boolean(value));
  return {
    identityConflict: products.some((product) => {
      const matchingCode =
        row.manufacturerPartNumber &&
        normalizeProductEvidence(product.mpn || product.sku) ===
          normalizeProductEvidence(row.manufacturerPartNumber);
      const matchingName = normalizeProductEvidence(product.name)
        .replace(/\s/g, "")
        .includes(
          normalizeProductEvidence(productNameForSearch(row)).replace(/\s/g, "")
        );
      return (
        (matchingCode || matchingName) && exactIdentityMatch(row, product) === 0
      );
    }),
    metadata: [pageTitle, pageManufacturer, ...metadata]
      .filter(Boolean)
      .join(" "),
    pageTitle,
    structured,
    imageUrls: [...new Set(candidates)]
      .slice(0, 10)
      .map((image) => {
        try {
          return new URL(image, pageUrl).href;
        } catch {
          return "";
        }
      })
      .filter(Boolean),
  };
}

function identityMatchScore(
  row: ImportProductEnrichmentRow,
  result: OpenverseImageResult
) {
  const tags = Array.isArray(result.tags)
    ? result.tags
        .slice(0, 30)
        .flatMap((tag) =>
          tag && typeof tag === "object" && "name" in tag
            ? [String(tag.name)]
            : []
        )
    : [];
  const metadata = [result.title, result.creator, ...tags]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  const mpn = normalizeProductEvidence(row.manufacturerPartNumber);
  const normalizedMetadata = normalizeProductEvidence(metadata);
  const rawIdentityFields = [result.title, result.creator, ...tags].filter(
    (value): value is string => typeof value === "string"
  );
  const hasMpn = Boolean(
    mpn.length >= 3 &&
      containsExactProductCode(
        rawIdentityFields,
        row.manufacturerPartNumber ?? ""
      )
  );
  const manufacturer = normalizeProductEvidence(row.manufacturer);
  const hasManufacturer = Boolean(
    manufacturer && normalizedMetadata.includes(manufacturer)
  );
  const name = normalizeProductEvidence(row.title);
  const hasExactName = Boolean(name && normalizedMetadata.includes(name));
  const modelName =
    manufacturer && name.startsWith(`${manufacturer} `)
      ? name.slice(manufacturer.length + 1)
      : name;
  const hasModel = Boolean(
    modelName &&
      normalizedMetadata
        .replace(/\s/g, "")
        .includes(modelName.replace(/\s/g, ""))
  );
  const titleIdentity = normalizeProductEvidence(
    typeof result.title === "string" ? result.title : undefined
  );
  const titleIsExactCode = Boolean(
    mpn &&
      (titleIdentity === mpn ||
        (manufacturer && titleIdentity === `${manufacturer} ${mpn}`))
  );
  // A weak image-library fallback must not override the product's model/variant.
  if (mpn.length >= 3)
    return hasMpn &&
      (hasModel || (titleIsExactCode && (!manufacturer || hasManufacturer)))
      ? 1
      : 0;
  if (hasExactName && manufacturer && hasManufacturer) return 0.95;
  return 0;
}

function searchResultRelevance(
  row: ImportProductEnrichmentRow,
  candidate: ProductSearchPageCandidate
) {
  const evidence = [
    candidate.title,
    candidate.description,
    candidate.productPageUrl,
  ];
  const mpn = row.manufacturerPartNumber?.trim() ?? "";
  if (mpn && containsExactProductCode(evidence, mpn)) return 4;
  const supplierSku = meaningfulSupplierSku(row);
  if (supplierSku && containsExactProductCode(evidence, supplierSku)) return 3;

  const metadata = normalizeProductEvidence(evidence.join(" "));
  const name = normalizeProductEvidence(row.title);
  const manufacturer = normalizeProductEvidence(row.manufacturer);
  const modelName =
    manufacturer && name.startsWith(`${manufacturer} `)
      ? name.slice(manufacturer.length + 1)
      : name;
  const hasManufacturer = Boolean(
    (manufacturer && metadata.includes(manufacturer)) ||
      manufacturerDomainMatches(candidate.productPageUrl, row.manufacturer)
  );
  if (
    modelName.length >= 3 &&
    metadata.includes(modelName) &&
    hasManufacturer
  ) {
    return 2;
  }
  if (
    modelName.length >= 3 &&
    metadata.includes(modelName) &&
    manufacturerDomainMatches(candidate.productPageUrl, row.manufacturer)
  ) {
    return 1;
  }
  return 0;
}

function productPageSourcePriority(source: ImportProductImageSource) {
  switch (source) {
    case "MANUFACTURER":
      return 0;
    case "DISTRIBUTOR":
      return 1;
    case "SUPPLIER":
      return 2;
    default:
      return 3;
  }
}

async function lookupSearchProviderProductImage(
  row: ImportProductEnrichmentRow,
  provider: ProductSearchProvider,
  attempt: ImportImageAttempt
) {
  let candidatesConsidered = 0;
  const inspectedPages = new Set<string>();
  let bestImage:
    | {
        image: Exclude<
          Awaited<ReturnType<typeof lookupProductPageImage>>,
          null
        >;
        sourcePriority: number;
        attempt: ImportImageAttempt;
      }
    | undefined;
  for (const query of buildProductSearchQueries(row)) {
    attempt.searchAttempted = true;
    let results: ProductSearchPageCandidate[];
    try {
      results = await provider.search(query, MAX_PRODUCT_SEARCH_RESULTS);
    } catch {
      attempt.failureReason = "SEARCH_FAILED";
      continue;
    }
    attempt.searchResultCount += results.length;
    const candidates = results
      .filter((candidate) => isAllowedProductHost(candidate.productPageUrl))
      .map((candidate) => ({
        candidate,
        relevance: searchResultRelevance(row, candidate),
      }))
      .filter(({ relevance }) => relevance > 0)
      .sort((left, right) => {
        const sourcePriorityDifference =
          productPageSourcePriority(
            productPageSource(left.candidate.productPageUrl, row)
          ) -
          productPageSourcePriority(
            productPageSource(right.candidate.productPageUrl, row)
          );
        return sourcePriorityDifference || right.relevance - left.relevance;
      })
      .slice(0, MAX_PRODUCT_PAGES_TO_INSPECT);
    for (const { candidate } of candidates) {
      if (inspectedPages.has(candidate.productPageUrl)) continue;
      inspectedPages.add(candidate.productPageUrl);
      candidatesConsidered += 1;
      const image = await lookupProductPageImage(row, candidate, attempt);
      if (image?.status === "IMAGE_FOUND") {
        const sourcePriority = productPageSourcePriority(
          productPageSource(candidate.productPageUrl, row)
        );
        if (!bestImage || sourcePriority < bestImage.sourcePriority) {
          bestImage = { image, sourcePriority, attempt: { ...attempt } };
        }
        // Manufacturer pages outrank every other source class. Continue to
        // later queries only while a better source can still be discovered.
        if (sourcePriority === 0) {
          return { ...image, candidatesConsidered };
        }
      }
    }
  }
  if (bestImage) {
    const searchResultCount = attempt.searchResultCount;
    Object.assign(attempt, bestImage.attempt, { searchResultCount });
    delete attempt.failureReason;
    return { ...bestImage.image, candidatesConsidered };
  }
  attempt.failureReason ??= attempt.searchResultCount
    ? "NO_TRUSTED_PRODUCT_MATCH"
    : "SEARCH_NO_RESULTS";
  return { status: "IMAGE_NOT_FOUND" as const, candidatesConsidered };
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
  const identity = [
    row.manufacturer,
    row.title,
    row.manufacturerPartNumber,
    meaningfulSupplierSku(row),
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

async function validateAndNormalizeImage(
  candidate: ImageCandidate,
  attempt?: ImportImageAttempt
) {
  if (
    /(?:^|[/_.-])(?:logo|banner|favicon|sprite|icon)(?:[/_.-]|$)/i.test(
      candidate.url
    )
  ) {
    if (attempt) attempt.failureReason = "NO_PRODUCT_IMAGE_METADATA";
    return { status: "IMAGE_AMBIGUOUS" as const };
  }
  if (!isAllowedProductHost(candidate.url)) {
    return { status: "IMAGE_INVALID_TYPE" as const };
  }
  if (
    (typeof candidate.width === "number" && candidate.width < 100) ||
    (typeof candidate.height === "number" && candidate.height < 100) ||
    (typeof candidate.width === "number" &&
      typeof candidate.height === "number" &&
      candidate.width * candidate.height > 40_000_000)
  ) {
    return { status: "IMAGE_AMBIGUOUS" as const };
  }

  let fetched: Awaited<ReturnType<typeof safeFetch>>;
  try {
    if (attempt) attempt.imageDownloadAttempted = true;
    fetched = await safeFetch(candidate.url, {
      maxBytes: IMPORT_IMAGE_SOURCE_MAX_BYTES,
      timeoutMs: IMAGE_LOOKUP_TIMEOUT_MS,
    });
  } catch (error) {
    if (attempt)
      attempt.failureReason =
        getFailureStatus(error) === "IMAGE_TOO_LARGE"
          ? "IMAGE_TOO_LARGE"
          : "IMAGE_DOWNLOAD_FAILED";
    return { status: getFailureStatus(error) };
  }
  if (attempt) attempt.downloadBytes = fetched.buffer.byteLength;
  if (fetched.buffer.byteLength > IMPORT_IMAGE_SOURCE_MAX_BYTES) {
    if (attempt) attempt.failureReason = "IMAGE_TOO_LARGE";
    return { status: "IMAGE_TOO_LARGE" as const };
  }
  const detectedMime = detectImageFormat(fetched.buffer);
  const contentMime = fetched.contentType.split(";")[0]?.trim().toLowerCase();
  if (
    !["image/jpeg", "image/png", "image/webp"].includes(contentMime ?? "") ||
    !detectedMime ||
    detectedMime !== contentMime
  ) {
    if (attempt) attempt.failureReason = "IMAGE_PROCESSING_FAILED";
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
      metadata.height < 100 ||
      metadata.width * metadata.height > 40_000_000
    ) {
      return { status: "IMAGE_AMBIGUOUS" as const };
    }
    let preview: Buffer | null = null;
    for (const [size, quality] of [
      [640, 75],
      [512, 68],
      [384, 60],
      [256, 52],
    ] as const) {
      const processed = await image
        .clone()
        .resize({
          width: size,
          height: size,
          fit: "inside",
          withoutEnlargement: true,
        })
        .webp({ quality, effort: 4 })
        .toBuffer();
      if (processed.byteLength <= IMAGE_PREVIEW_MAX_BYTES) {
        preview = processed;
        break;
      }
    }
    if (!preview || preview.byteLength > 2 * 1024 * 1024) {
      if (attempt) attempt.failureReason = "IMAGE_PROCESSING_FAILED";
      return { status: "IMAGE_TOO_LARGE_TO_PROCESS" as const };
    }
    if (attempt) {
      attempt.imageProcessed = true;
      attempt.finalBytes = preview.byteLength;
      delete attempt.failureReason;
    }
    return {
      status: "IMAGE_FOUND" as const,
      mimeType: "image/webp" as const,
      dataBase64: preview.toString("base64"),
      sourceName: (
        candidate.sourceName ??
        candidate.title ??
        "Product image"
      ).slice(0, 200),
      sourceUrl: safeDisplayUrl(
        candidate.sourceUrl ?? candidate.foreign_landing_url
      ),
      license:
        typeof candidate.license === "string"
          ? candidate.license.slice(0, 40)
          : undefined,
      source: candidate.source,
      sourceDomain:
        candidate.sourceDomain ?? new URL(candidate.url).hostname.toLowerCase(),
      identityEvidence: candidate.identityEvidence,
      autoAccepted: true,
    };
  } catch {
    if (attempt) attempt.failureReason = "IMAGE_PROCESSING_FAILED";
    return { status: "IMAGE_INVALID_TYPE" as const };
  }
}

async function lookupProductPageImage(
  row: ImportProductEnrichmentRow,
  searchCandidate?: ProductSearchPageCandidate,
  attempt?: ImportImageAttempt
) {
  const pageUrl = searchCandidate?.productPageUrl ?? row.productUrl;
  if (!pageUrl || !isAllowedProductHost(pageUrl)) return null;
  try {
    const response = await safeFetch(pageUrl, {
      maxBytes: PRODUCT_PAGE_MAX_BYTES,
      timeoutMs: IMAGE_LOOKUP_TIMEOUT_MS,
    });
    const contentType = response.contentType
      .split(";")[0]
      ?.trim()
      .toLowerCase();
    if (
      contentType !== "text/html" &&
      contentType !== "application/xhtml+xml"
    ) {
      return null;
    }
    const html = response.buffer.toString("utf8");
    const productPage = parseProductPage(html, pageUrl, row);
    if (productPage.identityConflict) {
      if (attempt) {
        attempt.failureReason = "IDENTITY_MISMATCH";
        attempt.identityMismatchFound = true;
      }
      return null;
    }
    const structuredIdentity = productPage.structured
      ? exactIdentityMatch(row, productPage.structured)
      : 0;
    const titleIdentity = exactIdentityMatch(row, {
      name: productPage.metadata,
      manufacturer: normalizeProductEvidence(productPage.metadata).includes(
        normalizeProductEvidence(row.manufacturer)
      )
        ? row.manufacturer ?? undefined
        : undefined,
    });
    if (structuredIdentity < 0.9 && titleIdentity < 0.9) {
      if (attempt) attempt.failureReason = "NO_TRUSTED_PRODUCT_MATCH";
      return null;
    }
    if (attempt) attempt.selectedProductPage = safeDisplayUrl(pageUrl);
    const candidateUrl = productPage.imageUrls.find(isAllowedProductHost);
    if (!candidateUrl) {
      if (attempt) attempt.failureReason = "NO_PRODUCT_IMAGE_METADATA";
      return null;
    }
    if (attempt) attempt.imageMetadataFound = true;
    const pageSource = productPageSource(pageUrl, row);
    const rowMpn = normalizeProductEvidence(row.manufacturerPartNumber);
    const rowSupplierSku = normalizeProductEvidence(meaningfulSupplierSku(row));
    const identityEvidence =
      productPage.structured &&
      rowMpn &&
      normalizeProductEvidence(productPage.structured.mpn) === rowMpn
        ? "EXACT_MPN"
        : productPage.structured &&
          ((rowSupplierSku &&
            normalizeProductEvidence(productPage.structured.sku) ===
              rowSupplierSku) ||
            (rowMpn &&
              normalizeProductEvidence(productPage.structured.sku) === rowMpn))
        ? "EXACT_SUPPLIER_SKU"
        : "MODEL_AND_MANUFACTURER";
    return await validateAndNormalizeImage(
      {
        url: candidateUrl,
        sourceUrl: pageUrl,
        sourceName:
          searchCandidate?.title ||
          productPage.structured?.name ||
          productPage.pageTitle ||
          "Product page image",
        source: pageSource,
        sourceDomain: new URL(pageUrl).hostname.toLowerCase(),
        identityEvidence,
      },
      attempt
    );
  } catch {
    if (attempt) attempt.failureReason = "IMAGE_DOWNLOAD_FAILED";
    return { status: "IMAGE_FETCH_FAILED" as const };
  }
}

async function lookupProductImage(
  row: ImportProductEnrichmentRow,
  provider: ProductSearchProvider | null,
  attempt: ImportImageAttempt
) {
  if (!identityIsClear(row)) {
    attempt.failureReason = "NO_TRUSTED_PRODUCT_MATCH";
    return { status: "IMAGE_AMBIGUOUS" as const, candidatesConsidered: 0 };
  }

  const sourceUrls =
    `${row.sourceDescription ?? ""} ${row.title}`.match(
      /https?:\/\/[^\s<>"')\]]+/gi
    ) ?? [];
  const cleanedSourceUrls = sourceUrls.map((url) =>
    url.replace(/[.,;:!?]+$/, "")
  );
  const extractedImageUrl = cleanedSourceUrls.find((url) =>
    /\.(?:jpe?g|png|webp)(?:$|[?#])/i.test(url)
  );
  const extractedProductUrl = cleanedSourceUrls.find(
    (url) => !/\.(?:jpe?g|png|webp)(?:$|[?#])/i.test(url)
  );
  const productImageUrl = row.productImageUrl ?? extractedImageUrl;
  const productUrl = row.productUrl ?? extractedProductUrl;

  if (productImageUrl) {
    const sourceImage = await validateAndNormalizeImage(
      {
        url: productImageUrl,
        sourceUrl: productUrl,
        sourceName: "Image URL from source document",
        source: "SOURCE_DOCUMENT",
      },
      attempt
    );
    if (sourceImage.status === "IMAGE_FOUND") {
      return { ...sourceImage, candidatesConsidered: 1 };
    }
  }

  if (productUrl) {
    const pageImage = await lookupProductPageImage(
      { ...row, productUrl },
      undefined,
      attempt
    );
    if (pageImage?.status === "IMAGE_FOUND") {
      return { ...pageImage, candidatesConsidered: 1 };
    }
  }

  let searchProviderFailed = false;
  let candidatesConsidered = 0;
  if (provider) {
    try {
      const searchResult = await lookupSearchProviderProductImage(
        row,
        provider,
        attempt
      );
      candidatesConsidered += searchResult.candidatesConsidered;
      if (
        searchResult.status === "IMAGE_FOUND" &&
        !attempt.identityMismatchFound
      )
        return searchResult;
    } catch {
      searchProviderFailed = true;
      attempt.failureReason = "SEARCH_FAILED";
    }
  } else {
    attempt.failureReason = "SEARCH_PROVIDER_NOT_CONFIGURED";
  }

  if (attempt.identityMismatchFound) {
    attempt.failureReason = "IDENTITY_MISMATCH";
    return { status: "IMAGE_AMBIGUOUS" as const, candidatesConsidered };
  }
  let candidates: OpenverseImageResult[];
  try {
    attempt.fallbackSearchAttempted = true;
    candidates = await getOpenverseCandidates(row);
    attempt.fallbackSearchResultCount = candidates.length;
  } catch {
    return {
      status: searchProviderFailed
        ? ("IMAGE_SEARCH_PROVIDER_UNAVAILABLE" as const)
        : ("IMAGE_FETCH_FAILED" as const),
      candidatesConsidered,
    };
  }
  const likelyMatches = candidates
    .map((candidate) => ({
      candidate,
      score: identityMatchScore(row, candidate),
    }))
    .filter(({ score }) => score >= 0.95)
    .sort((a, b) => b.score - a.score);
  if (!candidates.length) {
    return {
      status:
        !provider || searchProviderFailed
          ? ("IMAGE_SEARCH_PROVIDER_UNAVAILABLE" as const)
          : ("IMAGE_NOT_FOUND" as const),
      candidatesConsidered,
    };
  }
  if (
    !likelyMatches.length ||
    (likelyMatches[1]?.score ?? 0) === likelyMatches[0]?.score
  ) {
    return {
      status: "IMAGE_AMBIGUOUS" as const,
      candidatesConsidered: candidatesConsidered + candidates.length,
    };
  }
  const selectedCandidate = likelyMatches[0].candidate;
  if (
    !isAllowedProductHost(String(selectedCandidate.url ?? "")) ||
    !isAllowedProductHost(String(selectedCandidate.foreign_landing_url ?? ""))
  ) {
    return {
      status: "IMAGE_AMBIGUOUS" as const,
      candidatesConsidered: candidatesConsidered + candidates.length,
    };
  }
  const result = await validateAndNormalizeImage(
    {
      url: String(selectedCandidate.url),
      sourceUrl: String(selectedCandidate.foreign_landing_url),
      sourceName:
        typeof selectedCandidate.title === "string"
          ? selectedCandidate.title
          : "Openverse image",
      source: "OPENVERSE",
      license:
        typeof selectedCandidate.license === "string"
          ? selectedCandidate.license
          : undefined,
      width:
        typeof selectedCandidate.width === "number"
          ? selectedCandidate.width
          : undefined,
      height:
        typeof selectedCandidate.height === "number"
          ? selectedCandidate.height
          : undefined,
    },
    attempt
  );
  return {
    ...result,
    candidatesConsidered: candidatesConsidered + candidates.length,
  };
}

export async function enrichImportProductRows<
  TRow extends ImportProductEnrichmentRow,
>(
  rows: TRow[],
  existingModels: ExistingImportAssetModel[],
  getIdentityKey?: (row: TRow) => string | undefined,
  productSearchProvider: ProductSearchProvider | null = createProductSearchProvider()
) {
  const diagnostics: ProductEnrichmentDiagnostics = {
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
    descriptionSource: { SOURCE: 0, SHELF_EXISTING: 0, GENERATED: 0, NONE: 0 },
    searchProviderConfigured: Boolean(productSearchProvider),
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
    const identityKey = imageIdentityCacheKey(row);
    lookupRows.set(identityKey, lookupRows.get(identityKey) ?? row);
  }
  diagnostics.imageLookupAttempted = lookupRows.size;
  const queuedLookups = [...lookupRows.entries()];
  let nextLookup = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(IMAGE_LOOKUP_CONCURRENCY, queuedLookups.length) },
      async () => {
        while (nextLookup < queuedLookups.length) {
          const current = queuedLookups[nextLookup++];
          if (!current) continue;
          const [identityKey, row] = current;
          const attempt: ImportImageAttempt = {
            productIdentityBuilt: identityIsClear(row),
            searchAttempted: false,
            searchProvider:
              productSearchProvider?.name ??
              (productSearchProvider ? "CUSTOM" : "NOT_CONFIGURED"),
            searchResultCount: 0,
            imageMetadataFound: false,
            imageDownloadAttempted: false,
            downloadBytes: 0,
            imageProcessed: false,
            finalBytes: 0,
          };
          try {
            const result = await lookupProductImage(
              row,
              productSearchProvider,
              attempt
            );
            diagnostics.imageCandidatesConsidered +=
              result.candidatesConsidered;
            lookupCache.set(identityKey, {
              ...result,
              attempt,
              failureReason:
                result.status === "IMAGE_FOUND"
                  ? undefined
                  : attempt.failureReason ?? "NO_TRUSTED_PRODUCT_MATCH",
            });
          } catch {
            lookupCache.set(identityKey, {
              status: "IMAGE_FETCH_FAILED",
              failureReason: attempt.failureReason ?? "IMAGE_DOWNLOAD_FAILED",
              attempt,
            });
          }
        }
      }
    )
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

    const identityKey = imageIdentityCacheKey(row);
    const productImageProposal: ImportProductImageProposal =
      existingModel?.imageUrl || existingModel?.thumbnailUrl
        ? {
            status: "IMAGE_PRESERVED",
          }
        : lookupCache.get(identityKey) ?? {
            status: "IMAGE_NOT_FOUND",
          };
    if (!existingModel) diagnostics.newModels += 1;
    if (existingModel?.imageUrl || existingModel?.thumbnailUrl) {
      diagnostics.existingModelsWithImage += 1;
    }
    if (productImageProposal.status === "IMAGE_FOUND") {
      diagnostics.imageAccepted += 1;
      diagnostics.imageLookupSucceeded += 1;
      diagnostics.imageProcessed += 1;
      diagnostics.imageFinalBytes += Math.floor(
        Buffer.from(productImageProposal.dataBase64 ?? "", "base64").length
      );
      if (productImageProposal.source === "SOURCE_DOCUMENT") {
        diagnostics.imageSourceDocument += 1;
      } else if (productImageProposal.source === "MANUFACTURER") {
        diagnostics.imageSourceManufacturer += 1;
      } else if (productImageProposal.source === "SUPPLIER") {
        diagnostics.imageSourceSupplier += 1;
      }
    } else if (
      productImageProposal.status !== "IMAGE_PRESERVED" &&
      lookupCache.has(identityKey)
    ) {
      diagnostics.imageRejectedReason[productImageProposal.status] =
        (diagnostics.imageRejectedReason[productImageProposal.status] ?? 0) + 1;
    }
    if (
      productImageProposal.status !== "IMAGE_FOUND" &&
      productImageProposal.status !== "IMAGE_PRESERVED"
    ) {
      diagnostics.imageMissing += 1;
      if (lookupCache.has(identityKey)) {
        diagnostics.imageLookupFailed += 1;
      }
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
