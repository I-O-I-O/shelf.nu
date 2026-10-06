import { describe, expect, it } from "vitest";
import {
  getFirstAvailableLocationColor,
  getUsedSiblingColors,
} from "./ioio-location-color-picker";
import {
  getEffectiveIoioLocationColor,
  getIoioLocationColor,
} from "./ioio-location-colors";

describe("getIoioLocationColor", () => {
  it("uses the section color for a section", () => {
    expect(
      getIoioLocationColor({ name: "Section A", parentName: "B442 - Storage" })
        .color
    ).toBe("#1565C0");
    expect(
      getIoioLocationColor({ name: "Section C", parentName: "B442 - Storage" })
        .color
    ).toBe("#C62828");
  });

  it("inherits a section color through shelves and containers", () => {
    const shelf = getIoioLocationColor({
      name: "Shelf A1",
      parentName: "Section A",
    });
    const container = getIoioLocationColor({
      name: "Box 13",
      parentName: "Shelf A1",
    });

    expect(shelf.color).toBe("#1565C0");
    expect(container.color).toBe(shelf.color);
  });

  it("follows a moved branch to its new section", () => {
    const movedShelf = getIoioLocationColor({
      name: "Shelf A1",
      ancestorNames: ["B442 - Storage", "Section B"],
    });
    const movedContainer = getIoioLocationColor({
      name: "A1-13",
      ancestorNames: ["B442 - Storage", "Section B", "Shelf A1"],
    });

    expect(movedShelf.color).toBe("#2E7D32");
    expect(movedContainer.color).toBe(movedShelf.color);
  });

  it("gives direct-room shelves a stable color from their prefix", () => {
    expect(
      getIoioLocationColor({ name: "Shelf B1", parentName: "IOIO Lab" }).color
    ).toBe("#2E7D32");
    expect(
      getIoioLocationColor({ name: "Shelf B1", parentName: "IOIO Lab" }).color
    ).toBe("#2E7D32");
  });

  it("keeps rooms neutral", () => {
    expect(
      getIoioLocationColor({ name: "B477 - IOIO Lab", isRoom: true }).color
    ).toBe("#455A64");
  });

  it("prefers an explicitly stored location color", () => {
    expect(
      getIoioLocationColor({
        name: "Section Z",
        parentName: "B477 - IOIO Lab",
        color: "#00796B",
      }).color
    ).toBe("#00796B");
  });

  it("excludes colors used by sibling locations but keeps the current value editable", () => {
    const locations = [
      {
        id: "section-a",
        name: "Section A",
        parentId: "room",
        color: "#1565C0",
      },
      {
        id: "section-b",
        name: "Section B",
        parentId: "room",
        color: "#2E7D32",
      },
    ];

    expect(getUsedSiblingColors({ locations, parentId: "room" })).toEqual(
      new Set(["#1565c0", "#2e7d32"])
    );
    expect(
      getFirstAvailableLocationColor({
        locations,
        parentId: "room",
        currentLocationId: "section-a",
      })
    ).toBe("#1565C0");
  });

  it("does not restrict room colors", () => {
    const locations = [
      { id: "room-a", name: "Room A", parentId: null, color: "#1565C0" },
      { id: "room-b", name: "Room B", parentId: null, color: "#1565C0" },
    ];

    expect(
      getUsedSiblingColors({
        locations,
        parentId: null,
        locationType: "room",
      })
    ).toEqual(new Set());
  });

  it("limits section colors only to sections under the same room", () => {
    const locations = [
      { id: "room-a", name: "Room A", parentId: null, color: null },
      { id: "room-b", name: "Room B", parentId: null, color: null },
      { id: "room-c", name: "Room C", parentId: null, color: null },
      { id: "a", name: "A", parentId: "room-a", color: "#1565C0" },
      { id: "b", name: "B", parentId: "room-a", color: "#2E7D32" },
      { id: "other", name: "Other", parentId: "room-b", color: "#1565C0" },
    ];

    expect(
      getUsedSiblingColors({
        locations,
        parentId: "room-a",
        locationType: "section",
      })
    ).toEqual(new Set(["#1565c0", "#2e7d32"]));
    expect(
      getFirstAvailableLocationColor({
        locations,
        parentId: "room-c",
        locationType: "section",
      })
    ).toBe("#1565C0");
  });

  it("inherits the nearest section color through the stored parent chain", () => {
    const locations = [
      { id: "room", name: "North", parentId: null, color: "#455A64" },
      {
        id: "section",
        name: "Unexpected name",
        parentId: "room",
        color: "#C62828",
      },
      { id: "shelf", name: "Storage 1", parentId: "section", color: "#1565C0" },
      { id: "box", name: "Drawer", parentId: "shelf", color: "#2E7D32" },
    ];

    expect(
      getEffectiveIoioLocationColor({
        location: locations[2],
        locations,
        locationType: "shelf",
      }).color
    ).toBe("#C62828");
    expect(
      getEffectiveIoioLocationColor({
        location: locations[3],
        locations,
        locationType: "container",
      }).color
    ).toBe("#C62828");
  });
});
