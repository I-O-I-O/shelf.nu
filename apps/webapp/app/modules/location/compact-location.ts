export type CompactLocationSummary = {
  room: string | null;
  storageLabel: string | null;
};

const LOCATION_PREFIX = /^(?:room|section|shelf|container|box)\s+/iu;
const ROOM_CODE = /^[A-Z]{1,4}[\d-]+$/u;

function splitLocationName(value: string) {
  return value
    .split(/\s*(?:[\u2013\u2014]|\s-\s)\s*/u)
    .map((part) => part.trim())
    .filter(Boolean);
}

function formatRoomName(value: string) {
  const parts = splitLocationName(value);
  if (parts.length === 2) {
    if (ROOM_CODE.test(parts[0])) return `${parts[1]} - ${parts[0]}`;
    if (ROOM_CODE.test(parts[1])) return `${parts[0]} - ${parts[1]}`;
  }
  return value.trim();
}

function formatStorageName(value: string, depth: number) {
  const misspelledSectionPrefix = /^seciton\s+/iu;
  const cleanValue = value
    .replace(LOCATION_PREFIX, "")
    .replace(misspelledSectionPrefix, "")
    .trim();
  if (!cleanValue) return null;

  const inferredLabel =
    depth >= 3 ? "Container" : depth === 2 ? "Shelf" : "Section";
  const originalPrefix =
    value.match(LOCATION_PREFIX)?.[0]?.trim() ??
    (misspelledSectionPrefix.test(value) ? "Section" : undefined);
  const prefixLabel = originalPrefix?.toLocaleLowerCase();
  const label = prefixLabel
    ? prefixLabel === "box"
      ? "Container"
      : `${prefixLabel[0].toLocaleUpperCase()}${prefixLabel.slice(1)}`
    : inferredLabel;
  const normalizedValue = cleanValue.replace(
    new RegExp(`^${label}\\s+`, "iu"),
    ""
  );

  return `${label} ${normalizedValue}`;
}

/**
 * Projects a recursive location path into readable room and storage labels.
 * Quick-view callers can omit intermediate descendants while other compact
 * location surfaces retain the complete hierarchy.
 */
export function getCompactLocationSummary(
  path: string[],
  {
    showIntermediateLocations = true,
  }: { showIntermediateLocations?: boolean } = {}
): CompactLocationSummary {
  const values = path.map((value) => value.trim()).filter(Boolean);
  if (!values.length) return { room: null, storageLabel: null };

  const descendants = values
    .slice(1)
    .map((value, index) => ({ value, depth: index + 1 }));
  const displayedDescendants = showIntermediateLocations
    ? descendants
    : descendants.slice(-1);

  return {
    room: formatRoomName(values[0]),
    storageLabel:
      displayedDescendants
        .map(({ value, depth }) => formatStorageName(value, depth))
        .filter((value): value is string => value !== null)
        .join(" · ") || null,
  };
}
