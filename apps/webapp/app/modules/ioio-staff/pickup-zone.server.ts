import { db } from "~/database/db.server";
import { getLocationHierarchy } from "~/modules/location/service.server";

export const PICKUP_ZONE_NAME = "Pickup Zone";

/**
 * Resolves the canonical Pickup Zone below the room that owns the original
 * storage location. The zone is a normal Location record, so its image,
 * color, parent, and labels remain editable through Locations.
 */
export async function ensurePickupZone({
  organizationId,
  originalLocationId,
  actorUserId,
}: {
  organizationId: string;
  originalLocationId: string | null;
  actorUserId: string;
}) {
  const organization = await db.organization.findFirst({
    where: { id: organizationId },
    select: { userId: true },
  });
  if (!organization) throw new Error("The organization could not be found.");

  const hierarchy = originalLocationId
    ? await getLocationHierarchy({
        organizationId,
        locationId: originalLocationId,
      })
    : [];
  const room = hierarchy[0] ?? null;
  const parentId = room?.id ?? null;
  const existing = await db.location.findFirst({
    where: { organizationId, parentId, name: PICKUP_ZONE_NAME },
    select: { id: true, name: true, parentId: true },
  });
  if (existing) return { ...existing, roomName: room?.name ?? null };

  const created = await db.location.create({
    data: {
      name: PICKUP_ZONE_NAME,
      description: "Canonical IOIO pickup location for prepared equipment.",
      organizationId,
      userId: organization.userId || actorUserId,
      parentId,
    },
    select: { id: true, name: true, parentId: true },
  });
  return { ...created, roomName: room?.name ?? null };
}

export async function getPickupLocationDisplay({
  organizationId,
  locationId,
}: {
  organizationId: string;
  locationId: string;
}) {
  const hierarchy = await getLocationHierarchy({ organizationId, locationId });
  const zone = hierarchy.at(-1);
  const room = hierarchy[0];
  return {
    roomName: room?.name ?? null,
    zoneName: zone?.name ?? PICKUP_ZONE_NAME,
    label: room
      ? `${room.name} · ${zone?.name ?? PICKUP_ZONE_NAME}`
      : zone?.name ?? PICKUP_ZONE_NAME,
  };
}
