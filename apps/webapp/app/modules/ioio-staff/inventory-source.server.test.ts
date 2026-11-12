import { describe, expect, it } from "vitest";
import {
  parseExplicitInventorySources,
  resolveExplicitInventoryLocation,
  matchExplicitInventorySource,
} from "./inventory-source.server";
import {
  inventorySourceRows,
  inventorySourceText,
  inventorySourceLocations,
  shelfSourceCodes,
  shelfInventoryLocations,
} from "../../../test/factories/ioio-inventory-source";

const pages = (text = inventorySourceText()) => [
  { sourceRef: "pdf-page-1", page: 1, text },
];

describe("explicit IOIO source inventory fields", () => {
  it.each([" | ", ",", "\t"])(
    "preserves every A1/A2 quantity and bin in %s tables",
    (delimiter) => {
      const rows = parseExplicitInventorySources(
        pages(inventorySourceText(delimiter))
      );
      expect(
        rows.map((row) => [
          row.sourceStorageLocation,
          row.sourceItemName,
          row.quantity,
        ])
      ).toEqual(inventorySourceRows);
      for (const row of rows) {
        expect(row).toMatchObject({
          sourceOrganization: "IOIO Lab",
          sourceRoom: "B477",
          quantityIsEstimated: true,
        });
        const resolved = resolveExplicitInventoryLocation(
          row,
          inventorySourceLocations()
        );
        expect(resolved?.location.id).toBe(`bin-${row.sourceStorageLocation}`);
        expect(resolved?.roomLocationId).toBe("room-b477");
        expect(resolved?.location.name).not.toBe("B477");
      }
    }
  );
  it.each(shelfSourceCodes)(
    "parses %s and resolves the role-labelled canonical container, never its room/shelf",
    (code) => {
      const source = parseExplicitInventorySources(
        pages(
          `Organization: IOIO Lab\nRoom: B477\nLocation | Item | Quantity\n${code} | Push buttons | 25`
        )
      )[0];
      expect(source.sourceStorageLocation).toBe(code);
      const resolved = resolveExplicitInventoryLocation(
        source,
        shelfInventoryLocations()
      );
      expect(resolved).toMatchObject({
        location: {
          id: `bin-${code}`,
          name: `Container ${code}`,
          parentId: `shelf-${code.split("-")[0]}`,
        },
        roomLocationId: "room-b477",
      });
      expect(
        resolveExplicitInventoryLocation(
          source,
          shelfInventoryLocations().filter(
            (location) => location.id !== `bin-${code}`
          )
        )
      ).toBeNull();
    }
  );

  it("keeps the explicit inline IOIO example's room, bin, item and estimated count distinct", () => {
    const rows = parseExplicitInventorySources(
      pages(
        "IOIO Lab, room B477, A1-3, U-shaped PCB jumper wires, estimated quantity 150"
      )
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sourceOrganization: "IOIO Lab",
      sourceRoom: "B477",
      sourceStorageLocation: "A1-3",
      sourceItemName: "U-shaped PCB jumper wires",
      quantity: 150,
      quantityIsEstimated: true,
    });
  });

  it("applies unique document context even when it follows the table, and respects row room overrides", () => {
    const text =
      "Location | Item | Estimated quantity | Description | Room\nA1-1 | Wires | 25 | Mixed wires | B478\nA1-2 | Cables | 30 | Cables |\nIOIO Lab\nRoom B477";
    const rows = parseExplicitInventorySources(pages(text));
    expect(
      rows.map((row) => [
        row.sourceOrganization,
        row.sourceRoom,
        row.sourceStorageLocation,
        row.quantity,
      ])
    ).toEqual([
      ["IOIO Lab", "B478", "A1-1", 25],
      ["IOIO Lab", "B477", "A1-2", 30],
    ]);
  });

  it("reads vertical PDF table cells with the same authoritative fields", () => {
    const text = inventorySourceText().replaceAll(" | ", "\n");
    expect(
      parseExplicitInventorySources(pages(text)).map((row) => row.quantity)
    ).toEqual(inventorySourceRows.map((row) => row[2]));
  });
  it("preserves unambiguous grouped counts and never reads an extra CSV column as quantity 1", () => {
    const header = "Location | Item | Estimated quantity | Description";
    expect(
      parseExplicitInventorySources(
        pages(`${header}\nA2-2 | Arduino cables | 1,000 | Bulk cables`)
      )[0].quantity
    ).toBe(1000);
    expect(
      parseExplicitInventorySources(
        pages(
          'Location,Item,Estimated quantity,Description\nA2-2,Arduino cables,"1,000",Bulk cables'
        )
      )[0].quantity
    ).toBe(1000);
    expect(
      parseExplicitInventorySources(
        pages(
          "Location,Item,Estimated quantity,Description\nA2-2,Arduino cables,1,000,Bulk cables"
        )
      )[0].quantity
    ).toBeNull();
  });

  it("does not guess quantities or use room IDs as bins", () => {
    const rows = parseExplicitInventorySources(
      pages(
        "Lab: IOIO Lab\nRoom: B477\nLocation | Item | Estimated quantity | Description\nA1-3 | Jumpers | many | wires\nB477 | Room | 1 | room"
      )
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].quantity).toBeNull();
  });
  it("resolves duplicate bin names by room and rejects missing/ambiguous bins", () => {
    const source = parseExplicitInventorySources(pages())[0];
    const locations = inventorySourceLocations();
    const otherRoom = {
      id: "room-b478",
      name: "B478",
      parentId: "lab",
      pathLabel: "IOIO Lab / B478",
      operational: false,
      currentUnits: 0,
    };
    const otherBin = {
      ...locations[2],
      id: "other-bin",
      parentId: otherRoom.id,
    };
    expect(
      resolveExplicitInventoryLocation(source, [
        ...locations,
        otherRoom,
        otherBin,
      ])?.location.id
    ).toBe("bin-A1-1");
    expect(
      resolveExplicitInventoryLocation(source, [otherRoom, otherBin])
    ).toBeNull();
    expect(
      resolveExplicitInventoryLocation(source, [
        ...locations,
        { ...locations[2], id: "duplicate" },
      ])
    ).toBeNull();
    expect(
      resolveExplicitInventoryLocation(source, locations.slice(0, 2))
    ).toBeNull();
  });
  it("does not join an ambiguous page-wide quote to an arbitrary row", () => {
    const source = parseExplicitInventorySources(pages());
    expect(
      matchExplicitInventorySource(
        [{ sourceRef: "pdf-page-1", text: inventorySourceText() }],
        source
      )
    ).toBeNull();
    expect(
      matchExplicitInventorySource(
        [{ sourceRef: "pdf-page-1", text: source[7].sourceText }],
        source
      )?.sourceStorageLocation
    ).toBe("A2-2");
  });
});
