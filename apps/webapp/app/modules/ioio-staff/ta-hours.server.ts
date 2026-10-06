import { randomUUID } from "node:crypto";
import { Prisma, TAShiftStatus } from "@prisma/client";
import { db } from "~/database/db.server";
import { getAcademicYear } from "~/modules/ioio-lab-information/service.server";
import { getSelectedOrganization } from "~/modules/organization/context.server";
import { getWorkingHoursForOrganization } from "~/modules/working-hours/service.server";
import type { WeeklyScheduleJson } from "~/modules/working-hours/types";
import { ShelfError } from "~/utils/error";
import {
  calculateTAHoursBalance,
  calculateTAHoursSummary,
  deriveTAHoursStatus,
  getAvailableAcademicYears,
  getAcademicPeriodDateKeys,
  getNextAcademicYear,
  getScheduledHours,
  getTimeMinutes,
  isValidDateKey,
} from "./ta-hours";

const STAFF_ROLES = ["ADMIN", "OWNER"] as const;
const LAB_TIME_ZONE = "Europe/Stockholm";
const PERIOD_RELATIONS = {
  user: {
    select: {
      id: true,
      email: true,
      displayName: true,
      firstName: true,
      lastName: true,
      profilePicture: true,
    },
  },
} as const;

function taHoursError(message: string, status: 400 | 403 | 404 | 409 = 400) {
  return new ShelfError({
    cause: null,
    message,
    label: "TA Hours",
    status,
    shouldBeCaptured: false,
  });
}

function userName(
  user: {
    displayName: string | null;
    firstName: string | null;
    lastName: string | null;
    email: string;
  } | null
) {
  if (!user) return "Former user";
  return (
    user.displayName?.trim() ||
    [user.firstName, user.lastName].filter(Boolean).join(" ").trim() ||
    user.email
  );
}

export async function requireTAHoursAccess({
  userId,
  request,
}: {
  userId: string;
  request: Request;
}) {
  const selected = await getSelectedOrganization({ userId, request });
  const membership = selected.userOrganizations.find(
    (entry) => entry.organization.id === selected.organizationId
  );
  const isStaff = Boolean(
    membership?.roles.some((role) => role === "ADMIN" || role === "OWNER")
  );
  const isTA = Boolean(
    selected.organizationId &&
      (await db.ioioLabTA.findUnique({
        where: {
          organizationId_userId: {
            organizationId: selected.organizationId,
            userId,
          },
        },
        select: { id: true },
      }))
  );
  if (!selected.organizationId || (!isStaff && !isTA)) {
    throw taHoursError(
      "TA Hours is available to Staff and listed TAs only.",
      403
    );
  }
  return { organizationId: selected.organizationId, isStaff, isTA };
}

export function parseTAHoursAcademicYear(value: string | null) {
  const academicYear = value || getAcademicYear();
  if (!getAcademicPeriodDateKeys(academicYear)) {
    throw taHoursError("Choose a valid academic year.");
  }
  return academicYear;
}

function parseHours(value: unknown, label: string, allowZero = true) {
  const input = String(value ?? "").trim();
  if (!/^\d{1,6}(?:\.\d{1,2})?$/.test(input)) {
    throw taHoursError(`${label} must be a number with up to two decimals.`);
  }
  const hours = new Prisma.Decimal(input);
  if (
    !hours.isFinite() ||
    hours.greaterThan(100000) ||
    (!allowZero && hours.lessThanOrEqualTo(0))
  ) {
    throw taHoursError(
      allowZero
        ? `${label} must be between 0 and 100,000 hours.`
        : `${label} must be greater than zero.`
    );
  }
  return hours;
}

function parseSek(value: unknown, label: string, allowZero = true) {
  const input = String(value ?? "").trim();
  if (!/^\d{1,12}(?:\.\d{1,2})?$/.test(input)) {
    throw taHoursError(
      `${label} must be a valid SEK amount with up to two decimals.`
    );
  }
  const amount = new Prisma.Decimal(input);
  if (
    !amount.isFinite() ||
    amount.greaterThan("999999999999.99") ||
    (!allowZero && amount.lessThanOrEqualTo(0))
  ) {
    throw taHoursError(
      allowZero
        ? `${label} must be between 0 and 999,999,999,999.99 SEK.`
        : `${label} must be greater than 0 SEK.`
    );
  }
  return amount;
}

export function calculateTAHoursBudgetValues({
  mode,
  totalHoursBudget: totalHoursInput,
  budgetAmountSek: budgetAmountInput,
  hourlyRateSekPerHour: hourlyRateInput,
}: {
  mode: unknown;
  totalHoursBudget: unknown;
  budgetAmountSek: unknown;
  hourlyRateSekPerHour: unknown;
}) {
  if (mode !== "budget" && mode !== "hours") {
    throw taHoursError(
      "Choose whether to enter a SEK budget or available hours."
    );
  }
  const hourlyRateSekPerHour = parseSek(hourlyRateInput, "Hourly rate", false);
  let totalHoursBudget: Prisma.Decimal;
  let budgetAmountSek: Prisma.Decimal;
  if (mode === "budget") {
    budgetAmountSek = parseSek(budgetAmountInput, "Budget", true);
    totalHoursBudget = parseHours(
      budgetAmountSek
        .div(hourlyRateSekPerHour)
        .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
        .toFixed(2),
      "Available hours",
      true
    );
  } else {
    totalHoursBudget = parseHours(totalHoursInput, "Available hours", true);
    budgetAmountSek = parseSek(
      totalHoursBudget
        .mul(hourlyRateSekPerHour)
        .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
        .toFixed(2),
      "Calculated budget",
      true
    );
  }
  return { totalHoursBudget, budgetAmountSek, hourlyRateSekPerHour };
}

