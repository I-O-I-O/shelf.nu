import { describe, expect, it } from "vitest";

// This opt-in integration test uses the real local database and canonical
// createLocation service. It is intentionally separate from mocked unit tests.
const enabled = process.env.RUN_LOCAL_LOCATION_INTEGRATION === "1";

describe.skipIf(!enabled)("local createLocation integration", () => {
  it("creates a Room, Section, Shelf, and Container with valid parents", async () => {
    const { config } = await import("dotenv");
    config({ path: "../../.env", override: true, quiet: true });
    const databaseUrl = process.env.DATABASE_URL;
    const parsedDatabaseUrl = databaseUrl ? new URL(databaseUrl) : null;
    const isLocalDevelopmentDatabase =
      parsedDatabaseUrl !== null &&
      ["127.0.0.1", "localhost", "::1"].includes(parsedDatabaseUrl.hostname) &&
      parsedDatabaseUrl.port === "58322" &&
      parsedDatabaseUrl.pathname === "/postgres";
    if (!isLocalDevelopmentDatabase) {
      throw new Error(
        "Refusing location integration test: DATABASE_URL must target local Supabase at 127.0.0.1:58322/postgres."
      );
    }

    const [
      { db },
      { createLocation, getLocations },
      { getIoioArchivedItemIds },
      { summarizeIoioLocationInventory },
    ] = await Promise.all([
      import("~/database/db.server"),
      import("~/modules/location/service.server"),
      import("~/modules/ioio-staff/archive.server"),
      import("~/modules/location/ioio-hierarchy"),
    ]);
    const room = await db.location.findFirst({
      where: { parentId: null },
      select: { id: true, name: true, organizationId: true, userId: true },
      orderBy: { createdAt: "asc" },
    });
    expect(
      room,
      "local development database must contain a root Room"
    ).not.toBeNull();
    if (!room) return;

    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const createdIds: string[] = [];
    const createForTest = async (
      name: string,
      parentId: string | null,
      color?: string
    ) => {
      const location = await createLocation({
        name,
        description: "",
        address: "",
        userId: room.userId,
        organizationId: room.organizationId,
        parentId,
        ...(color !== undefined ? { color } : {}),
      });
      createdIds.push(location.id);
      return location;
    };

    try {
      const newRoom = await createForTest(
        `diagnostic-room-${suffix}`,
        null,
        "#455A64"
      );
      expect(newRoom.parentId).toBeNull();

      const section = await createForTest(
        `diagnostic-section-${suffix}`,
        room.id
      );
      expect(section.parentId).toBe(room.id);

      const shelf = await createForTest(
        `diagnostic-shelf-${suffix}`,
        section.id
      );
      expect(shelf.parentId).toBe(section.id);

      const container = await createForTest(
        `diagnostic-container-${suffix}`,
        shelf.id
      );
      expect(container.parentId).toBe(shelf.id);

      const createdRows = await db.location.findMany({
        where: { id: { in: createdIds }, organizationId: room.organizationId },
        select: { id: true, parentId: true, organizationId: true },
      });
      expect(createdRows).toHaveLength(4);
      expect(createdRows.find(({ id }) => id === newRoom.id)?.parentId).toBe(
        null
      );
      expect(createdRows.find(({ id }) => id === section.id)?.parentId).toBe(
        room.id
      );
      expect(createdRows.find(({ id }) => id === shelf.id)?.parentId).toBe(
        section.id
      );
      expect(createdRows.find(({ id }) => id === container.id)?.parentId).toBe(
        shelf.id
      );

      const reloaded = await getLocations({
        organizationId: room.organizationId,
        page: 1,
        perPage: 25,
      });
      expect(reloaded.locations.map(({ id }) => id)).toEqual(
        expect.arrayContaining(createdIds)
      );

      const archivedAssetIds = await getIoioArchivedItemIds({
        organizationId: room.organizationId,
        itemType: "ASSET",
      });
      const [activeAssignments, unassignedAssetCount] = await Promise.all([
        db.assetLocation.findMany({
          where: {
            organizationId: room.organizationId,
            asset: {
              organizationId: room.organizationId,
              id: { notIn: archivedAssetIds },
            },
          },
          select: { assetId: true, locationId: true },
          distinct: ["assetId", "locationId"],
        }),
        db.asset.count({
          where: {
            organizationId: room.organizationId,
            id: { notIn: archivedAssetIds },
            assetLocations: { none: {} },
          },
        }),
      ]);
      expect(() =>
        summarizeIoioLocationInventory({
          locations: reloaded.locations,
          assignments: activeAssignments,
          unassignedAssetCount,
        })
      ).not.toThrow();
    } finally {
      if (createdIds.length) {
        await db.$transaction([
          db.activityEvent.deleteMany({
            where: { entityType: "LOCATION", entityId: { in: createdIds } },
          }),
          db.location.deleteMany({ where: { id: { in: createdIds } } }),
        ]);
      }
    }
  });
});
