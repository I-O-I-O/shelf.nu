import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  ioioWriteOperation: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    updateMany: vi.fn(),
    update: vi.fn(),
    upsert: vi.fn(),
  },
  booking: { findFirst: vi.fn() },
  bookingAsset: { findFirst: vi.fn(), findMany: vi.fn() },
  asset: { findFirst: vi.fn(), findMany: vi.fn() },
  teamMember: { findFirst: vi.fn() },
  user: { findFirst: vi.fn() },
  qr: { findFirst: vi.fn() },
  barcode: { findFirst: vi.fn() },
  kit: { findFirst: vi.fn() },
}));

vi.mock("~/database/db.server", () => ({ db: dbMock }));
vi.mock("~/emails/mail.server", () => ({ sendEmail: vi.fn() }));
vi.mock("~/modules/booking/service.server", () => ({
  createBooking: vi.fn(),
  deleteBooking: vi.fn(),
  cancelBooking: vi.fn(),
  checkoutBooking: vi.fn(),
  partialCheckoutBooking: vi.fn(),
  reserveBooking: vi.fn(),
  updateBookingAssets: vi.fn(),
}));
vi.mock("~/modules/email-preferences/service.server", () => ({
  shouldSendOptionalEmail: vi.fn(),
}));
vi.mock("~/modules/email-templates/definitions", () => ({
  getEmailTemplateDefinition: vi.fn(),
}));
vi.mock("~/modules/email-templates/service.server", () => ({
  getResolvedEmailTemplate: vi.fn(),
  renderEmailTemplate: vi.fn(),
}));
vi.mock("~/modules/ioio-staff/pickup-zone.server", () => ({
  ensurePickupZone: vi.fn(),
  getPickupLocationDisplay: vi.fn(),
}));
vi.mock("~/modules/working-hours/service.server", () => ({
  getWorkingHoursForOrganization: vi.fn(),
}));
vi.mock("~/modules/ioio-student/availability.server", () => ({
  getIoioAvailability: vi.fn(),
  IOIO_STAFF_RESERVATION_ACKNOWLEDGEMENT:
    "Student acknowledged IOIO staff reservation overlap.",
}));
vi.mock("~/modules/ioio-student/annual-access.server", () => ({
  assertAnnualAccessApproved: vi.fn(),
}));
vi.mock("~/utils/scheduler.server", () => ({
  QueueNames: { bookingQueue: "booking-queue" },
  scheduler: { sendAfter: vi.fn().mockResolvedValue("scheduled-job") },
}));

import {
  createBooking,
  deleteBooking,
  cancelBooking,
  checkoutBooking,
  partialCheckoutBooking,
  reserveBooking,
  updateBookingAssets,
} from "~/modules/booking/service.server";
import { shouldSendOptionalEmail } from "~/modules/email-preferences/service.server";
import {
  ensurePickupZone,
  getPickupLocationDisplay,
} from "~/modules/ioio-staff/pickup-zone.server";
import {
  getIoioAvailability,
  IOIO_STAFF_RESERVATION_ACKNOWLEDGEMENT,
} from "~/modules/ioio-student/availability.server";
import { getWorkingHoursForOrganization } from "~/modules/working-hours/service.server";
import {
  getPreparationCancellationLabel,
  getPreparationPickupDeadline,
} from "./preparation";
import {
  cancelStudentPreparationRequest,
  assignPreparationRequest,
  confirmPreparationReady,
  confirmStudentPreparationPickup,
  validateStudentPreparationPickup,
  declinePreparation,
  expireReadyPreparationPickup,
  markPreparationReady,
} from "./preparation.server";

const MAKER_KIT_UNITS = [
  { id: "unit-001", title: "Makey Kit #001" },
  { id: "unit-002", title: "Makey Kit #002" },
  { id: "unit-003", title: "Makey Kit #003" },
  { id: "unit-004", title: "Makey Kit #004" },
  { id: "unit-005", title: "Makey Kit #005" },
];