function parseDateKey(value: unknown) {
  if (typeof value !== "string" || !isValidDateKey(value)) {
    throw taHoursError("Choose a valid shift date.");
  }
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function dateKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

function getLabLocalDateTime(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: LAB_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(
    parts.map(({ type, value }) => [type, value])
  );
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: LAB_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(now);
  return {
    dateKey: `${values.year}-${values.month}-${values.day}`,
    time,
  };
}

function periodDates(academicYear: string) {
  const dates = getAcademicPeriodDateKeys(academicYear);
  if (!dates) throw taHoursError("Choose a valid academic year.");
  return {
    startDate: parseDateKey(dates.startDateKey),
    endDate: parseDateKey(dates.endDateKey),
  };
}

async function ensurePeriod(organizationId: string, academicYear: string) {
  const { startDate, endDate } = periodDates(academicYear);
  return db.tAHoursPeriod.upsert({
    where: { organizationId_academicYear: { organizationId, academicYear } },
    create: {
      organizationId,
      academicYear,
      startDate,
      endDate,
      totalHoursBudget: 0,
    },
    update: {},
  });
}

export async function createNextTAHoursPeriod({
  organizationId,
}: {
  organizationId: string;
}) {
  const existingPeriods = await db.tAHoursPeriod.findMany({
    where: { organizationId },
    select: { academicYear: true },
  });
  const latestAcademicYear = [
    getAcademicYear(),
    ...existingPeriods.map((period) => period.academicYear),
  ].sort((left, right) => right.localeCompare(left))[0];
  const nextAcademicYear = latestAcademicYear
    ? getNextAcademicYear(latestAcademicYear)
    : null;
  if (!nextAcademicYear) {
    throw taHoursError("Choose a valid academic year.");
  }
  return ensurePeriod(organizationId, nextAcademicYear);
}

async function getTAHourCandidates(organizationId: string) {
  const [staffMembers, labTAs] = await Promise.all([
    db.userOrganization.findMany({
      where: {
        organizationId,
        roles: { hasSome: [...STAFF_ROLES] },
        user: { deletedAt: null },
      },
      select: { user: { select: PERIOD_RELATIONS.user.select } },
    }),
    db.ioioLabTA.findMany({
      where: {
        organizationId,
        user: {
          deletedAt: null,
          userOrganizations: { some: { organizationId } },
        },
      },
      select: { user: { select: PERIOD_RELATIONS.user.select } },
    }),
  ]);
  const users = new Map<string, (typeof staffMembers)[number]["user"]>();
  for (const { user } of [...staffMembers, ...labTAs]) users.set(user.id, user);
  return [...users.values()].sort((left, right) =>
    userName(left).localeCompare(userName(right))
  );
}

async function assertEligibleTA(organizationId: string, userId: string) {
  const candidates = await getTAHourCandidates(organizationId);
  const user = candidates.find((candidate) => candidate.id === userId);
  if (!user) {
    throw taHoursError("Choose an active Staff member or IOIO TA.");
  }
  return user;
}

function isBeforeCurrentShiftEnd(
  shift: {
    scheduledDate: Date;
    scheduledEndTime: string;
  },
  now: ReturnType<typeof getLabLocalDateTime>
) {
  const shiftDate = dateKey(shift.scheduledDate);
  return (
    shiftDate < now.dateKey ||
    (shiftDate === now.dateKey && shift.scheduledEndTime <= now.time)
  );
}

function isCurrentShiftStarted(
  shift: { scheduledDate: Date; scheduledStartTime: string },
  now: ReturnType<typeof getLabLocalDateTime>
) {
  const shiftDate = dateKey(shift.scheduledDate);
  return (
    shiftDate < now.dateKey ||
    (shiftDate === now.dateKey && shift.scheduledStartTime <= now.time)
  );
}

function isUpcomingShift(
  shift: {
    scheduledDate: Date;
    scheduledStartTime: string;
  },
  now: ReturnType<typeof getLabLocalDateTime>
) {
  const shiftDate = dateKey(shift.scheduledDate);
  return (
    shiftDate > now.dateKey ||
    (shiftDate === now.dateKey && shift.scheduledStartTime > now.time)
  );
}

function getDateSchedule(
  date: Date,
  workingHours: Awaited<ReturnType<typeof getWorkingHoursForOrganization>>
) {
  if (!workingHours.enabled) return null;
  const key = dateKey(date);
  const override = workingHours.overrides.find(
    (entry) => dateKey(entry.date) === key
  );
  if (override) {
    return override.isOpen
      ? {
          isOpen: true,
          openTime: override.openTime,
          closeTime: override.closeTime,
        }
      : { isOpen: false, openTime: null, closeTime: null };
  }
  const schedule = parseWeeklySchedule(workingHours.weeklySchedule);
  const day = schedule[String(date.getUTCDay())];
  return day?.isOpen
    ? {
        isOpen: true,
        openTime: day.openTime ?? null,
        closeTime: day.closeTime ?? null,
      }
    : { isOpen: false, openTime: null, closeTime: null };
}

function parseWeeklySchedule(value: Prisma.JsonValue): WeeklyScheduleJson {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    return {};
  }
  const schedule: WeeklyScheduleJson = {};
  for (const [day, valueForDay] of Object.entries(value)) {
    if (
      valueForDay === null ||
      Array.isArray(valueForDay) ||
      typeof valueForDay !== "object" ||
      typeof valueForDay.isOpen !== "boolean"
    ) {
      continue;
    }
    schedule[day] = {
      isOpen: valueForDay.isOpen,
      ...(typeof valueForDay.openTime === "string"
        ? { openTime: valueForDay.openTime }
        : {}),
      ...(typeof valueForDay.closeTime === "string"
        ? { closeTime: valueForDay.closeTime }
        : {}),
    };
  }
  return schedule;
}

function isOutsideOpeningHours(
  shift: {
    scheduledDate: Date;
    scheduledStartTime: string;
    scheduledEndTime: string;
  },
  workingHours: Awaited<ReturnType<typeof getWorkingHoursForOrganization>>
) {
  const schedule = getDateSchedule(shift.scheduledDate, workingHours);
  if (!schedule) return false;
  const open = schedule.isOpen ? schedule.openTime : null;
  const close = schedule.isOpen ? schedule.closeTime : null;
  return (
    open === null ||
    close === null ||
    shift.scheduledStartTime < open ||
    shift.scheduledEndTime > close
  );
}

function getDefaultShift(
  workingHours: Awaited<ReturnType<typeof getWorkingHoursForOrganization>>
) {
  if (!workingHours.enabled) return { date: "", startTime: "", endTime: "" };
  const localNow = getLabLocalDateTime();
  const [year, month, day] = localNow.dateKey.split("-").map(Number);
  for (let offset = 0; offset < 14; offset += 1) {
    const date = new Date(Date.UTC(year, month - 1, day + offset));
    const hours = getDateSchedule(date, workingHours);
    const dateValue = dateKey(date);
    if (
      hours?.isOpen &&
      hours.openTime &&
      hours.closeTime &&
      (dateValue > localNow.dateKey || hours.openTime >= localNow.time)
    ) {
      return {
        date: dateValue,
        startTime: hours.openTime,
        endTime: hours.closeTime,
      };
    }
  }
  return { date: "", startTime: "", endTime: "" };
}

