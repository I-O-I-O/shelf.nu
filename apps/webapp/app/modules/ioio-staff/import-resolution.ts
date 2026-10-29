export type ImportCategoryCandidate = {
  id: string;
  name: string;
  description?: string | null;
  color?: string | null;
  pathLabel?: string;
  archived?: boolean;
};

export type ImportLocationCandidate = {
  id: string;
  name: string;
  parentId: string | null;
  pathLabel?: string;
  description?: string | null;
  operational?: boolean;
  currentUnits?: number;
  categoryAffinities?: ImportLocationCategoryAffinity[];
  representativeProducts?: string[];
};

export type ImportLocationCategoryAffinity = {
  categoryId: string;
  categoryName: string;
  assetCount: number;
  units: number;
};

export type ImportSuggestionMethod = "claude" | "deterministic-fallback";
export type ImportLocationSuggestionStatus =
  | "SUGGESTED"
  | "WEAK_SUGGESTION"
  | "UNRESOLVED";
export type ImportLocationDiagnosticReason =
  | "LOCATION_CATEGORY_AFFINITY"
  | "LOCATION_SIMILAR_ITEMS"
  | "LOCATION_DETERMINISTIC_FALLBACK"
  | "LOCATION_UNRESOLVED";

export type ImportProductEvidence = {
  manufacturer?: string | null;
  productName?: string | null;
  rawDescription?: string | null;
  description?: string | null;
  mpn?: string | null;
  supplierDescription?: string | null;
  categoryText?: string | null;
};

const PRODUCT_CONCEPTS = [
  {
    name: "development-board",
    pattern:
      /\b(?:development|dev|embedded|microcontroller)\s+(?:boards?|platforms?)\b|\b(?:xiao|esp32(?:[- ]?s\d|c\d)?|nrf\s?52840|arduino|microcontrollers?)\b|\braspberry\s+pi\s+pico(?:\s+w)?\b/i,
  },
  {
    name: "motor",
    pattern:
      /\b(?:gear\s?motors?|gearmotors?|motors?|stepper|servos?|actuators?|robotics|motion\s+control)\b/i,
  },
  {
    name: "measurement",
    pattern:
      /\b(?:multimeters?|oscilloscopes?|logic\s+analy[sz]ers?|test\s+equipment|measurement|measuring\s+instruments?|signal\s+generators?)\b/i,
  },
  {
    name: "camera",
    pattern:
      /\b(?:cameras?|camera\s+modules?|imaging|machine\s+vision|vision\s+systems?)\b/i,
  },
  {
    name: "cable",
    pattern: /\b(?:cables?|wires?|connectors?|adapters?|usb[ -]?c)\b/i,
  },
  {
    name: "power",
    pattern:
      /\b(?:power\s+supplies|power\s+supply|psu|dc[ -]?dc\s+converters?|converters?|voltage\s+regulators?)\b/i,
  },
  {
    name: "sensor",
    pattern:
      /\b(?:sensors?|mmwave|presence|distance|radar|temperature|humidity|breathing|heartbeat)\b/i,
  },
  {
    name: "tool",
    pattern:
      /\b(?:tools?|screwdrivers?|pliers?|wrenches?|hand\s+tools?|tool\s+sets?)\b/i,
  },
  {
    name: "electronics",
    pattern: /\b(?:electronics?|electrical\s+equipment)\b/i,
  },
];

const CROSS_CONCEPT_AFFINITY: Record<string, string[]> = {
  power: ["electronics"],
  "development-board": ["electronics"],
  motor: ["electronics"],
  camera: ["sensor"],
};

const MATCH_STOP_WORDS = new Set([
  "and",
  "for",
  "from",
  "the",
  "with",
  "product",
  "products",
  "item",
  "items",
  "seeed",
  "studio",
  "equipment",
  "measurement",
  "test",
]);

