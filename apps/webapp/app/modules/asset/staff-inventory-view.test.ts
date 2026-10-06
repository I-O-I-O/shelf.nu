import {
  buildStaffInventoryDisplayRows,
  deduplicateStaffInventoryRows,
  groupStaffInventoryCandidates,
  getStaffInventoryEditTarget,
  normalizeInventoryTitle,
  selectCanonicalInventoryCandidate,
  summarizeStaffInventory,
} from "./staff-inventory-view";

describe("staff inventory presentation helpers", () => {
  it("normalizes whitespace and case for duplicate display grouping", () => {
    expect(normalizeInventoryTitle("  Teensy   4.1 ")).toBe("teensy 4.1");
  });

  it("routes grouped inventory edits through the normal Asset edit experience", () => {
    expect(
      getStaffInventoryEditTarget({
        assetId: "physical-unit-005",
        assetModelId: "makey-model",
      })
    ).toBe("/assets/physical-unit-005/edit?productGroup=1");
  });

  it("keeps ungrouped inventory edits on the asset record", () => {
    expect(getStaffInventoryEditTarget({ assetId: "single-asset" })).toBe(
      "/assets/single-asset/edit"
    );
  });

  it("selects one operational representative without summing quantities", () => {
    const rows = deduplicateStaffInventoryRows([
      {
        id: "legacy",
        title: "Teensy 4.1",
        quantity: 10,
        availableToBook: false,
        assetLocations: [],
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "operational",
        title: " teensy 4.1 ",
        quantity: 8,
        availableToBook: true,
        assetLocations: [{ id: "placement" }],
        updatedAt: "2025-01-01T00:00:00.000Z",
      },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("operational");
    expect(rows[0].quantity).toBe(8);
    expect(rows[0].duplicateRecordCount).toBe(2);
  });

  it("uses the stable id as the final canonical tie breaker", () => {
    const canonical = selectCanonicalInventoryCandidate([
      { id: "z-asset", title: "Multimeter", availableToBook: true },
      { id: "a-asset", title: "Multimeter", availableToBook: true },
    ]);

    expect(canonical.id).toBe("a-asset");
  });

  it("summarizes canonical rows without summing duplicate records", () => {
    expect(
      summarizeStaffInventory([
        { totalQuantity: 6, availableQuantity: 4 },
        { totalQuantity: 1, availableQuantity: 0 },
      ])
    ).toEqual({
      logicalItems: 2,
      totalQuantity: 7,
      available: 4,
      inUse: 3,
    });
  });

  it("keeps individually tracked same-name assets separate when requested", () => {
    const groups = groupStaffInventoryCandidates(
      [
        {
          id: "individual-a",
          title: "Oscilloscope",
          type: "INDIVIDUAL",
        },
        {
          id: "individual-b",
          title: "Oscilloscope",
          type: "INDIVIDUAL",
        },
        {
          id: "quantity-a",
          title: "Arduino Nano",
          type: "QUANTITY_TRACKED",
        },
        {
          id: "quantity-b",
          title: " arduino   nano ",
          type: "QUANTITY_TRACKED",
        },
      ],
      { shouldGroup: (item) => item.type === "QUANTITY_TRACKED" }
    );

    expect(groups).toHaveLength(3);
    expect(
      groups.find((group) => group.canonical.title === "Arduino Nano")?.members
    ).toHaveLength(2);
    expect(
      groups.filter((group) => group.canonical.title === "Oscilloscope")
    ).toHaveLength(2);
  });

  it("groups converted physical units by native AssetModel, not by title", () => {
    const rows = buildStaffInventoryDisplayRows([
      {
        id: "unit-2",
        title: "Makey Makey Kit #002",
        type: "INDIVIDUAL",
        assetModelId: "model-a",
        assetModel: { id: "model-a", name: "Makey Makey Kit" },
      },
      {
        id: "unit-1",
        title: "Makey Makey Kit #001",
        type: "INDIVIDUAL",
        assetModelId: "model-a",
        assetModel: { id: "model-a", name: "Makey Makey Kit" },
      },
      {
        id: "unrelated",
        title: "Makey Makey Kit #003",
        type: "INDIVIDUAL",
        assetModelId: "model-b",
        assetModel: { id: "model-b", name: "Makey Makey Kit" },
      },
    ]);

    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === "unit-1")).toMatchObject({
      logicalTitle: "Makey Makey Kit",
      isExpandable: true,
      duplicateRecordCount: 2,
    });
    expect(rows.find((row) => row.id === "unrelated")).toMatchObject({
      logicalTitle: "Makey Makey Kit #003",
      isExpandable: false,
    });
  });

  it("applies native AssetModel grouping to non-kit products too", () => {
    const rows = buildStaffInventoryDisplayRows([
      {
        id: "camera-1",
        title: "Camera #001",
        type: "INDIVIDUAL",
        assetModelId: "camera-model",
        assetModel: { id: "camera-model", name: "Camera" },
      },
      {
        id: "camera-2",
        title: "Camera #002",
        type: "INDIVIDUAL",
        assetModelId: "camera-model",
        assetModel: { id: "camera-model", name: "Camera" },
      },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      logicalTitle: "Camera",
      isExpandable: true,
      duplicateRecordCount: 2,
    });
  });

  it("hides a retired zero-quantity source when active physical units exist", () => {
    const rows = buildStaffInventoryDisplayRows([
      {
        id: "retired-source",
        title: "Makey Makey Kit",
        type: "QUANTITY_TRACKED",
        quantity: 0,
      },
      {
        id: "unit-1",
        title: "Makey Makey Kit #001",
        type: "INDIVIDUAL",
        status: "AVAILABLE",
        assetModelId: "makey-model",
        assetModel: { id: "makey-model", name: "Makey Makey Kit" },
      },
      {
        id: "unit-2",
        title: "Makey Makey Kit #002",
        type: "INDIVIDUAL",
        status: "AVAILABLE",
        assetModelId: "makey-model",
        assetModel: { id: "makey-model", name: "Makey Makey Kit" },
      },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      logicalTitle: "Makey Makey Kit",
      isExpandable: true,
      duplicateRecordCount: 2,
    });
  });
});