function setupPreparationAssignment({
  availableUnitIds,
  quantity = 1,
  draftUnitIds = ["unit-001"],
  acknowledgedStaffReservation = false,
  availableUnitIdsWithoutStaffReservations = MAKER_KIT_UNITS.map(
    ({ id }) => id
  ),
}: {
  availableUnitIds: string[];
  quantity?: number;
  draftUnitIds?: string[];
  acknowledgedStaffReservation?: boolean;
  availableUnitIdsWithoutStaffReservations?: string[];
}) {
  const request = {
    id: "request-1",
    userId: "student-1",
    assetId: "product-1",
    selectedAssetIds: MAKER_KIT_UNITS.map(({ id }) => id),
    quantity,
    from: new Date("2026-10-11T00:00:00.000Z"),
    to: new Date("2026-11-22T23:59:59.999Z"),
    bookingId: draftUnitIds.length ? "draft-1" : null,
    description: acknowledgedStaffReservation
      ? `Student requested equipment preparation. ${IOIO_STAFF_RESERVATION_ACKNOWLEDGEMENT}`
      : "Student requested equipment preparation.",
  };
  const draftBooking = {
    id: "draft-1",
    status: "DRAFT",
    bookingAssets: draftUnitIds.map((assetId) => ({ assetId, quantity: 1 })),
  };

  dbMock.ioioWriteOperation.findFirst.mockResolvedValue(request);
  dbMock.ioioWriteOperation.findMany.mockResolvedValue([]);
  dbMock.ioioWriteOperation.updateMany.mockResolvedValue({ count: 1 });
  dbMock.ioioWriteOperation.update.mockResolvedValue({ id: "request-1" });
  dbMock.ioioWriteOperation.upsert.mockImplementation(
    ({ create }: { create: { idempotencyKey: string } }) =>
      Promise.resolve({
        id: `task-${create.idempotencyKey}`,
        status: "PENDING_PREPARATION",
      })
  );
  dbMock.asset.findFirst.mockImplementation(({ where }) =>
    Promise.resolve(
      where.id === "product-1"
        ? {
            id: "product-1",
            title: "Makey Kit #005",
            type: "INDIVIDUAL",
            quantity: null,
            maxBorrowDays: 45,
            assetModel: { name: "Makey Kit" },
            assetLocations: [],
            assetKits: [],
          }
        : {
            id: where.id,
            title: MAKER_KIT_UNITS.find((unit) => unit.id === where.id)?.title,
          }
    )
  );
  dbMock.booking.findFirst.mockResolvedValue(draftBooking);
  dbMock.teamMember.findFirst.mockResolvedValue({ id: "student-member-1" });
  dbMock.bookingAsset.findMany.mockImplementation(() =>
    Promise.resolve(
      availableUnitIds
        .filter((id) => MAKER_KIT_UNITS.some((unit) => unit.id === id))
        .sort()
        .slice(0, quantity)
        .map((assetId, index) => ({
          id: `booking-asset-${index + 1}`,
          assetId,
          quantity: 1,
          asset: { assetLocations: [] },
        }))
    )
  );
  vi.mocked(getIoioAvailability).mockResolvedValue({
    totalActive: MAKER_KIT_UNITS.length,
    availableCount: availableUnitIds.length,
    availableUnitIds,
    // Staff reservations are intentionally ignored for some IOIO capacity
    // views, but Shelf's final reservation still treats them as conflicts.
    availableUnitIdsWithoutStaffReservations,
    conflicts: [],
    staffReservedCount: MAKER_KIT_UNITS.length - availableUnitIds.length,
    staffReservationBookingIds: ["staff-reservation-1"],
    staffReservationFrom: new Date("2026-10-11T00:00:00.000Z"),
    staffReservationTo: new Date("2027-01-30T23:59:59.999Z"),
    availableWithoutStaffReservations: MAKER_KIT_UNITS.length,
  });
  vi.mocked(updateBookingAssets).mockResolvedValue({} as never);
  vi.mocked(reserveBooking).mockResolvedValue({} as never);
  vi.mocked(createBooking).mockResolvedValue({ id: "draft-1" } as never);
}

