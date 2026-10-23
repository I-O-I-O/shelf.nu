import { describe, expect, it } from "vitest";
import {
  formatStudentAssetLocation,
  getCompactLocationSummary,
} from "./compact-location";

describe("getCompactLocationSummary", () => {
  it("keeps the room and every named storage level", () => {
    expect(
      getCompactLocationSummary([
        "IOIO Lab - B477",
        "Section A",
        "Shelf A1",
        "Container A1-13",
      ])
    ).toEqual({
      room: "IOIO Lab - B477",
      storageLabel: "Section A · Shelf A1 · Container A1-13",
    });
  });

  it("omits empty location levels", () => {
    expect(
      getCompactLocationSummary(["Room B477", "  ", "Shelf A1", ""])
    ).toEqual({ room: "Room B477", storageLabel: "Shelf A1" });
  });

  it("does not repeat hierarchy labels already present in stored names", () => {
    expect(
      getCompactLocationSummary([
        "IOIO Lab - B477",
        "Section Section A",
        "Shelf Shelf A1",
        "Container Container A1-13",
      ])
    ).toEqual({
      room: "IOIO Lab - B477",
      storageLabel: "Section A · Shelf A1 · Container A1-13",
    });
  });

  it("normalizes the misspelled section prefix without changing stored data", () => {
    expect(getCompactLocationSummary(["IOIO Lab - B477", "Seciton A"])).toEqual(
      { room: "IOIO Lab - B477", storageLabel: "Section A" }
    );
  });

  it("keeps only the room and deepest assigned descendant for asset quick views", () => {
    expect(
      getCompactLocationSummary(
        ["IOIO Lab - B477", "Section A", "Shelf A1", "Container A1-13"],
        { showIntermediateLocations: false }
      )
    ).toEqual({
      room: "IOIO Lab - B477",
      storageLabel: "Container A1-13",
    });
    expect(
      getCompactLocationSummary(["IOIO Lab - B477", "Section A", "Shelf A1"], {
        showIntermediateLocations: false,
      }).storageLabel
    ).toBe("Shelf A1");
    expect(
      getCompactLocationSummary(["IOIO Lab - B477", "Section A"], {
        showIntermediateLocations: false,
      }).storageLabel
    ).toBe("Section A");
    expect(
      getCompactLocationSummary(["IOIO Lab - B477"], {
        showIntermediateLocations: false,
      })
    ).toEqual({ room: "IOIO Lab - B477", storageLabel: null });
  });
});

describe("formatStudentAssetLocation", () => {
  it("shows the room and assigned container without intermediate levels", () => {
    expect(
      formatStudentAssetLocation([
        "IOIO Lab - B477",
        "Section A",
        "Shelf A1",
        "Container A1-1.1",
      ])
    ).toBe("IOIO Lab - B477 · Container A1-1.1");
  });

  it("shows the room and assigned shelf", () => {
    expect(
      formatStudentAssetLocation(["IOIO Lab - B477", "Section A", "Shelf A1"])
    ).toBe("IOIO Lab - B477 · Shelf A1");
  });

  it("does not duplicate a room assigned directly to an asset", () => {
    expect(formatStudentAssetLocation(["IOIO Lab - B477"])).toBe(
      "IOIO Lab - B477"
    );
  });

  it("uses the room name when no room code is present", () => {
    expect(
      formatStudentAssetLocation([
        "IOIO Lab",
        "Section A",
        "Shelf A1",
        "Container A1-1.1",
      ])
    ).toBe("IOIO Lab · Container A1-1.1");
  });

  it("preserves a cabinet as the final assigned location", () => {
    expect(
      formatStudentAssetLocation(["IOIO Lab - B477", "Section A", "Cabinet 3"])
    ).toBe("IOIO Lab - B477 · Cabinet 3");
  });

  it("returns null safely when no location path is available", () => {
    expect(formatStudentAssetLocation([])).toBeNull();
  });
});
