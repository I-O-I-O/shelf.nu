import type {
  AnnualAccessApprovalRenewalMode,
  AnnualAccessApprovalStatus,
} from "@prisma/client";
import { db } from "~/database/db.server";
import { triggerEmail } from "~/emails/email.worker.server";
import { shouldSendOptionalEmail } from "~/modules/email-preferences/service.server";
import { ShelfError } from "~/utils/error";
import { Logger } from "~/utils/logger";
import { resolveUserDisplayName } from "~/utils/user";
import { withIoioStudentLoadStage } from "./load-diagnostics.server";
import {
  ACCESS_APPROVAL_RENEWAL_MODE,
  formatApprovalDate,
} from "./annual-access";

export {
  ACCESS_APPROVAL_RENEWAL_MODE,
  formatApprovalDate,
} from "./annual-access";

export const ANNUAL_ACCESS_APPROVAL_STATUS = {
  PENDING: "PENDING",
  APPROVED: "APPROVED",
  DECLINED: "DECLINED",
  REVOKED: "REVOKED",
} as const satisfies Record<string, AnnualAccessApprovalStatus>;

export const DEFAULT_ACCESS_APPROVAL_STUDENT_MESSAGE =
  "Annual IOIO access approval required\n\nYou can browse IOIO Lab equipment, but borrowing requires current approval.\n\nApproval may take a few days.";
export const DEFAULT_ACCESS_APPROVAL_RENEWAL_MONTH = 9;

export const DEFAULT_ACCESS_APPROVAL_PENDING_MESSAGE =
  "Your request has been sent to IOIO Lab Staff. Approval may take a few days.";

export type AnnualAccessState =
  | "NOT_REQUESTED"
  | "PENDING"
  | "APPROVED"
  | "EXPIRED"
  | "DECLINED"
  | "REVOKED";

export type AccessApprovalSettings = {
  required: boolean;
  renewalMode: AnnualAccessApprovalRenewalMode;
  renewalMonth: number;
  customMonths: number | null;
  studentMessage: string;
};

export async function getAccessApprovalSettings(
  organizationId: string,
  diagnostics = false
): Promise<AccessApprovalSettings> {
  const organization = await withIoioStudentLoadStage(
    "2 annual access settings query (organization.findUnique)",
    diagnostics,
    () =>
      db.organization.findUnique({
        where: { id: organizationId },
        select: {
          accessApprovalRequired: true,
          accessApprovalRenewalMode: true,
          accessApprovalRenewalMonth: true,
          accessApprovalCustomMonths: true,
          accessApprovalStudentMessage: true,
        },
      })
  );

  return {
    required: organization?.accessApprovalRequired ?? true,
    renewalMode:
      organization?.accessApprovalRenewalMode ??
      ACCESS_APPROVAL_RENEWAL_MODE.ACADEMIC_YEAR,
    renewalMonth:
      organization?.accessApprovalRenewalMonth ??
      DEFAULT_ACCESS_APPROVAL_RENEWAL_MONTH,
    customMonths: organization?.accessApprovalCustomMonths ?? null,
    studentMessage:
      organization?.accessApprovalStudentMessage?.trim() ||
      DEFAULT_ACCESS_APPROVAL_STUDENT_MESSAGE,
  };
}

export async function updateAccessApprovalSettings({
  organizationId,
  updatedByUserId,
  required,
  renewalMode,
  renewalMonth,
  customMonths,
  studentMessage,
}: AccessApprovalSettings & {
  organizationId: string;
  updatedByUserId: string;
}) {
  return db.organization.update({
    where: { id: organizationId },
    data: {
      accessApprovalRequired: required,
      accessApprovalRenewalMode: renewalMode,
      accessApprovalRenewalMonth: renewalMonth,
      accessApprovalCustomMonths:
        renewalMode === ACCESS_APPROVAL_RENEWAL_MODE.CUSTOM
          ? customMonths
          : null,
      accessApprovalStudentMessage: studentMessage.trim() || null,
      accessApprovalUpdatedByUserId: updatedByUserId,
      accessApprovalUpdatedAt: new Date(),
    },
  });
}