describe("logical preparation physical-unit assignment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("marks a logical request ready with a free unit instead of its conflicted draft unit", async () => {
    setupPreparationAssignment({
      availableUnitIds: ["unit-002", "unit-003", "unit-004", "unit-005"],
      draftUnitIds: ["unit-001"],
    });
    dbMock.ioioWriteOperation.findFirst.mockImplementation(
      ({ where }: { where: { id: string } }) =>
        Promise.resolve(
          where.id === "task-IOIO_PREPARATION:booking-asset-1"
            ? {
                id: where.id,
                assetId: "unit-002",
                bookingAssetId: "booking-asset-1",
                bookingId: "draft-1",
                userId: "student-1",
                quantity: 1,
                from: new Date("2026-10-11T00:00:00.000Z"),
                to: new Date("2026-11-22T23:59:59.999Z"),
                locationId: null,
              }
            : {
                id: "request-1",
                source: "IOIO_PREPARATION_REQUEST",
                bookingAssetId: null,
                userId: "student-1",
                assetId: "product-1",
                selectedAssetIds: MAKER_KIT_UNITS.map(({ id }) => id),
                quantity: 1,
                from: new Date("2026-10-11T00:00:00.000Z"),
                to: new Date("2026-11-22T23:59:59.999Z"),
                bookingId: "draft-1",
              }
        )
    );
    dbMock.ioioWriteOperation.findMany.mockResolvedValue([
      {
        id: "task-IOIO_PREPARATION:booking-asset-1",
        status: "PENDING_PREPARATION",
      },
    ]);
    dbMock.booking.findFirst
      .mockResolvedValueOnce({
        id: "draft-1",
        status: "DRAFT",
        bookingAssets: [{ assetId: "unit-001", quantity: 1 }],
      })
      .mockResolvedValueOnce({
        id: "draft-1",
        status: "DRAFT",
        bookingAssets: [],
      });
    dbMock.bookingAsset.findMany.mockResolvedValue([
      {
        id: "booking-asset-1",
        assetId: "unit-002",
        quantity: 1,
        asset: { assetLocations: [] },
      },
    ]);
    dbMock.bookingAsset.findFirst.mockResolvedValue({
      booking: { status: "RESERVED" },
      asset: { title: "Makey Kit #002" },
    });
    dbMock.user.findFirst.mockResolvedValue({
      id: "student-1",
      email: null,
      firstName: "Student",
      lastName: "Borrower",
      displayName: null,
    });
    vi.mocked(ensurePickupZone).mockResolvedValue({
      id: "pickup-zone",
    } as never);
    vi.mocked(getPickupLocationDisplay).mockResolvedValue({
      label: "IOIO Pickup Zone",
    } as never);
    vi.mocked(getWorkingHoursForOrganization).mockResolvedValue({
      enabled: false,
      weeklySchedule: null,
    } as never);
    vi.mocked(shouldSendOptionalEmail).mockResolvedValue(false);

    const result = await confirmPreparationReady({
      organizationId: "ioio-lab",
      operationId: "request-1",
      staffUserId: "staff-1",
      hints: {} as never,
    });

    expect(result).toMatchObject({ assigned: 1, markedReady: 1 });
    expect(updateBookingAssets).toHaveBeenCalledWith(
      expect.objectContaining({ assetIds: ["unit-002"] })
    );
    expect(reserveBooking).toHaveBeenCalledOnce();
    expect(dbMock.ioioWriteOperation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "task-IOIO_PREPARATION:booking-asset-1",
        }),
        data: expect.objectContaining({ status: "READY_FOR_PICKUP" }),
      })
    );
  });

  it("skips two conflicted units and assigns the next reservable unit", async () => {
    setupPreparationAssignment({
      availableUnitIds: ["unit-003", "unit-004", "unit-005"],
      draftUnitIds: ["unit-001"],
    });

    await assignPreparationRequest({
      organizationId: "ioio-lab",
      operationId: "request-1",
      staffUserId: "staff-1",
      assignedAssetIds: [],
      hints: {} as never,
    });

    expect(updateBookingAssets).toHaveBeenCalledWith(
      expect.objectContaining({ assetIds: ["unit-003"] })
    );
  });

  it("allows an acknowledged course reservation while preserving hard conflicts", async () => {
    setupPreparationAssignment({
      availableUnitIds: [],
      acknowledgedStaffReservation: true,
      availableUnitIdsWithoutStaffReservations: [
        "unit-002",
        "unit-003",
        "unit-004",
        "unit-005",
      ],
      draftUnitIds: ["unit-001"],
    });

    await assignPreparationRequest({
      organizationId: "ioio-lab",
      operationId: "request-1",
      staffUserId: "staff-1",
      assignedAssetIds: [],
      hints: {} as never,
    });

    expect(updateBookingAssets).toHaveBeenCalledWith(
      expect.objectContaining({ assetIds: ["unit-002"] })
    );
    expect(reserveBooking).toHaveBeenCalledWith(
      expect.objectContaining({ ignoreBookingIds: ["staff-reservation-1"] })
    );
  });

  it("assigns a unit when the only conflicts are acknowledged course reservations", async () => {
    setupPreparationAssignment({
      availableUnitIds: [],
      acknowledgedStaffReservation: true,
      draftUnitIds: ["unit-001"],
    });

    await assignPreparationRequest({
      organizationId: "ioio-lab",
      operationId: "request-1",
      staffUserId: "staff-1",
      assignedAssetIds: [],
      hints: {} as never,
    });

    expect(updateBookingAssets).toHaveBeenCalledWith(
      expect.objectContaining({ assetIds: ["unit-001"] })
    );
    expect(reserveBooking).toHaveBeenCalledWith(
      expect.objectContaining({ ignoreBookingIds: ["staff-reservation-1"] })
    );
  });

  it("keeps a request unassigned when every physical unit conflicts", async () => {
    setupPreparationAssignment({
      availableUnitIds: [],
      draftUnitIds: ["unit-001"],
    });

    await expect(
      assignPreparationRequest({
        organizationId: "ioio-lab",
        operationId: "request-1",
        staffUserId: "staff-1",
        assignedAssetIds: [],
        hints: {} as never,
      })
    ).rejects.toThrow(
      "No Makey Kit units are available for this booking period."
    );

    expect(dbMock.ioioWriteOperation.updateMany).not.toHaveBeenCalled();
    expect(updateBookingAssets).not.toHaveBeenCalled();
    expect(reserveBooking).not.toHaveBeenCalled();
  });

  it("assigns the requested quantity using distinct reservable physical units", async () => {
    setupPreparationAssignment({
      availableUnitIds: ["unit-002", "unit-003"],
      quantity: 2,
      draftUnitIds: ["unit-001"],
    });

    await assignPreparationRequest({
      organizationId: "ioio-lab",
      operationId: "request-1",
      staffUserId: "staff-1",
      assignedAssetIds: [],
      hints: {} as never,
    });

    expect(updateBookingAssets).toHaveBeenCalledWith(
      expect.objectContaining({ assetIds: ["unit-002", "unit-003"] })
    );
  });

  it("does not partially assign when fewer units are available than requested", async () => {
    setupPreparationAssignment({
      availableUnitIds: ["unit-002"],
      quantity: 2,
      draftUnitIds: ["unit-001"],
    });

    await expect(
      assignPreparationRequest({
        organizationId: "ioio-lab",
        operationId: "request-1",
        staffUserId: "staff-1",
        assignedAssetIds: [],
        hints: {} as never,
      })
    ).rejects.toThrow(
      "Only 1 of 2 Makey Kit units are available for this booking period."
    );

    expect(dbMock.ioioWriteOperation.updateMany).not.toHaveBeenCalled();
    expect(updateBookingAssets).not.toHaveBeenCalled();
    expect(reserveBooking).not.toHaveBeenCalled();
  });

  it("returns the preparation request to the queue if final reservation detects a race", async () => {
    setupPreparationAssignment({
      availableUnitIds: ["unit-002", "unit-003"],
      draftUnitIds: ["unit-001"],
    });
    vi.mocked(reserveBooking).mockRejectedValue(
      new Error(
        "Cannot reserve booking because unit-002 is no longer available."
      )
    );

    await expect(
      assignPreparationRequest({
        organizationId: "ioio-lab",
        operationId: "request-1",
        staffUserId: "staff-1",
        assignedAssetIds: [],
        hints: {} as never,
      })
    ).rejects.toThrow("unit-002 is no longer available");

    expect(dbMock.ioioWriteOperation.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "ASSIGNING" }),
        data: { status: "PENDING_PREPARATION" },
      })
    );
    expect(dbMock.ioioWriteOperation.upsert).not.toHaveBeenCalled();
  });
});

