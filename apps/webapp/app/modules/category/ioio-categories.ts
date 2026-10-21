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
        "Electronic components, circuit boards and other general electronic equipment.",
      color: "#2563eb",
    },
    {
      name: "Motors & Actuators",
      description:
        "Motors, servos, actuators and equipment used to create movement.",
      color: "#4338ca",
    },
    {
      name: "Sensors",
      description:
        "Sensors and modules used to measure or detect physical conditions.",
      color: "#7c3aed",
    },
    {
      name: "Computing",
      description:
        "Computers, microcontrollers, single-board computers and accessories.",
      color: "#b45309",
    },
    {
      name: "Power & Batteries",
      description:
        "Batteries, power supplies, chargers and power management equipment.",
      color: "#ea580c",
    },
    {
      name: "Cables & Adapters",
      description:
        "Power, USB, HDMI, Ethernet and other cables, chargers and adapters.",
      color: "#0f766e",
    },
    {
      name: "Mechanical",
      description:
        "Mechanical parts, structural components and fabrication materials.",
      color: "#65a30d",
    },
    {
      name: "Tools",
      description:
        "Hand tools, power tools and equipment used to build or repair items.",
      color: "#64748b",
    },
    {
      name: "Prototyping",
      description:
        "Prototyping kits, development boards and materials used to make early designs.",
      color: "#ca8a04",
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
