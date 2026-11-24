import { buildLegacyImportedDescription } from "~/modules/ioio-staff/import-description";
import type { StaffImportProposalRow } from "~/modules/ioio-staff/inventory-import.server";

/** Synthetic records only: these IDs never refer to a database. */
export function importDescriptionFixtures() {
  const items = [
    {
      shelf: "A1",
      title: "Assorted wires",
      sourceDescription: "Assorted wires.",
      expectedDescription: "",
    },
    {
      shelf: "A2",
      title: "Breadboards",
      expectedDescription:
        "Solderless breadboards for building temporary electronics circuits without soldering.",
      sourceDescription:
        "Solderless breadboards for building temporary electronics circuits without soldering.",
    },
    {
      shelf: "A3",
      title: "TinkerKit joystick module",
      sourceDescription: "TinkerKit joystick module.",
      assetModelDescription:
        "TinkerKit joystick module for directional input in Arduino and electronics projects.",
      manufacturer: "TinkerKi",
      expectedDescription:
        "TinkerKit joystick module for directional input in Arduino and electronics projects.",
    },
    {
      shelf: "A4",
      title: "Multimeter",
      expectedDescription:
        "Multimeter for measuring voltage, current and resistance in electronics circuits.",
      sourceDescription:
        "Multimeter for measuring voltage, current and resistance in electronics circuits.",
    },
    {
      shelf: "A5",
      title: "Sensor module",
      expectedDescription: "",
      sourceDescription:
        "Source description: Sensor module. Manufacturer: TinkerKi",
    },
  ];
  const fixtures = items.map(
    ({ shelf, expectedDescription, ...item }, index) => {
      const row: StaffImportProposalRow = {
        rowNumber: index + 1,
        quantity: 10,
        category: "Electronics",
        location: `${shelf}-5`,
        type: "QUANTITY_TRACKED",
        action: "CREATE",
        assetId: null,
        categoryId: "fixture-category",
        locationId: `fixture-${shelf}-5`,
        currentQuantity: null,
        currentCategoryId: null,
        currentLocationId: null,
        reason: "Local description preview fixture",
        sourceOrganization: "IOIO Lab",
        sourceRoom: "B477",
        sourceStorageLocation: `${shelf}-5`,
        ...item,
      };
      const filename = `IOIO_Lab_B477_${shelf}_Claude_Import.pdf`;
      const legacy = buildLegacyImportedDescription(filename, row);
      return {
        id: `fixture-${shelf.toLowerCase()}`,
        filename,
        row,
        currentDescription: row.assetModelDescription
          ? `${row.assetModelDescription}\n\n${legacy}`
          : legacy,
        expectedDescription,
      };
    }
  );
  const joystick = fixtures[2];
  return [
    ...fixtures,
    {
      ...joystick,
      id: "fixture-manual",
      currentDescription:
        "Use this joystick with the student robotics kits. Ask staff for the wiring guide.",
    },
    {
      ...joystick,
      id: "fixture-manual-append",
      currentDescription: `${joystick.currentDescription}\nStaff note: keep with the student robotics kits.`,
    },
  ];
}