describe("getPreparationCancellationLabel", () => {
  it("labels expired pickups from their persisted review comment", () => {
    expect(
      getPreparationCancellationLabel("Pickup expired after 7 days.")
    ).toBe("Pickup expired");
  });

  it("labels student-cancelled requests as cancelled", () => {
    expect(getPreparationCancellationLabel("Cancelled by Student.")).toBe(
      "Cancelled"
    );
  });
});

describe("markPreparationReady", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refuses to mark a logical preparation request ready without an assigned booking item", async () => {
    dbMock.ioioWriteOperation.findFirst.mockResolvedValue({
      id: "logical-request-1",
      assetId: "product-1",
      bookingAssetId: null,
      bookingId: null,
      userId: "student-1",
      quantity: 1,
      from: new Date("2026-10-04T09:00:00Z"),
      to: new Date("2026-10-05T09:00:00Z"),
      locationId: null,
    });

    await expect(
      markPreparationReady({
        organizationId: "ioio-lab",
        operationId: "logical-request-1",
        staffUserId: "staff-1",
        hints: {} as never,
        checklist: {
          itemPresent: true,
          itemChecked: true,
          partsIncluded: true,
        },
      })
    ).rejects.toThrow(
      "Assign the requested equipment before marking it ready."
    );

    expect(dbMock.ioioWriteOperation.updateMany).not.toHaveBeenCalled();
  });

  it("declines a request without a reason and keeps the review comment empty", async () => {
    dbMock.ioioWriteOperation.findFirst.mockResolvedValue({
      id: "logical-request-1",
      bookingId: null,
      source: "IOIO_PREPARATION_REQUEST",
    });

    dbMock.ioioWriteOperation.updateMany.mockResolvedValue({ count: 1 });

    await declinePreparation({
      organizationId: "ioio-lab",
      operationId: "logical-request-1",
      staffUserId: "staff-1",
      hints: {} as never,
      staffComment: "   ",
    });

    expect(dbMock.ioioWriteOperation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "DECLINED",
          reviewComment: null,
        }),
      })
    );
    expect(cancelBooking).not.toHaveBeenCalled();
  });

  it("persists a reason when declining an unassigned preparation request", async () => {
    dbMock.ioioWriteOperation.findFirst.mockResolvedValue({
      id: "logical-request-1",
      bookingId: null,
      source: "IOIO_PREPARATION_REQUEST",
    });
    dbMock.ioioWriteOperation.updateMany.mockResolvedValue({ count: 1 });

    await declinePreparation({
      organizationId: "ioio-lab",
      operationId: "logical-request-1",
      staffUserId: "staff-1",
      hints: {} as never,
      staffComment: "The kit is unavailable that week.",
    });

    expect(dbMock.ioioWriteOperation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "logical-request-1" }),
        data: expect.objectContaining({
          status: "DECLINED",
          reviewComment: "The kit is unavailable that week.",
          reviewedByUserId: "staff-1",
        }),
      })
    );
    expect(cancelBooking).not.toHaveBeenCalled();
  });

  it("declines a pending request by deleting its stale draft assignment", async () => {
    dbMock.ioioWriteOperation.findFirst.mockResolvedValue({
      id: "logical-request-1",
      bookingId: "draft-1",
      source: "IOIO_PREPARATION_REQUEST",
    });
    dbMock.booking.findFirst.mockResolvedValue({
      id: "draft-1",
      status: "DRAFT",
    });
    dbMock.ioioWriteOperation.updateMany.mockResolvedValue({ count: 1 });

    await declinePreparation({
      organizationId: "ioio-lab",
      operationId: "logical-request-1",
      staffUserId: "staff-1",
      hints: {} as never,
      staffComment: "The kit is unavailable that week.",
    });

    expect(deleteBooking).toHaveBeenCalledWith(
      { id: "draft-1", organizationId: "ioio-lab" },
      {},
      "staff-1"
    );
    expect(cancelBooking).not.toHaveBeenCalled();
    expect(dbMock.ioioWriteOperation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "DECLINED",
          reviewComment: "The kit is unavailable that week.",
          reviewedByUserId: "staff-1",
        }),
      })
    );
  });
});