function getIntervalMonths(settings: AccessApprovalSettings) {
  switch (settings.renewalMode) {
    case ACCESS_APPROVAL_RENEWAL_MODE.TWELVE_MONTHS:
      return 12;
    case ACCESS_APPROVAL_RENEWAL_MODE.SIX_MONTHS:
      return 6;
    case ACCESS_APPROVAL_RENEWAL_MODE.CUSTOM:
      return settings.customMonths ?? 9;
    case ACCESS_APPROVAL_RENEWAL_MODE.ACADEMIC_YEAR:
      return null;
  }
}

function getAcademicCycleStartYear(now: Date, renewalMonth: number) {
  const monthIndex = renewalMonth - 1;
  return now.getUTCMonth() >= monthIndex
    ? now.getUTCFullYear()
    : now.getUTCFullYear() - 1;
}

export function getCurrentApprovalCycle(
  now = new Date(),
  settings: Pick<
    AccessApprovalSettings,
    "renewalMode" | "renewalMonth" | "customMonths"
  >
) {
  if (settings.renewalMode !== ACCESS_APPROVAL_RENEWAL_MODE.ACADEMIC_YEAR) {
    const intervalMonths = getIntervalMonths({
      required: true,
      studentMessage: DEFAULT_ACCESS_APPROVAL_STUDENT_MESSAGE,
      ...settings,
    });
    return {
      approvalYear: now.getUTCFullYear(),
      start: new Date(Date.UTC(now.getUTCFullYear(), 0, 1)),
      end: new Date(Date.UTC(now.getUTCFullYear() + 1, 0, 1)),
      label: intervalMonths
        ? `rolling ${intervalMonths}-month approval`
        : "configured approval period",
    };
  }

  const approvalYear = getAcademicCycleStartYear(now, settings.renewalMonth);
  const start = new Date(Date.UTC(approvalYear, settings.renewalMonth - 1, 1));
  const end = new Date(
    Date.UTC(approvalYear + 1, settings.renewalMonth - 1, 1)
  );
  return {
    approvalYear,
    start,
    end,
    label: `${approvalYear}-${approvalYear + 1}`,
  };
}

function getEndOfUtcDay(date: Date) {
  const result = new Date(date);
  result.setUTCHours(23, 59, 59, 999);
  return result;
}

function addUtcCalendarMonths(date: Date, months: number) {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + months;
  const day = date.getUTCDate();
  const targetMonthEnd = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const result = new Date(
    Date.UTC(
      year,
      month,
      Math.min(day, targetMonthEnd),
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds()
    )
  );
  return getEndOfUtcDay(result);
}

export function getApprovalValidUntil(
  approvedAt: Date,
  settings: AccessApprovalSettings
) {
  if (settings.renewalMode === ACCESS_APPROVAL_RENEWAL_MODE.ACADEMIC_YEAR) {
    const cycleStartYear = getAcademicCycleStartYear(
      approvedAt,
      settings.renewalMonth
    );
    const nextCycleStart = new Date(
      Date.UTC(cycleStartYear + 1, settings.renewalMonth - 1, 1)
    );
    return getEndOfUtcDay(new Date(nextCycleStart.getTime() - 1));
  }

  return addUtcCalendarMonths(approvedAt, getIntervalMonths(settings) ?? 12);
}

function getLegacyApprovalValidUntil(approvalYear: number) {
  // Before validUntil was stored, approved records followed the September
  // academic cycle. This fallback preserves those grants independently of
  // whatever renewal policy Staff configures now.
  const nextCycleStart = new Date(Date.UTC(approvalYear + 1, 8, 1));
  return new Date(nextCycleStart.getTime() - 1);
}

function approvalIsCurrent(
  approval: { validUntil: Date | null; approvalYear: number },
  now: Date
) {
  return (
    (approval.validUntil ??
      getLegacyApprovalValidUntil(approval.approvalYear)) >= now
  );
}

type AnnualAccessDecision = {
  id: string;
  status: AnnualAccessApprovalStatus;
  requestedAt: Date;
  approvedAt: Date | null;
  reviewedAt: Date | null;
  validUntil: Date | null;
  approvalYear: number;
};

function accessDecisionTime(record: AnnualAccessDecision) {
  return record.reviewedAt ?? record.approvedAt ?? record.requestedAt;
}

