export type ImportCategoryCandidate = {
  id: string;
  name: string;
  archived?: boolean;
};

export type ImportLocationCandidate = {
  id: string;
  name: string;
  parentId: string | null;
  operational?: boolean;
  currentUnits?: number;
};

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
