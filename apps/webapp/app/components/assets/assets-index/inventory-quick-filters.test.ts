import { AssetStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";
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

  it.each<[InventoryQuickFilter, string | null, string | null]>([
    ["all", null, null],
    ["available", AssetStatus.AVAILABLE, null],
    ["checked-out", AssetStatus.CHECKED_OUT, null],
    ["kits", null, "IN_OTHER_KITS"],
  ])("applies the %s quick filter", (filter, status, kitFilter) => {
    const result = applyInventoryQuickFilter(
      new URLSearchParams("s=makey&location=loc-1&category=category-1&page=3"),
      filter
    );

    expect(result.get("status")).toBe(status);
    expect(result.get("s")).toBe("makey");
    expect(result.get("location")).toBe("loc-1");
    expect(result.has("page")).toBe(false);
    expect(result.get("assetKitFilter")).toBe(kitFilter);
    expect(result.getAll("category")).toEqual(["category-1"]);
  });

  it("keeps an independently selected category when clearing a quick filter", () => {
    const result = applyInventoryQuickFilter(
      new URLSearchParams(
        `status=${AssetStatus.AVAILABLE}&assetKitFilter=IN_OTHER_KITS&category=category-1&category=__ioio-kit__`
      ),
      "all"
    );

    expect(result.get("status")).toBeNull();
    expect(result.getAll("category")).toEqual(["category-1"]);
    expect(result.has("assetKitFilter")).toBe(false);
  });
});
