import { describe, expect, it } from "vitest";
import { getParamsValues, IOIO_KIT_CATEGORY_FILTER } from "./list";

describe("IOIO Inventory kit filter query mapping", () => {
  it("maps the visible Kit category option to Shelf's native kit filter", () => {
    const params = new URLSearchParams();
    params.append("category", "electronics");
    params.append("category", IOIO_KIT_CATEGORY_FILTER);

    expect(getParamsValues(params)).toMatchObject({
      categoriesIds: ["electronics"],
      assetKitFilter: "IN_OTHER_KITS",
    });
  });

  it("keeps an explicitly selected kit filter authoritative", () => {
    const params = new URLSearchParams({
      category: IOIO_KIT_CATEGORY_FILTER,
      assetKitFilter: "NOT_IN_KIT",
    });

    expect(getParamsValues(params)).toMatchObject({
      categoriesIds: [],
      assetKitFilter: "NOT_IN_KIT",
    });
  });
});