describe("ready pickup expiry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses exactly seven days after the ready timestamp as the deadline", () => {
    const readyAt = new Date("2026-10-05T13:20:00.000Z");
    expect(getPreparationPickupDeadline(readyAt).toISOString()).toBe(
      "2026-10-12T13:20:00.000Z"
    );
  });

  it("does not expire before the deadline", async () => {
    const readyAt = new Date("2026-10-05T13:20:00.000Z");
    const expired = await expireReadyPreparationPickup({
      organizationId: "ioio-lab",
      operationId: "preparation-1",
      readyAt,
      now: new Date("2026-10-12T13:19:59.999Z"),
    });

    expect(expired).toBe(false);
    expect(dbMock.ioioWriteOperation.updateMany).not.toHaveBeenCalled();
  });

  it("atomically moves an uncollected ready pickup into the put-back queue", async () => {
    dbMock.ioioWriteOperation.updateMany.mockResolvedValue({ count: 1 });
    const readyAt = new Date("2026-10-05T13:20:00.000Z");
    const now = getPreparationPickupDeadline(readyAt);

    const expired = await expireReadyPreparationPickup({
      organizationId: "ioio-lab",
      operationId: "preparation-1",
      readyAt,
      now,
    });

    expect(expired).toBe(true);
    expect(dbMock.ioioWriteOperation.updateMany).toHaveBeenCalledWith({
      where: {
        id: "preparation-1",
        organizationId: "ioio-lab",
        operationType: "IOIO_PREPARATION",
        status: "READY_FOR_PICKUP",
        reviewedAt: readyAt,
      },
      data: expect.objectContaining({
        status: "CANCELLED_PICKUP",
        completedAt: null,
        reviewComment: "Pickup expired after 7 days.",
      }),
    });
  });
});

