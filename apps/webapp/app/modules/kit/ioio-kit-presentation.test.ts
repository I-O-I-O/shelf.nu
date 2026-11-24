import { describe, expect, it } from "vitest";
import {
  deduplicateIoioKitPresentationCandidates,
  getIoioKitDisplayName,
  getIoioKitPhysicalUnitNumber,
  getIoioPhysicalUnitDisplayName,
} from "./ioio-kit-presentation";

describe("IOIO Kit presentation candidates", () => {
  it("uses the native Kit name without imported unit suffixes", () => {
    expect(getIoioKitDisplayName({ name: "Arduino Kit" })).toBe("Arduino Kit");
    expect(getIoioKitDisplayName({ name: "Arduino Kit - #014 Board" })).toBe(
      "Arduino Kit"
    );
  });

  it("exposes only an explicit trailing Kit unit number", () => {
    expect(
      getIoioKitPhysicalUnitNumber({ name: "Makey Makey Kit - #003" })
    ).toBe("#003");
    expect(
      getIoioKitPhysicalUnitNumber({ name: "Arduino Kit - #014 Board" })
    ).toBeNull();
    expect(getIoioKitPhysicalUnitNumber({ name: "Arduino Kit" })).toBeNull();
  });

  it("renders a physical unit suffix exactly once", () => {
    expect(getIoioPhysicalUnitDisplayName("Arduino Kit", "002")).toBe(
      "Arduino Kit #002"
    );
    expect(getIoioPhysicalUnitDisplayName("Arduino Kit #002", "#002")).toBe(
      "Arduino Kit #002"
    );
    expect(
      getIoioPhysicalUnitDisplayName("Arduino Kit - #002 Board", "#002")
    ).toBe("Arduino Kit #002");
  });

  it("uses structured unit data and identifies missing numbers", () => {
    expect(
      getIoioPhysicalUnitDisplayName({
        logicalProductName: "Makey Makey Kit",
        unitNumber: "1",
      })
    ).toBe("Makey Makey Kit #001");
    expect(
      getIoioPhysicalUnitDisplayName({
        logicalProductName: "Makey Makey Kit",
        unitNumber: null,
        missingUnitLabel: "Unit number missing",
      })
    ).toBe("Makey Makey Kit Unit number missing");
  });

  it("chooses the populated duplicate while keeping identity scoped", () => {
    const rows = deduplicateIoioKitPresentationCandidates([
      {
        id: "empty",
        name: "Makey Makey Kit",
        categoryId: "boards",
        locationId: "section-d",
        assetCount: 0,
      },
      {
        id: "populated",
        name: " Makey   Makey Kit ",
        categoryId: "boards",
        locationId: "section-d",
        assetCount: 5,
      },
      {
        id: "imported-unit-name",
        name: "Makey Makey Kit - #014 Board",
        categoryId: "boards",
        locationId: "section-d",
        assetCount: 3,
      },
      {
        id: "different-location",
        name: "Makey Makey Kit",
        categoryId: "boards",
        locationId: "section-e",
        assetCount: 0,
      },
    ]);

    expect(rows.map((row) => row.id)).toEqual([
      "populated",
      "different-location",
    ]);
  });

  it("keeps an explicitly preselected Kit as the one option", () => {
    const rows = deduplicateIoioKitPresentationCandidates(
      [
        {
          id: "canonical",
          name: "Makey Makey Kit",
          categoryId: "boards",
          locationId: "section-d",
          assetCount: 5,
        },
        {
          id: "preselected",
          name: "Makey Makey Kit",
          categoryId: "boards",
          locationId: "section-d",
          assetCount: 0,
        },
      ],
      "preselected"
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("preselected");
  });
});
