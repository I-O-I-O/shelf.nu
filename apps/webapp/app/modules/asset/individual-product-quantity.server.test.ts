import { AssetStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  asset: { findMany: vi.fn() },
  bookingAsset: { findMany: vi.fn() },
  ioioWriteOperation: { findMany: vi.fn() },
}));
const getIoioArchivedItemIdsMock = vi.hoisted(() => vi.fn());

vi.mock("~/database/db.server", () => ({ db: dbMock }));
vi.mock("~/modules/ioio-staff/archive.server", () => ({
  getIoioArchivedItemIds: getIoioArchivedItemIdsMock,
  IOIO_ARCHIVE_ITEM_TYPE: { ASSET: "ASSET" },
}));

import {
  calculateIndividualUnitAvailability,
  getIndividualUnitAvailability,
} from "./individual-product-quantity.server";

describe("individual product availability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getIoioArchivedItemIdsMock.mockResolvedValue([]);
    dbMock.asset.findMany.mockResolvedValue(
      ["001", "002", "003", "004", "005"].map((id) => ({
        id,
        status: AssetStatus.AVAILABLE,
        availableToBook: true,
      }))
    );
    dbMock.bookingAsset.findMany.mockResolvedValue([]);
    dbMock.ioioWriteOperation.findMany.mockResolvedValue([]);
  });

  it("counts active physical units and removes units reserved for the selected dates", () => {
    const units = ["001", "002", "003", "004", "005"].map((id) => ({
      id,
      status: AssetStatus.AVAILABLE,
      availableToBook: true,
    }));

    expect(calculateIndividualUnitAvailability(units, [])).toEqual({
      total: 5,
      available: 5,
      availableUnitIds: ["001", "002", "003", "004", "005"],
    });
    expect(calculateIndividualUnitAvailability(units, ["003"])).toMatchObject({
      total: 5,
      available: 4,
      availableUnitIds: ["001", "002", "004", "005"],
    });
  });

  it("does not count unavailable or non-bookable physical units", () => {
    expect(
      calculateIndividualUnitAvailability(
        [
          {
            id: "001",
            status: AssetStatus.AVAILABLE,
            availableToBook: true,
          },
          {
            id: "002",
            status: AssetStatus.CHECKED_OUT,
            availableToBook: true,
          },
          {
            id: "003",
            status: AssetStatus.AVAILABLE,
            availableToBook: false,
          },
        ],
        []
      )
    ).toMatchObject({ total: 3, available: 1, availableUnitIds: ["001"] });
  });

  it("keeps ready and cancelled prepared pickups unavailable until Staff puts them back", async () => {
    dbMock.ioioWriteOperation.findMany.mockResolvedValue([
      { assetId: "002" },
      { assetId: "004" },
    ]);

    const heldResult = await getIndividualUnitAvailability({
      organizationId: "org-1",
      assetIds: ["001", "002", "003", "004", "005"],
      window: null,
    });

    expect(heldResult).toEqual({
      total: 5,
      available: 3,
      availableUnitIds: ["001", "003", "005"],
    });
    expect(dbMock.ioioWriteOperation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: "org-1",
          operationType: "IOIO_PREPARATION",
          status: { in: ["READY_FOR_PICKUP", "CANCELLED_PICKUP"] },
          bookingAssetId: { not: null },
        }),
      })
    );

    // Put-back changes the operation out of both held states.
    dbMock.ioioWriteOperation.findMany.mockResolvedValue([]);
    await expect(
      getIndividualUnitAvailability({
        organizationId: "org-1",
        assetIds: ["001", "002", "003", "004", "005"],
        window: null,
      })
    ).resolves.toMatchObject({ total: 5, available: 5 });
  });
});