function compareAccessDecisions(
  left: AnnualAccessDecision,
  right: AnnualAccessDecision
) {
  return (
    accessDecisionTime(left).getTime() - accessDecisionTime(right).getTime() ||
    left.id.localeCompare(right.id)
  );
}

/**
 * Revoke is an event that invalidates every earlier grant. A still-current
 * approval only counts when it was granted after the latest revocation. This
 * keeps old/duplicate approval rows from restoring access after a later
 * revoke, while allowing a subsequent re-approval to restore it.
 */
function resolveAnnualAccessDecision<T extends AnnualAccessDecision>(
  records: T[],
  now: Date
) {
  const latestRevocation = records
    .filter((record) => record.status === ANNUAL_ACCESS_APPROVAL_STATUS.REVOKED)
    .sort(compareAccessDecisions)
    .at(-1);
  const activeApproval = records
    .filter(
      (record) =>
        record.status === ANNUAL_ACCESS_APPROVAL_STATUS.APPROVED &&
        approvalIsCurrent(record, now) &&
        (!latestRevocation ||
          compareAccessDecisions(record, latestRevocation) > 0)
    )
    .sort(compareAccessDecisions)
    .at(-1);
  const latestResolved = records
    .filter((record) => record.status !== ANNUAL_ACCESS_APPROVAL_STATUS.PENDING)
    .sort(compareAccessDecisions)
    .at(-1);

  return { activeApproval, latestRevocation, latestResolved };
}

const studentSelect = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  displayName: true,
  profilePicture: true,
  sso: true,
} as const;

export async function getStudentAnnualAccessApproval({
  organizationId,
  userId,
  now = new Date(),
  diagnostics = false,
}: {
  organizationId: string;
  userId: string;
  now?: Date;
  diagnostics?: boolean;
}) {
  const settings = await getAccessApprovalSettings(organizationId, diagnostics);
  const cycle = getCurrentApprovalCycle(now, settings);
  const records = settings.required
    ? await withIoioStudentLoadStage(
        "2 annual access approval query (annualAccessApproval.findMany)",
        diagnostics,
        () =>
          db.annualAccessApproval.findMany({
            where: { organizationId, userId },
            orderBy: [
              { reviewedAt: { sort: "desc", nulls: "last" } },
              { requestedAt: "desc" },
              { id: "desc" },
            ],
            select: {
              id: true,
              status: true,
              approvalYear: true,
              requestedAt: true,
              approvedAt: true,
              validUntil: true,
              reviewedAt: true,
              staffComment: true,
            },
          })
      )
    : [];

  const { activeApproval: currentApproval, latestResolved } =
    resolveAnnualAccessDecision(records, now);
  const pending = records.find(
    (record) => record.status === ANNUAL_ACCESS_APPROVAL_STATUS.PENDING
  );

  const currentRequest = currentApproval ?? pending ?? latestResolved;
  const status: AnnualAccessState = currentApproval
    ? "APPROVED"
    : pending
    ? "PENDING"
    : latestResolved?.status === ANNUAL_ACCESS_APPROVAL_STATUS.REVOKED
    ? "REVOKED"
    : latestResolved?.status === ANNUAL_ACCESS_APPROVAL_STATUS.APPROVED
    ? "EXPIRED"
    : latestResolved?.status === ANNUAL_ACCESS_APPROVAL_STATUS.DECLINED
    ? "DECLINED"
    : "NOT_REQUESTED";

  return {
    status,
    required: settings.required,
    renewalMode: settings.renewalMode,
    renewalMonth: settings.renewalMonth,
    cycleLabel: cycle.label,
    approvalYear: currentRequest?.approvalYear ?? cycle.approvalYear,
    approvalId: currentRequest?.id ?? null,
    requestedAt: currentRequest?.requestedAt ?? null,
    approvedAt: currentApproval?.approvedAt ?? null,
    reviewedAt: currentRequest?.reviewedAt ?? null,
    validUntil: currentApproval
      ? currentApproval.validUntil ??
        getLegacyApprovalValidUntil(currentApproval.approvalYear)
      : null,
    staffComment:
      latestResolved?.status === ANNUAL_ACCESS_APPROVAL_STATUS.DECLINED
        ? latestResolved.staffComment
        : null,
    studentMessage: settings.studentMessage,
    pendingMessage: DEFAULT_ACCESS_APPROVAL_PENDING_MESSAGE,
  };
}

