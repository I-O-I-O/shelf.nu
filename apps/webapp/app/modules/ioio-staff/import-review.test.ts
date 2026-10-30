import { describe, expect, it } from "vitest";
import {
  resolveImportReviewState,
  validateImportRowForApply,
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
  trackingModeConfirmed: true,
  trackingModeSelectedByStaff: true,
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

  it("requires a staff-selected tracking mode before using individual tracking", () => {
    const defaultQuantityRow: ImportReviewRow = {
      ...readyRow,
      type: "QUANTITY_TRACKED",
      trackingSource: "DETERMINISTIC_DEFAULT",
    };
    const unselectedIndividual = {
      ...approved,
      type: "INDIVIDUAL" as const,
      trackingModeSelectedByStaff: false,
    };

    expect(evaluate(defaultQuantityRow, unselectedIndividual)).toBe(
      "NEEDS_REVIEW"
    );
    expect(
      evaluate(defaultQuantityRow, {
        ...unselectedIndividual,
        trackingModeSelectedByStaff: true,
      })
    ).toBe("READY");
  });

  it("allows a grouped Mouser row to remain uncategorized when no category was suggested", () => {
    const mouserRow: ImportReviewRow = {
      ...readyRow,
      categoryId: null,
      mouserLineItem: true,
      type: null,
    };
    expect(
      evaluate(mouserRow, {
        ...approved,
        categoryId: null,
        type: null,
      })
    ).toBe("READY");
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

describe("structured Apply readiness", () => {
  it("explains a historical CONFLICT with an invalid location", () => {
    const result = validateImportRowForApply({
      row: { ...readyRow, action: "CONFLICT" },
      decision: { ...approved, locationId: "deleted-location" },
      categoryAvailable: true,
      locationAvailable: false,
    });
    expect(result).toMatchObject({
      ready: false,
      state: "NEEDS_REVIEW",
      issues: [{ code: "INVALID_LOCATION" }],
    });
    expect(result.issues[0].message).toContain("Arduino Nano");
    expect(result.issues[0].message).not.toContain("CONFLICT");
  });
  it("does not gate a resolved row on historical CONFLICT or a second approval", () => {
    expect(
      validateImportRowForApply({
        row: { ...readyRow, action: "CONFLICT" },
        decision: { ...approved, decision: null },
        categoryAvailable: true,
        locationAvailable: true,
      })
    ).toEqual({ ready: true, state: "READY", issues: [] });
  });
  it("returns every missing decision for a batch row", () => {
    const result = validateImportRowForApply({
      row: {
        ...readyRow,
        action: "POSSIBLE_DUPLICATE",
        locationResolution: "UNMATCHED",
      },
      decision: {
        ...approved,
        quantity: null,
        categoryId: null,
        trackingModeConfirmed: false,
      },
      categoryAvailable: false,
      locationAvailable: false,
    });
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "MISSING_QUANTITY",
        "MISSING_CATEGORY",
        "MISSING_LOCATION",
        "AMBIGUOUS_EXISTING_MATCH",
        "TRACKING_REVIEW_REQUIRED",
      ])
    );
  });
});

it("does not let missing image or description block an otherwise valid product", () => {
  expect(
    validateImportRowForApply({
      row: {
        ...readyRow,
        uncertainFields: ["Product image", "AssetModel description"],
      },
      decision: { ...approved, decision: null },
      categoryAvailable: true,
      locationAvailable: true,
    })
  ).toMatchObject({ ready: true, issues: [] });
});
it.each([0, -1, 1.5, Infinity, NaN])(
  "explains invalid quantity %s",
  (quantity) => {
    expect(
      validateImportRowForApply({
        row: readyRow,
        decision: { ...approved, quantity },
        categoryAvailable: true,
        locationAvailable: true,
      })
    ).toMatchObject({ ready: false, issues: [{ code: "INVALID_QUANTITY" }] });
  }
);
it("reports completed and ignored rows explicitly", () => {
  expect(
    validateImportRowForApply({
      row: readyRow,
      decision: approved,
      categoryAvailable: true,
      locationAvailable: true,
      alreadyImported: true,
    })
  ).toMatchObject({
    ready: false,
    state: "IMPORTED",
    issues: [{ code: "ALREADY_IMPORTED" }],
  });
  expect(
    validateImportRowForApply({
      row: readyRow,
      decision: { ...approved, decision: "IGNORE" },
      categoryAvailable: true,
      locationAvailable: true,
    })
  ).toMatchObject({
    ready: false,
    state: "IGNORED",
    issues: [{ code: "IGNORED" }],
  });
});
