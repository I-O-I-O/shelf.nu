import { db } from "~/database/db.server";

const returnAreaNames = [
  "Problem / Broken Zone",
  "Broken Zone",
  "Problem / Repair Zone",
  "Problem Zone",
  "Repair Zone",
  "Kit Return Zone",
  "IOIO Return Zone",
  "Return Zone",
  "Return Section",
  "Returns Area",
];

function normalizeLocationName(name: string) {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

function getLocationPath(
  locationId: string,
  locations: Array<{ id: string; name: string; parentId: string | null }>
) {
  const byId = new Map(locations.map((location) => [location.id, location]));
  const path: string[] = [];
  let currentId: string | null = locationId;
  const visited = new Set<string>();
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const current = byId.get(currentId);
    if (!current) break;
    path.unshift(current.name);
    currentId = current.parentId;
  }
  return path.join(" · ");
}

/** Resolve the configured IOIO return/problem location from Shelf locations. */
export async function getConfiguredReportReturnArea(organizationId: string) {
  const locations = await db.location.findMany({
    where: { organizationId },
    select: { id: true, name: true, parentId: true },
  });
  const location = returnAreaNames
    .map((name) =>
      locations.find(
        (candidate) =>
          normalizeLocationName(candidate.name) === normalizeLocationName(name)
      )
    )
    .find((candidate) => candidate !== undefined);
  return location ? getLocationPath(location.id, locations) : null;
}
