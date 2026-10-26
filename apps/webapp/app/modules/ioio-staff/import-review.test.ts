import { describe, expect, it } from "vitest";
import {
  resolveImportReviewState,
  type ImportReviewDecision,
  type ImportReviewRow,
} from "./import-review";

const readyRow = {
  action: "CREATE",
  title: "Arduino Nano",
  assetId: null,
  categoryId: "cat-1",
  locationId: null,
  type: "INDIVIDUAL" as const,
  quantity: 5,
};
const approved = {
  decision: "APPROVE" as const,
  title: "Arduino Nano",
  assetId: null,
  categoryId: "cat-1",
  newCategoryName: null,
  approveNewCategory: false,
  locationId: null,
  quantity: 5,
  type: "INDIVIDUAL" as const,
};

describe("staff import review readiness", () => {
  const evaluate = (
    row: ImportReviewRow = readyRow,
    decision: ImportReviewDecision | undefined = approved,
    extra: Partial<Parameters<typeof resolveImportReviewState>[0]> = {}
  ) =>
    resolveImportReviewState({
      row,
      decision,
      categoryAvailable: true,
      locationAvailable: true,
      ...extra,
    });

  it("allows fully resolved rows and explicit skips", () => {
    expect(evaluate()).toBe("READY");
    expect(evaluate(readyRow, { ...approved, decision: "IGNORE" })).toBe(
      "SKIPPED"
    );
  });

  it.each([
    ["unapproved category", { ...approved, categoryId: null }],
    ["missing tracking", { ...approved, type: null }],
    ["missing quantity", { ...approved, quantity: null }],
  ])("keeps %s in review", (_label, decision) => {
    expect(evaluate(readyRow, decision as ImportReviewDecision)).toBe(
      "NEEDS_REVIEW"
    );
  });

  it("does not let Approve bypass an ambiguous location", () => {
    expect(
      evaluate({ ...readyRow, locationResolution: "AMBIGUOUS" }, approved)
    ).toBe("NEEDS_REVIEW");
  });

  it("requires an explicit product choice when the match is ambiguous", () => {
    const ambiguous = { ...readyRow, action: "POSSIBLE_DUPLICATE" };
    expect(evaluate(ambiguous)).toBe("NEEDS_REVIEW");
    expect(evaluate(ambiguous, { ...approved, productChoice: "NEW" })).toBe(
      "READY"
    );
  });

  it("classifies stale targets as conflicts and invalid rows as invalid", () => {
    expect(
      evaluate(
        readyRow,
        { ...approved, locationId: "location-1" },
        { locationAvailable: false }
      )
    ).toBe("CONFLICT");
    expect(evaluate({ ...readyRow, action: "REJECT" })).toBe("INVALID");
  });

  it("requires valid deterministic quantity settings", () => {
    expect(
      evaluate(readyRow, {
        ...approved,
        type: "QUANTITY_TRACKED",
        minQuantity: -1,
        unitOfMeasure: "pcs",
        consumptionType: "TWO_WAY",
      })
    ).toBe("INVALID");
    expect(
      evaluate(readyRow, {
        ...approved,
        type: "QUANTITY_TRACKED",
        unitOfMeasure: "pcs",
        consumptionType: "TWO_WAY",
        minQuantity: 2,
      })
    ).toBe("READY");
  });
});