function normalizeMatchText(value: string | null | undefined) {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function matchTokens(value: string | null | undefined) {
  return normalizeMatchText(value)
    .split(/\s+/)
    .filter((token) => token.length > 1 && !MATCH_STOP_WORDS.has(token));
}

function singularizeToken(token: string) {
  if (token.endsWith("ies") && token.length > 4)
    return `${token.slice(0, -3)}y`;
  if (token.endsWith("s") && token.length > 4 && !token.endsWith("ss")) {
    return token.slice(0, -1);
  }
  return token;
}

function normalizedTokens(value: string | null | undefined) {
  return new Set(matchTokens(value).map(singularizeToken));
}

function evidenceText(evidence: ImportProductEvidence) {
  return [
    evidence.manufacturer,
    evidence.productName,
    evidence.rawDescription,
    evidence.description,
    evidence.supplierDescription,
    evidence.mpn,
    evidence.categoryText,
  ]
    .filter(Boolean)
    .join(" ");
}

function evidenceGroups(value: string) {
  return PRODUCT_CONCEPTS.filter(({ pattern }) => pattern.test(value)).map(
    ({ name }) => name
  );
}

function sharedTokenScore(evidence: string, candidate: string) {
  const evidenceTokens = normalizedTokens(evidence);
  const candidateTokens = normalizedTokens(candidate);
  let score = 0;
  for (const token of candidateTokens) {
    if (evidenceTokens.has(token)) {
      // Distinctive item tokens (for example "oscilloscope") should separate
      // sibling locations after category context has narrowed the search.
      score += token.length > 8 ? 20 : token.length > 4 ? 2 : 1;
    }
  }
  return score;
}

function semanticMatchScore(evidence: string, candidate: string) {
  let score = sharedTokenScore(evidence, candidate);
  const evidenceFeatures = evidenceGroups(evidence);
  const candidateFeatures = evidenceGroups(candidate);
  for (const feature of evidenceFeatures) {
    if (candidateFeatures.includes(feature)) score += 16;
    if (
      CROSS_CONCEPT_AFFINITY[feature]?.some((related) =>
        candidateFeatures.includes(related)
      )
    ) {
      score += 9;
    }
  }
  return score;
}

function hierarchyDepth(pathLabel: string | null | undefined) {
  return (pathLabel ?? "").split(/\s*(?:\/|>|·)\s*/u).filter(Boolean).length;
}

function pickUniqueStrongest<T>(
  scores: Array<{ candidate: T; score: number }>,
  minimumScore: number,
  minimumLead = 2
) {
  const ranked = [...scores].sort((left, right) => right.score - left.score);
  const best = ranked[0];
  const next = ranked[1];
  if (
    !best ||
    best.score < minimumScore ||
    (next && best.score - next.score < minimumLead)
  ) {
    return null;
  }
  return best.candidate;
}

export function suggestImportCategory({
  evidence,
  categories,
}: {
  evidence: ImportProductEvidence;
  categories: ImportCategoryCandidate[];
}): { category: ImportCategoryCandidate; score: number } | null {
  const productText = evidenceText(evidence);
  const candidates = categories
    .filter((category) => !category.archived)
    .map((category) => ({
      candidate: category,
      score:
        semanticMatchScore(
          productText,
          `${category.pathLabel ?? category.name} ${category.description ?? ""}`
        ) +
        (evidence.categoryText &&
        normalizeMatchText(evidence.categoryText) ===
          normalizeMatchText(category.name)
          ? 30
          : 0) +
        Math.min(hierarchyDepth(category.pathLabel), 5) * 2.5,
    }));
  const category = pickUniqueStrongest(candidates, 9, 3);
  if (!category) return null;
  return {
    category,
    score:
      candidates.find(({ candidate }) => candidate.id === category.id)?.score ??
      0,
  };
}

export function resolveImportCategorySuggestion({
  claudeCategoryId,
  claudeConfidence,
  evidence,
  categories,
}: {
  claudeCategoryId?: string | null;
  claudeConfidence?: number | null;
  evidence: ImportProductEvidence;
  categories: ImportCategoryCandidate[];
}): {
  category: ImportCategoryCandidate | null;
  method: ImportSuggestionMethod | "unresolved";
  diagnostics?: {
    categoryCandidateCount: number;
    categoryClaudeResult: string;
    categoryClaudeConfidence: number;
    categoryFallbackUsed: boolean;
    categoryFinalSource: string;
  };
} {
  const claudeCategory = categories.find(
    (category) => category.id === claudeCategoryId && !category.archived
  );
  const deterministic = suggestImportCategory({ evidence, categories });
  const finish = (
    category: ImportCategoryCandidate | null,
    method: ImportSuggestionMethod | "unresolved"
  ) => ({
    category,
    method,
    diagnostics: {
      categoryCandidateCount: categories.filter((entry) => !entry.archived)
        .length,
      categoryClaudeResult: !claudeCategoryId
        ? "NULL"
        : !claudeCategory
        ? "INVALID_ID"
        : (claudeConfidence ?? 0) < 0.8
        ? "LOW_CONFIDENCE"
        : "VALID",
      categoryClaudeConfidence: claudeConfidence ?? 0,
      categoryFallbackUsed: method === "deterministic-fallback",
      categoryFinalSource: !category
        ? "UNRESOLVED"
        : method === "claude"
        ? "CLAUDE"
        : evidence.categoryText &&
          normalizeMatchText(evidence.categoryText) ===
            normalizeMatchText(category.name)
        ? "SPREADSHEET_EXACT_MATCH"
        : "DETERMINISTIC",
    },
  });
  if (!claudeCategory || (claudeConfidence ?? 0) < 0.8) {
    return deterministic
      ? finish(deterministic.category, "deterministic-fallback")
      : finish(null, "unresolved");
  }
  if (
    deterministic &&
    deterministic.category.id !== claudeCategory.id &&
    deterministic.score >= 14
  ) {
    const claudeScore =
      deterministic.category.id === claudeCategory.id
        ? deterministic.score
        : semanticMatchScore(
            evidenceText(evidence),
            `${claudeCategory.pathLabel ?? claudeCategory.name} ${
              claudeCategory.description ?? ""
            }`
          );
    if (deterministic.score >= claudeScore + 2) {
      return finish(deterministic.category, "deterministic-fallback");
    }
  }
  return finish(claudeCategory, "claude");
}

function rankImportLocations({
  evidence,
  category,
  locations,
}: {
  evidence: ImportProductEvidence;
  category?: ImportCategoryCandidate | null;
  locations: Array<ImportLocationCandidate & { pathLabel: string }>;
}) {
  const productText = evidenceText(evidence);
  const categoryText = category
    ? `${category.name} ${category.description ?? ""}`
    : "";
  const matchingText = `${productText} ${categoryText}`;
  const assignableLocations = locations.filter(
    (location) => !location.operational
  );
  const totalAffinity = category
    ? assignableLocations.reduce(
        (total, candidate) =>
          total +
          (candidate.categoryAffinities?.find(
            (item) => item.categoryId === category.id
          )?.assetCount ?? 0),
        0
      )
    : 0;
  const rankedLocations = assignableLocations.map((location) => {
    const specificText = `${location.name} ${location.description ?? ""} ${
      location.pathLabel
    }`;
    const specificScore = semanticMatchScore(matchingText, specificText);
    const depth = hierarchyDepth(location.pathLabel);
    const affinity = category
      ? location.categoryAffinities?.find(
          (candidate) => candidate.categoryId === category.id
        )
      : undefined;
    const affinityShare =
      affinity && totalAffinity > 0 ? affinity.assetCount / totalAffinity : 0;
    const affinityCount = affinity?.assetCount ?? 0;
    const similarProductScore = Math.max(
      0,
      ...(location.representativeProducts ?? []).map((product) =>
        semanticMatchScore(productText, product)
      )
    );
    const strongHistory =
      affinityCount >= 2 && affinityShare >= 0.2 && totalAffinity >= 2;
    const historicalScore = affinityCount
      ? 8 + 20 * affinityShare + Math.min(8, Math.log2(affinityCount + 1) * 2)
      : 0;
    const depthBonus =
      specificScore > 0 || similarProductScore > 0 || affinityCount > 0
        ? Math.min(depth, 6) * 2.5
        : 0;
    const occupancyBonus =
      location.currentUnits !== undefined &&
      (specificScore > 0 || similarProductScore > 0 || affinityCount > 0)
        ? Math.max(0, 3 - Math.log2(location.currentUnits + 1))
        : 0;
    const reasonCodes: ImportLocationDiagnosticReason[] = [];
    if (affinityCount > 0) reasonCodes.push("LOCATION_CATEGORY_AFFINITY");
    if (similarProductScore > 0) reasonCodes.push("LOCATION_SIMILAR_ITEMS");
    return {
      candidate: location,
      score:
        specificScore +
        similarProductScore * 0.75 +
        historicalScore +
        depthBonus +
        occupancyBonus,
      strength: strongHistory ? ("historical" as const) : ("semantic" as const),
      reasonCodes,
    };
  });
  return [...rankedLocations].sort(
    (left, right) =>
      right.score - left.score ||
      left.candidate.pathLabel.localeCompare(right.candidate.pathLabel)
  );
}

export function suggestImportLocation({
  evidence,
  category,
  locations,
}: {
  evidence: ImportProductEvidence;
  category?: ImportCategoryCandidate | null;
  locations: Array<ImportLocationCandidate & { pathLabel: string }>;
}): {
  location: ImportLocationCandidate & { pathLabel: string };
  score: number;
  strength: "historical" | "semantic";
  status: Exclude<ImportLocationSuggestionStatus, "UNRESOLVED">;
  reasonCodes: ImportLocationDiagnosticReason[];
} | null {
  const ranked = rankImportLocations({ evidence, category, locations });
  const best = ranked[0];
  if (!best || best.score <= 0) return null;
  const next = ranked[1];
  const clearlySuggested =
    best.score >= 12 && (!next || best.score - next.score >= 2);
  return {
    location: best.candidate,
    score: best.score,
    strength: best.strength,
    status: clearlySuggested ? "SUGGESTED" : "WEAK_SUGGESTION",
    reasonCodes: best.reasonCodes,
  };
}

export function resolveImportLocationSuggestion({
  claudeLocationId,
  claudeConfidence,
  evidence,
  category,
  locations,
}: {
  claudeLocationId?: string | null;
  claudeConfidence?: number | null;
  evidence: ImportProductEvidence;
  category?: ImportCategoryCandidate | null;
  locations: Array<ImportLocationCandidate & { pathLabel: string }>;
}): {
  location: (ImportLocationCandidate & { pathLabel: string }) | null;
  method: ImportSuggestionMethod | "unresolved";
  status: ImportLocationSuggestionStatus;
  reasonCodes: ImportLocationDiagnosticReason[];
} {
  const claudeLocation = locations.find(
    (location) => location.id === claudeLocationId && !location.operational
  );
  const deterministic = suggestImportLocation({
    evidence,
    category,
    locations,
  });
  if (!claudeLocation || (claudeConfidence ?? 0) < 0.8) {
    if (deterministic) {
      return {
        location: deterministic.location,
        method: "deterministic-fallback",
        status: deterministic.status,
        reasonCodes: [
          ...deterministic.reasonCodes,
          "LOCATION_DETERMINISTIC_FALLBACK",
        ],
      };
    }
    if (claudeLocation) {
      return {
        location: claudeLocation,
        method: "claude",
        status: "WEAK_SUGGESTION",
        reasonCodes: [],
      };
    }
    return {
      location: null,
      method: "unresolved",
      status: "UNRESOLVED",
      reasonCodes: ["LOCATION_UNRESOLVED"],
    };
  }
  if (
    deterministic &&
    deterministic.location.id !== claudeLocation.id &&
    (deterministic.strength === "historical" || deterministic.score >= 18)
  ) {
    const claudeAffinity = category
      ? claudeLocation.categoryAffinities?.find(
          (candidate) => candidate.categoryId === category.id
        )
      : undefined;
    const deterministicAffinity = category
      ? deterministic.location.categoryAffinities?.find(
          (candidate) => candidate.categoryId === category.id
        )
      : undefined;
    const historyClearlyPrefersDeterministic =
      deterministic.strength === "historical" &&
      (deterministicAffinity?.assetCount ?? 0) >
        (claudeAffinity?.assetCount ?? 0);
    const claudeScore =
      semanticMatchScore(
        `${evidenceText(evidence)} ${category?.name ?? ""} ${
          category?.description ?? ""
        }`,
        `${claudeLocation.name} ${claudeLocation.description ?? ""} ${
          claudeLocation.pathLabel
        }`
      ) +
      Math.min(hierarchyDepth(claudeLocation.pathLabel), 6) * 2.5;
    if (
      historyClearlyPrefersDeterministic ||
      deterministic.score >= claudeScore + 2
    ) {
      return {
        location: deterministic.location,
        method: "deterministic-fallback",
        status: deterministic.status,
        reasonCodes: [
          ...deterministic.reasonCodes,
          "LOCATION_DETERMINISTIC_FALLBACK",
        ],
      };
    }
  }
  return {
    location: claudeLocation,
    method: "claude",
    status: "SUGGESTED",
    reasonCodes: [],
  };
}

export function selectImportLocationCandidates({
  products,
  locations,
  limit = 20,
  perProductLimit = 5,
}: {
  products: Array<{
    evidence: ImportProductEvidence;
    category?: ImportCategoryCandidate | null;
  }>;
  locations: Array<ImportLocationCandidate & { pathLabel: string }>;
  limit?: number;
  perProductLimit?: number;
}) {
  const ranked = new Map<
    string,
    { location: ImportLocationCandidate & { pathLabel: string }; score: number }
  >();
  for (const product of products) {
    const productRanked = rankImportLocations({
      evidence: product.evidence,
      category: product.category,
      locations,
    });
    for (const { candidate, score } of productRanked
      .filter(({ score }) => score > 0)
      .slice(0, perProductLimit)) {
      const current = ranked.get(candidate.id);
      if (!current || score > current.score)
        ranked.set(candidate.id, { location: candidate, score });
    }
  }
  if (products.length > 0 && ranked.size < limit) {
    const inventoryUsedLocations = locations
      .filter(
        (location) =>
          !location.operational &&
          (location.categoryAffinities?.length ?? 0) > 0
      )
      .map((location) => ({
        location,
        score:
          (location.categoryAffinities ?? []).reduce(
            (total, affinity) =>
              total + affinity.assetCount * 2 + Math.log2(affinity.units + 1),
            0
          ) + Math.min(4, hierarchyDepth(location.pathLabel)),
      }))
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.location.pathLabel.localeCompare(right.location.pathLabel)
      );
    for (const candidate of inventoryUsedLocations) {
      if (ranked.size >= limit) break;
      if (!ranked.has(candidate.location.id))
        ranked.set(candidate.location.id, candidate);
    }
  }
  return [...ranked.values()]
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.location.pathLabel.localeCompare(right.location.pathLabel)
    )
    .slice(0, limit)
    .map(({ location }) => location);
}