function sumDecimals(
  values: Array<Prisma.Decimal | number | null | undefined>
): Prisma.Decimal {
  let sum = new Prisma.Decimal(0);
  for (const value of values) sum = sum.plus(value ?? 0);
  return sum;
}

function addHoursSummary(
  budget: Prisma.Decimal,
  allocated: Prisma.Decimal,
  worked: Prisma.Decimal,
  scheduled: Prisma.Decimal
) {
  const summary = calculateTAHoursSummary({
    budget: Number(budget.toString()),
    allocated: Number(allocated.toString()),
    worked: Number(worked.toString()),
    scheduled: Number(scheduled.toString()),
  });
  const rounded = (value: number) => Number(value.toFixed(2));
  return {
    budget: rounded(summary.budget),
    allocated: rounded(summary.allocated),
    worked: rounded(summary.worked),
    scheduled: rounded(summary.scheduled),
    unallocated: rounded(summary.unallocated),
    allocationRemaining: rounded(summary.allocationRemaining),
    projectedAllocationRemaining: rounded(summary.projectedAllocationRemaining),
  };
}

export async function getTAHoursPageData({
  organizationId,
  academicYear,
  userId,
  isStaff,
  isTA = false,
  now = new Date(),
}: {
  organizationId: string;
  academicYear: string;
  userId: string;
  isStaff: boolean;
  isTA?: boolean;
  now?: Date;
}) {
  const period = await ensurePeriod(organizationId, academicYear);
  const [workingHours, periods] = await Promise.all([
    getWorkingHoursForOrganization(organizationId),
    db.tAHoursPeriod.findMany({
      where: { organizationId },
      select: { academicYear: true },
      orderBy: { academicYear: "desc" },
    }),
  ]);
  const [allocationRows, shiftRows, budgetAdjustments, candidates] =
    await Promise.all([
      db.tAHoursAllocation.findMany({
        where: { periodId: period.id, ...(isStaff ? {} : { userId }) },
        include: { user: { select: PERIOD_RELATIONS.user.select } },
        orderBy: { allocatedHours: "desc" },
      }),
      db.tAShift.findMany({
        where: {
          organizationId,
          periodId: period.id,
          cancelledAt: null,
          ...(isStaff ? {} : { userId }),
        },
        include: {
          user: { select: PERIOD_RELATIONS.user.select },
          corrections: {
            include: {
              changedBy: {
                select: {
                  id: true,
                  email: true,
                  displayName: true,
                  firstName: true,
                  lastName: true,
                },
              },
            },
            orderBy: { createdAt: "desc" },
          },
        },
        orderBy: [{ scheduledDate: "asc" }, { scheduledStartTime: "asc" }],
        take: 500,
      }),
      isStaff
        ? db.tAHoursBudgetAdjustment.findMany({
            where: { periodId: period.id },
            include: {
              changedBy: {
                select: {
                  displayName: true,
                  firstName: true,
                  lastName: true,
                  email: true,
                },
              },
            },
            orderBy: { createdAt: "desc" },
            take: 25,
          })
        : Promise.resolve([]),
      isStaff ? getTAHourCandidates(organizationId) : Promise.resolve([]),
    ]);

  const localNow = getLabLocalDateTime(now);
  const shifts = shiftRows.map((shift) => {
    const scheduledHours =
      getScheduledHours(shift.scheduledStartTime, shift.scheduledEndTime) ?? 0;
    const status = deriveTAHoursStatus(
      shift.status,
      dateKey(shift.scheduledDate),
      shift.scheduledEndTime,
      localNow.dateKey,
      localNow.time
    );
    return {
      ...shift,
      scheduledDateKey: dateKey(shift.scheduledDate),
      scheduledHours,
      actualHoursValue: shift.actualHours?.toString() ?? null,
      displayStatus: status,
      outsideOpeningHours: isOutsideOpeningHours(shift, workingHours),
      corrections: shift.corrections.map((entry) => ({
        ...entry,
        previousHours: entry.previousHours?.toString() ?? null,
        newHours: entry.newHours.toString(),
        changedByName: userName(entry.changedBy),
      })),
    };
  });

  const completedShifts = shifts.filter(
    (shift) =>
      (shift.displayStatus === "CONFIRMED" ||
        shift.displayStatus === "ADJUSTED") &&
      shift.actualHoursValue !== null
  );
  const totalWorked = sumDecimals(
    completedShifts.map((shift) => new Prisma.Decimal(shift.actualHoursValue!))
  );
  const upcomingShifts = shifts.filter(
    (shift) =>
      shift.displayStatus === "SCHEDULED" && isUpcomingShift(shift, localNow)
  );
  const totalScheduled = sumDecimals(
    upcomingShifts.map((shift) => new Prisma.Decimal(shift.scheduledHours))
  );
  const totalAllocated = sumDecimals(
    allocationRows.map((allocation) => allocation.allocatedHours)
  );
  const currentUserAllocation = allocationRows.find(
    (allocation) => allocation.userId === userId
  );
  const visibleBudget = isStaff
    ? new Prisma.Decimal(period.totalHoursBudget)
    : currentUserAllocation?.allocatedHours ?? new Prisma.Decimal(0);

  const allocations = allocationRows.map((allocation) => {
    const taShifts = shifts.filter(
      (shift) => shift.userId === allocation.userId
    );
    const worked = sumDecimals(
      taShifts
        .filter(
          (shift) =>
            (shift.displayStatus === "CONFIRMED" ||
              shift.displayStatus === "ADJUSTED") &&
            shift.actualHoursValue !== null
        )
        .map((shift) => new Prisma.Decimal(shift.actualHoursValue!))
    );
    const scheduled = sumDecimals(
      taShifts
        .filter(
          (shift) =>
            shift.displayStatus === "SCHEDULED" &&
            isUpcomingShift(shift, localNow)
        )
        .map((shift) => new Prisma.Decimal(shift.scheduledHours))
    );
    const remaining = new Prisma.Decimal(allocation.allocatedHours).minus(
      worked
    );
    const projectedRemaining = remaining.minus(scheduled);
    const recentLog = taShifts
      .filter(
        (shift) =>
          (shift.displayStatus === "CONFIRMED" ||
            shift.displayStatus === "ADJUSTED") &&
          shift.actualHoursValue !== null
      )
      .sort(
        (left, right) => right.updatedAt.getTime() - left.updatedAt.getTime()
      )[0];
    return {
      id: allocation.id,
      userId: allocation.userId,
      name: userName(allocation.user),
      email: allocation.user.email,
      profilePicture: allocation.user.profilePicture,
      allocatedHours: allocation.allocatedHours.toString(),
      workedHours: worked.toString(),
      scheduledHours: scheduled.toString(),
      remainingHours: remaining.greaterThan(0) ? remaining.toString() : "0",
      projectedRemainingHours: projectedRemaining.greaterThan(0)
        ? projectedRemaining.toString()
        : "0",
      overAllocation: worked.greaterThan(allocation.allocatedHours),
      quickEntryKey: randomUUID(),
      recentLog: recentLog
        ? {
            shiftId: recentLog.id,
            date: recentLog.scheduledDateKey,
            hours: recentLog.actualHoursValue!,
            isManual: recentLog.isManual,
          }
        : null,
    };
  });
  const personalRecentLog =
    shifts
      .filter(
        (shift) =>
          shift.userId === userId &&
          (shift.displayStatus === "CONFIRMED" ||
            shift.displayStatus === "ADJUSTED") &&
          shift.actualHoursValue !== null
      )
      .sort(
        (left, right) => right.updatedAt.getTime() - left.updatedAt.getTime()
      )
      .slice(0, 1)
      .map((shift) => ({
        shiftId: shift.id,
        date: shift.scheduledDateKey,
        hours: shift.actualHoursValue!,
        isManual: shift.isManual,
      }))[0] ?? null;

  const hoursThisWeek = getThisWeekDateKeys(localNow.dateKey);
  const scheduledThisWeek = sumDecimals(
    upcomingShifts
      .filter(
        (shift) =>
          shift.scheduledDateKey >= hoursThisWeek.start &&
          shift.scheduledDateKey <= hoursThisWeek.end
      )
      .map((shift) => new Prisma.Decimal(shift.scheduledHours))
  );
  const awaitingCount = shifts.filter(
    (shift) => shift.displayStatus === "AWAITING_CONFIRMATION"
  ).length;
  const years = getAvailableAcademicYears(
    periods.map((entry) => entry.academicYear),
    getAcademicYear(now)
  );
  return {
    isStaff,
    canSelfLog: isTA,
    quickEntryKey: randomUUID(),
    personalRecentLog,
    currentUserId: userId,
    activeAcademicYear: getAcademicYear(now),
    period: {
      id: period.id,
      academicYear: period.academicYear,
      startDateKey: dateKey(period.startDate),
      endDateKey: dateKey(period.endDate),
      totalHoursBudget: visibleBudget.toString(),
      budgetAmountSek: period.budgetAmountSek?.toString() ?? null,
      hourlyRateSekPerHour: period.hourlyRateSekPerHour?.toString() ?? null,
    },
    todayDateKey: localNow.dateKey,
    years,
    summary: {
      ...addHoursSummary(
        visibleBudget,
        totalAllocated,
        totalWorked,
        totalScheduled
      ),
      scheduledThisWeek: Number(scheduledThisWeek.toFixed(2)),
      awaitingConfirmationCount: awaitingCount,
    },
    allocations,
    candidates: candidates.map((candidate) => ({
      id: candidate.id,
      name: userName(candidate),
      email: candidate.email,
      alreadyIncluded: allocationRows.some(
        ({ userId: id }) => id === candidate.id
      ),
    })),
    shifts,
    budgetAdjustments: budgetAdjustments.map((entry) => ({
      ...entry,
      previousHours: entry.previousHours.toString(),
      newHours: entry.newHours.toString(),
      changedByName: userName(entry.changedBy),
    })),
    defaultShift: getDefaultShift(workingHours),
    openingHoursEnabled: workingHours.enabled,
  };
}