export async function assertAnnualAccessApproved({
  organizationId,
  userId,
  role,
  now = new Date(),
}: {
  organizationId: string;
  userId: string;
  role: string;
  now?: Date;
}) {
  if (role === "ADMIN" || role === "OWNER") return;

  // TAs are Staff delegates in IOIO, even where their underlying Shelf
  // membership remains SELF_SERVICE.
  const isIoioTA = await db.ioioLabTA.findFirst({
    where: { organizationId, userId },
    select: { id: true },
  });
  if (isIoioTA) return;

  const state = await getStudentAnnualAccessApproval({
    organizationId,
    userId,
    now,
  });
  if (!state.required || state.status === "APPROVED") return;

  throw new ShelfError({
    cause: null,
    message: "Current IOIO access approval is required before borrowing.",
    label: "Booking",
    status: 403,
    shouldBeCaptured: false,
    additionalData: {
      approvalStatus: state.status,
      approvalYear: state.approvalYear,
    },
  });
}

async function sendApprovalEmail({
  to,
  userId,
  name,
  outcome,
  cycleLabel,
  validUntil,
  staffComment,
}: {
  to: string;
  userId: string;
  name: string;
  outcome: "requested" | "approved" | "declined";
  cycleLabel: string;
  validUntil?: Date;
  staffComment?: string | null;
}) {
  try {
    if (!(await shouldSendOptionalEmail(userId, "ANNUAL_ACCESS_UPDATE"))) {
      return;
    }
    await triggerEmail({
      to,
      subject:
        outcome === "approved"
          ? "IOIO Lab borrowing access approved"
          : outcome === "requested"
          ? "IOIO access approval requested"
          : "IOIO Lab borrowing access request update",
      text:
        outcome === "approved"
          ? `Hi ${name},\n\nYour IOIO Lab borrowing access is approved. It is valid until ${
              validUntil ? formatApprovalDate(validUntil) : cycleLabel
            }. You can now borrow equipment.\n\nIOIO Lab`
          : outcome === "requested"
          ? `Hi ${name},\n\nYour IOIO access approval request has been submitted. You'll be notified when it has been reviewed.\n\nIOIO Lab`
          : `Hi ${name},\n\nYour IOIO access request was not approved.${
              staffComment?.trim()
                ? `\n\nStaff comment: ${staffComment.trim()}`
                : ""
            }\n\nContact IOIO Lab Staff if you have questions.\n\nIOIO Lab`,
    });
  } catch (cause) {
    Logger.warn({
      event: "ioio_annual_access_email_failed",
      recipient: to,
      outcome,
      cause,
    });
  }
}

export async function requestStudentAnnualAccessApproval({
  organizationId,
  userId,
}: {
  organizationId: string;
  userId: string;
}) {
  const settings = await getAccessApprovalSettings(organizationId);
  if (!settings.required) {
    throw new ShelfError({
      cause: null,
      message: "Student borrowing approval is not currently required.",
      label: "Settings",
      status: 409,
      shouldBeCaptured: false,
    });
  }

  const now = new Date();
  const cycle = getCurrentApprovalCycle(now, settings);
  const result = await db.$transaction(async (tx) => {
    // Serialize requests per canonical user so two parallel submits cannot
    // create duplicate pending approval records.
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
    const pending = await tx.annualAccessApproval.findFirst({
      where: {
        organizationId,
        userId,
        status: ANNUAL_ACCESS_APPROVAL_STATUS.PENDING,
      },
      orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
      select: { id: true },
    });
    if (pending) {
      throw new ShelfError({
        cause: null,
        message: "Your access approval request is already pending.",
        label: "Settings",
        status: 409,
        shouldBeCaptured: false,
      });
    }

    const approved = await tx.annualAccessApproval.findMany({
      where: {
        organizationId,
        userId,
        status: ANNUAL_ACCESS_APPROVAL_STATUS.APPROVED,
      },
      select: { approvalYear: true, validUntil: true },
    });
    if (approved.some((record) => approvalIsCurrent(record, now))) {
      return { alreadyApproved: true as const, id: null };
    }

    const approval = await tx.annualAccessApproval.create({
      data: {
        organizationId,
        userId,
        approvalYear: cycle.approvalYear,
        status: ANNUAL_ACCESS_APPROVAL_STATUS.PENDING,
      },
      select: { id: true },
    });
    return { alreadyApproved: false as const, id: approval.id };
  });

  if (result.alreadyApproved) {
    return { status: "APPROVED" as const, cycleLabel: cycle.label };
  }

  const user = await db.user.findUnique({
    where: { id: userId },
    select: studentSelect,
  });
  if (user) {
    await sendApprovalEmail({
      to: user.email,
      userId: user.id,
      name: resolveUserDisplayName(user) || user.email,
      outcome: "requested",
      cycleLabel: cycle.label,
    });
  }
  return {
    id: result.id,
    status: "PENDING" as const,
    cycleLabel: cycle.label,
  };
}

