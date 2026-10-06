export type IoioCategoryDefinition = {
  name: string;
  description: string;
  color: string;
};

/**
 * The canonical category catalog for the IOIO workspace.
 *
 * These are data definitions used when initializing an IOIO workspace. Live
 * selectors still read the organization's Shelf Category records so staff can
 * manage the catalog from the Categories page.
 */
export const IOIO_CATEGORY_CATALOG: readonly IoioCategoryDefinition[] = [
  {
    name: "Boards & Embedded Systems",
    description:
      "Arduino, Raspberry Pi, shields, driver boards, Arduino Sense, NFC boards and tags, and development boards.",
    color: "#2563eb",
  },
  {
    name: "Components & Prototyping - Basic",
    description:
      "LEDs, resistors, capacitors, transistors, potentiometers, switches, relays, breadboards, pins, and connectors.",
    color: "#7c3aed",
  },
  {
    name: "Motors, Power & Actuation",
    description:
      "DC motors, servos, pumps, batteries, heating elements, power modules, and cooling parts.",
    color: "#ea580c",
  },
  {
    name: "Cables & Connectivity",
    description:
      "USB cables, wires, battery leads, electrode cables, adapters, wire spools, and miscellaneous cables.",
    color: "#0f766e",
  },
  {
    name: "Tools & Fabrication",
    description:
      "Glue guns, scissors, pliers, soldering tools, solder wick, 3D printers, filament, laser-cut parts, and ultrasonic cleaners.",
    color: "#b45309",
  },
  {
    name: "Measurement & Lab Equipment",
    description:
      "Oscilloscopes, HAMEG equipment, probes, BGA and rework equipment, and measuring equipment.",
    color: "#0891b2",
  },
  {
    name: "Computing, AV & Imaging",
    description:
      "Computers, iMacs, monitors, projectors, cameras, Insta360 cameras, and old screens.",
    color: "#4338ca",
  },
  {
    name: "Kits & Complete Sets",
    description:
      "Arduino bachelor and master kits, ready-to-borrow sets, and boxed complete equipment.",
    color: "#db2777",
  },
  {
    name: "Old Projects / Legacy / Unknown",
    description:
      "Old student projects, legacy prototypes, unidentified equipment, and miscellaneous items awaiting review.",
    color: "#64748b",
  },
  {
    name: "Storage Infrastructure",
    description:
      "Empty boxes, organizers, shelf parts, brackets, racks, and storage equipment.",
    color: "#65a30d",
  },
  {
    name: "Other",
    description: "Items that do not fit into another IOIO category.",
    color: "#6b7280",
  },
];
