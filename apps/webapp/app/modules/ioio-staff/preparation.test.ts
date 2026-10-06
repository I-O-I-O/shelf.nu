import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  ioioWriteOperation: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    updateMany: vi.fn(),
  },
  booking: { findFirst: vi.fn() },
  asset: { findFirst: vi.fn() },
  qr: { findFirst: vi.fn() },
}));

vi.mock("~/database/db.server", () => ({ db: dbMock }));
vi.mock("~/emails/mail.server", () => ({ sendEmail: vi.fn() }));
vi.mock("~/modules/booking/service.server", () => ({
  createBooking: vi.fn(),
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
}));
vi.mock("~/modules/ioio-student/annual-access.server", () => ({
  assertAnnualAccessApproved: vi.fn(),
}));
vi.mock("~/utils/scheduler.server", () => ({
  QueueNames: { bookingQueue: "booking-queue" },
  scheduler: { sendAfter: vi.fn().mockResolvedValue("scheduled-job") },
}));

import {
  cancelBooking,
  checkoutBooking,
  partialCheckoutBooking,
} from "~/modules/booking/service.server";
import {
  getPreparationCancellationLabel,
  getPreparationPickupDeadline,
} from "./preparation";
import {
  cancelStudentPreparationRequest,
  confirmStudentPreparationPickup,
  declinePreparation,
  expireReadyPreparationPickup,
  markPreparationReady,
} from "./preparation.server";

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
            maxBorrowDays: 45,
            assetKits: [{ kit: { maxBorrowDays: 45 } }],
          },
        },
      ],
    });
    dbMock.qr.findFirst.mockResolvedValue(null);
    dbMock.ioioWriteOperation.updateMany.mockResolvedValue({ count: 1 });
  });

  it("rejects a different physical unit without checking out the booking", async () => {
    await expect(
      confirmStudentPreparationPickup({
        organizationId: "ioio-lab",
        operationId: "preparation-1",
        borrowerUserId: "student-1",
        hints: {} as never,
        verificationValue: "#002",
      })
    ).rejects.toMatchObject({
      message: "This isn't the kit assigned to your request.",
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
    vi.mocked(cancelBooking).mockResolvedValue({} as never);
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
        where: expect.objectContaining({ bookingId: "booking-1" }),
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
