import { describe, expect, it } from "vitest";
import { getSelectedAssetModelIds } from "./organize-selection";

describe("selected inventory product handoff", () => {
  it("preserves distinct selected AssetModels and deduplicates units of one model", () => {
    expect(
      getSelectedAssetModelIds([
        { assetModelId: "usb-c-cable" },
        { assetModelId: "arduino-nano" },
        { assetModelId: "motor" },
        { assetModelId: "smalaa" },
        { assetModelId: "usb-c-cable" },
      ])
    ).toEqual(["usb-c-cable", "arduino-nano", "motor", "smalaa"]);
  });

  it("does not silently drop selected assets without an AssetModel", () => {
    expect(
      getSelectedAssetModelIds([
        { assetModelId: "arduino-nano" },
        { assetModelId: null },
      ])
    ).toBeNull();
  });
});