export async function getStaffAnnualAccessApprovals({
  organizationId,
  now = new Date(),
}: {
  organizationId: string;
  now?: Date;
}) {
  const settings = await getAccessApprovalSettings(organizationId);
  const cycle = getCurrentApprovalCycle(now, settings);
  const rows = await db.annualAccessApproval.findMany({
    // Filter in application code rather than comparing against every enum
    // value in SQL. This keeps the directory readable while a database is
    // rolling out the REVOKED enum migration; the migration is still required
    // before a revocation can be persisted.
    where: { organizationId },
    orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      status: true,
      approvalYear: true,
      requestedAt: true,
      approvedAt: true,
      validUntil: true,
      reviewedAt: true,
      staffComment: true,
      student: { select: studentSelect },
      reviewedBy: { select: studentSelect },
    },
  });
  const pending = rows
    .filter((row) => row.status === ANNUAL_ACCESS_APPROVAL_STATUS.PENDING)
    .sort(
      (a, b) =>
        a.requestedAt.getTime() - b.requestedAt.getTime() ||
        a.id.localeCompare(b.id)
    );
  const accessRecordsByStudent = new Map<string, (typeof rows)[number][]>();
  for (const row of rows) {
    if (row.status === ANNUAL_ACCESS_APPROVAL_STATUS.PENDING) continue;
    const studentRows = accessRecordsByStudent.get(row.student.id) ?? [];
    studentRows.push(row);
    accessRecordsByStudent.set(row.student.id, studentRows);
  }
  type StaffAccessRecord = (typeof rows)[number] & {
    accessState: "ACTIVE" | "REVOKED" | "EXPIRED";
  };
  const access: StaffAccessRecord[] = [];
  for (const studentRows of accessRecordsByStudent.values()) {
    const { activeApproval, latestResolved } = resolveAnnualAccessDecision(
      studentRows,
      now
    );
    if (activeApproval) {
      access.push({ ...activeApproval, accessState: "ACTIVE" });
      continue;
    }

    if (latestResolved) {
      access.push({
        ...latestResolved,
        accessState:
          latestResolved.status === ANNUAL_ACCESS_APPROVAL_STATUS.REVOKED
            ? "REVOKED"
            : "EXPIRED",
      });
    }
  }

  return {
    approvalYear: cycle.approvalYear,
    cycleLabel: cycle.label,
    required: settings.required,
    pending,
    access,
  };
}

