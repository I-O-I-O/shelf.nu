export type IoioLocationColorInput = {
  name: string;
  parentName?: string | null;
  ancestorNames?: string[];
  isRoom?: boolean;
  /** Persisted location color, when the location has an explicit choice. */
  color?: string | null;
};

export type IoioLocationNode = {
  id: string;
  name: string;
  parentId: string | null;
  color?: string | null;
};

export type IoioLocationType = "room" | "section" | "shelf" | "container";

export type IoioLocationColor = {
  color: string;
  name: string;
  softBackground: string;
  softBorder: string;
  text: string;
};

const ROOM_COLOR: IoioLocationColor = {
  color: "#455A64",
  name: "Room neutral",
  softBackground: "#F1F4F5",
  softBorder: "#B0BEC5",
  text: "#263238",
};

export const IOIO_LOCATION_COLORS: IoioLocationColor[] = [
  {
    color: "#1565C0",
    name: "Blue",
    softBackground: "#EAF2FB",
    softBorder: "#90CAF9",
    text: "#0D47A1",
  },
  {
    color: "#2E7D32",
    name: "Green",
    softBackground: "#ECF7EF",
    softBorder: "#A5D6A7",
    text: "#1B5E20",
  },
  {
    color: "#C62828",
    name: "Red",
    softBackground: "#FDF0F0",
    softBorder: "#EF9A9A",
    text: "#8E0000",
  },
  {
    color: "#6A1B9A",
    name: "Purple",
    softBackground: "#F6EFFB",
    softBorder: "#CE93D8",
    text: "#4A148C",
  },
  {
    color: "#E65100",
    name: "Orange",
    softBackground: "#FFF4E8",
    softBorder: "#FFB74D",
    text: "#8D3A00",
  },
  {
    color: "#00796B",
    name: "Teal",
    softBackground: "#EAF8F7",
    softBorder: "#80CBC4",
    text: "#004D40",
  },
  {
    color: "#AD1457",
    name: "Magenta",
    softBackground: "#FBEDF4",
    softBorder: "#F48FB1",
    text: "#880E4F",
  },
  {
    color: "#455A64",
    name: "Slate",
    softBackground: "#F1F4F5",
    softBorder: "#B0BEC5",
    text: "#263238",
  },
  {
    color: "#827717",
    name: "Olive",
    softBackground: "#F6F7E8",
    softBorder: "#C5CA73",
    text: "#5F6210",
  },
  {
    color: "#5D4037",
    name: "Brown",
    softBackground: "#F5EFED",
    softBorder: "#BCAAA4",
    text: "#3E2723",
  },
];

export const IOIO_LOCATION_COLOR_VALUES = IOIO_LOCATION_COLORS.map(
  (entry) => entry.color
);

function normalized(value: string | null | undefined) {
  return value?.trim().toLocaleLowerCase() ?? "";
}

function locationLetter(value: string | null | undefined) {
  const match =
    value?.match(/(?:section\s+|shelf\s+|container\s+|box\s+)([a-z])/iu) ??
    value?.match(/^([a-z])(?=\d)/iu);
  return match?.[1]?.toLocaleUpperCase() ?? null;
}

function isSectionName(value: string) {
  return /^section\s+[a-z]/iu.test(value.trim());
}

function colorForLetter(letter: string | null) {
  if (!letter) return ROOM_COLOR;
  return IOIO_LOCATION_COLORS[
    (letter.charCodeAt(0) - "A".charCodeAt(0)) % IOIO_LOCATION_COLORS.length
  ];
}

function colorForName(value: string) {
  const hash = [...value].reduce(
    (result, character) => result + character.charCodeAt(0),
    0
  );
  return IOIO_LOCATION_COLORS[hash % IOIO_LOCATION_COLORS.length];
}

function getOwnLocationColor(location: IoioLocationNode) {
  return getIoioLocationColor({
    name: location.name,
    isRoom: !location.parentId,
    color: location.color,
  });
}

function findSectionAncestor(
  parentId: string | null | undefined,
  locationsById: Map<string, IoioLocationNode>
) {
  let current = parentId ? locationsById.get(parentId) : undefined;
  const visited = new Set<string>();

  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    const parent = current.parentId
      ? locationsById.get(current.parentId)
      : undefined;

    // In the IOIO hierarchy a section is the level directly below a room.
    // This uses the stored parent chain, never a location name.
    if (parent && parent.parentId === null) return current;
    current = parent;
  }

  return undefined;
}

/**
 * Resolves the color that should be presented for a canonical location.
 * Rooms and sections use their own stored color. Shelves and containers use
 * the nearest section color, so a section edit is reflected everywhere
 * without mutating every descendant record.
 */
export function getEffectiveIoioLocationColor({
  location,
  locations,
  parentId,
  locationType,
}: {
  location?: IoioLocationNode;
  locations: IoioLocationNode[];
  parentId?: string | null;
  locationType?: IoioLocationType;
}) {
  const locationsById = new Map(locations.map((entry) => [entry.id, entry]));
  const resolvedLocation =
    location ?? (parentId ? locationsById.get(parentId) : undefined);

  if (locationType === "room" || resolvedLocation?.parentId === null) {
    return resolvedLocation
      ? getOwnLocationColor(resolvedLocation)
      : ROOM_COLOR;
  }

  const section = findSectionAncestor(
    location ? location.parentId : parentId,
    locationsById
  );
  if (section) return getOwnLocationColor(section);

  if (location) return getOwnLocationColor(location);
  return ROOM_COLOR;
}

/**
 * Resolves the presentation color for a physical location. The resolver is
 * intentionally deterministic and uses only location names and hierarchy.
 * It does not persist or mutate location data.
 */
export function getIoioLocationColor(
  input: IoioLocationColorInput
): IoioLocationColor {
  const persistedColor = input.color?.trim();
  if (persistedColor) {
    const matchingColor = getIoioLocationColorByHex(persistedColor);
    if (
      matchingColor.color.toLocaleLowerCase() ===
      persistedColor.toLocaleLowerCase()
    ) {
      return matchingColor;
    }
  }

  const hasParentContext = Boolean(
    input.parentName || input.ancestorNames?.length
  );
  const hasChildLevelName =
    /^(?:section\s+|shelf\s+|container\s+|box\s+)[a-z]/iu.test(
      input.name.trim()
    ) || /^[a-z]\d/iu.test(input.name.trim());

  if (input.isRoom === true || (!hasParentContext && !hasChildLevelName)) {
    return ROOM_COLOR;
  }

  const hierarchy = [
    ...(input.ancestorNames ?? []),
    input.parentName ?? "",
    input.name,
  ].filter(Boolean);
  const section = [...hierarchy].reverse().find(isSectionName);
  const letter =
    locationLetter(section) ??
    [...hierarchy].reverse().map(locationLetter).find(Boolean) ??
    null;
  return letter ? colorForLetter(letter) : colorForName(input.name);
}

export function getIoioLocationColorByHex(value: string) {
  return (
    IOIO_LOCATION_COLORS.find(
      (entry) => entry.color.toLocaleLowerCase() === normalized(value)
    ) ?? ROOM_COLOR
  );
}