describe("confirmStudentPreparationPickup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.ioioWriteOperation.findFirst.mockResolvedValue({
      id: "preparation-1",
      bookingId: "booking-1",
      assetId: "unit-1",
      bookingAssetId: "booking-asset-1",
      to: new Date("2026-10-20T00:00:00Z"),
      reviewedAt: new Date("2999-01-01T00:00:00Z"),
    });
    dbMock.booking.findFirst.mockResolvedValue({
      status: "RESERVED",
      bookingAssets: [
        {
          id: "booking-asset-1",
          assetId: "unit-1",
          checkedOutAt: null,
          checkedInAt: null,
          asset: {
            id: "unit-1",
            title: "Makey Kit #001",
            type: "INDIVIDUAL",
            assetModelId: "model-1",
            sequentialId: "001",
            assetModel: { name: "Makey Kit" },
            maxBorrowDays: 45,
            qrCodes: [{ id: "qr-assigned-unit" }],
            barcodes: [{ value: "MAKEY-001" }],
            organizationId: "ioio-lab",
            assetKits: [{ kit: { maxBorrowDays: 45 } }],
          },
        },
      ],
    });
    dbMock.qr.findFirst.mockResolvedValue(null);
    dbMock.barcode.findFirst.mockResolvedValue(null);
    dbMock.ioioWriteOperation.updateMany.mockResolvedValue({ count: 1 });
  });

  it("rejects a different physical unit without checking out the booking", async () => {
    dbMock.asset.findFirst.mockResolvedValue({
      id: "unit-2",
      title: "Makey Kit #002",
      assetModelId: "model-1",
      type: "INDIVIDUAL",
    });
    await expect(
      confirmStudentPreparationPickup({
        organizationId: "ioio-lab",
        operationId: "preparation-1",
        borrowerUserId: "student-1",
        hints: {} as never,
        verificationValue: "#002",
      })
    ).rejects.toMatchObject({
      message: "Wrong unit. This request is assigned to Makey Kit #001.",
      status: 400,
    });

    expect(dbMock.ioioWriteOperation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: "student-1" }),
      })
    );
    expect(dbMock.booking.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ custodianUserId: "student-1" }),
      })
    );
    expect(checkoutBooking).not.toHaveBeenCalled();
  });

  it("expires a pickup at its deadline and refuses checkout", async () => {
    const readyAt = new Date("2026-09-20T10:00:00.000Z");
    dbMock.ioioWriteOperation.findFirst.mockResolvedValue({
      id: "preparation-1",
      bookingId: "booking-1",
      assetId: "unit-1",
      bookingAssetId: "booking-asset-1",
      to: new Date("2026-10-20T00:00:00Z"),
      reviewedAt: readyAt,
    });
    dbMock.ioioWriteOperation.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      confirmStudentPreparationPickup({
        organizationId: "ioio-lab",
        operationId: "preparation-1",
        borrowerUserId: "student-1",
        hints: {} as never,
        verificationValue: "001",
      })
    ).rejects.toThrow("This pickup has expired.");

    expect(dbMock.ioioWriteOperation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "CANCELLED_PICKUP",
          reviewComment: "Pickup expired after 7 days.",
        }),
      })
    );
    expect(dbMock.booking.findFirst).not.toHaveBeenCalled();
    expect(checkoutBooking).not.toHaveBeenCalled();
  });

  it("checks out only the assigned unit after a matching unit number is entered", async () => {
    await confirmStudentPreparationPickup({
      organizationId: "ioio-lab",
      operationId: "preparation-1",
      borrowerUserId: "student-1",
      hints: {} as never,
      verificationValue: "001",
    });

    expect(checkoutBooking).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "booking-1",
        organizationId: "ioio-lab",
        userId: "student-1",
      })
    );
    expect(dbMock.ioioWriteOperation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "READY_FOR_PICKUP" }),
        data: expect.objectContaining({ status: "PICKED_UP" }),
      })
    );
  });

  it.each([
    "http://127.0.0.1:3000/qr/vdqo0i7hk9",
    "http://localhost:3000/qr/vdqo0i7hk9",
    "/qr/vdqo0i7hk9",
  ])("resolves a QR URL to the assigned physical unit: %s", async (value) => {
    dbMock.qr.findFirst.mockImplementation(({ where }) =>
      Promise.resolve(
        where.id === "vdqo0i7hk9"
          ? { id: "vdqo0i7hk9", assetId: "unit-1", kitId: null }
          : null
      )
    );
    dbMock.asset.findFirst.mockResolvedValue({
      id: "unit-1",
      title: "Makey Kit #001",
      assetModelId: "model-1",
      type: "INDIVIDUAL",
    });

    const validation = await validateStudentPreparationPickup({
      organizationId: "ioio-lab",
      operationId: "preparation-1",
      borrowerUserId: "student-1",
      verificationValue: value,
    });

    expect(validation).toMatchObject({
      valid: true,
      status: "valid",
      assignedUnitLabel: "Makey Kit #001",
    });
    expect(dbMock.qr.findFirst).toHaveBeenCalledWith({
      where: { id: "vdqo0i7hk9", organizationId: "ioio-lab" },
      select: { id: true, assetId: true, kitId: true },
    });
    expect(checkoutBooking).not.toHaveBeenCalled();
  });

  it("checks out the assigned physical unit after its QR URL is scanned", async () => {
    dbMock.qr.findFirst.mockResolvedValue({
      id: "vdqo0i7hk9",
      assetId: "unit-1",
      kitId: null,
    });
    dbMock.asset.findFirst.mockResolvedValue({
      id: "unit-1",
      title: "Makey Kit #001",
      assetModelId: "model-1",
      type: "INDIVIDUAL",
    });

    await confirmStudentPreparationPickup({
      organizationId: "ioio-lab",
      operationId: "preparation-1",
      borrowerUserId: "student-1",
      hints: {} as never,
      verificationValue: "http://127.0.0.1:3000/qr/vdqo0i7hk9",
    });

    expect(dbMock.qr.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "vdqo0i7hk9", organizationId: "ioio-lab" },
      })
    );
    expect(checkoutBooking).toHaveBeenCalledTimes(1);
    expect(dbMock.ioioWriteOperation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "PICKED_UP" }),
      })
    );
  });

  it("distinguishes a wrong sibling unit from another equipment type", async () => {
    dbMock.qr.findFirst.mockImplementation(({ where }) =>
      Promise.resolve(
        where.id === "qr-unit-004"
          ? { id: where.id, assetId: "unit-004", kitId: null }
          : where.id === "qr-other-model"
          ? { id: where.id, assetId: "other-item", kitId: null }
          : null
      )
    );
    dbMock.asset.findFirst.mockImplementation(({ where }) =>
      Promise.resolve(
        where.id === "unit-004"
          ? {
              id: "unit-004",
              title: "Makey Kit #004",
              assetModelId: "model-1",
              type: "INDIVIDUAL",
            }
          : {
              id: "other-item",
              title: "Oscilloscope #001",
              assetModelId: "model-2",
              type: "INDIVIDUAL",
            }
      )
    );

    const wrongUnit = await validateStudentPreparationPickup({
      organizationId: "ioio-lab",
      operationId: "preparation-1",
      borrowerUserId: "student-1",
      verificationValue: "http://localhost:3000/qr/qr-unit-004",
    });
    const wrongItem = await validateStudentPreparationPickup({
      organizationId: "ioio-lab",
      operationId: "preparation-1",
      borrowerUserId: "student-1",
      verificationValue: "http://localhost:3000/qr/qr-other-model",
    });

    expect(wrongUnit).toMatchObject({ valid: false, status: "wrong-unit" });
    expect(wrongItem).toMatchObject({ valid: false, status: "wrong-item" });
  });

  it("accepts a typed unit number and an organization-scoped barcode", async () => {
    const typedNumber = await validateStudentPreparationPickup({
      organizationId: "ioio-lab",
      operationId: "preparation-1",
      borrowerUserId: "student-1",
      verificationValue: "#001",
    });
    dbMock.barcode.findFirst.mockResolvedValue({ assetId: "unit-1" });
    dbMock.asset.findFirst.mockResolvedValue({
      id: "unit-1",
      title: "Makey Kit #001",
      assetModelId: "model-1",
      type: "INDIVIDUAL",
    });
    const barcode = await validateStudentPreparationPickup({
      organizationId: "ioio-lab",
      operationId: "preparation-1",
      borrowerUserId: "student-1",
      verificationValue: "MAKEY-001",
    });

    expect(typedNumber).toMatchObject({ valid: true, status: "valid" });
    expect(barcode).toMatchObject({ valid: true, status: "valid" });
    expect(dbMock.barcode.findFirst).toHaveBeenCalledWith({
      where: { organizationId: "ioio-lab", value: "MAKEY-001" },
      select: { assetId: true },
    });
  });

  it("reconciles a pickup whose exact assigned slice was already checked out", async () => {
    dbMock.booking.findFirst.mockResolvedValue({
      status: "ONGOING",
      bookingAssets: [
        {
          id: "booking-asset-1",
          assetId: "unit-1",
          checkedOutAt: new Date("2026-10-05T10:00:00Z"),
          checkedInAt: null,
          asset: {
            id: "unit-1",
            title: "Makey Kit #002",
            type: "INDIVIDUAL",
            maxBorrowDays: 45,
            assetKits: [{ kit: { maxBorrowDays: 45 } }],
          },
        },
      ],
    });

    await confirmStudentPreparationPickup({
      organizationId: "ioio-lab",
      operationId: "preparation-1",
      borrowerUserId: "student-1",
      hints: {} as never,
      verificationValue: "#002",
    });

    expect(checkoutBooking).not.toHaveBeenCalled();
    expect(partialCheckoutBooking).not.toHaveBeenCalled();
    expect(dbMock.ioioWriteOperation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "READY_FOR_PICKUP" }),
        data: expect.objectContaining({ status: "PICKED_UP" }),
      })
    );
  });

  it("checks out only the assigned unit when another slice already started the booking", async () => {
    dbMock.booking.findFirst.mockResolvedValue({
      status: "ONGOING",
      bookingAssets: [
        {
          id: "booking-asset-1",
          assetId: "unit-1",
          checkedOutAt: null,
          checkedInAt: null,
          asset: {
            id: "unit-1",
            title: "Makey Kit #002",
            type: "INDIVIDUAL",
            maxBorrowDays: 45,
            assetKits: [{ kit: { maxBorrowDays: 45 } }],
          },
        },
      ],
    });
    vi.mocked(partialCheckoutBooking).mockResolvedValue({} as never);

    await confirmStudentPreparationPickup({
      organizationId: "ioio-lab",
      operationId: "preparation-1",
      borrowerUserId: "student-1",
      hints: {} as never,
      verificationValue: "#002",
    });

    expect(partialCheckoutBooking).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "booking-1",
        organizationId: "ioio-lab",
        assetIds: ["unit-1"],
        userId: "student-1",
      })
    );
    expect(checkoutBooking).not.toHaveBeenCalled();
  });
});