export function buildImportLocationAffinities({
  assets,
  categories,
  locations,
}: {
  assets: Array<{
    categoryId: string | null;
    modelDefaultCategoryId?: string | null;
    assetLocations: Array<{
      locationId: string;
      quantity: number;
      assetKitId?: string | null;
    }>;
  }>;
  categories: ImportCategoryCandidate[];
  locations: ImportLocationCandidate[];
}) {
  const categoryNames = new Map(categories.map(({ id, name }) => [id, name]));
  const assignableLocationIds = new Set(
    locations.filter((location) => !location.operational).map(({ id }) => id)
  );
  const summaries = new Map<
    string,
    Map<string, { categoryId: string; assetCount: number; units: number }>
  >();

  for (const asset of assets) {
    const categoryId = asset.categoryId ?? asset.modelDefaultCategoryId ?? null;
    if (!categoryId || !categoryNames.has(categoryId)) continue;
    const seenLocations = new Set<string>();
    for (const placement of asset.assetLocations) {
      if (
        placement.assetKitId != null ||
        !assignableLocationIds.has(placement.locationId)
      ) {
        continue;
      }
      const byCategory = summaries.get(placement.locationId) ?? new Map();
      const affinity = byCategory.get(categoryId) ?? {
        categoryId,
        assetCount: 0,
        units: 0,
      };
      affinity.units += placement.quantity;
      if (!seenLocations.has(placement.locationId)) {
        affinity.assetCount += 1;
        seenLocations.add(placement.locationId);
      }
      byCategory.set(categoryId, affinity);
      summaries.set(placement.locationId, byCategory);
    }
  }

  return new Map(
    [...summaries].map(([locationId, byCategory]) => [
      locationId,
      [...byCategory.values()]
        .map((affinity) => ({
          ...affinity,
          categoryName: categoryNames.get(affinity.categoryId) ?? "",
        }))
        .sort((left, right) => right.assetCount - left.assetCount),
    ])
  );
}

