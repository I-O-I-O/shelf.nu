export type InventoryLocationOption = {
  id: string;
  name: string;
  parentId?: string | null;
};

export const INVENTORY_LOCATION_GROUPS = [
  "Rooms",
  "Sections",
  "Shelves",
  "Containers",
] as const;

export function getInventoryLocationLevel(
  item: InventoryLocationOption,
  locations: InventoryLocationOption[]
): number {
  const byId = new Map(locations.map((location) => [location.id, location]));
  let depth = 0;
  let parentId = item.parentId ?? null;
  while (parentId && depth < 20) {
    depth++;
    parentId = byId.get(parentId)?.parentId ?? null;
  }
  return Math.min(depth, INVENTORY_LOCATION_GROUPS.length - 1);
}

export function getInventoryLocationGroup(
  item: InventoryLocationOption,
  locations: InventoryLocationOption[]
): string {
  return INVENTORY_LOCATION_GROUPS[getInventoryLocationLevel(item, locations)];
}

export function sortInventoryLocationItems<T extends InventoryLocationOption>(
  items: T[],
  locations: InventoryLocationOption[]
): T[] {
  return [...items].sort((left, right) => {
    const groupDifference =
      getInventoryLocationLevel(left, locations) -
      getInventoryLocationLevel(right, locations);
    if (groupDifference !== 0) return groupDifference;
    return left.name.localeCompare(right.name, undefined, {
      numeric: true,
      sensitivity: "base",
    });
  });
}

export function formatInventoryLocationName(name: string): string {
  const codeFirstName = name.match(/^([A-Z]\d{3})\s+—\s+(.+)$/u);
  if (codeFirstName) return `${codeFirstName[2]} - ${codeFirstName[1]}`;
  return name.replace(/\s*—\s*/gu, " - ");
}

export function getInventoryLocationContext(
  item: InventoryLocationOption,
  locations: InventoryLocationOption[]
): string | null {
  const path: string[] = [];
  const byId = new Map(locations.map((location) => [location.id, location]));
  let parentId = item.parentId ?? null;
  while (parentId && path.length < 20) {
    const parent = byId.get(parentId);
    if (!parent) break;
    path.unshift(formatInventoryLocationName(parent.name));
    parentId = parent.parentId ?? null;
  }
  return path.length ? path.join(" › ") : null;
}

export function isUniqueInventoryLocationName(
  item: InventoryLocationOption,
  locations: InventoryLocationOption[]
): boolean {
  return !locations.some(
    (location) => location.id !== item.id && location.name === item.name
  );
}
