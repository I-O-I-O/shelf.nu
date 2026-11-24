import { describe, expect, it } from "vitest";
import { partitionInventoryVisibilitySelection } from "./inventory-visibility-selection";

describe("inventory visibility selection", () => {
  it("splits mixed selections so Hide and Unhide target only matching assets", () => {
    const visible = { id: "visible-1", ioioHidden: false };
    const hidden = { id: "hidden-1", ioioHidden: true };
    const modelHiddenUnit = {
      id: "hidden-model-unit",
      assetModel: { ioioHidden: true },
    };

    const result = partitionInventoryVisibilitySelection([
      visible,
      hidden,
      modelHiddenUnit,
    ]);

    expect(result.visibleItems).toEqual([visible]);
    expect(result.hiddenItems).toEqual([hidden, modelHiddenUnit]);
  });

  it("returns no targets for an action that would repeat the current state", () => {
    const hidden = { id: "hidden-1", ioioHidden: true };
    const visible = { id: "visible-1", ioioHidden: false };

    expect(
      partitionInventoryVisibilitySelection([hidden]).visibleItems
    ).toEqual([]);
    expect(
      partitionInventoryVisibilitySelection([visible]).hiddenItems
    ).toEqual([]);
  });
});
