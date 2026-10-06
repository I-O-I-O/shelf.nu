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
  const cleanValue = value.replace(LOCATION_PREFIX, "").trim();
  if (!cleanValue) return null;

  const inferredLabel =
    depth >= 3 ? "Container" : depth === 2 ? "Shelf" : "Section";
  const originalPrefix = value.match(LOCATION_PREFIX)?.[0]?.trim();
  const label = originalPrefix
    ? originalPrefix.toLowerCase() === "box"
      ? "Container"
      : originalPrefix.replace(/\s+$/u, "")
    : inferredLabel;

  return `${label} ${cleanValue}`;
}

/**
 * Projects a recursive location path into the compact information shown on
 * asset detail pages. The first node is the room and the deepest child is the
 * useful pickup/storage location.
 */
export function getCompactLocationSummary(
  path: string[]
): CompactLocationSummary {
  const values = path.map((value) => value.trim()).filter(Boolean);
  if (!values.length) return { room: null, storageLabel: null };

  return {
    room: formatRoomName(values[0]),
    storageLabel:
      values.length > 1
        ? formatStorageName(values.at(-1)!, values.length - 1)
        : null,
  };
}
