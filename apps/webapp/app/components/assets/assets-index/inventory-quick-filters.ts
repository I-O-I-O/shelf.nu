import { AssetStatus } from "@prisma/client";

export type InventoryQuickFilter = "all" | "available" | "checked-out" | "kits";

export const INVENTORY_QUICK_FILTERS: Array<{
  key: InventoryQuickFilter;
  label: string;
}> = [
  { key: "all", label: "All" },
  { key: "available", label: "Available" },
  { key: "checked-out", label: "Checked out" },
  { key: "kits", label: "Kits" },
];

export function applyInventoryQuickFilter(
  current: URLSearchParams,
  filter: InventoryQuickFilter
): URLSearchParams {
  const next = new URLSearchParams(current);
  if (filter === "all") {
    next.delete("status");
    next.delete("assetKitFilter");
    next.delete("category", "__ioio-kit__");
  } else if (filter === "kits") {
    next.delete("status");
    next.delete("category", "__ioio-kit__");
    next.set("assetKitFilter", "IN_OTHER_KITS");
  } else {
    next.set(
      "status",
      filter === "available" ? AssetStatus.AVAILABLE : AssetStatus.CHECKED_OUT
    );
    next.delete("assetKitFilter");
    next.delete("category", "__ioio-kit__");
  }

  next.delete("page");
  return next;
}
