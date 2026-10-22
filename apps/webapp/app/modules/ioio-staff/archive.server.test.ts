import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  $transaction: vi.fn(),
  asset: { findMany: vi.fn(), findFirst: vi.fn(), delete: vi.fn() },
  custody: { findMany: vi.fn() },
  bookingAsset: { findMany: vi.fn(), deleteMany: vi.fn() },
  bookingModelRequest: { findMany: vi.fn() },
  booking: { findMany: vi.fn() },
  ioioWriteOperation: { findMany: vi.fn() },
  kit: { findMany: vi.fn() },
  ioioArchivedItem: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    createMany: vi.fn(),
    deleteMany: vi.fn(),
  },
}));

// why: these lifecycle tests exercise the canonical archive records without
// requiring a running local database or changing inventory data.
vi.mock("~/database/db.server", () => ({ db: database }));

import { IOIO_STAFF_RESERVATION_DESCRIPTION } from "~/modules/ioio-student/reservation-constants";

import {
  getIoioAssetLifecycleRedirectTarget,
  getIoioArchivedItemIds,
  IOIO_ITEM_DISPOSITION,
  restoreIoioItem,
  trashIoioItems,
} from "./archive.server";

const availableAsset = (id: string, title = id) => ({
  id,
  title,
  status: "AVAILABLE",
  assetModelId: null,
  categoryId: null,
  category: null,
  assetLocations: [],
});

function setAssets(ids: string[], titles: string[] = ids) {
  database.asset.findMany.mockImplementation(({ select }) =>
    select?.type
      ? ids.map((id) => ({
          id,
          title: titles[ids.indexOf(id)],
          type: "INDIVIDUAL",
        }))
      : ids.map((id) => availableAsset(id, titles[ids.indexOf(id)]))
  );
}

function setSuccessfulMarkers(ids: string[]) {
  database.ioioArchivedItem.findMany.mockReset();
  database.ioioArchivedItem.findMany
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce(
      ids.map((itemId, index) => ({
        id: `marker-${index + 1}`,
        itemType: "ASSET",
        itemId,
      }))
    );
  database.ioioArchivedItem.createMany.mockResolvedValue({ count: ids.length });
}

function trashAssets(ids: string[]) {
  return trashIoioItems({
    organizationId: "org-1",
    items: ids.map((itemId) => ({ itemType: "ASSET" as const, itemId })),
    trashedById: "staff-1",
  });
}