export async function reviewAnnualAccessApprovals({
  organizationId,
  staffUserId,
  requestIds,
}: {
  organizationId: string;
  staffUserId: string;
  requestIds: string[];
}) {
  const now = new Date();
  const settings = await getAccessApprovalSettings(organizationId);
  const cycle = getCurrentApprovalCycle(now, settings);
  const validUntil = getApprovalValidUntil(now, settings);
  const ids = [...new Set(requestIds.filter(Boolean))];
  const requestedRows = await db.annualAccessApproval.findMany({
    where: {
      organizationId,
      id: { in: ids },
    },
    select: { id: true, status: true, student: { select: studentSelect } },
  });
  const pendingRows = requestedRows.filter(
    (row) => row.status === ANNUAL_ACCESS_APPROVAL_STATUS.PENDING
  );
  const approvedRows = await db.$transaction(async (tx) => {
    const transitioned: typeof pendingRows = [];
    for (const row of pendingRows) {
      const result = await tx.annualAccessApproval.updateMany({
        where: {
          organizationId,
          id: row.id,
          status: ANNUAL_ACCESS_APPROVAL_STATUS.PENDING,
        },
        data: {
          status: ANNUAL_ACCESS_APPROVAL_STATUS.APPROVED,
          approvedAt: now,
          validUntil,
          reviewedAt: now,
          reviewedByUserId: staffUserId,
        },
      });
      if (result.count !== 1) continue;

      await tx.annualAccessApprovalNotification.upsert({
        where: { approvalId_eventAt: { approvalId: row.id, eventAt: now } },
        create: {
          organizationId,
          userId: row.student.id,
          approvalId: row.id,
          eventAt: now,
        },
        update: {},
      });
      transitioned.push(row);
    }
    return transitioned;
  });
  await Promise.all(
    approvedRows.map((row) =>
      sendApprovalEmail({
        to: row.student.email,
        userId: row.student.id,
        name: resolveUserDisplayName(row.student) || row.student.email,
        outcome: "approved",
        cycleLabel: cycle.label,
        validUntil,
      })
    )
  );
  return {
    approvedCount: approvedRows.length,
    failedCount: ids.length - approvedRows.length,
    failed: ids
      .filter((id) => !approvedRows.some((row) => row.id === id))
      .map((id) => {
        const row = requestedRows.find((candidate) => candidate.id === id);
        return {
          id,
          name: row
            ? resolveUserDisplayName(row.student) || row.student.email
            : id,
          reason: row
            ? "This request is no longer pending."
            : "Request was not found in this organization.",
        };
      }),
  };
}

export async function declineAnnualAccessApproval({
  organizationId,
  staffUserId,
  requestId,
  staffComment,
}: {
  organizationId: string;
  staffUserId: string;
  requestId: string;
  staffComment?: string;
}) {
  const row = await db.annualAccessApproval.findFirst({
    where: {
      organizationId,
      id: requestId,
      status: ANNUAL_ACCESS_APPROVAL_STATUS.PENDING,
    },
    select: { id: true, student: { select: studentSelect } },
  });
  if (!row) {
    throw new ShelfError({
      cause: null,
      message: "This access approval request is no longer pending.",
      label: "Settings",
      status: 409,
      shouldBeCaptured: false,
    });
  }
  await db.annualAccessApproval.updateMany({
    where: { organizationId, id: row.id, status: "PENDING" },
    data: {
      status: ANNUAL_ACCESS_APPROVAL_STATUS.DECLINED,
      reviewedAt: new Date(),
      reviewedByUserId: staffUserId,
      staffComment: staffComment?.trim() || null,
    },
  });
  const cycle = getCurrentApprovalCycle(
    new Date(),
    await getAccessApprovalSettings(organizationId)
  );
  await sendApprovalEmail({
    to: row.student.email,
    userId: row.student.id,
    name: resolveUserDisplayName(row.student) || row.student.email,
    outcome: "declined",
    staffComment,
    cycleLabel: cycle.label,
  });
  return { declined: true as const };
}

export async function revokeAnnualAccessApproval({
  organizationId,
  staffUserId,
  requestId,
}: {
  organizationId: string;
  staffUserId: string;
  requestId: string;
}) {
  const now = new Date();
  const row = await db.annualAccessApproval.findFirst({
    where: {
      organizationId,
      id: requestId,
      status: ANNUAL_ACCESS_APPROVAL_STATUS.APPROVED,
    },
    select: { id: true, userId: true, approvalYear: true, validUntil: true },
  });
  if (!row || !approvalIsCurrent(row, now)) {
    throw new ShelfError({
      cause: null,
      message: "This access approval is no longer active.",
      label: "Settings",
      status: 409,
      shouldBeCaptured: false,
    });
  }

  const result = await db.annualAccessApproval.updateMany({
    where: {
      organizationId,
      userId: row.userId,
      status: ANNUAL_ACCESS_APPROVAL_STATUS.APPROVED,
    },
    data: {
      status: ANNUAL_ACCESS_APPROVAL_STATUS.REVOKED,
      reviewedAt: now,
      reviewedByUserId: staffUserId,
    },
  });
  if (result.count < 1) {
    throw new ShelfError({
      cause: null,
      message: "This access approval is no longer active.",
      label: "Settings",
      status: 409,
      shouldBeCaptured: false,
    });
  }

  return { revoked: true as const };
}

