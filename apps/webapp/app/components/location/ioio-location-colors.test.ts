import { describe, expect, it } from "vitest";
import {
  getDerivedIoioLocationColor,
  getEffectiveIoioLocationColor,
  getFirstAvailableIoioColor,
  getIoioRoomColorError,
  getIoioSectionColorError,
  getUsedIoioRoomColors,
  getUsedIoioSectionColors,
  IOIO_LOCATION_COLORS,
} from "./ioio-location-colors";

const hierarchy = () => [
  { id: "room-1", name: "Room B477", parentId: null, color: "#455A64" },
  { id: "section-a", name: "Section A", parentId: "room-1", color: "#1565C0" },
  { id: "section-b", name: "Section B", parentId: "room-1", color: "#C62828" },
  { id: "shelf-a", name: "Shelf A1", parentId: "section-a", color: null },
  { id: "box-a", name: "Container A1-1", parentId: "shelf-a", color: null },
  { id: "room-2", name: "Room B478", parentId: null, color: "#455A64" },
  { id: "section-c", name: "Section C", parentId: "room-2", color: "#1565C0" },
];

describe("IOIO Section colors", () => {
  it("reserves Room colors across root locations and chooses the first free color", () => {
    const locations = hierarchy();
    const used = getUsedIoioRoomColors({ locations });
    expect(used).toEqual(new Set(["#455a64"]));
    expect(getFirstAvailableIoioColor(used)).toBe("#1565C0");
    expect(getIoioRoomColorError({ color: "#455A64", locations })).toMatch(
      /Room B477/u
    );
    expect(
      getIoioRoomColorError({
        color: "#455A64",
        locations,
        currentLocationId: "room-1",
      })
    ).toMatch(/Room B478/u);
    expect(getIoioRoomColorError({ color: "#1565C0", locations })).toBeNull();
    const uniqueRooms = locations.filter((entry) => entry.id !== "room-2");
    expect(
      getIoioRoomColorError({
        color: "#455A64",
        locations: uniqueRooms,
        currentLocationId: "room-1",
      })
    ).toBeNull();
  });

  it("returns no default when every palette color is taken", () => {
    expect(
      getFirstAvailableIoioColor(
        new Set(IOIO_LOCATION_COLORS.map((entry) => entry.color.toLowerCase()))
      )
    ).toBeNull();
    const rooms = IOIO_LOCATION_COLORS.map((entry, index) => ({
      id: `room-${index}`,
      name: `Room ${index}`,
      parentId: null,
      color: entry.color,
    }));
    expect(getIoioRoomColorError({ color: null, locations: rooms })).toMatch(
      /No room colors are available/u
    );
    const sections = rooms.map((entry) => ({
      ...entry,
      parentId: "room",
    }));
    expect(
      getIoioSectionColorError({
        color: null,
        locations: sections,
        parentId: "room",
      })
    ).toMatch(/No section colors are available/u);
  });
  it("reserves colors only among sibling Sections and permits the current Section's own color", () => {
    const locations = hierarchy();
    expect(getUsedIoioSectionColors({ locations, parentId: "room-1" })).toEqual(
      new Set(["#1565c0", "#c62828"])
    );
    expect(
      getIoioSectionColorError({
        color: "#1565C0",
        locations,
        parentId: "room-1",
        currentLocationId: "section-a",
      })
    ).toBeNull();
    expect(
      getIoioSectionColorError({
        color: "#1565C0",
        locations,
        parentId: "room-1",
      })
    ).toMatch(/already used/u);
    expect(
      getIoioSectionColorError({
        color: "#1565C0",
        locations,
        parentId: "room-2",
        currentLocationId: "section-c",
      })
    ).toBeNull();
  });

  it("frees a Section color when its assignment changes", () => {
    const locations = hierarchy().map((location) =>
      location.id === "section-a" ? { ...location, color: "#2E7D32" } : location
    );
    expect(
      getIoioSectionColorError({
        color: "#1565C0",
        locations,
        parentId: "room-1",
      })
    ).toBeNull();
  });

  it("reserves the Room fallback color of a legacy Section with no assigned color", () => {
    const locations = [
      { id: "room", name: "B477", parentId: null, color: "#1565C0" },
      { id: "legacy", name: "Seciton A", parentId: "room", color: null },
    ];
    expect(getUsedIoioSectionColors({ locations, parentId: "room" })).toEqual(
      new Set(["#1565c0"])
    );
    expect(
      getIoioSectionColorError({
        color: "#1565C0",
        locations,
        parentId: "room",
      })
    ).toBe("This color is already used by Seciton A in this room.");
    expect(
      getFirstAvailableIoioColor(
        getUsedIoioSectionColors({ locations, parentId: "room" })
      )
    ).toBe("#2E7D32");
  });

  it("uses parent depth rather than a location's name to identify sibling Sections", () => {
    const locations = [
      { id: "room", name: "B477", parentId: null, color: "#1565C0" },
      {
        id: "section",
        name: "Shelf Storage",
        parentId: "room",
        color: "#6A1B9A",
      },
    ];
    expect(
      getIoioSectionColorError({
        color: "#6A1B9A",
        locations,
        parentId: "room",
      })
    ).toBe("This color is already used by Shelf Storage in this room.");
  });

  it("detects a Section color conflict in its new parent room", () => {
    const locations = hierarchy();
    expect(
      getIoioSectionColorError({
        color: "#1565C0",
        locations,
        parentId: "room-2",
        currentLocationId: "section-a",
      })
    ).toMatch(/already used/u);
  });

  it("inherits the Section color at every descendant depth and after moves", () => {
    const locations = hierarchy();
    for (const id of ["section-a", "shelf-a", "box-a"]) {
      expect(
        getEffectiveIoioLocationColor({
          location: locations.find((location) => location.id === id),
          locations,
        }).color
      ).toBe("#1565C0");
    }
    expect(
      getDerivedIoioLocationColor({
        name: "New Container",
        locations,
        parentId: "box-a",
        locationType: "container",
      }).color
    ).toBe("#1565C0");

    const moved = locations.map((location) =>
      location.id === "shelf-a"
        ? { ...location, parentId: "section-b" }
        : location
    );
    for (const id of ["shelf-a", "box-a"]) {
      expect(
        getEffectiveIoioLocationColor({
          location: moved.find((location) => location.id === id),
          locations: moved,
        }).color
      ).toBe("#C62828");
    }
  });

  it("updates descendants when a Section color changes without updating them", () => {
    const locations = hierarchy().map((location) =>
      location.id === "section-a" ? { ...location, color: "#2E7D32" } : location
    );
    expect(
      getEffectiveIoioLocationColor({
        location: locations.find((location) => location.id === "box-a"),
        locations,
      }).color
    ).toBe("#2E7D32");
  });

  it("uses the existing neutral fallback when a location has no Room or Section ancestor", () => {
    const locations = [
      ...hierarchy(),
      { id: "orphan", name: "Unassigned", parentId: "missing", color: null },
    ];
    expect(
      getEffectiveIoioLocationColor({
        location: locations.at(-1),
        locations,
      }).color
    ).toBe("#455A64");
  });
});
