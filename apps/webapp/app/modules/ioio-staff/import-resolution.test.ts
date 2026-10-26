import { describe, expect, it } from "vitest";
import {
  getImportLocationPath,
  getOperationalImportLocationIds,
  matchesReviewedImportLocationPath,
  normalizeImportLabel,
  resolveImportCategory,
  resolveImportLocation,
} from "./import-resolution";

describe("import category resolution", () => {
  const categories = [
    { id: "electronics", name: "Electronics" },
    { id: "archived", name: "Old Electronics", archived: true },
  ];

  it("reuses active names after case and whitespace normalization", () => {
    expect(resolveImportCategory("  ELECTRONICS   ", categories)).toEqual({
      status: "ACTIVE_MATCH",
      category: categories[0],
    });
    expect(normalizeImportLabel("  Power   Supplies ")).toBe("power supplies");
  });

  it("marks archived matches for review and does not propose a duplicate", () => {
    expect(resolveImportCategory("old electronics", categories)).toEqual({
      status: "ARCHIVED_MATCH",
      category: categories[1],
    });
  });

  it("returns an explicit new-category proposal when no category matches", () => {
    expect(resolveImportCategory("Sensors", categories)).toEqual({
      status: "NEW_PROPOSED",
      name: "Sensors",
    });
  });

  it("does not choose arbitrarily among duplicate normalized categories", () => {
    expect(
      resolveImportCategory("ELECTRONICS", [
        ...categories,
        { id: "electronics-2", name: " electronics " },
      ]).status
    ).toBe("AMBIGUOUS");
  });
});

describe("import location resolution", () => {
  const locations = [
    {
      id: "lab",
      name: "IOIO Lab – B477",
      parentId: null,
      pathLabel: "IOIO Lab – B477",
      operational: false,
      currentUnits: 18,
    },
    {
      id: "container",
      name: "Container A1-1.1",
      parentId: "lab",
      pathLabel: "IOIO Lab – B477 · Container A1-1.1",
      operational: false,
      currentUnits: 18,
    },
    {
      id: "container-duplicate",
      name: "Container A1-1.1",
      parentId: null,
      pathLabel: "Container A1-1.1",
      operational: false,
      currentUnits: 0,
    },
    {
      id: "pickup",
      name: "Pickup Zone",
      parentId: "lab",
      pathLabel: "IOIO Lab – B477 · Pickup Zone",
      operational: true,
      currentUnits: 2,
    },
  ];

  it("builds useful hierarchy labels", () => {
    expect(getImportLocationPath("container", locations)).toBe(
      "IOIO Lab – B477 · Container A1-1.1"
    );
  });

  it("reports duplicate names as ambiguous and accepts exact full paths", () => {
    expect(resolveImportLocation("Container A1-1.1", locations).status).toBe(
      "AMBIGUOUS"
    );
    expect(
      resolveImportLocation("IOIO Lab – B477 · Container A1-1.1", locations)
    ).toMatchObject({ status: "MATCH", location: { id: "container" } });
  });

  it("marks operational matches and excludes broken, pickup and return areas", () => {
    expect(resolveImportLocation("Pickup Zone", locations).status).toBe(
      "OPERATIONAL"
    );
    expect(
      getOperationalImportLocationIds({
        locations,
        brokenSectionId: "container",
        pickupZoneName: "Pickup Zone",
        reportReturnPath: "IOIO Lab – B477 · Pickup Zone",
      })
    ).toEqual(new Set(["container", "pickup"]));
  });

  it("preserves occupancy context without adding capacity rules", () => {
    expect(locations[1]).toMatchObject({ currentUnits: 18 });
    expect(
      resolveImportLocation("IOIO Lab – B477 · Container A1-1.1", locations)
    ).toMatchObject({ status: "MATCH" });
  });

  it("detects a removed location and a changed hierarchy before Apply", () => {
    const reviewedPath = "IOIO Lab – B477 · Container A1-1.1";
    expect(
      matchesReviewedImportLocationPath({
        expectedPath: reviewedPath,
        currentPath: reviewedPath,
        currentName: "Container A1-1.1",
      })
    ).toBe(true);
    expect(
      matchesReviewedImportLocationPath({
        expectedPath: reviewedPath,
        currentPath: "IOIO Lab – B477 · Other Room · Container A1-1.1",
        currentName: "Container A1-1.1",
      })
    ).toBe(false);
    expect(
      matchesReviewedImportLocationPath({
        expectedPath: reviewedPath,
        currentPath: "",
        currentName: "",
      })
    ).toBe(false);
  });
});
