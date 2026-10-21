import { AssetType, BookingStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assetFindFirst: vi.fn(),
  bookingAssetFindMany: vi.fn(),
  getIoioAvailability: vi.fn(),
}));

// why: this unit test isolates the conflict policy and does not require a live
// database or send email while evaluating availability.
vi.mock("~/database/db.server", () => ({
  db: {
    asset: { findFirst: mocks.assetFindFirst },
    bookingAsset: { findMany: mocks.bookingAssetFindMany },
  },
}));
vi.mock("~/emails/mail.server", () => ({ sendEmail: vi.fn() }));
vi.mock("~/utils/env", () => ({ SERVER_URL: "http://localhost" }));
vi.mock("./availability.server", () => ({
  getIoioAvailability: mocks.getIoioAvailability,
}));

import { getIoioStaffReservationConflictSummary } from "./staff-reservation-conflicts.server";

const window = {
  from: new Date("2026-10-09T00:00:00.000Z"),
  to: new Date("2026-11-23T23:59:59.999Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assetFindFirst.mockResolvedValue({
    type: AssetType.INDIVIDUAL,
    assetModelId: "makey-model",
  });
  mocks.bookingAssetFindMany.mockResolvedValue([]);
  mocks.getIoioAvailability.mockResolvedValue({
    totalActive: 5,
    availableCount: 0,
    availableUnitIds: [],
    availableUnitIdsWithoutStaffReservations: [],
    conflicts: [],
    staffReservedCount: 5,
    staffReservationBookingIds: ["course-calendar-booking"],
    staffReservationFrom: window.from,
    staffReservationTo: window.to,
    availableWithoutStaffReservations: 5,
  });
});

