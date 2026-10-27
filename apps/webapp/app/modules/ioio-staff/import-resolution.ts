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
};

export type ImportLocationCategoryAffinity = {
  categoryId: string;
  categoryName: string;
  assetCount: number;
  units: number;
};

export type ImportSuggestionMethod = "claude" | "deterministic-fallback";

export type ImportProductEvidence = {
  manufacturer?: string | null;
  productName?: string | null;
  rawDescription?: string | null;
  description?: string | null;
  mpn?: string | null;
  supplierDescription?: string | null;
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
} {
  const claudeCategory = categories.find(
    (category) => category.id === claudeCategoryId && !category.archived
  );
  const deterministic = suggestImportCategory({ evidence, categories });
  if (!claudeCategory || (claudeConfidence ?? 0) < 0.8) {
    return deterministic
      ? { category: deterministic.category, method: "deterministic-fallback" }
      : { category: null, method: "unresolved" };
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
      return {
        category: deterministic.category,
        method: "deterministic-fallback",
      };
    }
  }
  return { category: claudeCategory, method: "claude" };
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
} | null {
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
    const strongHistory =
      totalAffinity >= 3 &&
      (affinity?.assetCount ?? 0) >= 2 &&
      affinityShare >= 0.25;
    const historicalScore =
      affinity && totalAffinity >= 3
        ? 36 * (affinity!.assetCount / totalAffinity) +
          Math.min(6, Math.log2(affinity!.assetCount + 1))
        : 0;
    const depthBonus =
      specificScore > 0 || strongHistory ? Math.min(depth, 6) * 2.5 : 0;
    return {
      candidate: location,
      score: specificScore + historicalScore + depthBonus,
      strength: strongHistory ? ("historical" as const) : ("semantic" as const),
    };
  });
  const location = pickUniqueStrongest(rankedLocations, 12, 2);
  if (!location) return null;
  return {
    location,
    score:
      rankedLocations.find(({ candidate }) => candidate.id === location.id)
        ?.score ?? 0,
    strength:
      rankedLocations.find(({ candidate }) => candidate.id === location.id)
        ?.strength ?? "semantic",
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
    return deterministic
      ? { location: deterministic.location, method: "deterministic-fallback" }
      : { location: null, method: "unresolved" };
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
      };
    }
  }
  return { location: claudeLocation, method: "claude" };
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
