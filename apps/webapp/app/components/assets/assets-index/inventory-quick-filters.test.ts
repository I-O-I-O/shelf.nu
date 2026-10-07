import { AssetStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { IOIO_KIT_CATEGORY_FILTER } from "~/utils/list";
import {
  applyInventoryQuickFilter,
  INVENTORY_QUICK_FILTERS,
  type InventoryQuickFilter,
} from "./inventory-quick-filters";

describe("Inventory quick filters", () => {
  it("offers the requested status and kit shortcuts", () => {
    expect(INVENTORY_QUICK_FILTERS.map(({ label }) => label)).toEqual([
      "All",
      "Available",
      "Checked out",
      "Kits",
    ]);
  });

  it.each<[InventoryQuickFilter, string, string | null]>([
    ["all", "All", null],
    ["available", "Available", AssetStatus.AVAILABLE],
    ["checked-out", "Checked out", AssetStatus.CHECKED_OUT],
    ["kits", "Kits", null],
  ])("applies the %s quick filter", (filter, _label, status) => {
    const result = applyInventoryQuickFilter(
      new URLSearchParams(
        "search=makey&location=loc-1&category=category-1&page=3"
      ),
      filter
    );

    expect(result.get("status")).toBe(status);
    expect(result.get("search")).toBe("makey");
    expect(result.get("location")).toBe("loc-1");
    expect(result.has("page")).toBe(false);
    expect(result.getAll("category")).toEqual(
      filter === "kits" ? [IOIO_KIT_CATEGORY_FILTER] : ["category-1"]
    );
  });

  it("keeps an independently selected category when clearing a quick filter", () => {
    const result = applyInventoryQuickFilter(
      new URLSearchParams(
        `status=${AssetStatus.AVAILABLE}&category=category-1&category=${IOIO_KIT_CATEGORY_FILTER}`
      ),
      "all"
    );

    expect(result.get("status")).toBeNull();
    expect(result.getAll("category")).toEqual(["category-1"]);
  });
});
