export const inventorySourceRows = [
  ["A1-1", "Assorted wires", 25],
  ["A1-2", "Arduino cables", 30],
  ["A1-3", "U-shaped jumper wires", 150],
  ["A1-4", "EL wire", 10],
  ["A1-5", "Battery holders", 40],
  ["A1-6", "9V/DC leads", 100],
  ["A2-1", "Breadboards", 30],
  ["A2-2", "Arduino cables", 1000],
  ["A2-3", "Small motors", 20],
  ["A2-4", "Small servo motors", 15],
  ["A2-5", "Solenoids/electromagnetic actuators", 10],
] as const;

export function inventorySourceText(delimiter = " | ") {
  return [
    "Lab: IOIO Lab",
    "Room: B477",
    ["Location", "Item", "Estimated quantity", "Description"].join(delimiter),
    ...inventorySourceRows.map(([bin, name, count]) =>
      [bin, name, count, `Source description of ${name}`].join(delimiter)
    ),
  ].join("\n");
}

export function inventorySourceLocations() {
  return [
    { id: "lab", name: "IOIO Lab", parentId: null, pathLabel: "IOIO Lab" },
    {
      id: "room-b477",
      name: "B477",
      parentId: "lab",
      pathLabel: "IOIO Lab · B477",
    },
    ...inventorySourceRows.map(([bin]) => ({
      id: `bin-${bin}`,
      name: bin,
      parentId: "room-b477",
      pathLabel: `IOIO Lab · B477 · ${bin}`,
    })),
  ].map((location) => ({ ...location, operational: false, currentUnits: 0 }));
}

/** A3-sized readable inventory: 48 complete rows across six bin sections. */
export function a3InventoryText(count = 48) {
  return [
    "Organization: IOIO Lab",
    "Room: B477",
    "Location | Item | Estimated quantity | Description",
    ...Array.from(
      { length: count },
      (_, index) =>
        `A3-${Math.floor(index / 8) + 1} | Workshop component ${index + 1} | ${
          (index + 1) * 25
        } | Prototyping component variant ${index + 1}`
    ),
  ].join("\n");
}
