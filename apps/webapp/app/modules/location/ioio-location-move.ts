export type IoioMoveLocationType = "room" | "section" | "shelf" | "container";

export type IoioMoveLocationNode = {
  id: string;
  name: string;
  parentId: string | null;
};

const MAX_IOIO_DEPTH = 3;

export function getIoioLocationDepth(
  locationId: string,
  locations: IoioMoveLocationNode[]
): number | null {
  const locationsById = new Map(
    locations.map((location) => [location.id, location])
  );
  const visited = new Set<string>();
  let current = locationsById.get(locationId);
  let depth = 0;

  while (current) {
    if (visited.has(current.id)) return null;
    visited.add(current.id);
    if (!current.parentId) return depth;
    current = locationsById.get(current.parentId);
    if (!current) return null;
    depth += 1;
  }

  return null;
}

export function getIoioLocationDescendantIds(
  locationId: string,
  locations: IoioMoveLocationNode[]
): Set<string> {
  const descendants = new Set<string>();
  const pending = [locationId];

  while (pending.length > 0) {
    const parentId = pending.pop();
    if (!parentId) continue;
    for (const location of locations) {
      if (location.parentId !== parentId || descendants.has(location.id))
        continue;
      descendants.add(location.id);
      pending.push(location.id);
    }
  }

  return descendants;
}

export function getIoioLocationSubtreeDepth(
  locationId: string,
  locations: IoioMoveLocationNode[]
): number {
  const descendants = getIoioLocationDescendantIds(locationId, locations);
  const locationsById = new Map(
    locations.map((location) => [location.id, location])
  );
  const pending = [{ id: locationId, depth: 0 }];
  const visited = new Set([locationId]);
  let maxDepth = 0;

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    maxDepth = Math.max(maxDepth, current.depth);
    for (const id of descendants) {
      if (locationsById.get(id)?.parentId === current.id && !visited.has(id)) {
        visited.add(id);
        pending.push({ id, depth: current.depth + 1 });
      }
    }
  }

  return maxDepth;
}

export function getIoioMoveParentDepth(
  locationType: IoioMoveLocationType
): number | null {
  if (locationType === "room") return null;
  if (locationType === "section") return 0;
  if (locationType === "shelf") return 1;
  return 2;
}

export function validateIoioLocationMove({
  locationId,
  locationType,
  parentId,
  locations,
}: {
  locationId: string;
  locationType: IoioMoveLocationType;
  parentId: string | null;
  locations: IoioMoveLocationNode[];
}): string | null {
  const location = locations.find((entry) => entry.id === locationId);
  if (!location) return "Location not found.";

  if (locationType === "room") {
    if (parentId) return "A room must be at the top level.";
  } else {
    if (!parentId) return "Choose a destination location.";
    const parent = locations.find((entry) => entry.id === parentId);
    if (!parent) return "Choose a valid destination location.";
    if (parent.id === locationId)
      return "A location cannot be moved into itself.";
    if (getIoioLocationDescendantIds(locationId, locations).has(parent.id)) {
      return "A location cannot be moved into one of its descendants.";
    }
    const parentDepth = getIoioLocationDepth(parent.id, locations);
    if (parentDepth !== getIoioMoveParentDepth(locationType)) {
      const levelName =
        locationType === "section"
          ? "room"
          : locationType === "shelf"
          ? "section"
          : "shelf";
      return `A ${locationType} must be placed inside a ${levelName}.`;
    }
  }

  const newDepth = parentId
    ? (getIoioLocationDepth(parentId, locations) ?? -1) + 1
    : 0;
  const subtreeDepth = getIoioLocationSubtreeDepth(locationId, locations);
  if (newDepth < 0 || newDepth + subtreeDepth > MAX_IOIO_DEPTH) {
    return "This location contains nested locations that would exceed the maximum hierarchy depth.";
  }

  return null;
}