function getThisWeekDateKeys(today: string) {
  const [year, month, day] = today.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const dayOfWeek = date.getUTCDay();
  const daysSinceMonday = (dayOfWeek + 6) % 7;
  const monday = new Date(date);
  monday.setUTCDate(date.getUTCDate() - daysSinceMonday);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  return { start: dateKey(monday), end: dateKey(sunday) };
}

export async function getTAHoursDashboardSummary(
  organizationId: string,
  userId: string,
  now = new Date()
) {
  const academicYear = getAcademicYear(now);
  const period = await db.tAHoursPeriod.findUnique({
    where: { organizationId_academicYear: { organizationId, academicYear } },
    select: { id: true, totalHoursBudget: true },
  });
  if (!period) {
    return {
      academicYear,
      totalHoursBudget: 0,
      allocatedHours: 0,
      workedHours: 0,
      unallocatedHours: 0,
      scheduledHours: 0,
      scheduledThisWeek: 0,
      awaitingConfirmationCount: 0,
      personalAllocatedHours: 0,
      personalWorkedHours: 0,
      personalHoursBalance: 0,
      personalRecentShift: null,
    };
  }

  const localNow = getLabLocalDateTime(now);
  const [allocations, shifts] = await Promise.all([
    db.tAHoursAllocation.findMany({
      where: { periodId: period.id },
      select: { userId: true, allocatedHours: true },
    }),
    db.tAShift.findMany({
      where: {
        organizationId,
        periodId: period.id,
        cancelledAt: null,
      },
      select: {
        id: true,
        userId: true,
        status: true,
        actualHours: true,
        scheduledDate: true,
        scheduledStartTime: true,
        scheduledEndTime: true,
        isManual: true,
      },
    }),
  ]);
  const decorated = shifts.map((shift) => ({
    ...shift,
    scheduledDateKey: dateKey(shift.scheduledDate),
    displayStatus: deriveTAHoursStatus(
      shift.status,
      dateKey(shift.scheduledDate),
      shift.scheduledEndTime,
      localNow.dateKey,
      localNow.time
    ),
    scheduledHours:
      getScheduledHours(shift.scheduledStartTime, shift.scheduledEndTime) ?? 0,
  }));
  const worked = sumDecimals(
    decorated
      .filter(
        (shift) =>
          (shift.displayStatus === "CONFIRMED" ||
            shift.displayStatus === "ADJUSTED") &&
          shift.actualHours !== null
      )
      .map((shift) => shift.actualHours)
  );
  const upcoming = decorated.filter(
    (shift) =>
      shift.displayStatus === "SCHEDULED" && isUpcomingShift(shift, localNow)
  );
  const allocated = sumDecimals(allocations.map((row) => row.allocatedHours));
  const personalAllocation = allocations.find((row) => row.userId === userId);
  const personalWorked = sumDecimals(
    decorated
      .filter(
        (shift) =>
          shift.userId === userId &&
          (shift.displayStatus === "CONFIRMED" ||
            shift.displayStatus === "ADJUSTED") &&
          shift.actualHours !== null
      )
      .map((shift) => shift.actualHours)
  );
  const personalBalance = calculateTAHoursBalance(
    Number(
      (personalAllocation?.allocatedHours ?? new Prisma.Decimal(0)).toString()
    ),
    Number(personalWorked.toString())
  );
  const personalRecentShift = decorated
    .filter(
      (shift) =>
        shift.userId === userId &&
        (shift.displayStatus === "AWAITING_CONFIRMATION" ||
          shift.displayStatus === "CONFIRMED" ||
          shift.displayStatus === "ADJUSTED")
    )
    .sort((left, right) => {
      const leftPending = left.displayStatus === "AWAITING_CONFIRMATION";
      const rightPending = right.displayStatus === "AWAITING_CONFIRMATION";
      if (leftPending !== rightPending) return leftPending ? -1 : 1;
      const byDate = right.scheduledDateKey.localeCompare(
        left.scheduledDateKey
      );
      return (
        byDate ||
        right.scheduledStartTime.localeCompare(left.scheduledStartTime)
      );
    })[0];
  const thisWeek = getThisWeekDateKeys(localNow.dateKey);
  const weekScheduled = sumDecimals(
    upcoming
      .filter(
        (shift) =>
          shift.scheduledDateKey >= thisWeek.start &&
          shift.scheduledDateKey <= thisWeek.end
      )
      .map((shift) => new Prisma.Decimal(shift.scheduledHours))
  );
  const awaiting = decorated.filter(
    (shift) => shift.displayStatus === "AWAITING_CONFIRMATION"
  ).length;
  return {
    academicYear,
    totalHoursBudget: Number(period.totalHoursBudget.toString()),
    allocatedHours: Number(allocated.toString()),
    workedHours: Number(worked.toString()),
    personalAllocatedHours: Number(
      (personalAllocation?.allocatedHours ?? new Prisma.Decimal(0)).toString()
    ),
    personalWorkedHours: Number(personalWorked.toString()),
    personalHoursBalance: personalBalance.balance,
    personalRecentShift: personalRecentShift
      ? {
          id: personalRecentShift.id,
          dateKey: personalRecentShift.scheduledDateKey,
          startTime: personalRecentShift.scheduledStartTime,
          endTime: personalRecentShift.scheduledEndTime,
          scheduledHours: personalRecentShift.scheduledHours,
          actualHours: personalRecentShift.actualHours?.toString() ?? null,
          isManual: personalRecentShift.isManual,
          status: personalRecentShift.displayStatus,
        }
      : null,
    unallocatedHours: Number(
      new Prisma.Decimal(period.totalHoursBudget).minus(allocated).toString()
    ),
    scheduledThisWeek: Number(weekScheduled.toString()),
    awaitingConfirmationCount: awaiting,
  };
}