export function buildImportLocationRepresentativeProducts({
  assets,
  locations,
}: {
  assets: Array<{
    title?: string | null;
    description?: string | null;
    modelName?: string | null;
    assetLocations: Array<{
      locationId: string;
      assetKitId?: string | null;
    }>;
  }>;
  locations: ImportLocationCandidate[];
}) {
  const assignableLocationIds = new Set(
    locations.filter((location) => !location.operational).map(({ id }) => id)
  );
  const productCountsByLocation = new Map<string, Map<string, number>>();
  for (const asset of assets) {
    const product = [asset.modelName, asset.title, asset.description]
      .filter(Boolean)
      .join(" ")
      .trim();
    if (!product) continue;
    for (const placement of asset.assetLocations) {
      if (
        placement.assetKitId != null ||
        !assignableLocationIds.has(placement.locationId)
      ) {
        continue;
      }
      const products =
        productCountsByLocation.get(placement.locationId) ?? new Map();
      products.set(product, (products.get(product) ?? 0) + 1);
      productCountsByLocation.set(placement.locationId, products);
    }
  }
  return new Map(
    [...productCountsByLocation].map(([locationId, products]) => [
      locationId,
      [...products]
        .sort(
          (left, right) => right[1] - left[1] || left[0].localeCompare(right[0])
        )
        .slice(0, 12)
        .map(([product]) => product.slice(0, 500)),
    ])
  );
}

