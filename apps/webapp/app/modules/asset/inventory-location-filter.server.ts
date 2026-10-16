import type { Organization } from "@prisma/client";
import { getLocationDescendantIds } from "~/modules/location/descendants.server";

/**
 * Resolve the inventory's selected location(s) to Shelf's existing location
 * tree, retaining the selected node and each descendant for the asset query.
 */
export async function getInventoryLocationFilterIds({
  organizationId,
  locationIds,
}: {
  organizationId: Organization["id"];
  locationIds: string[];
}): Promise<string[]> {
  if (locationIds.length === 0) return locationIds;

  const includesWithoutLocation = locationIds.includes("without-location");
  const selectedLocationIds = locationIds.filter(
    (locationId) => locationId !== "without-location"
  );
  if (selectedLocationIds.length === 0) return locationIds;

  const expandedIds = [
    ...new Set(
      (
        await Promise.all(
          selectedLocationIds.map((locationId) =>
            getLocationDescendantIds({ organizationId, locationId })
          )
        )
      ).flat()
    ),
  ];
  return includesWithoutLocation
    ? [...expandedIds, "without-location"]
    : expandedIds;
}
