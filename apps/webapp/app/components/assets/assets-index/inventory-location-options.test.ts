import { describe, expect, it } from "vitest";
import {
  getInventoryLocationContext,
  getInventoryLocationGroup,
  isUniqueInventoryLocationName,
  sortInventoryLocationItems,
} from "./inventory-location-options";

const locations = [
  { id: "room-b477", name: "IOIO Lab - B477", parentId: null },
  { id: "room-b478", name: "IOIO Lab - B478", parentId: null },
  { id: "section-a", name: "Section A", parentId: "room-b477" },
  { id: "section-b", name: "Section B", parentId: "room-b478" },
  { id: "shelf-a1", name: "Shelf A1", parentId: "section-a" },
  { id: "shelf-b1", name: "Shelf A1", parentId: "section-b" },
  { id: "container-a113", name: "Container A1-13", parentId: "shelf-a1" },
  { id: "container-a114", name: "Container A1-14", parentId: "shelf-a1" },
];

describe("staff inventory location options", () => {
  it("groups actual hierarchy levels in room, section, shelf, container order", () => {
    const items = sortInventoryLocationItems(
      [...locations].reverse(),
      locations
    );

    expect(
      items.map((item) => getInventoryLocationGroup(item, locations))
    ).toEqual([
      "Rooms",
      "Rooms",
      "Sections",
      "Sections",
      "Shelves",
      "Shelves",
      "Containers",
      "Containers",
    ]);
    expect(items.slice(0, 2).map(({ name }) => name)).toEqual([
      "IOIO Lab - B477",
      "IOIO Lab - B478",
    ]);
  });

  it("adds compact parent context only when a location name is duplicated", () => {
    expect(getInventoryLocationContext(locations[4]!, locations)).toBe(
      "IOIO Lab - B477 › Section A"
    );
    expect(isUniqueInventoryLocationName(locations[4]!, locations)).toBe(false);
    expect(isUniqueInventoryLocationName(locations[6]!, locations)).toBe(true);
    expect(getInventoryLocationContext(locations[6]!, locations)).toBe(
      "IOIO Lab - B477 › Section A › Shelf A1"
    );
  });
});
