import { AssetType } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  asset: { findFirst: vi.fn(), findMany: vi.fn() },
  bookingAsset: { findMany: vi.fn() },
  ioioWriteOperation: { findMany: vi.fn() },
}));
const getAssetAvailabilityMock = vi.hoisted(() => vi.fn());
const getIndividualUnitAvailabilityMock = vi.hoisted(() => vi.fn());
const getIoioArchivedItemIdsMock = vi.hoisted(() => vi.fn());

vi.mock("~/database/db.server", () => ({ db: dbMock }));
vi.mock("~/modules/asset/availability.server", () => ({
  getAssetAvailability: getAssetAvailabilityMock,
}));
vi.mock("~/modules/asset/individual-product-quantity.server", () => ({
  getIndividualUnitAvailability: getIndividualUnitAvailabilityMock,
}));
vi.mock("~/modules/ioio-staff/archive.server", () => ({
  getIoioArchivedItemIds: getIoioArchivedItemIdsMock,
  IOIO_ARCHIVE_ITEM_TYPE: "ASSET",
}));

import {
  calculateMaxStaffReservedQuantity,
  getIoioAvailability,
} from "./availability.server";

const from = new Date("2026-09-20T00:00:00.000Z");
const to = new Date("2026-09-25T00:00:00.000Z");

describe("calculateMaxStaffReservedQuantity", () => {
  it("does not double-count overlapping pooled reservations", () => {
    const rows = [
      {
        assetId: "motor",
        bookingId: "reservation-a",
        quantity: 4,
        booking: {
          from: new Date("2026-09-20T00:00:00.000Z"),
          to: new Date("2026-09-25T00:00:00.000Z"),
        },
      },
      {
        assetId: "motor",
        bookingId: "reservation-b",
        quantity: 4,
        booking: {
          from: new Date("2026-09-22T00:00:00.000Z"),
          to: new Date("2026-09-24T00:00:00.000Z"),
        },
      },
    ];

    expect(
      calculateMaxStaffReservedQuantity(rows, AssetType.QUANTITY_TRACKED, 5)
    ).toBe(5);
  });

  it("counts distinct physical units across overlapping reservations", () => {
    const rows = [
      {
        assetId: "unit-1",
        bookingId: "reservation-a",
        quantity: 1,
        booking: { from, to },
      },
      {
        assetId: "unit-1",
        bookingId: "reservation-b",
        quantity: 1,
        booking: { from, to },
      },
      {
        assetId: "unit-2",
        bookingId: "reservation-a",
        quantity: 1,
        booking: { from, to },
      },
    ];

    expect(
      calculateMaxStaffReservedQuantity(rows, AssetType.INDIVIDUAL, 5)
    ).toBe(2);
  });
});

describe("getIoioAvailability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getIoioArchivedItemIdsMock.mockResolvedValue([]);
    dbMock.ioioWriteOperation.findMany.mockResolvedValue([]);
    getAssetAvailabilityMock.mockResolvedValue({
      bookable: 5,
      physicalAvailable: 5,
    });
    getIndividualUnitAvailabilityMock.mockImplementation(
      ({ assetIds }: { assetIds: string[] }) =>
        Promise.resolve({
          total: assetIds.length,
          available: assetIds.length,
          availableUnitIds: assetIds,
        })
    );
  });

  it("reports the logical product quantity for a selected individual unit", async () => {
    dbMock.asset.findFirst.mockResolvedValue({
      id: "unit-1",
      type: AssetType.INDIVIDUAL,
      quantity: null,
      availableToBook: true,
      assetModelId: "model-a",
    });
    dbMock.asset.findMany.mockResolvedValue([
      { id: "unit-1", status: "AVAILABLE", availableToBook: true },
      { id: "unit-2", status: "AVAILABLE", availableToBook: true },
      { id: "unit-3", status: "AVAILABLE", availableToBook: true },
      { id: "unit-4", status: "AVAILABLE", availableToBook: true },
      { id: "unit-5", status: "AVAILABLE", availableToBook: true },
    ]);
    dbMock.bookingAsset.findMany.mockResolvedValue([
      {
        assetId: "unit-1",
        bookingId: "reservation-a",
        quantity: 1,
        booking: { from, to },
      },
      {
        assetId: "unit-2",
        bookingId: "reservation-a",
        quantity: 1,
        booking: { from, to },
      },
      {
        assetId: "unit-3",
        bookingId: "reservation-a",
        quantity: 1,
        booking: { from, to },
      },
      {
        assetId: "unit-4",
        bookingId: "reservation-a",
        quantity: 1,
        booking: { from, to },
      },
    ]);

    const result = await getIoioAvailability({
      organizationId: "org-a",
      productId: "unit-1",
      candidateAssetIds: ["unit-1"],
      from,
      to,
    });

    expect(result.totalActive).toBe(5);
    expect(result.availableCount).toBe(1);
    expect(result.staffReservedCount).toBe(4);
    expect(result.staffReservationBookingIds).toEqual(["reservation-a"]);
  });

  it("uses the shared individual-unit availability result for prepared pickup holds", async () => {
    dbMock.asset.findFirst.mockResolvedValue({
      id: "logical-product",
      type: AssetType.INDIVIDUAL,
      quantity: null,
      availableToBook: true,
      assetModelId: "model-a",
    });
    dbMock.asset.findMany.mockResolvedValue([
      { id: "unit-001", status: "AVAILABLE", availableToBook: true },
      { id: "unit-002", status: "AVAILABLE", availableToBook: true },
    ]);
    dbMock.bookingAsset.findMany.mockResolvedValue([]);
    getIndividualUnitAvailabilityMock.mockResolvedValue({
      total: 2,
      available: 1,
      availableUnitIds: ["unit-002"],
    });

    const result = await getIoioAvailability({
      organizationId: "org-a",
      productId: "logical-product",
      from,
      to,
    });

    expect(result.availableUnitIds).toEqual(["unit-002"]);
    expect(result.availableUnitIdsWithoutStaffReservations).toEqual([
      "unit-002",
    ]);
    expect(result.availableWithoutStaffReservations).toBe(1);
    expect(dbMock.ioioWriteOperation.findMany).not.toHaveBeenCalled();
  });
});
