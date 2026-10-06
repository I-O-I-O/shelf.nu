import { describe, expect, it } from "vitest";
import { resolveFuzzyInventoryCandidates } from "./inventory-search.shared";

describe("confidence-gated fuzzy inventory matching", () => {
  it("groups physical units under one logical product before deciding ambiguity", () => {
    expect(
      resolveFuzzyInventoryCandidates([
        {
          productId: "arduino-model",
          name: "Arduino Kit",
          score: 0.44,
          assetIds: ["unit-001"],
        },
        {
          productId: "arduino-model",
          name: "Arduino Kit",
          score: 0.48,
          assetIds: ["unit-002"],
        },
      ])
    ).toEqual({
      kind: "unique",
      matches: [
        {
          productId: "arduino-model",
          name: "Arduino Kit",
          score: 0.48,
          assetIds: ["unit-001", "unit-002"],
        },
      ],
    });
  });

  it("selects a clearly stronger candidate without hardcoded typo aliases", () => {
    expect(
      resolveFuzzyInventoryCandidates([
        {
          productId: "microbit-kit",
          name: "Micro:bit Kit",
          score: 0.52,
          assetIds: ["a"],
        },
        {
          productId: "microcontroller-kit",
          name: "Microcontroller Kit",
          score: 0.37,
          assetIds: ["b"],
        },
      ])
    ).toMatchObject({ kind: "unique", matches: [{ name: "Micro:bit Kit" }] });
  });

  it("asks for clarification when distinct products have close scores", () => {
    expect(
      resolveFuzzyInventoryCandidates([
        {
          productId: "motor",
          name: "Motor",
          score: 0.47,
          assetIds: ["a"],
        },
        {
          productId: "motor-driver",
          name: "Motor Driver",
          score: 0.43,
          assetIds: ["b"],
        },
      ])
    ).toMatchObject({
      kind: "ambiguous",
      matches: [{ name: "Motor" }, { name: "Motor Driver" }],
    });
  });

  it("rejects candidates below the confidence threshold", () => {
    expect(
      resolveFuzzyInventoryCandidates([
        {
          productId: "unrelated",
          name: "Unrelated Item",
          score: 0.21,
          assetIds: ["a"],
        },
      ])
    ).toEqual({ kind: "none", matches: [] });
  });
});