export async function updateTAHoursBudget({
  organizationId,
  academicYear,
  userId,
  mode,
  totalHoursBudget: totalHoursInput,
  budgetAmountSek: budgetAmountInput,
  hourlyRateSekPerHour: hourlyRateInput,
  reason,
  confirmedOverBudget,
}: {
  organizationId: string;
  academicYear: string;
  userId: string;
  mode: unknown;
  totalHoursBudget: unknown;
  budgetAmountSek: unknown;
  hourlyRateSekPerHour: unknown;
  reason: unknown;
  confirmedOverBudget: boolean;
}) {
  const { totalHoursBudget, budgetAmountSek, hourlyRateSekPerHour } =
    calculateTAHoursBudgetValues({
      mode,
      totalHoursBudget: totalHoursInput,
      budgetAmountSek: budgetAmountInput,
      hourlyRateSekPerHour: hourlyRateInput,
    });
  const period = await ensurePeriod(organizationId, academicYear);
  const summary = await getTAHoursPageData({
    organizationId,
    academicYear,
    userId,
    isStaff: true,
  });
  const committed = new Prisma.Decimal(summary.summary.worked).plus(
    summary.summary.scheduled
  );
  if (totalHoursBudget.lessThan(committed) && !confirmedOverBudget) {
    throw taHoursError(
      `This budget will leave ${committed
        .minus(totalHoursBudget)
        .toFixed(
          2
        )} h above the total of confirmed and scheduled hours. Confirm to continue.`,
      409
    );
  }
  const reasonText =
    String(reason ?? "")
      .trim()
      .slice(0, 500) || null;
  return db.$transaction(async (tx) => {
    const updated = await tx.tAHoursPeriod.update({
      where: { id: period.id, organizationId },
      data: {
        totalHoursBudget,
        budgetAmountSek,
        hourlyRateSekPerHour,
      },
    });
    if (!new Prisma.Decimal(period.totalHoursBudget).equals(totalHoursBudget)) {
      await tx.tAHoursBudgetAdjustment.create({
        data: {
          periodId: period.id,
          previousHours: period.totalHoursBudget,
          newHours: totalHoursBudget,
          reason: reasonText,
          changedByUserId: userId,
        },
      });
    }
    return updated;
  });
}

export async function saveTAHoursAllocation({
  organizationId,
  academicYear,
  userId,
  taUserId,
  hours,
  confirmedOverBudget,
}: {
  organizationId: string;
  academicYear: string;
  userId: string;
  taUserId: string;
  hours: unknown;
  confirmedOverBudget: boolean;
}) {
  const allocatedHours = parseHours(hours, "Allocated hours", true);
  await assertEligibleTA(organizationId, taUserId);
  const period = await ensurePeriod(organizationId, academicYear);
  const allocations = await db.tAHoursAllocation.findMany({
    where: { periodId: period.id },
    select: { userId: true, allocatedHours: true },
  });
  const allocatedWithoutTA = sumDecimals(
    allocations
      .filter((entry) => entry.userId !== taUserId)
      .map((entry) => entry.allocatedHours)
  );
  const proposedTotal = allocatedWithoutTA.plus(allocatedHours);
  if (
    proposedTotal.greaterThan(period.totalHoursBudget) &&
    !confirmedOverBudget
  ) {
    throw taHoursError(
      `TA allocations will exceed the total budget by ${proposedTotal
        .minus(period.totalHoursBudget)
        .toFixed(2)} h. Confirm to continue.`,
      409
    );
  }
  return db.tAHoursAllocation.upsert({
    where: { periodId_userId: { periodId: period.id, userId: taUserId } },
    create: {
      periodId: period.id,
      userId: taUserId,
      allocatedHours,
      createdByUserId: userId,
      updatedByUserId: userId,
    },
    update: { allocatedHours, updatedByUserId: userId },
  });
}

