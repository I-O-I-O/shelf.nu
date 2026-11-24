import {
  getQuickLocationPath,
  getQuickLocationSelection,
  type QuickLocationNode,
} from "./ioio-location-quick-select";

const room: QuickLocationNode = {
  id: "room",
  name: "B477",
  parentId: null,
};
const section: QuickLocationNode = {
  id: "section",
  name: "Section A",
  parentId: room.id,
};
const shelf: QuickLocationNode = {
  id: "shelf",
  name: "Shelf A1",
  parentId: section.id,
};
const container: QuickLocationNode = {
  id: "container",
  name: "Container A1-13",
  parentId: shelf.id,
};
const locations = [room, section, shelf, container];
const locationsById = new Map(
  locations.map((location) => [location.id, location])
);

describe("IOIO quick location path", () => {
  it.each([
    [room, ["room"], { roomId: "room" }],
    [section, ["room", "section"], { roomId: "room", sectionId: "section" }],
    [
      shelf,
      ["room", "section", "shelf"],
      {
        roomId: "room",
        sectionId: "section",
        shelfId: "shelf",
      },
    ],
    [
      container,
      ["room", "section", "shelf", "container"],
      {
        roomId: "room",
        sectionId: "section",
        shelfId: "shelf",
        containerId: "container",
      },
    ],
  ])(
    "resolves a selected level and fills its ancestor fields",
    (location, ids, selection) => {
      const path = getQuickLocationPath(
        location as QuickLocationNode,
        locationsById
      );
      expect(path.map(({ id }) => id)).toEqual(ids);
      expect(getQuickLocationSelection(ids as string[])).toEqual(selection);
    }
  );

  it("provides distinct context for duplicate location names", () => {
    const otherShelf = {
      id: "other-shelf",
      name: "Shelf A2",
      parentId: section.id,
    };
    const otherContainer = {
      id: "container-2",
      name: "Container A1-13",
      parentId: otherShelf.id,
    };
    const tree = new Map(
      [...locations, otherShelf, otherContainer].map((location) => [
        location.id,
        location,
      ])
    );

    expect(
      getQuickLocationPath(container, tree).map(({ name }) => name)
    ).toEqual(["B477", "Section A", "Shelf A1", "Container A1-13"]);
    expect(
      getQuickLocationPath(otherContainer, tree).map(({ name }) => name)
    ).toEqual(["B477", "Section A", "Shelf A2", "Container A1-13"]);
  });
});
