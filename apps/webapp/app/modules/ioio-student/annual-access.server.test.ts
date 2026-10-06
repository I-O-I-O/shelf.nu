import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  organization: { findUnique: vi.fn(), update: vi.fn() },
  annualAccessApproval: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    updateMany: vi.fn(),
  },
  annualAccessApprovalNotification: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    updateMany: vi.fn(),
    upsert: vi.fn(),
  },
  ioioLabTA: { findFirst: vi.fn() },
  userOrganization: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    upsert: vi.fn(),
  },
  user: { findUnique: vi.fn(), updateMany: vi.fn() },
  teamMember: { findFirst: vi.fn(), create: vi.fn() },
  $transaction: vi.fn(),
}));

vi.mock("~/database/db.server", () => ({ db: dbMock }));
vi.mock("~/emails/email.worker.server", () => ({ triggerEmail: vi.fn() }));
vi.mock("~/modules/email-preferences/service.server", () => ({
  shouldSendOptionalEmail: vi.fn().mockResolvedValue(false),
}));

import {
  ACCESS_APPROVAL_RENEWAL_MODE,
  assertAnnualAccessApproved,
  getApprovalValidUntil,
  getCurrentApprovalCycle,
  getStaffAnnualAccessApprovals,
  grantAnnualAccessToStudent,
  getStudentAnnualAccessApproval,
  markAnnualAccessApprovalNotificationRead,
  reapproveAnnualAccessApproval,
  reviewAnnualAccessApprovals,
  revokeAnnualAccessApproval,
  type AccessApprovalSettings,
} from "./annual-access.server";

const baseSettings: AccessApprovalSettings = {
  required: true,
  renewalMode: ACCESS_APPROVAL_RENEWAL_MODE.ACADEMIC_YEAR,
  renewalMonth: 9,
  customMonths: null,
  studentMessage: "Approval required",
};