export function normalizeImportLabel(value: string | null | undefined) {
  return (value ?? "").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en");
}

export function resolveImportCategory(
  proposedName: string | null | undefined,
  categories: ImportCategoryCandidate[]
) {
  const normalizedName = normalizeImportLabel(proposedName);
  if (!normalizedName) return { status: "MISSING" as const };
  const matches = categories.filter(
    (category) => normalizeImportLabel(category.name) === normalizedName
  );
  const active = matches.filter((category) => !category.archived);
  const archived = matches.filter((category) => category.archived);
  if (active.length > 1 || (!active.length && archived.length > 1)) {
    return { status: "AMBIGUOUS" as const, matches };
  }
  if (active.length === 1) {
    return { status: "ACTIVE_MATCH" as const, category: active[0] };
  }
  if (archived.length === 1) {
    return { status: "ARCHIVED_MATCH" as const, category: archived[0] };
  }
  return { status: "NEW_PROPOSED" as const, name: proposedName!.trim() };
}

export function getImportLocationPath(
  locationId: string,
  locations: ImportLocationCandidate[]
) {
  const byId = new Map(locations.map((location) => [location.id, location]));
  const path: string[] = [];
  const visited = new Set<string>();
  let currentId: string | null = locationId;
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const current = byId.get(currentId);
    if (!current) break;
    path.unshift(current.name);
    currentId = current.parentId;
  }
  return path.join(" · ");
}

