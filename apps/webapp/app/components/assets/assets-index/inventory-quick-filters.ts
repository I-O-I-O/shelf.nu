import { AssetStatus } from "@prisma/client";
import { IOIO_KIT_CATEGORY_FILTER } from "~/utils/list";

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
  const categories = next.getAll("category");

  if (filter === "all") {
    next.delete("status");
    next.delete("category");
    for (const category of categories) {
      if (category !== IOIO_KIT_CATEGORY_FILTER) {
        next.append("category", category);
      }
    }
  } else if (filter === "kits") {
    next.delete("status");
    next.delete("category");
    next.append("category", IOIO_KIT_CATEGORY_FILTER);
  } else {
    next.set(
      "status",
      filter === "available" ? AssetStatus.AVAILABLE : AssetStatus.CHECKED_OUT
    );
    next.delete("category");
    for (const category of categories) {
      if (category !== IOIO_KIT_CATEGORY_FILTER) {
        next.append("category", category);
      }
    }
  }

  next.delete("page");
  return next;
}
