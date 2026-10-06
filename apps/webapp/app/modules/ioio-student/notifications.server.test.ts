import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  ioioWriteOperation: { findMany: vi.fn() },
  cardAccessRequest: { findFirst: vi.fn() },
  booking: { findMany: vi.fn() },
  asset: { findMany: vi.fn() },
  annualAccessApprovalNotification: { findFirst: vi.fn() },
}));

vi.mock("~/database/db.server", () => ({ db: dbMock }));
vi.mock("~/modules/ioio-staff/pickup-zone.server", () => ({
  getPickupLocationDisplay: vi.fn(),
}));

import type { getStudentAnnualAccessApproval } from "./annual-access.server";
import { getStudentIoioNotifications } from "./notifications.server";

const approvedAt = new Date("2026-09-30T10:00:00.000Z");

describe("Student annual borrowing approval notification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.ioioWriteOperation.findMany.mockResolvedValue([]);
    dbMock.cardAccessRequest.findFirst.mockResolvedValue(null);
    dbMock.booking.findMany.mockResolvedValue([]);
    dbMock.asset.findMany.mockResolvedValue([]);
    dbMock.annualAccessApprovalNotification.findFirst.mockResolvedValue(null);
  });

  it("loads only the persisted unread notice for the current approval event", async () => {
    dbMock.annualAccessApprovalNotification.findFirst.mockResolvedValue({
      id: "notice-1",
    });
    const annualApproval = {
      required: true,
      status: "APPROVED" as const,
      approvalId: "approval-1",
      approvedAt,
    } as Awaited<ReturnType<typeof getStudentAnnualAccessApproval>>;

    const notifications = await getStudentIoioNotifications({
      organizationId: "org-1",
      userId: "student-1",
      annualApproval,
    });

    expect(
      dbMock.annualAccessApprovalNotification.findFirst
    ).toHaveBeenCalledWith({
      where: {
        organizationId: "org-1",
        userId: "student-1",
        approvalId: "approval-1",
        eventAt: approvedAt,
        readAt: null,
      },
      select: { id: true },
    });
    expect(notifications).toContainEqual(
      expect.objectContaining({
        annualAccessApprovalNotificationId: "notice-1",
        title: "Borrowing access approved",
        message: "You can now borrow IOIO Lab equipment.",
      })
    );
  });

  it("does not show an old approval notice after borrowing access is revoked", async () => {
    const annualApproval = {
      required: true,
      status: "REVOKED" as const,
      approvalId: "approval-1",
      approvedAt: null,
    } as Awaited<ReturnType<typeof getStudentAnnualAccessApproval>>;

    const notifications = await getStudentIoioNotifications({
      organizationId: "org-1",
      userId: "student-1",
      annualApproval,
    });

    expect(
      dbMock.annualAccessApprovalNotification.findFirst
    ).not.toHaveBeenCalled();
    expect(
      notifications.some(
        (notification) => notification.annualAccessApprovalNotificationId
      )
    ).toBe(false);
  });

  it("shows a declined preparation request with the staff reason", async () => {
    dbMock.ioioWriteOperation.findMany.mockImplementation(({ where }) =>
      where.status === "DECLINED"
        ? Promise.resolve([
            {
              id: "prep-request-1",
              assetId: "makey-kit",
              reviewComment: "The kit is unavailable that week.",
              updatedAt: new Date("2026-10-04T10:00:00Z"),
            },
          ])
        : Promise.resolve([])
    );
    dbMock.asset.findMany.mockResolvedValue([
      { id: "makey-kit", title: "Makey Kit" },
    ]);

    const notifications = await getStudentIoioNotifications({
      organizationId: "org-1",
      userId: "student-1",
      annualApproval: {
        required: false,
        status: "NOT_REQUESTED",
        approvalId: null,
        approvedAt: null,
      } as Awaited<ReturnType<typeof getStudentAnnualAccessApproval>>,
    });

    expect(notifications).toContainEqual(
      expect.objectContaining({
        id: "preparation-declined-prep-request-1",
        title: "Preparation request declined",
        message:
          "Makey Kit was declined. Reason: The kit is unavailable that week.",
        href: "/ioio/loans",
      })
    );
  });

  it("shows a generic declined-preparation message when no reason was entered", async () => {
    dbMock.ioioWriteOperation.findMany.mockImplementation(({ where }) =>
      where.status === "DECLINED"
        ? Promise.resolve([
            {
              id: "prep-request-2",
              assetId: "makey-kit",
              reviewComment: null,
              updatedAt: new Date("2026-10-04T10:00:00Z"),
            },
          ])
        : Promise.resolve([])
    );
    dbMock.asset.findMany.mockResolvedValue([
      { id: "makey-kit", title: "Makey Kit" },
    ]);

    const notifications = await getStudentIoioNotifications({
      organizationId: "org-1",
      userId: "student-1",
      annualApproval: {
        required: false,
        status: "NOT_REQUESTED",
        approvalId: null,
        approvedAt: null,
      } as Awaited<ReturnType<typeof getStudentAnnualAccessApproval>>,
    });

    expect(notifications).toContainEqual(
      expect.objectContaining({
        id: "preparation-declined-prep-request-2",
        title: "Preparation request declined",
        message: "Makey Kit was declined.",
        href: "/ioio/loans",
      })
    );
  });
});