async function getShiftAndAllocation({
  organizationId,
  periodId,
  userId,
}: {
  organizationId: string;
  periodId: string;
  userId: string;
}) {
  const allocation = await db.tAHoursAllocation.findFirst({
    where: { periodId, userId, period: { organizationId } },
  });
  if (!allocation) {
    throw taHoursError(
      "Add this person to the TA Hours plan before scheduling."
    );
  }
  return allocation;
}

async function assertShiftProjection({
  organizationId,
  periodId,
  taUserId,
  shiftId,
  date,
  startTime,
  scheduledHours,
  confirmedOverBudget,
}: {
  organizationId: string;
  periodId: string;
  taUserId: string;
  shiftId?: string;
  date: Date;
  startTime: string;
  scheduledHours: number;
  confirmedOverBudget: boolean;
}) {
  const [period, allocations, shifts] = await Promise.all([
    db.tAHoursPeriod.findFirstOrThrow({
      where: { id: periodId, organizationId },
    }),
    db.tAHoursAllocation.findMany({ where: { periodId } }),
    db.tAShift.findMany({
      where: { organizationId, periodId, cancelledAt: null },
      select: {
        id: true,
        userId: true,
        status: true,
        actualHours: true,
        scheduledDate: true,
        scheduledStartTime: true,
        scheduledEndTime: true,
      },
    }),
  ]);
  const now = getLabLocalDateTime();
  const worked = sumDecimals(
    shifts
      .filter(
        (shift) =>
          (shift.status === "CONFIRMED" || shift.status === "ADJUSTED") &&
          shift.actualHours !== null
      )
      .map((shift) => shift.actualHours)
  );
  const planned = shifts.filter(
    (shift) =>
      shift.id !== shiftId &&
      shift.status === "SCHEDULED" &&
      isUpcomingShift(shift, now)
  );
  const totalScheduled = sumDecimals(
    planned.map(
      (shift) =>
        new Prisma.Decimal(
          getScheduledHours(shift.scheduledStartTime, shift.scheduledEndTime) ??
            0
        )
    )
  );
  const dateKeyValue = dateKey(date);
  const newIsFuture =
    dateKeyValue > now.dateKey ||
    (dateKeyValue === now.dateKey && startTime > now.time);
  const addedScheduled = newIsFuture
    ? new Prisma.Decimal(scheduledHours)
    : new Prisma.Decimal(0);
  const budgetOverage = worked
    .plus(totalScheduled)
    .plus(addedScheduled)
    .minus(period.totalHoursBudget);

  const allocation = allocations.find((item) => item.userId === taUserId);
  const taWorked = sumDecimals(
    shifts
      .filter(
        (shift) =>
          shift.userId === taUserId &&
          (shift.status === "CONFIRMED" || shift.status === "ADJUSTED") &&
          shift.actualHours !== null
      )
      .map((shift) => shift.actualHours)
  );
  const taScheduled = sumDecimals(
    planned
      .filter((shift) => shift.userId === taUserId)
      .map(
        (shift) =>
          new Prisma.Decimal(
            getScheduledHours(
              shift.scheduledStartTime,
              shift.scheduledEndTime
            ) ?? 0
          )
      )
  );
  const taOverage = taWorked
    .plus(taScheduled)
    .plus(addedScheduled)
    .minus(allocation?.allocatedHours ?? 0);

  const warnings = [
    budgetOverage.greaterThan(0)
      ? `${budgetOverage.toFixed(2)} h above the total TA-hour budget`
      : null,
    taOverage.greaterThan(0)
      ? `${taOverage.toFixed(2)} h above this TA's allocation`
      : null,
  ].filter(Boolean);
  if (warnings.length && !confirmedOverBudget) {
    throw taHoursError(
      `This shift will put ${warnings.join(" and ")}. Confirm to continue.`,
      409
    );
  }
}

function parseShiftValues({
  date,
  startTime,
  endTime,
  period,
  allowPast = false,
}: {
  date: unknown;
  startTime: unknown;
  endTime: unknown;
  period: { startDate: Date; endDate: Date };
  allowPast?: boolean;
}) {
  const dateString = String(date ?? "");
  const scheduledDate = parseDateKey(dateString);
  if (scheduledDate < period.startDate || scheduledDate > period.endDate) {
    throw taHoursError("Choose a date within this academic year.");
  }
  const now = getLabLocalDateTime();
  if (!allowPast && dateString < now.dateKey) {
    throw taHoursError("New shifts must be scheduled for today or later.");
  }
  const start = String(startTime ?? "");
  const end = String(endTime ?? "");
  if (getTimeMinutes(start) === null || getTimeMinutes(end) === null) {
    throw taHoursError("Enter a valid shift start and end time.");
  }
  const scheduledHours = getScheduledHours(start, end);
  if (scheduledHours === null) {
    throw taHoursError("Shift end time must be later than its start time.");
  }
  return { scheduledDate, dateString, start, end, scheduledHours };
}

export async function createTAShift({
  organizationId,
  academicYear,
  userId,
  taUserId,
  date,
  startTime,
  endTime,
  confirmedOverBudget,
}: {
  organizationId: string;
  academicYear: string;
  userId: string;
  taUserId: string;
  date: unknown;
  startTime: unknown;
  endTime: unknown;
  confirmedOverBudget: boolean;
}) {
  const period = await ensurePeriod(organizationId, academicYear);
  await getShiftAndAllocation({
    organizationId,
    periodId: period.id,
    userId: taUserId,
  });
  const values = parseShiftValues({
    date,
    startTime,
    endTime,
    period,
  });
  await assertShiftProjection({
    organizationId,
    periodId: period.id,
    taUserId,
    date: values.scheduledDate,
    startTime: values.start,
    scheduledHours: values.scheduledHours,
    confirmedOverBudget,
  });
  return db.tAShift.create({
    data: {
      organizationId,
      periodId: period.id,
      userId: taUserId,
      scheduledDate: values.scheduledDate,
      scheduledStartTime: values.start,
      scheduledEndTime: values.end,
      createdByUserId: userId,
      status: TAShiftStatus.SCHEDULED,
    },
  });
}

