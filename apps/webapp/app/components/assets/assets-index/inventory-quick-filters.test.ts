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
      "Hidden",
    ]);
  });

  it.each<[InventoryQuickFilter, string | null, string | null, string | null]>([
    ["all", null, null, null],
    ["available", AssetStatus.AVAILABLE, null, null],
    ["checked-out", AssetStatus.CHECKED_OUT, null, null],
    ["kits", null, "IN_OTHER_KITS", null],
    ["hidden", null, null, "hidden"],
  ])("applies the %s quick filter", (filter, status, kitFilter, visibility) => {
    const result = applyInventoryQuickFilter(
      new URLSearchParams(
        "s=makey&location=loc-1&category=category-1&page=3&ioioVisibility=hidden"
      ),
      filter
    );

    expect(result.get("status")).toBe(status);
    expect(result.get("s")).toBe("makey");
    expect(result.get("location")).toBe("loc-1");
    expect(result.has("page")).toBe(false);
    expect(result.get("assetKitFilter")).toBe(kitFilter);
    expect(result.get("ioioVisibility")).toBe(visibility);
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
    expect(result.has("ioioVisibility")).toBe(false);
  });
});