export async function markAnnualAccessApprovalNotificationRead({
  organizationId,
  userId,
  notificationId,
}: {
  organizationId: string;
  userId: string;
  notificationId: string;
}) {
  await db.annualAccessApprovalNotification.updateMany({
    where: {
      id: notificationId,
      organizationId,
      userId,
      readAt: null,
    },
    data: { readAt: new Date() },
  });
}

export async function reapproveAnnualAccessApproval({
  organizationId,
  staffUserId,
  requestId,
}: {
  organizationId: string;
  staffUserId: string;
  requestId: string;
}) {
  const now = new Date();
  const settings = await getAccessApprovalSettings(organizationId);
  const cycle = getCurrentApprovalCycle(now, settings);
  const validUntil = getApprovalValidUntil(now, settings);
  const row = await db.annualAccessApproval.findFirst({
    where: {
      organizationId,
      id: requestId,
      status: {
        in: [
          ANNUAL_ACCESS_APPROVAL_STATUS.REVOKED,
          ANNUAL_ACCESS_APPROVAL_STATUS.APPROVED,
        ],
      },
    },
    select: {
      id: true,
      status: true,
      approvalYear: true,
      validUntil: true,
      student: { select: studentSelect },
    },
  });
  if (
    !row ||
    (row.status === ANNUAL_ACCESS_APPROVAL_STATUS.APPROVED &&
      approvalIsCurrent(row, now))
  ) {
    throw new ShelfError({
      cause: null,
      message: "This Student does not need a new access approval.",
      label: "Settings",
      status: 409,
      shouldBeCaptured: false,
    });
  }

  const currentStudentAccess = await getStudentAnnualAccessApproval({
    organizationId,
    userId: row.student.id,
    now,
  });
  if (currentStudentAccess.status === "APPROVED") {
    throw new ShelfError({
      cause: null,
      message: "This Student already has valid access approval.",
      label: "Settings",
      status: 409,
      shouldBeCaptured: false,
    });
  }

  await db.$transaction(async (tx) => {
    const result = await tx.annualAccessApproval.updateMany({
      where: {
        organizationId,
        id: row.id,
        status: row.status,
      },
      data: {
        status: ANNUAL_ACCESS_APPROVAL_STATUS.APPROVED,
        approvalYear: cycle.approvalYear,
        approvedAt: now,
        validUntil,
        reviewedAt: now,
        reviewedByUserId: staffUserId,
        staffComment: null,
      },
    });
    if (result.count !== 1) {
      throw new ShelfError({
        cause: null,
        message: "This access approval changed before it could be restored.",
        label: "Settings",
        status: 409,
        shouldBeCaptured: false,
      });
    }
    await tx.annualAccessApprovalNotification.upsert({
      where: { approvalId_eventAt: { approvalId: row.id, eventAt: now } },
      create: {
        organizationId,
        userId: row.student.id,
        approvalId: row.id,
        eventAt: now,
      },
      update: {},
    });
  });

  await sendApprovalEmail({
    to: row.student.email,
    userId: row.student.id,
    name: resolveUserDisplayName(row.student) || row.student.email,
    outcome: "approved",
    cycleLabel: cycle.label,
    validUntil,
  });
  return { reapproved: true as const };
}

/** Grants current borrowing approval directly from the Staff user directory.
 * It restores an existing request/revocation when one exists, and creates a
 * single approved record for Students who have never requested approval.
 */