export async function updateTAShift({
  organizationId,
  shiftId,
  taUserId,
  date,
  startTime,
  endTime,
  confirmedOverBudget,
}: {
  organizationId: string;
  shiftId: string;
  taUserId: string;
  date: unknown;
  startTime: unknown;
  endTime: unknown;
  confirmedOverBudget: boolean;
}) {
  const existing = await db.tAShift.findFirst({
    where: { id: shiftId, organizationId, cancelledAt: null },
    include: { period: true },
  });
  if (!existing) throw taHoursError("That shift could not be found.", 404);
  if (existing.actualHours !== null) {
    throw taHoursError(
      "A shift with confirmed hours cannot be rescheduled. Adjust its actual hours instead.",
      409
    );
  }
  await getShiftAndAllocation({
    organizationId,
    periodId: existing.periodId,
    userId: taUserId,
  });
  const values = parseShiftValues({
    date,
    startTime,
    endTime,
    period: existing.period,
    allowPast: true,
  });
  await assertShiftProjection({
    organizationId,
    periodId: existing.periodId,
    taUserId,
    shiftId,
    date: values.scheduledDate,
    startTime: values.start,
    scheduledHours: values.scheduledHours,
    confirmedOverBudget,
  });
  return db.tAShift.update({
    where: { id: shiftId, organizationId },
    data: {
      userId: taUserId,
      scheduledDate: values.scheduledDate,
      scheduledStartTime: values.start,
      scheduledEndTime: values.end,
    },
  });
}

export async function cancelTAShift({
  organizationId,
  shiftId,
}: {
  organizationId: string;
  shiftId: string;
}) {
  const existing = await db.tAShift.findFirst({
    where: { id: shiftId, organizationId, cancelledAt: null },
    select: { id: true, actualHours: true },
  });
  if (!existing) throw taHoursError("That shift could not be found.", 404);
  if (existing.actualHours !== null) {
    throw taHoursError(
      "A shift with confirmed hours cannot be cancelled.",
      409
    );
  }
  return db.tAShift.update({
    where: { id: shiftId, organizationId },
    data: { cancelledAt: new Date() },
  });
}

export async function saveTAHoursActual({
  organizationId,
  shiftId,
  actorUserId,
  isStaff,
  actualHours,
  reason,
  allowEarlyConfirmation = false,
}: {
  organizationId: string;
  shiftId: string;
  actorUserId: string;
  isStaff: boolean;
  actualHours: unknown;
  reason: unknown;
  allowEarlyConfirmation?: boolean;
}) {
  const existing = await db.tAShift.findFirst({
    where: { id: shiftId, organizationId, cancelledAt: null },
  });
  if (!existing) throw taHoursError("That shift could not be found.", 404);
  if (!isStaff && existing.userId !== actorUserId) {
    throw taHoursError("You can only confirm your own TA hours.", 403);
  }
  const now = getLabLocalDateTime();
  if (
    !isBeforeCurrentShiftEnd(existing, now) &&
    !(allowEarlyConfirmation && isCurrentShiftStarted(existing, now))
  ) {
    throw taHoursError(
      "Actual hours can be confirmed after the shift ends.",
      409
    );
  }
  const parsedActual = parseHours(actualHours, "Actual hours", true);
  if (parsedActual.greaterThan(9999.99)) {
    throw taHoursError("Actual hours must be 9,999.99 or less.");
  }
  const reasonText =
    String(reason ?? "")
      .trim()
      .slice(0, 500) || null;
  const scheduledHours = new Prisma.Decimal(
    getScheduledHours(existing.scheduledStartTime, existing.scheduledEndTime) ??
      0
  );
  const adjusted = !parsedActual.equals(scheduledHours);
  return db.$transaction(async (tx) => {
    const actualHoursChanged =
      existing.actualHours === null ||
      !new Prisma.Decimal(existing.actualHours).equals(parsedActual);
    if (actualHoursChanged) {
      await tx.tAHoursCorrection.create({
        data: {
          shiftId,
          previousHours: existing.actualHours,
          newHours: parsedActual,
          reason: reasonText,
          changedByUserId: actorUserId,
        },
      });
    }
    return tx.tAShift.update({
      where: { id: shiftId, organizationId },
      data: {
        actualHours: parsedActual,
        actualHoursReason: reasonText,
        status: adjusted ? TAShiftStatus.ADJUSTED : TAShiftStatus.CONFIRMED,
        confirmedByUserId: actorUserId,
        confirmedAt: new Date(),
      },
    });
  });
}

