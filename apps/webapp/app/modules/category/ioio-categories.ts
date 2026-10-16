export type IoioCategoryDefinition = {
  name: string;
  description: string;
  color: string;
};

/** Recommended initial category set for new IOIO organizations. */
export const IOIO_INITIAL_CATEGORY_DEFAULTS: readonly IoioCategoryDefinition[] =
  [
    {
      name: "Electronics",
      description:
        "Arduino boards, sensors, electronic components, power supplies and similar equipment.",
      color: "#2563eb",
    },
    {
      name: "Computers & accessories",
      description:
        "Computers, monitors, keyboards, mice, hubs and related computer equipment.",
      color: "#4338ca",
    },
    {
      name: "Audio & video",
      description:
        "Cameras, microphones, speakers, projectors and other media equipment.",
      color: "#7c3aed",
    },
    {
      name: "Tools & machinery",
      description:
        "Hand tools, power tools, soldering equipment and workshop machinery.",
      color: "#b45309",
    },
    {
      name: "Prototyping & making",
      description:
        "Equipment and materials used for prototyping, physical computing and making.",
      color: "#ea580c",
    },
    {
      name: "Cables & adapters",
      description:
        "Power, USB, HDMI, Ethernet and other cables, chargers and adapters.",
      color: "#0f766e",
    },
    {
      name: "Furniture",
      description: "Tables, chairs, shelves, cabinets and other lab furniture.",
      color: "#65a30d",
    },
    {
      name: "Office equipment",
      description:
        "Printers, scanners, label makers and general office equipment.",
      color: "#64748b",
    },
    {
      name: "Supplies & consumables",
      description:
        "Items intended to be consumed or replaced, such as paper, tape, batteries and filament.",
      color: "#ca8a04",
    },
    {
      name: "Safety equipment",
      description:
        "Protective and safety-related equipment such as goggles, gloves and first-aid items.",
      color: "#dc2626",
    },
    {
      name: "Other",
      description:
        "Items that do not reasonably fit into another standard category.",
      color: "#6b7280",
    },
  ];

function normalizeCategoryName(name: string): string {
  return name.trim().toLocaleLowerCase("en");
}

/**
 * Keep the recommended order while the organization's records are still the
 * untouched initial set. Once Staff renames, adds, or deletes a category, keep
 * the ordering supplied by Shelf's category query.
 */
export function orderUntouchedIoioDefaults<T extends { name: string }>(
  categories: T[]
): T[] {
  if (categories.length !== IOIO_INITIAL_CATEGORY_DEFAULTS.length) {
    return categories;
  }

  const categoriesByName = new Map(
    categories.map((category) => [
      normalizeCategoryName(category.name),
      category,
    ])
  );
  const ordered = IOIO_INITIAL_CATEGORY_DEFAULTS.map((category) =>
    categoriesByName.get(normalizeCategoryName(category.name))
  );

  return ordered.every((category) => category !== undefined)
    ? (ordered as T[])
    : categories;
}
