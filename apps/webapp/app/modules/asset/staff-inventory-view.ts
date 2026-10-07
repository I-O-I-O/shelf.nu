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
};

export type StaffInventorySummary = {
  logicalItems: number;
  totalQuantity: number;
  available: number;
  inUse: number;
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

  return {
    logicalItems: quantities.length,
    totalQuantity,
    available,
    inUse: Math.max(0, totalQuantity - available),
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
