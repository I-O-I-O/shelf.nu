import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  $transaction: vi.fn(),
  asset: { findMany: vi.fn(), findFirst: vi.fn(), delete: vi.fn() },
  custody: { findMany: vi.fn() },
  bookingAsset: { findMany: vi.fn() },
  bookingModelRequest: { findMany: vi.fn() },
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

import {
  getIoioAssetLifecycleRedirectTarget,
  getIoioArchivedItemIds,
  IOIO_ITEM_DISPOSITION,
  restoreIoioItem,
  trashIoioItems,
} from "./archive.server";

describe("IOIO asset archive lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const tx = {
      asset: database.asset,
      custody: database.custody,
      bookingAsset: database.bookingAsset,
      bookingModelRequest: database.bookingModelRequest,
      kit: database.kit,
      ioioArchivedItem: database.ioioArchivedItem,
    };
    database.$transaction.mockImplementation((callback) => callback(tx));
    database.asset.findMany.mockImplementation(({ select }) =>
      select?.type
        ? [{ id: "asset-1", title: "IOIO image upload", type: "INDIVIDUAL" }]
        : [
            {
              id: "asset-1",
              status: "AVAILABLE",
              assetModelId: null,
              categoryId: null,
              category: null,
              assetLocations: [],
            },
          ]
    );
    database.kit.findMany.mockResolvedValue([]);
    database.custody.findMany.mockResolvedValue([]);
    database.bookingAsset.findMany.mockResolvedValue([]);
    database.bookingModelRequest.findMany.mockResolvedValue([]);
    database.ioioArchivedItem.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: "marker-1", itemType: "ASSET", itemId: "asset-1" },
      ]);
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
    database.asset.findMany.mockImplementation(({ select }) =>
      select?.type
        ? ids.map((id) => ({ id, title: id, type: "INDIVIDUAL" }))
        : ids.map((id) => ({
            id,
            status: "AVAILABLE",
            assetModelId: null,
            categoryId: null,
            category: null,
            assetLocations: [],
          }))
    );
    database.ioioArchivedItem.findMany
      .mockReset()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(
        ids.map((itemId, index) => ({
          id: `marker-${index + 1}`,
          itemType: "ASSET",
          itemId,
        }))
      );

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
      { assetId: "asset-1", bookingId: "booking-1" },
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
});