export async function logTAHoursWorked({
  organizationId,
  actorUserId,
  targetTAUserId,
  isTA,
  isStaff,
  academicYear,
  hours,
  workDate,
  submissionKey,
  allowAdditional,
  now = new Date(),
}: {
  organizationId: string;
  actorUserId: string;
  targetTAUserId?: unknown;
  isTA: boolean;
  isStaff: boolean;
  academicYear: string;
  hours: unknown;
  workDate: unknown;
  submissionKey: unknown;
  allowAdditional: boolean;
  now?: Date;
}) {
  if (!isTA && !isStaff) {
    throw taHoursError("Only a listed TA can log personal worked hours.", 403);
  }
  if (academicYear !== getAcademicYear(now)) {
    throw taHoursError(
      "Quick worked-hours entry is available for the current academic year only."
    );
  }
  const parsedHours = parseHours(hours, "Hours worked", false);
  if (parsedHours.greaterThan(9999.99)) {
    throw taHoursError("Hours worked must be 9,999.99 or less.");
  }
  const nowLocal = getLabLocalDateTime(now);
  const requestedTarget = String(targetTAUserId ?? "").trim();
  const taUserId = isStaff ? requestedTarget || actorUserId : actorUserId;
  if (!isStaff && requestedTarget && requestedTarget !== actorUserId) {
    throw taHoursError("You can only log your own TA hours.", 403);
  }
  if (isStaff) await assertEligibleTA(organizationId, taUserId);
  const dateInput = String(workDate ?? "").trim() || nowLocal.dateKey;
  const workDateValue = parseDateKey(dateInput);
  const dateBounds = getAcademicPeriodDateKeys(academicYear);
  if (
    !dateBounds ||
    dateInput < dateBounds.startDateKey ||
    dateInput > dateBounds.endDateKey
  ) {
    throw taHoursError("Choose a date within the current academic year.");
  }
  const entryKey = String(submissionKey ?? "");
  if (entryKey.length < 16 || entryKey.length > 64) {
    throw taHoursError("Refresh the page before logging worked hours.");
  }
  const period = await ensurePeriod(organizationId, academicYear);
  const dateShifts = await db.tAShift.findMany({
    where: {
      organizationId,
      periodId: period.id,
      userId: taUserId,
      scheduledDate: workDateValue,
      cancelledAt: null,
    },
    orderBy: { scheduledStartTime: "asc" },
  });
  const startedUnconfirmed = dateShifts.filter(
    (shift) =>
      shift.status === TAShiftStatus.SCHEDULED &&
      shift.actualHours === null &&
      isCurrentShiftStarted(shift, nowLocal)
  );
  if (startedUnconfirmed.length > 1) {
    throw taHoursError(
      "You have multiple shifts on this date. Confirm each scheduled shift from Timesheets to avoid double-counting."
    );
  }
  if (startedUnconfirmed.length === 1) {
    const shift = startedUnconfirmed[0];
    const saved = await saveTAHoursActual({
      organizationId,
      shiftId: shift.id,
      actorUserId,
      isStaff,
      actualHours: parsedHours.toString(),
      reason: null,
      allowEarlyConfirmation: true,
    });
    return {
      kind: "logged" as const,
      entryId: saved.id,
      actualHours: saved.actualHours?.toString() ?? parsedHours.toString(),
      dateKey: dateInput,
      linkedToShift: true,
    };
  }

  const existingWorked = sumDecimals(
    dateShifts
      .filter(
        (shift) =>
          (shift.status === TAShiftStatus.CONFIRMED ||
            shift.status === TAShiftStatus.ADJUSTED) &&
          shift.actualHours !== null
      )
      .map((shift) => shift.actualHours)
  );
  if (!allowAdditional && existingWorked.greaterThan(0)) {
    return {
      kind: "alreadyLogged" as const,
      actualHours: existingWorked.toString(),
      dateKey: dateInput,
    };
  }

  try {
    const saved = await db.tAShift.create({
      data: {
        organizationId,
        periodId: period.id,
        userId: taUserId,
        scheduledDate: workDateValue,
        scheduledStartTime: "00:00",
        scheduledEndTime: "00:00",
        actualHours: parsedHours,
        status: TAShiftStatus.CONFIRMED,
        isManual: true,
        manualEntryKey: entryKey,
        createdByUserId: actorUserId,
        confirmedByUserId: actorUserId,
        confirmedAt: now,
      },
    });
    return {
      kind: "logged" as const,
      entryId: saved.id,
      actualHours: saved.actualHours?.toString() ?? parsedHours.toString(),
      dateKey: dateInput,
      linkedToShift: false,
    };
  } catch (cause) {
    if (
      cause instanceof Prisma.PrismaClientKnownRequestError &&
      cause.code === "P2002"
    ) {
      const existing = await db.tAShift.findUnique({
        where: { manualEntryKey: entryKey },
        select: { id: true, actualHours: true, scheduledDate: true },
      });
      if (existing?.actualHours) {
        return {
          kind: "logged" as const,
          entryId: existing.id,
          actualHours: existing.actualHours.toString(),
          dateKey: dateKey(existing.scheduledDate),
          linkedToShift: false,
        };
      }
    }
    throw cause;
  }
}

export async function undoLastTAHoursLog({
  organizationId,
  actorUserId,
  targetTAUserId,
  isTA,
  isStaff,
  academicYear,
  shiftId,
  now = new Date(),
}: {
  organizationId: string;
  actorUserId: string;
  targetTAUserId?: unknown;
  isTA: boolean;
  isStaff: boolean;
  academicYear: string;
  shiftId: unknown;
  now?: Date;
}) {
  if (!isTA && !isStaff) {
    throw taHoursError(
      "Only a listed TA or Staff can remove a worked-hours log.",
      403
    );
  }
  if (academicYear !== getAcademicYear(now)) {
    throw taHoursError(
      "Only the current academic year's latest log can be removed."
    );
  }
  const requestedTarget = String(targetTAUserId ?? "").trim();
  const taUserId = isStaff ? requestedTarget || actorUserId : actorUserId;
  if (!isStaff && requestedTarget && requestedTarget !== actorUserId) {
    throw taHoursError("You can only remove your own worked-hours log.", 403);
  }
  if (isStaff) await assertEligibleTA(organizationId, taUserId);

  const targetShiftId = String(shiftId ?? "").trim();
  if (!targetShiftId)
    throw taHoursError("Choose a worked-hours log to remove.");
  const period = await ensurePeriod(organizationId, academicYear);

  await db.$transaction(async (tx) => {
    const latestLog = await tx.tAShift.findFirst({
      where: {
        organizationId,
        periodId: period.id,
        userId: taUserId,
        cancelledAt: null,
        actualHours: { not: null },
        status: { in: [TAShiftStatus.CONFIRMED, TAShiftStatus.ADJUSTED] },
      },
      include: {
        corrections: { orderBy: { createdAt: "desc" } },
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    });

    if (!latestLog || latestLog.id !== targetShiftId) {
      throw taHoursError(
        "This is no longer the latest log. Refresh the page and try again.",
        409
      );
    }

    if (latestLog.isManual) {
      const removed = await tx.tAShift.updateMany({
        where: {
          id: latestLog.id,
          organizationId,
          periodId: period.id,
          userId: taUserId,
          cancelledAt: null,
        },
        data: { cancelledAt: now },
      });
      if (removed.count !== 1) {
        throw taHoursError(
          "That log was already removed. Refresh the page.",
          409
        );
      }
      return;
    }

    const initialConfirmation = latestLog.corrections[0];
    if (
      !initialConfirmation ||
      initialConfirmation.previousHours !== null ||
      !initialConfirmation.newHours.equals(latestLog.actualHours!)
    ) {
      throw taHoursError(
        "This scheduled shift has later adjustments and cannot be undone as a single log. Refresh the page and review its history.",
        409
      );
    }

    await tx.tAHoursCorrection.update({
      where: { id: initialConfirmation.id },
      data: {
        reason:
          "Initial confirmation undone; hours restored to scheduled state.",
      },
    });
    await tx.tAShift.update({
      where: { id: latestLog.id, organizationId },
      data: {
        actualHours: null,
        actualHoursReason: null,
        status: TAShiftStatus.SCHEDULED,
        confirmedByUserId: null,
        confirmedAt: null,
      },
    });
  });
}