describe("cancelStudentPreparationRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.ioioWriteOperation.updateMany.mockResolvedValue({ count: 1 });
    dbMock.ioioWriteOperation.findMany.mockResolvedValue([]);
    dbMock.ioioWriteOperation.count.mockResolvedValue(0);
    dbMock.booking.findFirst.mockResolvedValue(null);
    vi.mocked(cancelBooking).mockResolvedValue({} as never);
    vi.mocked(deleteBooking).mockResolvedValue({} as never);
  });

  it("retains an unassigned request as cancelled history", async () => {
    dbMock.ioioWriteOperation.findFirst.mockResolvedValue({
      id: "request-1",
      source: "IOIO_PREPARATION_REQUEST",
      status: "PENDING_PREPARATION",
      bookingId: null,
    });

    await cancelStudentPreparationRequest({
      organizationId: "ioio-lab",
      operationId: "request-1",
      borrowerUserId: "student-1",
      hints: {} as never,
    });

    expect(dbMock.ioioWriteOperation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "request-1",
          organizationId: "ioio-lab",
          userId: "student-1",
        }),
      })
    );
    expect(dbMock.ioioWriteOperation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "PENDING_PREPARATION" }),
        data: expect.objectContaining({ status: "CANCELLED" }),
      })
    );
    expect(cancelBooking).not.toHaveBeenCalled();
  });

  it("keeps a prepared unit reserved and creates a Staff put-back task", async () => {
    dbMock.ioioWriteOperation.findFirst.mockResolvedValue({
      id: "preparation-task-1",
      source: "IOIO_ASSISTANT",
      status: "READY_FOR_PICKUP",
      bookingId: "booking-1",
    });
    dbMock.ioioWriteOperation.findMany.mockResolvedValue([
      {
        id: "preparation-task-1",
        status: "READY_FOR_PICKUP",
        bookingAssetId: "booking-asset-1",
        source: "IOIO_ASSISTANT",
      },
    ]);
    dbMock.booking.findFirst.mockResolvedValue({
      id: "booking-1",
      status: "RESERVED",
    });

    await cancelStudentPreparationRequest({
      organizationId: "ioio-lab",
      operationId: "preparation-task-1",
      borrowerUserId: "student-1",
      hints: {} as never,
    });

    expect(cancelBooking).not.toHaveBeenCalled();
    expect(dbMock.ioioWriteOperation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { in: ["preparation-task-1"] },
          status: "READY_FOR_PICKUP",
        }),
        data: expect.objectContaining({ status: "CANCELLED_PICKUP" }),
      })
    );
  });

  it("releases an assigned booking when nothing was physically prepared", async () => {
    dbMock.ioioWriteOperation.findFirst.mockResolvedValue({
      id: "preparation-task-1",
      source: "IOIO_ASSISTANT",
      status: "PENDING_PREPARATION",
      bookingId: "booking-1",
    });
    dbMock.ioioWriteOperation.findMany.mockResolvedValue([
      {
        id: "preparation-task-1",
        status: "PENDING_PREPARATION",
        bookingAssetId: "booking-asset-1",
        source: "IOIO_ASSISTANT",
      },
    ]);
    dbMock.booking.findFirst.mockResolvedValue({
      id: "booking-1",
      status: "RESERVED",
    });

    await cancelStudentPreparationRequest({
      organizationId: "ioio-lab",
      operationId: "preparation-task-1",
      borrowerUserId: "student-1",
      hints: {} as never,
    });

    expect(cancelBooking).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "booking-1",
        expectedStatus: "RESERVED",
      })
    );
    expect(dbMock.ioioWriteOperation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ id: "preparation-task-1" }, { bookingId: "booking-1" }],
        }),
        data: expect.objectContaining({ status: "CANCELLED" }),
      })
    );
  });

  it("deletes a stale draft assignment and cancels the pending request", async () => {
    dbMock.ioioWriteOperation.findFirst.mockResolvedValue({
      id: "request-1",
      source: "IOIO_PREPARATION_REQUEST",
      status: "PENDING_PREPARATION",
      bookingId: "draft-1",
    });
    dbMock.booking.findFirst.mockResolvedValue({
      id: "draft-1",
      status: "DRAFT",
    });
    dbMock.ioioWriteOperation.findMany.mockResolvedValue([
      {
        id: "request-1",
        status: "PENDING_PREPARATION",
        bookingAssetId: null,
        source: "IOIO_PREPARATION_REQUEST",
      },
      {
        id: "task-1",
        status: "PENDING_PREPARATION",
        bookingAssetId: "draft-booking-asset-1",
        source: "IOIO_ASSISTANT",
      },
    ]);

    await cancelStudentPreparationRequest({
      organizationId: "ioio-lab",
      operationId: "request-1",
      borrowerUserId: "student-1",
      hints: {} as never,
    });

    expect(deleteBooking).toHaveBeenCalledWith(
      { id: "draft-1", organizationId: "ioio-lab" },
      {},
      "student-1"
    );
    expect(cancelBooking).not.toHaveBeenCalled();
    expect(dbMock.ioioWriteOperation.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: "ioio-lab",
          operationType: "IOIO_PREPARATION",
          status: {
            in: [
              "PENDING_PREPARATION",
              "ASSIGNING",
              "ASSIGNED",
              "READY_FOR_PICKUP",
            ],
          },
        }),
        data: expect.objectContaining({
          status: "CANCELLED",
          reviewComment: "Cancelled by Student.",
        }),
      })
    );
  });

  it("finds and deletes a request draft created before its id was linked", async () => {
    dbMock.ioioWriteOperation.findFirst.mockResolvedValue({
      id: "request-1",
      source: "IOIO_PREPARATION_REQUEST",
      status: "PENDING_PREPARATION",
      bookingId: null,
    });
    dbMock.booking.findFirst.mockResolvedValue({
      id: "orphan-draft-1",
      status: "DRAFT",
    });
    dbMock.ioioWriteOperation.findMany.mockResolvedValue([]);

    await cancelStudentPreparationRequest({
      organizationId: "ioio-lab",
      operationId: "request-1",
      borrowerUserId: "student-1",
      hints: {} as never,
    });

    expect(dbMock.booking.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: "ioio-lab",
          description: "IOIO_PREPARATION_REQUEST:request-1",
        }),
      })
    );
    expect(deleteBooking).toHaveBeenCalledOnce();
    expect(dbMock.ioioWriteOperation.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ id: "request-1" }, { bookingId: "orphan-draft-1" }],
        }),
        data: expect.objectContaining({ status: "CANCELLED" }),
      })
    );
  });

  it("refuses cancellation after pickup", async () => {
    dbMock.ioioWriteOperation.findFirst.mockResolvedValue({
      id: "preparation-task-1",
      source: "IOIO_ASSISTANT",
      status: "PICKED_UP",
      bookingId: "booking-1",
    });

    await expect(
      cancelStudentPreparationRequest({
        organizationId: "ioio-lab",
        operationId: "preparation-task-1",
        borrowerUserId: "student-1",
        hints: {} as never,
      })
    ).rejects.toThrow("This equipment has already been picked up.");
    expect(cancelBooking).not.toHaveBeenCalled();
    expect(dbMock.ioioWriteOperation.updateMany).not.toHaveBeenCalled();
  });
});

