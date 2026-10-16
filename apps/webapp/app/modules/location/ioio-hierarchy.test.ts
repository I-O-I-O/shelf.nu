import { describe, expect, it } from "vitest";
import {
  findDuplicateIoioSiblingName,
  getIoioLocationParentError,
  inferIoioLocationKind,
  summarizeIoioLocationInventory,
} from "~/modules/location/ioio-hierarchy";

describe("IOIO location hierarchy validation", () => {
  it("classifies arbitrary names by their canonical hierarchy depth", () => {
    const locations = [
      { id: "room", name: "B477", parentId: null },
      { id: "section", name: "Assembly", parentId: "room" },
      { id: "shelf", name: "A1", parentId: "section" },
      { id: "container", name: "A1-13", parentId: "shelf" },
    ];
    const byId = new Map(locations.map((location) => [location.id, location]));

    expect(inferIoioLocationKind(locations[0]!, byId)).toBe("Rooms");
    expect(inferIoioLocationKind(locations[1]!, byId)).toBe("Sections");
    expect(inferIoioLocationKind(locations[2]!, byId)).toBe("Shelves");
    expect(inferIoioLocationKind(locations[3]!, byId)).toBe("Containers");
  });

  it.each([
    ["section", { parentId: null, grandparentId: null }, null],
    ["shelf", { parentId: "room", grandparentId: null }, null],
    ["shelf", { parentId: null, grandparentId: null }, null],
    ["container", { parentId: "section", grandparentId: "room" }, null],
  ] as const)(
    "accepts %s at a valid hierarchy depth",
    (locationType, parent) => {
      expect(
        getIoioLocationParentError({
          locationType,
          parentId: "parent",
          parent: { name: "Parent", ...parent },
        })
      ).toBeNull();
    }
  );

  it("requires containers to be placed under a shelf", () => {
    expect(
      getIoioLocationParentError({
        locationType: "container",
        parentId: "room",
        parent: { name: "Room", parentId: null, grandparentId: null },
      })
    ).toBe("A container must be placed inside a shelf.");
  });

  it("rejects sibling names that differ only by case or surrounding spaces", () => {
    expect(findDuplicateIoioSiblingName([" Shelf A1 "], "shelf a1")).toBe(
      " Shelf A1 "
    );
    expect(findDuplicateIoioSiblingName(["Shelf A1"], "Shelf A2")).toBe(
      undefined
    );
  });

  it("counts unique active assignments in containers and rolls them up to ancestors", () => {
    const locations = [
      { id: "room", name: "IOIO Lab - B477", parentId: null },
      { id: "section", name: "Section A", parentId: "room" },
      { id: "shelf", name: "Shelf A1", parentId: "section" },
      { id: "container", name: "Container A1-13", parentId: "shelf" },
      { id: "broken", name: "Broken Section", parentId: null },
    ];
    const summary = summarizeIoioLocationInventory({
      locations,
      assignments: [
        { assetId: "container-asset", locationId: "container" },
        { assetId: "container-asset", locationId: "container" },
        { assetId: "container-asset", locationId: "shelf" },
        { assetId: "shelf-asset", locationId: "shelf" },
        { assetId: "section-asset", locationId: "section" },
        { assetId: "room-asset", locationId: "room" },
        { assetId: "broken-asset", locationId: "broken" },
      ],
      unassignedAssetCount: 1,
    });

    expect(summary.containerAssetCounts.container).toBe(1);
    expect(summary.sections.section).toEqual({
      shelves: 1,
      containers: 1,
      assets: 1,
    });
    expect(summary.rooms.room).toEqual({
      sections: 1,
      shelves: 1,
      containers: 1,
      assets: 1,
    });
    expect(summary.unassignedOrIncompleteAssetCount).toBe(4);
  });
});
