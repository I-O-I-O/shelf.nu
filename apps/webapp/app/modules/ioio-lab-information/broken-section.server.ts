import { db } from "~/database/db.server";

/** Reserved organization-scoped setting stored with existing Lab Info metadata. */
const BROKEN_SECTION_SETTING_KEY = "ioio_broken_section_location";

const locationSelect = {
  id: true,
  name: true,
  parentId: true,
  imageUrl: true,
  thumbnailUrl: true,
} as const;

type BrokenSectionLocation = {
  id: string;
  name: string;
  path: string;
  imageUrl: string | null;
  thumbnailUrl: string | null;
};

function getLocationPath(
  locationId: string,
  locations: Array<{ id: string; name: string; parentId: string | null }>
) {
  const byId = new Map(locations.map((location) => [location.id, location]));
  const path: string[] = [];
  const visited = new Set<string>();
  let currentId: string | null = locationId;
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const current = byId.get(currentId);
    if (!current) break;
    path.unshift(current.name);
    currentId = current.parentId;
  }
  return path.join(" · ");
}

async function getLocations(organizationId: string) {
  return db.location.findMany({
    where: { organizationId },
    select: locationSelect,
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
}

export async function getBrokenSectionSettings(organizationId: string) {
  const [setting, locations] = await Promise.all([
    db.ioioLabInformationSection.findUnique({
      where: {
        organizationId_key: {
          organizationId,
          key: BROKEN_SECTION_SETTING_KEY,
        },
      },
      select: { content: true },
    }),
    getLocations(organizationId),
  ]);
  const byId = new Map(locations.map((location) => [location.id, location]));
  const locationId = setting?.content ?? null;
  const configured = locationId ? byId.get(locationId) : null;

  return {
    brokenSectionLocationId: configured?.id ?? "",
    brokenSectionOptions: locations.map((location) => ({
      id: location.id,
      path: getLocationPath(location.id, locations),
    })),
    brokenSection: configured
      ? {
          id: configured.id,
          name: configured.name,
          path: getLocationPath(configured.id, locations),
          imageUrl: configured.imageUrl,
          thumbnailUrl: configured.thumbnailUrl,
        }
      : null,
  };
}

export async function getConfiguredBrokenSection(organizationId: string) {
  return (await getBrokenSectionSettings(organizationId)).brokenSection;
}

export async function saveBrokenSectionLocation({
  organizationId,
  locationId,
}: {
  organizationId: string;
  locationId: string;
}) {
  if (locationId) {
    const location = await db.location.findFirst({
      where: { id: locationId, organizationId },
      select: { id: true },
    });
    if (!location) throw new Error("Choose a location in this workspace.");
  }

  return db.ioioLabInformationSection.upsert({
    where: {
      organizationId_key: {
        organizationId,
        key: BROKEN_SECTION_SETTING_KEY,
      },
    },
    create: {
      organizationId,
      key: BROKEN_SECTION_SETTING_KEY,
      title: null,
      content: locationId || null,
      position: 9999,
      isCustom: false,
    },
    update: { content: locationId || null },
    select: { content: true },
  });
}

export type { BrokenSectionLocation };