export function matchesReviewedImportLocationPath({
  expectedPath,
  currentPath,
  currentName,
}: {
  expectedPath?: string | null;
  currentPath: string;
  currentName: string;
}) {
  if (!expectedPath || expectedPath === "Unassigned") return true;
  // Accept a legacy saved name-only label, while new proposals persist the full
  // path so hierarchy edits are detected before Shelf writes.
  return expectedPath === currentPath || expectedPath === currentName;
}

function isWithinLocation(
  locationId: string,
  ancestorId: string,
  locations: ImportLocationCandidate[]
) {
  const byId = new Map(locations.map((location) => [location.id, location]));
  const visited = new Set<string>();
  let currentId: string | null = locationId;
  while (currentId && !visited.has(currentId)) {
    if (currentId === ancestorId) return true;
    visited.add(currentId);
    currentId = byId.get(currentId)?.parentId ?? null;
  }
  return false;
}

export function getOperationalImportLocationIds({
  locations,
  brokenSectionId,
  pickupZoneName,
  reportReturnPath,
}: {
  locations: ImportLocationCandidate[];
  brokenSectionId?: string | null;
  pickupZoneName: string;
  reportReturnPath?: string | null;
}) {
  const pickupIds = new Set(
    locations
      .filter(
        (location) =>
          normalizeImportLabel(location.name) ===
          normalizeImportLabel(pickupZoneName)
      )
      .map(({ id }) => id)
  );
  return new Set(
    locations
      .filter((location) => {
        const path = getImportLocationPath(location.id, locations);
        return Boolean(
          (brokenSectionId &&
            isWithinLocation(location.id, brokenSectionId, locations)) ||
            [...pickupIds].some((pickupId) =>
              isWithinLocation(location.id, pickupId, locations)
            ) ||
            (reportReturnPath &&
              normalizeImportLabel(path) ===
                normalizeImportLabel(reportReturnPath))
        );
      })
      .map(({ id }) => id)
  );
}

export function resolveImportLocation(
  proposedName: string | null | undefined,
  locations: Array<ImportLocationCandidate & { pathLabel: string }>
) {
  const normalizedName = normalizeImportLabel(proposedName);
  if (!normalizedName) return { status: "MISSING" as const };
  const matches = locations.filter(
    (location) =>
      normalizeImportLabel(location.name) === normalizedName ||
      normalizeImportLabel(location.pathLabel) === normalizedName
  );
  if (matches.length > 1) {
    return { status: "AMBIGUOUS" as const, matches };
  }
  if (matches[0]?.operational) {
    return { status: "OPERATIONAL" as const, location: matches[0] };
  }
  if (matches.length === 1) {
    return { status: "MATCH" as const, location: matches[0] };
  }
  return { status: "UNMATCHED" as const };
}