describe("putBackCancelledPreparationPickup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.ioioWriteOperation.count.mockResolvedValue(0);
    dbMock.ioioWriteOperation.updateMany.mockResolvedValue({ count: 1 });
    dbMock.ioioWriteOperation.findFirst.mockResolvedValue({
      id: "pickup-task-1",
      bookingId: "booking-1",
      bookingAssetId: "booking-asset-1",
      assetId: "unit-1",
    });
    dbMock.booking.findFirst.mockResolvedValue({
      id: "booking-1",
      status: "RESERVED",
      bookingAssets: [{ id: "booking-asset-1", assetId: "unit-1" }],
    });
    dbMock.asset.findFirst.mockResolvedValue({
      id: "unit-1",
      title: "Makey Kit #001",
    });
    vi.mocked(cancelBooking).mockResolvedValue({} as never);
  });

  it("releases the final reserved hold only after confirming the physical unit", async () => {
    const { putBackCancelledPreparationPickup } = await import(
      "./preparation.server"
    );
    await putBackCancelledPreparationPickup({
      organizationId: "ioio-lab",
      operationId: "pickup-task-1",
      staffUserId: "staff-1",
      hints: {} as never,
    });

    expect(cancelBooking).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "booking-1",
        userId: "staff-1",
        expectedStatus: "RESERVED",
      })
    );
    expect(dbMock.ioioWriteOperation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "pickup-task-1",
          status: "CANCELLED_PICKUP",
        }),
        data: expect.objectContaining({
          status: "CANCELLED",
          reviewedByUserId: "staff-1",
        }),
      })
    );
  });

  it("keeps the booking reserved while another physical unit still needs put-back", async () => {
    const { putBackCancelledPreparationPickup } = await import(
      "./preparation.server"
    );
    dbMock.ioioWriteOperation.count.mockResolvedValue(1);

    await putBackCancelledPreparationPickup({
      organizationId: "ioio-lab",
      operationId: "pickup-task-1",
      staffUserId: "staff-1",
      hints: {} as never,
    });

    expect(cancelBooking).not.toHaveBeenCalled();
  });
});
