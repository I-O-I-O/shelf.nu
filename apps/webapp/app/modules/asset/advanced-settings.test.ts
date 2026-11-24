import { describe, expect, it } from "vitest";
import { assetAdvancedSettingsSchema } from "./advanced-settings";

describe("asset advanced settings", () => {
  it("keeps blank min quantity nullable and parses an explicit whole number", () => {
    const blank = assetAdvancedSettingsSchema.parse({ minQuantity: "  " });
    const configured = assetAdvancedSettingsSchema.parse({ minQuantity: "5" });

    expect(blank.minQuantity).toBeNull();
    expect(configured.minQuantity).toBe(5);
  });
});