export async function grantAnnualAccessToStudent({
  organizationId,
  staffUserId,
  studentUserId,
}: {
  organizationId: string;
  staffUserId: string;
  studentUserId: string;
}) {
  const membership = await db.userOrganization.findFirst({
    where: {
      organizationId,
      userId: studentUserId,
      roles: { has: "SELF_SERVICE" },
    },
    select: { user: { select: studentSelect } },
  });
  if (!membership) {
    throw new ShelfError({
      cause: null,
      message: "This Student is not a member of this organization.",
      label: "Settings",
      status: 404,
      shouldBeCaptured: false,
    });
  }

  const ta = await db.ioioLabTA.findFirst({
    where: { organizationId, userId: studentUserId },
    select: { id: true },
  });
  if (ta) {
    throw new ShelfError({
      cause: null,
      message: "TA accounts do not require Student borrowing approval.",
      label: "Settings",
      status: 409,
      shouldBeCaptured: false,
    });
  }

  const now = new Date();
  const settings = await getAccessApprovalSettings(organizationId);
  if (!settings.required) {
    throw new ShelfError({
      cause: null,
      message: "Student borrowing approval is not currently required.",
      label: "Settings",
      status: 409,
      shouldBeCaptured: false,
    });
  }

  const currentAccess = await getStudentAnnualAccessApproval({
    organizationId,
    userId: studentUserId,
    now,
  });
  if (currentAccess.status === "APPROVED") {
    throw new ShelfError({
      cause: null,
      message: "This Student already has valid borrowing approval.",
      label: "Settings",
      status: 409,
      shouldBeCaptured: false,
    });
  }

  const pendingRecord = await db.annualAccessApproval.findFirst({
    where: {
      organizationId,
      userId: studentUserId,
      status: ANNUAL_ACCESS_APPROVAL_STATUS.PENDING,
    },
    orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
    select: { id: true, status: true },
  });
  const previousRecord =
    pendingRecord ??
    (await db.annualAccessApproval.findFirst({
      where: {
        organizationId,
        userId: studentUserId,
        status: {
          in: [
            ANNUAL_ACCESS_APPROVAL_STATUS.APPROVED,
            ANNUAL_ACCESS_APPROVAL_STATUS.DECLINED,
            ANNUAL_ACCESS_APPROVAL_STATUS.REVOKED,
          ],
        },
      },
      orderBy: [
        { reviewedAt: { sort: "desc", nulls: "last" } },
        { requestedAt: "desc" },
        { id: "desc" },
      ],
      select: { id: true, status: true },
    }));
  const cycle = getCurrentApprovalCycle(now, settings);
  const validUntil = getApprovalValidUntil(now, settings);

  if (previousRecord) {
    await db.$transaction(async (tx) => {
      const updated = await tx.annualAccessApproval.updateMany({
        where: {
          organizationId,
          id: previousRecord.id,
          status: previousRecord.status,
        },
        data: {
          status: ANNUAL_ACCESS_APPROVAL_STATUS.APPROVED,
          approvalYear: cycle.approvalYear,
          approvedAt: now,
          validUntil,
          reviewedAt: now,
          reviewedByUserId: staffUserId,
          staffComment: null,
        },
      });
      if (updated.count !== 1) {
        throw new ShelfError({
          cause: null,
          message:
            "This Student's approval changed before it could be granted.",
          label: "Settings",
          status: 409,
          shouldBeCaptured: false,
        });
      }
      await tx.annualAccessApprovalNotification.upsert({
        where: {
          approvalId_eventAt: { approvalId: previousRecord.id, eventAt: now },
        },
        create: {
          organizationId,
          userId: studentUserId,
          approvalId: previousRecord.id,
          eventAt: now,
        },
        update: {},
      });
    });
  } else {
    await db.$transaction(async (tx) => {
      const approval = await tx.annualAccessApproval.create({
        data: {
          organizationId,
          userId: studentUserId,
          approvalYear: cycle.approvalYear,
          status: ANNUAL_ACCESS_APPROVAL_STATUS.APPROVED,
          approvedAt: now,
          validUntil,
          reviewedAt: now,
          reviewedByUserId: staffUserId,
        },
        select: { id: true },
      });
      await tx.annualAccessApprovalNotification.upsert({
        where: {
          approvalId_eventAt: { approvalId: approval.id, eventAt: now },
        },
        create: {
          organizationId,
          userId: studentUserId,
          approvalId: approval.id,
          eventAt: now,
        },
        update: {},
      });
    });
  }

  const student = membership.user;
  await sendApprovalEmail({
    to: student.email,
    userId: student.id,
    name: resolveUserDisplayName(student) || student.email,
    outcome: "approved",
    cycleLabel: cycle.label,
    validUntil,
  });
  return { granted: true as const };
}
