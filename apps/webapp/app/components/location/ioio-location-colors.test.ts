import { describe, expect, it } from "vitest";
import {
  getDerivedIoioLocationColor,
  getEffectiveIoioLocationColor,
} from "./ioio-location-colors";

const hierarchy = (roomColor: string) => [
  { id: "room", name: "Room A", parentId: null, color: roomColor },
  { id: "section", name: "Section A", parentId: "room", color: "#C62828" },
  { id: "shelf", name: "Shelf A1", parentId: "section", color: "#2E7D32" },
  { id: "box", name: "Box A1-1", parentId: "shelf", color: "#E65100" },
];

describe("IOIO location room color theme", () => {
  it("uses the Room color for every descendant, ignoring stored child colors", () => {
    const locations = hierarchy("#1565C0");

    for (const location of locations) {
      expect(getEffectiveIoioLocationColor({ location, locations }).color).toBe(
        "#1565C0"
      );
    }
  });

  it("updates all descendants when the Room color changes", () => {
    const locations = hierarchy("#C62828");

    expect(
      getEffectiveIoioLocationColor({
        location: locations[3],
        locations,
      }).color
    ).toBe("#C62828");
  });

  it("derives child creation color from the top-level Room", () => {
    const locations = hierarchy("#00796B");

    expect(
      getDerivedIoioLocationColor({
        name: "Container A1-2",
        locations,
        parentId: "shelf",
        locationType: "container",
      }).color
    ).toBe("#00796B");
  });

  it("uses the neutral Room theme when no root Room color is available", () => {
    const locations = [
      { id: "room", name: "Room A", parentId: null, color: null },
      { id: "section", name: "Section A", parentId: "room", color: "#C62828" },
    ];

    expect(
      getEffectiveIoioLocationColor({
        location: locations[1],
        locations,
      }).color
    ).toBe("#455A64");
  });
});
