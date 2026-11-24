import type { Prisma } from "@prisma/client";

/** Keep picker ancestry at Shelf's maximum supported location depth. */
export const MAX_LOCATION_HIERARCHY_DEPTH = 12;

function parentSelect(depth: number): Prisma.LocationSelect["parent"] {
  if (depth <= 0) return undefined;

  return {
    select: {
      id: true,
      name: true,
      parentId: true,
      ...(depth > 1 ? { parent: parentSelect(depth - 1) } : {}),
    },
  } as Prisma.LocationSelect["parent"];
}

/**
 * Shelf's location picker fields, including the canonical parent chain so
 * selectors can display a useful breadcrumb without inventing IOIO levels.
 */
export const LOCATION_PICKER_SELECT = {
  id: true,
  name: true,
  parentId: true,
  thumbnailUrl: true,
  parent: parentSelect(MAX_LOCATION_HIERARCHY_DEPTH - 1),
} satisfies Prisma.LocationSelect;

/**
 * Preserve the full Location row for Shelf forms while adding the same parent
 * ancestry used by the narrow generic picker search response.
 */
export const LOCATION_PICKER_INCLUDE = {
  parent: parentSelect(MAX_LOCATION_HIERARCHY_DEPTH - 1),
} satisfies Prisma.LocationInclude;
