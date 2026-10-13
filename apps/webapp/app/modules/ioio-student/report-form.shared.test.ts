import { describe, expect, it } from "vitest";
import type { StudentAsset } from "~/modules/ioio-student/service.server";
import {
  getReportAssetOptions,
  searchReportAssets,
} from "./report-form.shared";
import {
  classifyIoioReport,
  IOIO_REPORT_LABELS,
} from "./report-problem.shared";

function studentAsset(overrides: Partial<StudentAsset>): StudentAsset {
  return {
    id: "asset-id",
    title: "Makey Kit #001",
    description: null,
    mainImage: null,
    mainImageExpiration: null,
    thumbnailImage: null,
    assetModel: null,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    assetModelId: null,
    status: "AVAILABLE",
    type: "INDIVIDUAL",
    quantity: null,
    availableQuantity: 1,
    availableToBook: true,
    sequentialId: "001",
    category: null,
    locations: [],
    kits: [],
    qrIds: [],
    ...overrides,
  } as StudentAsset;
}

describe("Student report asset options", () => {
  it("shows the canonical logical product first with its exact unit choices", () => {
    const options = getReportAssetOptions(
      [
        studentAsset({
          id: "unit-2",
          title: "Makey Kit #002",
          sequentialId: "002",
          assetModelId: "makey-model",
        }),
        studentAsset({
          id: "unit-1",
          title: "Makey Kit #001",
          sequentialId: "001",
          assetModelId: "makey-model",
        }),
      ],
      (label) => label
    );

    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({
      label: "Makey Kit",
      defaultUnitId: null,
      units: [
        { id: "unit-1", label: "#001" },
        { id: "unit-2", label: "#002" },
      ],
    });
  });

  it("automatically selects the only physical unit and omits choices for pooled assets", () => {
    const options = getReportAssetOptions(
      [
        studentAsset({
          id: "camera-1",
          title: "Camera #001",
          assetModelId: null,
        }),
        studentAsset({
          id: "tripods",
          title: "Tripod",
          type: "QUANTITY_TRACKED",
          quantity: 4,
          assetModelId: null,
        }),
      ],
      (label) => label
    );

    expect(options.find(({ id }) => id === "camera-1")).toMatchObject({
      units: [{ id: "camera-1", label: "#001" }],
      defaultUnitId: "camera-1",
    });
    expect(options.find(({ id }) => id === "tripods")).toMatchObject({
      units: [],
      defaultUnitId: null,
    });
  });

  it("labels only unresolved reported exact units and keeps siblings selectable", () => {
    const options = getReportAssetOptions(
      [
        studentAsset({
          id: "unit-3",
          title: "Makey Kit #003",
          sequentialId: "003",
          assetModelId: "makey-model",
        }),
        studentAsset({
          id: "unit-2",
          title: "Makey Kit #002",
          sequentialId: "002",
          assetModelId: "makey-model",
        }),
        studentAsset({
          id: "unit-1",
          title: "Makey Kit #001",
          sequentialId: "001",
          assetModelId: "makey-model",
        }),
      ],
      (label) => label,
      new Set(["unit-3"])
    );

    expect(options[0].units).toEqual([
      { id: "unit-1", label: "#001", reported: false },
      { id: "unit-2", label: "#002", reported: false },
      { id: "unit-3", label: "#003 — Reported", reported: true },
    ]);
  });
});

describe("Student report item search", () => {
  it("matches logical product names and exact unit labels without returning a flat unit list", () => {
    const options = getReportAssetOptions(
      [
        studentAsset({
          id: "unit-1",
          title: "Makey Kit #001",
          assetModelId: "makey-model",
        }),
        studentAsset({
          id: "unit-2",
          title: "Makey Kit #002",
          assetModelId: "makey-model",
        }),
        studentAsset({
          id: "camera-1",
          title: "Camera #001",
          assetModelId: "camera-model",
        }),
      ],
      (label) => label
    );

    expect(
      searchReportAssets(options, "Makey").map(({ label }) => label)
    ).toEqual(["Makey Kit"]);
    expect(
      searchReportAssets(options, "#002").map(({ label }) => label)
    ).toEqual(["Makey Kit"]);
  });
});

describe("shared IOIO report classification and labels", () => {
  it.each([
    ["WRONG_LOCATION", "general"],
    ["LOCATION_FULL", "general"],
    ["OTHER", "general"],
    ["ITEM_MISSING", "general"],
    ["CANNOT_FIND", "general"],
    ["ITEM_DAMAGED", "equipment-condition"],
    ["KIT_INCOMPLETE", "equipment-condition"],
  ] as const)("classifies %s as %s", (type, classification) => {
    expect(classifyIoioReport(type)).toBe(classification);
  });

  it("provides human-readable labels for report enum values", () => {
    expect(IOIO_REPORT_LABELS.WRONG_LOCATION).toBe("Wrong location");
    expect(IOIO_REPORT_LABELS.ITEM_DAMAGED).toBe("Item damaged");
  });
});