describe("configurable Student access approval periods", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.annualAccessApprovalNotification.upsert.mockResolvedValue({});
    dbMock.annualAccessApprovalNotification.updateMany.mockResolvedValue({
      count: 1,
    });
    dbMock.$transaction.mockImplementation((callback) =>
      typeof callback === "function"
        ? callback({
            annualAccessApproval: dbMock.annualAccessApproval,
            annualAccessApprovalNotification:
              dbMock.annualAccessApprovalNotification,
          })
        : Promise.all(callback)
    );
  });

  it("uses the configured renewal month to resolve academic cycles", () => {
    const cycle = getCurrentApprovalCycle(
      new Date("2026-07-20T12:00:00.000Z"),
      { ...baseSettings, renewalMonth: 8 }
    );

    expect(cycle.approvalYear).toBe(2025);
    expect(cycle.label).toBe("2025-2026");
    expect(cycle.start.toISOString()).toBe("2025-08-01T00:00:00.000Z");
  });

  it("stores a configured academic renewal expiry without using a fixed September", () => {
    const validUntil = getApprovalValidUntil(
      new Date("2026-07-20T12:00:00.000Z"),
      { ...baseSettings, renewalMonth: 8 }
    );

    expect(validUntil.toISOString()).toBe("2026-07-31T23:59:59.999Z");
  });

  it.each([
    [
      ACCESS_APPROVAL_RENEWAL_MODE.TWELVE_MONTHS,
      null,
      "2027-10-15T23:59:59.999Z",
    ],
    [ACCESS_APPROVAL_RENEWAL_MODE.SIX_MONTHS, null, "2027-04-15T23:59:59.999Z"],
    [ACCESS_APPROVAL_RENEWAL_MODE.CUSTOM, 9, "2027-07-15T23:59:59.999Z"],
  ] as const)(
    "calculates %s validity from the approval date",
    (renewalMode, customMonths, expected) => {
      expect(
        getApprovalValidUntil(new Date("2026-10-15T12:30:00.000Z"), {
          ...baseSettings,
          renewalMode,
          customMonths,
        }).toISOString()
      ).toBe(expected);
    }
  );

  it("does not require approval for ADMIN or IOIO TAs", async () => {
    await expect(
      assertAnnualAccessApproved({
        organizationId: "org-1",
        userId: "staff-1",
        role: "ADMIN",
      })
    ).resolves.toBeUndefined();
    expect(dbMock.ioioLabTA.findFirst).not.toHaveBeenCalled();

    dbMock.ioioLabTA.findFirst.mockResolvedValue({ id: "ta-1" });
    await expect(
      assertAnnualAccessApproved({
        organizationId: "org-1",
        userId: "ta-1",
        role: "SELF_SERVICE",
      })
    ).resolves.toBeUndefined();
    expect(dbMock.organization.findUnique).not.toHaveBeenCalled();
  });

  it("allows Student borrowing when the organization disables the requirement", async () => {
    dbMock.ioioLabTA.findFirst.mockResolvedValue(null);
    dbMock.organization.findUnique.mockResolvedValue({
      accessApprovalRequired: false,
      accessApprovalRenewalMode: ACCESS_APPROVAL_RENEWAL_MODE.ACADEMIC_YEAR,
      accessApprovalRenewalMonth: 9,
      accessApprovalCustomMonths: null,
      accessApprovalStudentMessage: null,
    });

    await expect(
      assertAnnualAccessApproved({
        organizationId: "org-1",
        userId: "student-1",
        role: "SELF_SERVICE",
      })
    ).resolves.toBeUndefined();
    expect(dbMock.annualAccessApproval.findMany).not.toHaveBeenCalled();
  });

  it("rejects new Student borrowing when required approval has expired", async () => {
    dbMock.ioioLabTA.findFirst.mockResolvedValue(null);
    dbMock.organization.findUnique.mockResolvedValue({
      accessApprovalRequired: true,
      accessApprovalRenewalMode: ACCESS_APPROVAL_RENEWAL_MODE.ACADEMIC_YEAR,
      accessApprovalRenewalMonth: 9,
      accessApprovalCustomMonths: null,
      accessApprovalStudentMessage: null,
    });
    dbMock.annualAccessApproval.findMany.mockResolvedValue([]);

    await expect(
      assertAnnualAccessApproved({
        organizationId: "org-1",
        userId: "student-1",
        role: "SELF_SERVICE",
        now: new Date("2026-09-22T12:00:00.000Z"),
      })
    ).rejects.toMatchObject({ status: 403 });
  });

  it("treats a revoked approval as inactive for Student borrowing", async () => {
    dbMock.ioioLabTA.findFirst.mockResolvedValue(null);
    dbMock.organization.findUnique.mockResolvedValue({
      accessApprovalRequired: true,
      accessApprovalRenewalMode: ACCESS_APPROVAL_RENEWAL_MODE.ACADEMIC_YEAR,
      accessApprovalRenewalMonth: 9,
      accessApprovalCustomMonths: null,
      accessApprovalStudentMessage: null,
    });
    dbMock.annualAccessApproval.findMany.mockResolvedValue([
      {
        id: "approval-1",
        status: "REVOKED",
        approvalYear: 2026,
        requestedAt: new Date("2026-09-01T00:00:00Z"),
        approvedAt: new Date("2026-09-02T00:00:00Z"),
        validUntil: new Date("2027-08-31T23:59:59.999Z"),
        reviewedAt: new Date("2026-09-20T00:00:00Z"),
        staffComment: null,
      },
    ]);

    await expect(
      getStudentAnnualAccessApproval({
        organizationId: "org-1",
        userId: "student-1",
        now: new Date("2026-09-22T12:00:00.000Z"),
      })
    ).resolves.toMatchObject({ status: "REVOKED" });
    await expect(
      assertAnnualAccessApproved({
        organizationId: "org-1",
        userId: "student-1",
        role: "SELF_SERVICE",
        now: new Date("2026-09-22T12:00:00.000Z"),
      })
    ).rejects.toMatchObject({ status: 403 });
  });

  it("lets a later revocation override an older still-valid approval", async () => {
    dbMock.ioioLabTA.findFirst.mockResolvedValue(null);
    dbMock.organization.findUnique.mockResolvedValue({
      accessApprovalRequired: true,
      accessApprovalRenewalMode: ACCESS_APPROVAL_RENEWAL_MODE.ACADEMIC_YEAR,
      accessApprovalRenewalMonth: 9,
      accessApprovalCustomMonths: null,
      accessApprovalStudentMessage: null,
    });
    dbMock.annualAccessApproval.findMany.mockResolvedValue([
      {
        id: "approval-old",
        status: "APPROVED",
        approvalYear: 2026,
        requestedAt: new Date("2026-09-01T00:00:00Z"),
        approvedAt: new Date("2026-09-02T00:00:00Z"),
        validUntil: new Date("2027-08-31T23:59:59.999Z"),
        reviewedAt: new Date("2026-09-02T00:00:00Z"),
        staffComment: null,
      },
      {
        id: "approval-revoked",
        status: "REVOKED",
        approvalYear: 2026,
        requestedAt: new Date("2026-09-01T00:00:00Z"),
        approvedAt: new Date("2026-09-02T00:00:00Z"),
        validUntil: new Date("2027-08-31T23:59:59.999Z"),
        reviewedAt: new Date("2026-09-20T00:00:00Z"),
        staffComment: null,
      },
    ]);

    await expect(
      getStudentAnnualAccessApproval({
        organizationId: "org-1",
        userId: "student-1",
        now: new Date("2026-09-22T12:00:00Z"),
      })
    ).resolves.toMatchObject({ status: "REVOKED" });
    await expect(
      assertAnnualAccessApproved({
        organizationId: "org-1",
        userId: "student-1",
        role: "SELF_SERVICE",
        now: new Date("2026-09-22T12:00:00Z"),
      })
    ).rejects.toMatchObject({ status: 403 });
  });

  it("lets a later grant restore access after revocation", async () => {
    dbMock.organization.findUnique.mockResolvedValue({
      accessApprovalRequired: true,
      accessApprovalRenewalMode: ACCESS_APPROVAL_RENEWAL_MODE.ACADEMIC_YEAR,
      accessApprovalRenewalMonth: 9,
      accessApprovalCustomMonths: null,
      accessApprovalStudentMessage: null,
    });
    dbMock.annualAccessApproval.findMany.mockResolvedValue([
      {
        id: "approval-revoked",
        status: "REVOKED",
        approvalYear: 2026,
        requestedAt: new Date("2026-09-01T00:00:00Z"),
        approvedAt: new Date("2026-09-02T00:00:00Z"),
        validUntil: new Date("2027-08-31T23:59:59.999Z"),
        reviewedAt: new Date("2026-09-20T00:00:00Z"),
        staffComment: null,
      },
      {
        id: "approval-granted-later",
        status: "APPROVED",
        approvalYear: 2026,
        requestedAt: new Date("2026-09-01T00:00:00Z"),
        approvedAt: new Date("2026-09-21T00:00:00Z"),
        validUntil: new Date("2027-08-31T23:59:59.999Z"),
        reviewedAt: new Date("2026-09-21T00:00:00Z"),
        staffComment: null,
      },
    ]);

    await expect(
      getStudentAnnualAccessApproval({
        organizationId: "org-1",
        userId: "student-1",
        now: new Date("2026-09-22T12:00:00Z"),
      })
    ).resolves.toMatchObject({
      status: "APPROVED",
      approvalId: "approval-granted-later",
    });
  });

  it("revokes every approved record for the Student, not just the selected row", async () => {
    dbMock.annualAccessApproval.findFirst.mockResolvedValue({
      id: "approval-1",
      userId: "student-1",
      approvalYear: 2026,
      validUntil: new Date("2027-08-31T23:59:59.999Z"),
    });
    dbMock.annualAccessApproval.updateMany.mockResolvedValue({ count: 2 });

    await expect(
      revokeAnnualAccessApproval({
        organizationId: "org-1",
        staffUserId: "staff-1",
        requestId: "approval-1",
      })
    ).resolves.toEqual({ revoked: true });
    expect(dbMock.annualAccessApproval.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: "org-1",
          userId: "student-1",
          status: "APPROVED",
        },
        data: expect.objectContaining({
          status: "REVOKED",
          reviewedByUserId: "staff-1",
        }),
      })
    );
    expect(dbMock.userOrganization.findFirst).not.toHaveBeenCalled();
    expect(dbMock.userOrganization.upsert).not.toHaveBeenCalled();
    expect(dbMock.user.updateMany).not.toHaveBeenCalled();
    expect(dbMock.teamMember.create).not.toHaveBeenCalled();
    expect(
      dbMock.annualAccessApprovalNotification.upsert
    ).not.toHaveBeenCalled();
  });

  it("re-approves the existing revoked record instead of creating a duplicate", async () => {
    dbMock.organization.findUnique.mockResolvedValue({
      accessApprovalRequired: true,
      accessApprovalRenewalMode: ACCESS_APPROVAL_RENEWAL_MODE.ACADEMIC_YEAR,
      accessApprovalRenewalMonth: 9,
      accessApprovalCustomMonths: null,
      accessApprovalStudentMessage: null,
    });
    dbMock.annualAccessApproval.findMany.mockResolvedValue([
      {
        id: "approval-1",
        status: "REVOKED",
        approvalYear: 2026,
        requestedAt: new Date("2026-09-01T10:00:00.000Z"),
        approvedAt: null,
        validUntil: new Date("2027-08-31T23:59:59.999Z"),
        reviewedAt: new Date("2026-09-22T10:00:00.000Z"),
        staffComment: null,
      },
    ]);
    dbMock.annualAccessApproval.findFirst.mockResolvedValue({
      id: "approval-1",
      status: "REVOKED",
      approvalYear: 2026,
      validUntil: new Date("2027-08-31T23:59:59.999Z"),
      student: {
        id: "student-1",
        email: "student@example.test",
        firstName: "IOIO",
        lastName: "Student",
        displayName: null,
      },
    });
    dbMock.annualAccessApproval.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      reapproveAnnualAccessApproval({
        organizationId: "org-1",
        staffUserId: "staff-1",
        requestId: "approval-1",
      })
    ).resolves.toEqual({ reapproved: true });
    expect(dbMock.annualAccessApproval.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: "org-1",
          id: "approval-1",
          status: "REVOKED",
        },
        data: expect.objectContaining({
          status: "APPROVED",
          reviewedByUserId: "staff-1",
        }),
      })
    );
    expect(
      dbMock.annualAccessApprovalNotification.upsert
    ).toHaveBeenCalledWith({
      where: {
        approvalId_eventAt: {
          approvalId: "approval-1",
          eventAt: expect.any(Date),
        },
      },
      create: {
        organizationId: "org-1",
        userId: "student-1",
        approvalId: "approval-1",
        eventAt: expect.any(Date),
      },
      update: {},
    });
    expect(dbMock.annualAccessApproval.create).not.toHaveBeenCalled();
  });

  it("creates an approval notification only for a pending request actually transitioned by Staff", async () => {
    dbMock.organization.findUnique.mockResolvedValue({
      accessApprovalRequired: true,
      accessApprovalRenewalMode: ACCESS_APPROVAL_RENEWAL_MODE.ACADEMIC_YEAR,
      accessApprovalRenewalMonth: 9,
      accessApprovalCustomMonths: null,
      accessApprovalStudentMessage: null,
    });
    dbMock.annualAccessApproval.findMany.mockResolvedValue([
      {
        id: "approval-pending",
        status: "PENDING",
        student: {
          id: "student-1",
          email: "student@example.test",
          firstName: "IOIO",
          lastName: "Student",
          displayName: null,
        },
      },
    ]);
    dbMock.annualAccessApproval.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      reviewAnnualAccessApprovals({
        organizationId: "org-1",
        staffUserId: "staff-1",
        requestIds: ["approval-pending"],
      })
    ).resolves.toMatchObject({ approvedCount: 1, failedCount: 0 });

    expect(
      dbMock.annualAccessApprovalNotification.upsert
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          organizationId: "org-1",
          userId: "student-1",
          approvalId: "approval-pending",
          eventAt: expect.any(Date),
        }),
      })
    );
  });

  it("keeps revoked Students visible in Staff access management", async () => {
    dbMock.organization.findUnique.mockResolvedValue({
      accessApprovalRequired: true,
      accessApprovalRenewalMode: ACCESS_APPROVAL_RENEWAL_MODE.ACADEMIC_YEAR,
      accessApprovalRenewalMonth: 9,
      accessApprovalCustomMonths: null,
      accessApprovalStudentMessage: null,
    });
    dbMock.annualAccessApproval.findMany.mockResolvedValue([
      {
        id: "approval-old",
        status: "APPROVED",
        approvalYear: 2026,
        requestedAt: new Date("2026-09-01T00:00:00Z"),
        approvedAt: new Date("2026-09-02T00:00:00Z"),
        validUntil: new Date("2027-08-31T23:59:59.999Z"),
        reviewedAt: new Date("2026-09-02T00:00:00Z"),
        staffComment: null,
        student: {
          id: "student-1",
          email: "student@example.test",
          firstName: "IOIO",
          lastName: "Student",
          displayName: null,
        },
        reviewedBy: null,
      },
      {
        id: "approval-1",
        status: "REVOKED",
        approvalYear: 2026,
        requestedAt: new Date("2026-09-01T00:00:00Z"),
        approvedAt: new Date("2026-09-02T00:00:00Z"),
        validUntil: new Date("2027-08-31T23:59:59.999Z"),
        reviewedAt: new Date("2026-09-20T00:00:00Z"),
        staffComment: null,
        student: {
          id: "student-1",
          email: "student@example.test",
          firstName: "IOIO",
          lastName: "Student",
          displayName: null,
        },
        reviewedBy: null,
      },
    ]);

    const result = await getStaffAnnualAccessApprovals({
      organizationId: "org-1",
      now: new Date("2026-09-22T12:00:00.000Z"),
    });

    expect(result.access).toHaveLength(1);
    expect(result.access[0]).toMatchObject({
      id: "approval-1",
      accessState: "REVOKED",
    });
  });

  it("grants a Student access from IOIO Users without changing organization membership", async () => {
    dbMock.userOrganization.findFirst.mockResolvedValue({
      user: {
        id: "student-1",
        email: "student@example.test",
        firstName: "IOIO",
        lastName: "Student",
        displayName: null,
      },
    });
    dbMock.ioioLabTA.findFirst.mockResolvedValue(null);
    dbMock.organization.findUnique.mockResolvedValue({
      accessApprovalRequired: true,
      accessApprovalRenewalMode: ACCESS_APPROVAL_RENEWAL_MODE.ACADEMIC_YEAR,
      accessApprovalRenewalMonth: 9,
      accessApprovalCustomMonths: null,
      accessApprovalStudentMessage: null,
    });
    dbMock.annualAccessApproval.findMany.mockResolvedValue([]);
    dbMock.annualAccessApproval.findFirst.mockResolvedValue(null);
    dbMock.annualAccessApproval.create.mockResolvedValue({
      id: "approval-new",
    });

    await expect(
      grantAnnualAccessToStudent({
        organizationId: "org-1",
        staffUserId: "staff-1",
        studentUserId: "student-1",
      })
    ).resolves.toEqual({ granted: true });

    expect(dbMock.userOrganization.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: "org-1",
          userId: "student-1",
          roles: { has: "SELF_SERVICE" },
        },
      })
    );
    expect(dbMock.annualAccessApproval.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: "org-1",
          userId: "student-1",
          status: "APPROVED",
          reviewedByUserId: "staff-1",
        }),
      })
    );
    expect(
      dbMock.annualAccessApprovalNotification.upsert
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          organizationId: "org-1",
          userId: "student-1",
          approvalId: "approval-new",
          eventAt: expect.any(Date),
        }),
      })
    );
  });

  it("creates one notice per grant event and none for login reads or revocation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T10:00:00.000Z"));
    try {
      dbMock.userOrganization.findFirst.mockResolvedValue({
        user: {
          id: "student-1",
          email: "student@example.test",
          firstName: "IOIO",
          lastName: "Student",
          displayName: null,
        },
      });
      dbMock.ioioLabTA.findFirst.mockResolvedValue(null);
      dbMock.organization.findUnique.mockResolvedValue({
        accessApprovalRequired: true,
        accessApprovalRenewalMode: ACCESS_APPROVAL_RENEWAL_MODE.ACADEMIC_YEAR,
        accessApprovalRenewalMonth: 9,
        accessApprovalCustomMonths: null,
        accessApprovalStudentMessage: null,
      });
      dbMock.annualAccessApproval.findMany.mockResolvedValue([]);
      dbMock.annualAccessApproval.findFirst.mockResolvedValue(null);
      dbMock.annualAccessApproval.create.mockResolvedValue({
        id: "approval-1",
      });

      await grantAnnualAccessToStudent({
        organizationId: "org-1",
        staffUserId: "staff-1",
        studentUserId: "student-1",
      });
      expect(
        dbMock.annualAccessApprovalNotification.upsert
      ).toHaveBeenCalledTimes(1);
      const firstEventAt =
        dbMock.annualAccessApprovalNotification.upsert.mock.calls[0][0].create
          .eventAt;

      // Repeated layout loads only read approval state; they do not create events.
      dbMock.annualAccessApproval.findMany.mockResolvedValue([
        {
          id: "approval-1",
          status: "APPROVED",
          approvalYear: 2026,
          requestedAt: new Date("2026-09-01T00:00:00.000Z"),
          approvedAt: firstEventAt,
          validUntil: new Date("2027-08-31T23:59:59.999Z"),
          reviewedAt: firstEventAt,
          staffComment: null,
        },
      ]);
      await getStudentAnnualAccessApproval({
        organizationId: "org-1",
        userId: "student-1",
        now: firstEventAt,
      });
      await getStudentAnnualAccessApproval({
        organizationId: "org-1",
        userId: "student-1",
        now: firstEventAt,
      });
      expect(
        dbMock.annualAccessApprovalNotification.upsert
      ).toHaveBeenCalledTimes(1);

      dbMock.annualAccessApproval.findFirst.mockResolvedValue({
        id: "approval-1",
        userId: "student-1",
        approvalYear: 2026,
        validUntil: new Date("2027-08-31T23:59:59.999Z"),
      });
      dbMock.annualAccessApproval.updateMany.mockResolvedValue({ count: 1 });
      await revokeAnnualAccessApproval({
        organizationId: "org-1",
        staffUserId: "staff-1",
        requestId: "approval-1",
      });
      expect(
        dbMock.annualAccessApprovalNotification.upsert
      ).toHaveBeenCalledTimes(1);

      vi.setSystemTime(new Date("2026-09-30T10:05:00.000Z"));
      dbMock.userOrganization.findFirst.mockResolvedValue({
        user: {
          id: "student-1",
          email: "student@example.test",
          firstName: "IOIO",
          lastName: "Student",
          displayName: null,
        },
      });
      dbMock.ioioLabTA.findFirst.mockResolvedValue(null);
      dbMock.annualAccessApproval.findMany.mockResolvedValue([
        {
          id: "approval-1",
          status: "REVOKED",
          approvalYear: 2026,
          requestedAt: new Date("2026-09-01T00:00:00.000Z"),
          approvedAt: firstEventAt,
          validUntil: new Date("2027-08-31T23:59:59.999Z"),
          reviewedAt: new Date("2026-09-30T10:02:00.000Z"),
          staffComment: null,
        },
      ]);
      dbMock.annualAccessApproval.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: "approval-1",
          status: "REVOKED",
        });
      await grantAnnualAccessToStudent({
        organizationId: "org-1",
        staffUserId: "staff-1",
        studentUserId: "student-1",
      });

      expect(
        dbMock.annualAccessApprovalNotification.upsert
      ).toHaveBeenCalledTimes(2);
      const secondEventAt =
        dbMock.annualAccessApprovalNotification.upsert.mock.calls[1][0].create
          .eventAt;
      expect(secondEventAt).not.toEqual(firstEventAt);
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks an approval notice read only for its authenticated Student and organization", async () => {
    await markAnnualAccessApprovalNotificationRead({
      organizationId: "org-1",
      userId: "student-1",
      notificationId: "notice-1",
    });

    expect(
      dbMock.annualAccessApprovalNotification.updateMany
    ).toHaveBeenCalledWith({
      where: {
        id: "notice-1",
        organizationId: "org-1",
        userId: "student-1",
        readAt: null,
      },
      data: { readAt: expect.any(Date) },
    });
  });
});
