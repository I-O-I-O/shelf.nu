import { describe, expect, it } from "vitest";
import {
  getIoioLocationDepth,
  getIoioLocationSubtreeDepth,
  validateIoioLocationMove,
  type IoioMoveLocationNode,
} from "./ioio-location-move";

const hierarchy: IoioMoveLocationNode[] = [
  { id: "room-a", name: "Room A", parentId: null },
  { id: "room-b", name: "Room B", parentId: null },
  { id: "section-a", name: "Section A", parentId: "room-a" },
  { id: "section-b", name: "Section B", parentId: "room-b" },
  { id: "shelf-a1", name: "Shelf A1", parentId: "section-a" },
  { id: "shelf-d1", name: "Shelf D1", parentId: "section-a" },
  { id: "container-a1", name: "Container A1", parentId: "shelf-a1" },
];

describe("IOIO location moves", () => {
  it("derives depth from parent relationships and preserves a moved subtree", () => {
    expect(getIoioLocationDepth("shelf-a1", hierarchy)).toBe(2);
    expect(getIoioLocationSubtreeDepth("section-a", hierarchy)).toBe(2);
    expect(
      validateIoioLocationMove({
        locationId: "section-a",
        locationType: "section",
        parentId: "room-b",
        locations: hierarchy,
      })
    ).toBeNull();
  });

  it("blocks cycles and moves that would exceed Container depth", () => {
    expect(
      validateIoioLocationMove({
        locationId: "section-a",
        locationType: "section",
        parentId: "shelf-a1",
        locations: hierarchy,
      })
    ).toMatch(/descendants/iu);

    expect(
      validateIoioLocationMove({
        locationId: "room-a",
        locationType: "section",
        parentId: "room-b",
        locations: hierarchy,
      })
    ).toMatch(/maximum hierarchy depth/iu);
  });

  it("requires the destination level and blocks duplicate sibling locations in the caller", () => {
    expect(
      validateIoioLocationMove({
        locationId: "shelf-d1",
        locationType: "container",
        parentId: "section-a",
        locations: hierarchy,
      })
    ).toMatch(/inside a shelf/iu);
    expect(
      validateIoioLocationMove({
        locationId: "section-a",
        locationType: "room",
        parentId: null,
        locations: hierarchy,
      })
    ).toBeNull();
  });
});
