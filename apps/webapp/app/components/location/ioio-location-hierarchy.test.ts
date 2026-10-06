import {
  formatIoioRoomHeader,
  formatIoioLocationName,
  groupIoioLocations,
  type IoioLocation,
} from "./ioio-location-hierarchy";

function location(
  name: string,
  parent?: { name: string; parentId: string | null }
) {
  return {
    id: name,
    name,
    parentId: parent ? `parent-${parent.name}` : null,
    parent: parent
      ? {
          id: `parent-${parent.name}`,
          name: parent.name,
          parentId: parent.parentId,
          _count: { children: 0 },
        }
      : null,
    _count: { children: 0, assetLocations: 0, kits: 0 },
  } as unknown as IoioLocation;
}

describe("IOIO location hierarchy presentation", () => {
  it("preserves the canonical stored room name", () => {
    expect(formatIoioLocationName("B477 \u2014 IOIO Lab")).toEqual({
      label: "B477 \u2014 IOIO Lab",
      code: null,
    });
    expect(formatIoioLocationName("B477 - IOIO Lab")).toEqual({
      label: "B477 - IOIO Lab",
      code: null,
    });
  });

  it("uses the exact Locations value for label headers", () => {
    expect(formatIoioRoomHeader("IOIO Lab - B477")).toBe("IOIO Lab - B477");
    expect(formatIoioRoomHeader("B442 - Narnia / Storage Room")).toBe(
      "B442 - Narnia / Storage Room"
    );
    expect(formatIoioRoomHeader("Workshop North")).toBe("Workshop North");
  });

  it("groups recursive locations into presentation levels", () => {
    const groups = groupIoioLocations([
      location("B477 \u2014 IOIO Lab"),
      location("Section A", { name: "B477 \u2014 IOIO Lab", parentId: null }),
      location("Shelf A1", { name: "Section A", parentId: "room" }),
      location("Container A1-13", { name: "Shelf A1", parentId: "section" }),
    ]);

    expect(groups.map((group) => [group.kind, group.locations.length])).toEqual(
      [
        ["Rooms", 1],
        ["Sections", 1],
        ["Shelves", 1],
        ["Containers", 1],
      ]
    );
  });
});
