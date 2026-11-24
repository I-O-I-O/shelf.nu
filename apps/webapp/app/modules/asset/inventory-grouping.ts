/**
 * Shared, presentation-only grouping for Staff and Student inventory views.
 * Shelf Asset records remain unchanged. Native AssetModel identity groups
 * individual physical units; otherwise exact normalized titles select one
 * deterministic canonical record without summing duplicate stock.
 */
export type InventoryCandidate = {
  id: string;
  title: string;
  type?: string | null;
  status?: string | null;
  availableToBook?: boolean | null;
  quantity?: number | null;
  assetLocations?: Array<unknown> | null;
  updatedAt?: Date | string | null;
  assetModelId?: string | null;
  assetModel?: { id?: string; name?: string | null } | null;
};

export type InventoryCandidateGroup<T extends InventoryCandidate> = {
  canonical: T;
  members: T[];
};

export type InventoryDisplayRow<T extends InventoryCandidate> = T & {
  duplicateRecordCount: number;
  members: T[];
  logicalTitle: string;
  isExpandable: boolean;
};

export function normalizeInventoryTitle(title: string): string {
  return title.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

/** Picks one canonical row without adding quantities from duplicate records. */
export function selectCanonicalInventoryCandidate<T extends InventoryCandidate>(
  candidates: T[]
): T {
  if (candidates.length === 0) {
    throw new Error("At least one inventory candidate is required");
  }

  return [...candidates].sort((left, right) => {
    const availabilityDifference =
      Number(Boolean(right.availableToBook)) -
      Number(Boolean(left.availableToBook));
    if (availabilityDifference !== 0) return availabilityDifference;

    const locationDifference =
      Number(Boolean(right.assetLocations?.length)) -
      Number(Boolean(left.assetLocations?.length));
    if (locationDifference !== 0) return locationDifference;

    const updatedDifference =
      toTimestamp(right.updatedAt) - toTimestamp(left.updatedAt);
    if (updatedDifference !== 0) return updatedDifference;

    return left.id.localeCompare(right.id);
  })[0];
}

export function groupInventoryCandidates<T extends InventoryCandidate>(
  items: T[],
  options?: {
    shouldGroup?: (item: T) => boolean;
    groupKey?: (item: T) => string;
  }
): InventoryCandidateGroup<T>[] {
  const grouped = new Map<string, T[]>();

  for (const item of items) {
    const shouldGroup = options?.shouldGroup?.(item) ?? true;
    const key = shouldGroup
      ? options?.groupKey?.(item) ?? normalizeInventoryTitle(item.title)
      : `__individual:${item.id}`;
    const group = grouped.get(key) ?? [];
    group.push(item);
    grouped.set(key, group);
  }

  return Array.from(grouped.values()).map((members) => ({
    canonical: selectCanonicalInventoryCandidate(members),
    members,
  }));
}

export function buildInventoryDisplayRows<T extends InventoryCandidate>(
  items: T[]
): InventoryDisplayRow<T>[] {
  // Converting a quantity pool into individually tracked units leaves the
  // old zero-quantity source row in Shelf. Once active AssetModel-linked
  // units exist for that product, the source row is no longer a physical
  // product and must not become a misleading `0 of 1` display row. Keep the
  // physical units and the existing model-based duplicate handling intact.
  const activeIndividualProductNames = new Set(
    items
      .filter(
        (item) =>
          item.type === "INDIVIDUAL" &&
          Boolean(item.assetModelId ?? item.assetModel?.id)
      )
      .flatMap((item) => [item.assetModel?.name, stripUnitSuffix(item.title)])
      .filter((name): name is string => Boolean(name))
      .map(normalizeInventoryTitle)
  );
  const displayItems = items.filter(
    (item) =>
      !(
        item.type === "QUANTITY_TRACKED" &&
        (item.quantity ?? 0) <= 0 &&
        !item.assetModelId &&
        activeIndividualProductNames.has(normalizeInventoryTitle(item.title))
      )
  );

  return groupInventoryCandidates(displayItems, {
    groupKey: (item) =>
      item.assetModelId || item.assetModel?.id
        ? "asset-model:" + (item.assetModelId ?? item.assetModel?.id)
        : "title:" + normalizeInventoryTitle(item.title),
  }).map(({ canonical, members }) => {
    const isExpandable =
      members.length > 1 &&
      members.every((member) => member.type === "INDIVIDUAL") &&
      Boolean(canonical.assetModelId ?? canonical.assetModel?.id);
    const logicalTitle = isExpandable
      ? canonical.assetModel?.name ?? stripUnitSuffix(canonical.title)
      : canonical.title;

    return {
      ...canonical,
      duplicateRecordCount: members.length,
      members,
      logicalTitle,
      isExpandable,
    };
  });
}

export function deduplicateInventoryRows<T extends InventoryCandidate>(
  items: T[]
) {
  return groupInventoryCandidates(items).map(({ canonical, members }) => ({
    ...canonical,
    duplicateRecordCount: members.length,
  }));
}

function toTimestamp(value: Date | string | null | undefined): number {
  if (!value) return 0;
  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function stripUnitSuffix(title: string): string {
  return title.replace(/\s+#\d+$/u, "");
}
