/** Presentation helpers specific to the Staff Inventory surface. */
import {
  buildInventoryDisplayRows,
  deduplicateInventoryRows,
  groupInventoryCandidates,
} from "./inventory-grouping";
import type {
  InventoryCandidate,
  InventoryCandidateGroup,
  InventoryDisplayRow,
} from "./inventory-grouping";
export {
  normalizeInventoryTitle,
  selectCanonicalInventoryCandidate,
} from "./inventory-grouping";
export type {
  InventoryCandidate,
  InventoryCandidateGroup,
  InventoryDisplayRow,
} from "./inventory-grouping";

export type StaffInventoryCandidate = InventoryCandidate;
export type StaffInventoryRow<T extends StaffInventoryCandidate> = T & {
  duplicateRecordCount: number;
};
export type StaffInventoryCandidateGroup<T extends StaffInventoryCandidate> =
  InventoryCandidateGroup<T>;
export type StaffInventoryDisplayRow<T extends StaffInventoryCandidate> =
  InventoryDisplayRow<T>;

type StaffInventoryImageCandidate = {
  id: string;
  mainImage?: string | null;
  mainImageStoragePath?: string | null;
  assetModel?: {
    image?: string | null;
    imageStoragePath?: string | null;
  } | null;
};

/** Find the first asset in a logical product group that has an image. */
export function findStaffInventoryImageCandidate<
  T extends StaffInventoryImageCandidate,
>(candidates: readonly T[]): T | null {
  return (
    candidates.find(
      (candidate) =>
        candidate.mainImage ||
        candidate.mainImageStoragePath ||
        candidate.assetModel?.image ||
        candidate.assetModel?.imageStoragePath
    ) ?? null
  );
}

/** Open grouped products in the standard Asset editor's product-level mode. */
export function getStaffInventoryEditTarget({
  assetId,
  assetModelId,
}: {
  assetId: string;
  assetModelId?: string | null;
}) {
  return assetModelId
    ? `/assets/${encodeURIComponent(assetId)}/edit?productGroup=1`
    : `/assets/${encodeURIComponent(assetId)}/edit`;
}

/** Expand a logical row to its actual Asset records before bulk mutations. */
export function getStaffInventoryActionTargets<
  T extends StaffInventoryCandidate,
>(row: StaffInventoryDisplayRow<T>): T[] {
  return row.members.length > 0 ? row.members : [row];
}

export type LogicalInventoryQuantity = {
  totalQuantity: number;
  availableQuantity: number;
  /** Active custody/loan count when known; unavailable stock is not "in use". */
  inUseQuantity?: number;
  outOfServiceQuantity?: number;
};

export type StaffInventorySummary = {
  logicalItems: number;
  totalQuantity: number;
  available: number;
  inUse: number;
  outOfService: number;
};

export function summarizeStaffInventory(
  quantities: LogicalInventoryQuantity[]
): StaffInventorySummary {
  const totalQuantity = quantities.reduce(
    (sum, item) => sum + Math.max(0, item.totalQuantity),
    0
  );
  const available = quantities.reduce(
    (sum, item) =>
      sum +
      Math.min(
        Math.max(0, item.totalQuantity),
        Math.max(0, item.availableQuantity)
      ),
    0
  );

  const inUse = quantities.reduce(
    (sum, item) =>
      sum +
      Math.max(
        0,
        item.inUseQuantity ?? item.totalQuantity - item.availableQuantity
      ),
    0
  );
  const outOfService = quantities.reduce(
    (sum, item) => sum + Math.max(0, item.outOfServiceQuantity ?? 0),
    0
  );

  return {
    logicalItems: quantities.length,
    totalQuantity,
    available,
    inUse,
    outOfService,
  };
}

export function deduplicateStaffInventoryRows<
  T extends StaffInventoryCandidate,
>(items: T[]): StaffInventoryRow<T>[] {
  return deduplicateInventoryRows(items);
}

export function buildStaffInventoryDisplayRows<
  T extends StaffInventoryCandidate,
>(items: T[]): StaffInventoryDisplayRow<T>[] {
  return buildInventoryDisplayRows(items);
}

export function groupStaffInventoryCandidates<
  T extends StaffInventoryCandidate,
>(
  items: T[],
  options?: {
    shouldGroup?: (item: T) => boolean;
    groupKey?: (item: T) => string;
  }
): StaffInventoryCandidateGroup<T>[] {
  return groupInventoryCandidates(items, options);
}