describe("getIoioStaffReservationConflictSummary", () => {
  it("ignores only marked Calendar reservations and keeps active loans hard", async () => {
    mocks.bookingAssetFindMany.mockResolvedValue([
      {
        id: "loan-booking-asset",
        assetId: "makey-001",
        quantity: 1,
        asset: { title: "Makey Kit #001" },
        booking: {
          id: "active-student-loan",
          status: BookingStatus.ONGOING,
          to: new Date("2026-10-15T00:00:00.000Z"),
          custodianUser: {
            displayName: null,
            firstName: "Student",
            lastName: "Borrower",
          },
        },
      },
    ]);
    mocks.getIoioAvailability
      .mockResolvedValueOnce({
        totalActive: 5,
        availableCount: 0,
        availableUnitIds: [],
        availableUnitIdsWithoutStaffReservations: [],
        conflicts: [],
        staffReservedCount: 5,
        staffReservationBookingIds: ["course-calendar-booking"],
        staffReservationFrom: window.from,
        staffReservationTo: window.to,
        availableWithoutStaffReservations: 4,
      })
      .mockResolvedValueOnce({
        totalActive: 5,
        availableCount: 4,
        availableUnitIds: ["makey-002", "makey-003", "makey-004", "makey-005"],
        availableUnitIdsWithoutStaffReservations: [],
        conflicts: [],
        staffReservedCount: 0,
        staffReservationBookingIds: [],
        staffReservationFrom: null,
        staffReservationTo: null,
        availableWithoutStaffReservations: 4,
      });

    const result = await getIoioStaffReservationConflictSummary({
      organizationId: "ioio-dev",
      productId: "makey-model",
      candidateAssetIds: [
        "makey-001",
        "makey-002",
        "makey-003",
        "makey-004",
        "makey-005",
      ],
      quantity: 1,
      ...window,
    });

    expect(result.loanBookingIds).toEqual(["active-student-loan"]);
    expect(result.staffReservationBookingIds).toEqual([
      "course-calendar-booking",
    ]);
    expect(result.softConflictBookingIds).toEqual(["course-calendar-booking"]);
    expect(result.available).toBe(4);
    expect(result.availableAfterSoftConflicts).toBe(4);
    expect(result.availableUnitIdsAfterSoftConflicts).toEqual([
      "makey-002",
      "makey-003",
      "makey-004",
      "makey-005",
    ]);
    expect(mocks.getIoioAvailability).toHaveBeenLastCalledWith({
      organizationId: "ioio-dev",
      productId: "makey-model",
      candidateAssetIds: [
        "makey-001",
        "makey-002",
        "makey-003",
        "makey-004",
        "makey-005",
      ],
      ...window,
      excludeBookingIds: ["course-calendar-booking"],
    });
  });

  it("does not create a soft override when only a Student loan conflicts", async () => {
    mocks.getIoioAvailability.mockResolvedValue({
      totalActive: 5,
      availableCount: 0,
      availableUnitIds: [],
      availableUnitIdsWithoutStaffReservations: [],
      conflicts: [],
      staffReservedCount: 0,
      staffReservationBookingIds: [],
      staffReservationFrom: null,
      staffReservationTo: null,
      availableWithoutStaffReservations: 0,
    });
    mocks.bookingAssetFindMany.mockResolvedValue([
      {
        id: "loan-booking-asset",
        assetId: "makey-001",
        quantity: 1,
        asset: { title: "Makey Kit #001" },
        booking: {
          id: "active-student-loan",
          status: BookingStatus.ONGOING,
          to: new Date("2026-10-15T00:00:00.000Z"),
          custodianUser: null,
        },
      },
    ]);

    const result = await getIoioStaffReservationConflictSummary({
      organizationId: "ioio-dev",
      productId: "makey-model",
      candidateAssetIds: ["makey-001"],
      quantity: 1,
      ...window,
    });

    expect(result.loanBookingIds).toEqual(["active-student-loan"]);
    expect(result.softConflictBookingIds).toEqual([]);
    expect(result.availableAfterSoftConflicts).toBe(0);
    expect(mocks.getIoioAvailability).toHaveBeenCalledTimes(1);
  });

  it("reports four units when one unit is held for preparation", async () => {
    mocks.getIoioAvailability.mockResolvedValue({
      totalActive: 5,
      availableCount: 4,
      availableUnitIds: ["makey-001", "makey-002", "makey-003", "makey-005"],
      availableUnitIdsWithoutStaffReservations: [
        "makey-001",
        "makey-002",
        "makey-003",
        "makey-005",
      ],
      conflicts: [],
      staffReservedCount: 0,
      staffReservationBookingIds: [],
      staffReservationFrom: null,
      staffReservationTo: null,
      availableWithoutStaffReservations: 4,
    });

    const result = await getIoioStaffReservationConflictSummary({
      organizationId: "ioio-dev",
      productId: "makey-model",
      candidateAssetIds: [
        "makey-001",
        "makey-002",
        "makey-003",
        "makey-004",
        "makey-005",
      ],
      quantity: 4,
      ...window,
    });

    expect(result).toMatchObject({
      total: 5,
      available: 4,
      requested: 4,
      shortfall: 0,
      availableAfterSoftConflicts: 4,
      availableUnitIdsAfterSoftConflicts: [
        "makey-001",
        "makey-002",
        "makey-003",
        "makey-005",
      ],
    });
  });

  it("keeps the count at three when two units have hard date conflicts", async () => {
    mocks.getIoioAvailability.mockResolvedValue({
      totalActive: 5,
      availableCount: 3,
      availableUnitIds: ["makey-001", "makey-003", "makey-005"],
      availableUnitIdsWithoutStaffReservations: [
        "makey-001",
        "makey-003",
        "makey-005",
      ],
      conflicts: [],
      staffReservedCount: 0,
      staffReservationBookingIds: [],
      staffReservationFrom: null,
      staffReservationTo: null,
      availableWithoutStaffReservations: 3,
    });

    const result = await getIoioStaffReservationConflictSummary({
      organizationId: "ioio-dev",
      productId: "makey-model",
      candidateAssetIds: [
        "makey-001",
        "makey-002",
        "makey-003",
        "makey-004",
        "makey-005",
      ],
      quantity: 4,
      ...window,
    });

    expect(result.available).toBe(3);
    expect(result.shortfall).toBe(1);
    expect(result.availableUnitIdsAfterSoftConflicts).toEqual([
      "makey-001",
      "makey-003",
      "makey-005",
    ]);
  });
});