describe("IOIO asset archive lifecycle", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    const tx = {
      asset: database.asset,
      custody: database.custody,
      bookingAsset: database.bookingAsset,
      bookingModelRequest: database.bookingModelRequest,
      booking: database.booking,
      ioioWriteOperation: database.ioioWriteOperation,
      kit: database.kit,
      ioioArchivedItem: database.ioioArchivedItem,
    };
    database.$transaction.mockImplementation((callback) => callback(tx));
    setAssets(["asset-1"], ["IOIO image upload"]);
    database.kit.findMany.mockResolvedValue([]);
    database.custody.findMany.mockResolvedValue([]);
    database.bookingAsset.findMany.mockResolvedValue([]);
    database.bookingAsset.deleteMany.mockResolvedValue({ count: 0 });
    database.bookingModelRequest.findMany.mockResolvedValue([]);
    database.booking.findMany.mockResolvedValue([]);
    database.ioioWriteOperation.findMany.mockResolvedValue([]);
    setSuccessfulMarkers(["asset-1"]);
    database.ioioArchivedItem.createMany.mockResolvedValue({ count: 1 });
  });

  it("moves an asset to Trash with an organization-scoped reversible marker", async () => {
    await expect(
      trashIoioItems({
        organizationId: "org-1",
        items: [{ itemType: "ASSET", itemId: "asset-1" }],
        trashedById: "staff-1",
      })
    ).resolves.toEqual([
      { id: "marker-1", itemType: "ASSET", itemId: "asset-1" },
    ]);

    expect(database.ioioArchivedItem.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          organizationId: "org-1",
          itemType: "ASSET",
          itemId: "asset-1",
          archivedById: "staff-1",
          disposition: IOIO_ITEM_DISPOSITION.TRASH,
        }),
      ],
    });
    expect(database.asset.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: "org-1" }),
      })
    );
    expect(database.asset.delete).not.toHaveBeenCalled();
    expect(database.ioioArchivedItem.deleteMany).not.toHaveBeenCalled();
  });

  it("moves multiple normal Asset records to Trash by their Asset IDs", async () => {
    const ids = ["asset-1", "asset-2"];
    setAssets(ids);
    setSuccessfulMarkers(ids);

    await expect(
      trashIoioItems({
        organizationId: "org-1",
        items: ids.map((itemId) => ({ itemType: "ASSET", itemId })),
        trashedById: "staff-1",
      })
    ).resolves.toHaveLength(2);

    expect(database.ioioArchivedItem.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({ itemId: "asset-1" }),
        expect.objectContaining({ itemId: "asset-2" }),
      ]),
    });
  });

  it("rejects missing or wrong-organization Asset IDs without making markers", async () => {
    database.asset.findMany.mockImplementation(() => []);

    await expect(
      trashIoioItems({
        organizationId: "org-1",
        items: [{ itemType: "ASSET", itemId: "foreign-or-missing-asset" }],
        trashedById: "staff-1",
      })
    ).rejects.toMatchObject({
      status: 404,
      message: expect.stringContaining("could not be found in this workspace"),
    });

    expect(database.ioioArchivedItem.createMany).not.toHaveBeenCalled();
  });

  it("excludes active markers from inventory and restores the same Shelf asset", async () => {
    database.ioioArchivedItem.findMany.mockReset();
    database.ioioArchivedItem.findMany.mockResolvedValue([
      { itemId: "asset-1" },
    ]);
    await expect(
      getIoioArchivedItemIds({ organizationId: "org-1", itemType: "ASSET" })
    ).resolves.toEqual(["asset-1"]);

    database.ioioArchivedItem.findFirst.mockResolvedValue({ id: "marker-1" });
    database.asset.findFirst.mockResolvedValue({ id: "asset-1" });
    database.ioioArchivedItem.update.mockResolvedValue({
      id: "marker-1",
      restoredAt: new Date("2026-10-14T12:00:00.000Z"),
    });

    await expect(
      restoreIoioItem({
        organizationId: "org-1",
        itemType: "ASSET",
        itemId: "asset-1",
        restoredById: "staff-1",
      })
    ).resolves.toMatchObject({ id: "marker-1", restoredAt: expect.any(Date) });

    expect(database.ioioArchivedItem.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: "org-1",
          itemType: "ASSET",
          itemId: "asset-1",
          restoredAt: null,
        },
      })
    );
    expect(database.asset.findFirst).toHaveBeenCalledWith({
      where: { id: "asset-1", organizationId: "org-1" },
      select: { id: true },
    });
  });

  it("sends a trashed Asset URL to Trash and an archived Asset URL to Inventory", async () => {
    database.ioioArchivedItem.findFirst
      .mockResolvedValueOnce({ disposition: "TRASH" })
      .mockResolvedValueOnce({ disposition: "ARCHIVE" })
      .mockResolvedValueOnce(null);

    await expect(
      getIoioAssetLifecycleRedirectTarget({
        organizationId: "org-1",
        assetId: "asset-1",
      })
    ).resolves.toBe("/staff/trash");
    await expect(
      getIoioAssetLifecycleRedirectTarget({
        organizationId: "org-1",
        assetId: "asset-1",
      })
    ).resolves.toBe("/assets");
    await expect(
      getIoioAssetLifecycleRedirectTarget({
        organizationId: "org-1",
        assetId: "asset-1",
      })
    ).resolves.toBeNull();

    expect(database.ioioArchivedItem.findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: "org-1",
        itemType: "ASSET",
        itemId: "asset-1",
        restoredAt: null,
      },
      orderBy: { archivedAt: "desc" },
      select: { disposition: true },
    });
  });

  it("rejects Trash for an asset with active custody without creating a marker", async () => {
    database.custody.findMany.mockResolvedValue([{ assetId: "asset-1" }]);

    await expect(
      trashIoioItems({
        organizationId: "org-1",
        items: [{ itemType: "ASSET", itemId: "asset-1" }],
        trashedById: "staff-1",
      })
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("checked out or in custody"),
    });

    expect(database.ioioArchivedItem.createMany).not.toHaveBeenCalled();
  });

  it("rejects Trash for an asset with an active booking without creating a marker", async () => {
    database.bookingAsset.findMany.mockResolvedValue([
      {
        assetId: "asset-1",
        bookingId: "booking-1",
        booking: {
          status: "ONGOING",
          description: "Student loan",
          to: new Date("2026-10-25T00:00:00.000Z"),
        },
      },
    ]);

    await expect(
      trashIoioItems({
        organizationId: "org-1",
        items: [{ itemType: "ASSET", itemId: "asset-1" }],
        trashedById: "staff-1",
      })
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("active booking"),
    });

    expect(database.ioioArchivedItem.createMany).not.toHaveBeenCalled();
  });

  it.each([
    ["completed", "COMPLETE", new Date("2026-10-21T00:00:00.000Z")],
    ["cancelled", "CANCELLED", new Date("2026-10-25T00:00:00.000Z")],
    ["expired", "RESERVED", new Date("2026-10-01T00:00:00.000Z")],
  ])(
    "allows Trash when the only membership is a %s booking",
    async (_label, status, to) => {
      database.bookingAsset.findMany.mockResolvedValue([
        {
          assetId: "asset-1",
          bookingId: "booking-history",
          booking: { status, description: "Student booking", to },
        },
      ]);

      await expect(trashAssets(["asset-1"])).resolves.toHaveLength(1);

      expect(database.ioioArchivedItem.createMany).toHaveBeenCalled();
    }
  );

  it("allows Trash for an available unit with only a soft IOIO calendar reservation", async () => {
    database.bookingAsset.findMany.mockResolvedValue([
      {
        assetId: "asset-1",
        bookingId: "course-reservation-1",
        booking: {
          status: "RESERVED",
          description: IOIO_STAFF_RESERVATION_DESCRIPTION,
          to: new Date("2027-01-30T23:59:59.999Z"),
        },
      },
    ]);

    await expect(trashAssets(["asset-1"])).resolves.toHaveLength(1);

    expect(database.ioioArchivedItem.createMany).toHaveBeenCalled();
    // The reversible Trash marker leaves the still-valid soft booking row intact.
    expect(database.bookingAsset.deleteMany).not.toHaveBeenCalled();
  });

  it("allows all five available physical units to move to Trash despite soft reservations", async () => {
    const ids = ["asset-1", "asset-2", "asset-3", "asset-4", "asset-5"];
    setAssets(
      ids,
      ids.map((_, index) => `Makey Kit #00${index + 1}`)
    );
    setSuccessfulMarkers(ids);
    database.bookingAsset.findMany.mockResolvedValue(
      ids.map((assetId, index) => ({
        assetId,
        bookingId: `course-reservation-${index + 1}`,
        booking: {
          status: "RESERVED",
          description: IOIO_STAFF_RESERVATION_DESCRIPTION,
          to: new Date("2027-01-30T23:59:59.999Z"),
        },
      }))
    );

    await expect(trashAssets(ids)).resolves.toHaveLength(5);

    expect(database.ioioArchivedItem.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining(
        ids.map((itemId) => expect.objectContaining({ itemId }))
      ),
    });
  });

  it("reports only the genuinely blocked unit in a mixed bulk selection", async () => {
    const ids = ["asset-1", "asset-2", "asset-3", "asset-4", "asset-5"];
    setAssets(
      ids,
      ids.map((_, index) => `Makey Kit #00${index + 1}`)
    );
    database.bookingAsset.findMany.mockResolvedValue(
      ids.map((assetId, index) => ({
        assetId,
        bookingId:
          index === 2 ? "live-booking-3" : `course-reservation-${index + 1}`,
        booking: {
          status: "RESERVED",
          description:
            index === 2
              ? "Student booking"
              : IOIO_STAFF_RESERVATION_DESCRIPTION,
          to: new Date("2027-01-30T23:59:59.999Z"),
        },
      }))
    );

    const rejection = trashAssets(ids);
    const failure = await rejection.catch((error: unknown) => error);
    expect(failure).toMatchObject({ status: 409 });
    expect((failure as Error).message).toContain("Makey Kit #003 (asset-3)");
    expect((failure as Error).message).not.toContain("Makey Kit #001");
    expect(database.ioioArchivedItem.createMany).not.toHaveBeenCalled();
  });

  it("keeps checked-out units blocked and identifies the unit", async () => {
    database.asset.findMany.mockImplementation(({ select }) =>
      select?.type
        ? [{ id: "asset-1", title: "Makey Kit #001", type: "INDIVIDUAL" }]
        : [
            {
              ...availableAsset("asset-1", "Makey Kit #001"),
              status: "CHECKED_OUT",
            },
          ]
    );

    await expect(trashAssets(["asset-1"])).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("Makey Kit #001 (asset-1)"),
    });

    expect(database.ioioArchivedItem.createMany).not.toHaveBeenCalled();
  });

  it("keeps a staged cancelled pickup blocked after its booking is cancelled", async () => {
    database.ioioWriteOperation.findMany.mockResolvedValue([
      {
        assetId: "asset-1",
        bookingId: "cancelled-booking-1",
        status: "CANCELLED_PICKUP",
      },
    ]);

    await expect(trashAssets(["asset-1"])).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("IOIO image upload (asset-1)"),
    });

    expect(database.booking.findMany).not.toHaveBeenCalled();
    expect(database.ioioArchivedItem.createMany).not.toHaveBeenCalled();
  });

  it("keeps a ready pickup blocked only while its Shelf booking is reserved", async () => {
    database.ioioWriteOperation.findMany.mockResolvedValue([
      {
        assetId: "asset-1",
        bookingId: "ready-booking-1",
        status: "READY_FOR_PICKUP",
      },
    ]);
    database.booking.findMany.mockResolvedValue([{ id: "ready-booking-1" }]);

    await expect(trashAssets(["asset-1"])).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("active preparation or pickup"),
    });

    expect(database.booking.findMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["ready-booking-1"] },
        organizationId: "org-1",
        status: "RESERVED",
      },
      select: { id: true },
    });
  });

  it("keeps a unit with an active preparation commitment blocked", async () => {
    database.bookingAsset.findMany.mockResolvedValue([
      {
        assetId: "asset-1",
        bookingId: "preparation-booking-1",
        booking: {
          status: "RESERVED",
          description: IOIO_STAFF_RESERVATION_DESCRIPTION,
          to: new Date("2027-01-30T23:59:59.999Z"),
        },
      },
    ]);
    database.ioioWriteOperation.findMany.mockResolvedValue([
      {
        assetId: "asset-1",
        bookingAssetId: "booking-asset-1",
        bookingId: "preparation-booking-1",
        status: "PENDING_PREPARATION",
      },
    ]);
    database.booking.findMany.mockResolvedValue([
      { id: "preparation-booking-1" },
    ]);

    await expect(trashAssets(["asset-1"])).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("IOIO image upload (asset-1)"),
    });

    expect(database.ioioArchivedItem.createMany).not.toHaveBeenCalled();
  });

  it("ignores a soft model-level calendar request when validating physical units", async () => {
    setAssets(["asset-1"], ["Makey Kit #001"]);
    database.asset.findMany.mockImplementation(({ select }) =>
      select?.type
        ? [{ id: "asset-1", title: "Makey Kit #001", type: "INDIVIDUAL" }]
        : [
            {
              ...availableAsset("asset-1", "Makey Kit #001"),
              assetModelId: "model-1",
            },
          ]
    );
    database.bookingModelRequest.findMany.mockResolvedValue([
      {
        assetModelId: "model-1",
        bookingId: "course-reservation-1",
        booking: {
          status: "RESERVED",
          description: IOIO_STAFF_RESERVATION_DESCRIPTION,
          to: new Date("2027-01-30T23:59:59.999Z"),
        },
      },
    ]);

    await expect(trashAssets(["asset-1"])).resolves.toHaveLength(1);
  });
});
