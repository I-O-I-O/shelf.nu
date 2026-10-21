import { AssetStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  asset: { findMany: vi.fn() },
  booking: { findMany: vi.fn() },
  bookingAsset: { findMany: vi.fn() },
  custody: { findMany: vi.fn() },
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
  getIndividualUnitPreparationStates,
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
    dbMock.booking.findMany.mockResolvedValue([]);
    dbMock.custody.findMany.mockResolvedValue([]);
    dbMock.ioioWriteOperation.findMany.mockResolvedValue([]);
  });

  it("labels exactly the booked units for a quantity-two preparation request", async () => {
    const booked = ["004", "005"].map((assetId) => ({
      id: `slice-${assetId}`,
      assetId,
      bookingId: "reservation-1",
    }));
    dbMock.bookingAsset.findMany.mockResolvedValue(booked);
    dbMock.ioioWriteOperation.findMany.mockImplementation(({ where }) =>
      Promise.resolve(
        where.status === "CANCELLED_PICKUP"
          ? []
          : [
              {
                source: "IOIO_PREPARATION_REQUEST",
                status: "PENDING_PREPARATION",
                bookingId: "reservation-1",
                bookingAssetId: null,
              },
            ]
      )
    );

    const states = await getIndividualUnitPreparationStates({
      organizationId: "org-1",
      assetIds: ["001", "002", "003", "004", "005"],
    });

    expect([...states]).toEqual([
      ["004", ["PENDING_PREPARATION"]],
      ["005", ["PENDING_PREPARATION"]],
    ]);
    expect(states.has("002")).toBe(false);
    expect(
      calculateIndividualUnitAvailability(
        ["001", "002", "003", "004", "005"].map((id) => ({
          id,
          status: AssetStatus.AVAILABLE,
          availableToBook: true,
        })),
        booked.map(({ assetId }) => assetId)
      ).available
    ).toBe(3);
  });

  it("releases cancelled reservations and ignores stale request anchors", async () => {
    dbMock.bookingAsset.findMany.mockResolvedValue([]);
    dbMock.ioioWriteOperation.findMany.mockResolvedValue([]);

    await expect(
      getIndividualUnitPreparationStates({
        organizationId: "org-1",
        assetIds: ["001", "002", "003", "004", "005"],
      })
    ).resolves.toEqual(new Map());
    expect(
      calculateIndividualUnitAvailability(
        ["001", "002", "003", "004", "005"].map((id) => ({
          id,
          status: AssetStatus.AVAILABLE,
          availableToBook: true,
        })),
        []
      ).available
    ).toBe(5);
  });

  it("releases only the cancelled request's physical unit", async () => {
    const activeBookings = [
      { id: "slice-004", assetId: "004", bookingId: "request-a" },
      { id: "slice-005", assetId: "005", bookingId: "request-b" },
    ];
    dbMock.bookingAsset.findMany.mockImplementation(() =>
      Promise.resolve(activeBookings)
    );
    dbMock.ioioWriteOperation.findMany.mockImplementation(({ where }) =>
      Promise.resolve(
        where.status === "CANCELLED_PICKUP"
          ? []
          : activeBookings.map((row) => ({
              source: "IOIO_PREPARATION_REQUEST",
              status: "PENDING_PREPARATION",
              bookingId: row.bookingId,
              bookingAssetId: null,
            }))
      )
    );
    const readStates = () =>
      getIndividualUnitPreparationStates({
        organizationId: "org-1",
        assetIds: ["001", "002", "003", "004", "005"],
      });

    expect((await readStates()).size).toBe(2);
    activeBookings.pop();
    expect([...(await readStates())].map(([id]) => id)).toEqual(["004"]);
    activeBookings.pop();
    expect((await readStates()).size).toBe(0);
  });

  it("keeps a prepared booked unit staged without making another hold", async () => {
    dbMock.bookingAsset.findMany.mockResolvedValue([
      { id: "slice-004", assetId: "004", bookingId: "reservation-1" },
    ]);
    dbMock.ioioWriteOperation.findMany.mockImplementation(({ where }) =>
      Promise.resolve(
        where.status === "CANCELLED_PICKUP"
          ? []
          : [
              {
                source: "IOIO_PREPARATION_REQUEST",
                status: "ASSIGNED",
                bookingId: "reservation-1",
                bookingAssetId: null,
              },
              {
                source: "IOIO_ASSISTANT",
                status: "READY_FOR_PICKUP",
                bookingId: "reservation-1",
                bookingAssetId: "slice-004",
              },
            ]
      )
    );
    const states = await getIndividualUnitPreparationStates({
      organizationId: "org-1",
      assetIds: ["004"],
    });
    expect(states.get("004")).toContain("READY_FOR_PICKUP");
    expect(states.size).toBe(1);
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

  it("counts five units with one active loan as four available and one in use", () => {
    const units = ["001", "002", "003", "004", "005"].map((id) => ({
      id,
      status: AssetStatus.AVAILABLE,
      availableToBook: true,
    }));
    const availability = calculateIndividualUnitAvailability(units, ["003"]);

    expect(availability).toEqual({
      total: 5,
      available: 4,
      availableUnitIds: ["001", "002", "004", "005"],
    });
  });

  it("excludes an unresolved damaged report and ignores resolved or general reports", async () => {
    dbMock.ioioWriteOperation.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ assetId: "003" }]);

    const availability = await getIndividualUnitAvailability({
      organizationId: "org-1",
      assetIds: ["001", "002", "003", "004", "005"],
      window: null,
    });

    expect(availability).toEqual({
      total: 5,
      available: 4,
      availableUnitIds: ["001", "002", "004", "005"],
    });
    expect(dbMock.ioioWriteOperation.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          operationType: "REPORT_PROBLEM",
          status: { in: ["SUCCEEDED", "PROCESSING"] },
          reportType: {
            in: [
              "ITEM_MISSING",
              "ITEM_DAMAGED",
              "ITEM_NOT_WORKING",
              "PART_MISSING",
              "KIT_INCOMPLETE",
            ],
          },
        }),
      })
    );
  });

  it("keeps ready and cancelled prepared pickups unavailable until Staff puts them back", async () => {
    dbMock.ioioWriteOperation.findMany.mockResolvedValue([
      { assetId: "002", status: "READY_FOR_PICKUP", bookingId: "booking-2" },
      { assetId: "004", status: "CANCELLED_PICKUP", bookingId: "booking-4" },
    ]);
    dbMock.booking.findMany.mockResolvedValue([{ id: "booking-2" }]);

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

  it("releases a stale ready-for-pickup state after its booking finishes", async () => {
    dbMock.ioioWriteOperation.findMany.mockImplementation(({ where }) =>
      Promise.resolve(
        where.operationType === "IOIO_PREPARATION"
          ? [
              {
                assetId: "002",
                status: "READY_FOR_PICKUP",
                bookingId: "finished-booking",
              },
            ]
          : []
      )
    );
    dbMock.booking.findMany.mockResolvedValue([]);

    const availability = await getIndividualUnitAvailability({
      organizationId: "org-1",
      assetIds: ["001", "002", "003", "004", "005"],
      window: null,
    });

    expect(availability.available).toBe(5);
  });
});
