export type TAHoursStatus =
  | "SCHEDULED"
  | "AWAITING_CONFIRMATION"
  | "CONFIRMED"
  | "ADJUSTED";

export function getAcademicPeriodDateKeys(academicYear: string) {
  const match = /^(\d{4})-(\d{4})$/.exec(academicYear);
  if (!match || Number(match[2]) !== Number(match[1]) + 1) return null;
  return {
    startDateKey: `${match[1]}-09-01`,
    endDateKey: `${match[2]}-08-31`,
  };
}

export function getAvailableAcademicYears(
  existingYears: string[],
  activeYear: string
) {
  return [
    ...new Set(
      [activeYear, ...existingYears].filter((year) =>
        Boolean(getAcademicPeriodDateKeys(year))
      )
    ),
  ].sort((left, right) => right.localeCompare(left));
}

export function getNextAcademicYear(academicYear: string) {
  const dates = getAcademicPeriodDateKeys(academicYear);
  if (!dates) return null;
  const firstYear = Number(academicYear.slice(0, 4)) + 1;
  return `${firstYear}-${firstYear + 1}`;
}

export function isValidDateKey(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function getTimeMinutes(value: string) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

export function getScheduledHours(startTime: string, endTime: string) {
  const start = getTimeMinutes(startTime);
  const end = getTimeMinutes(endTime);
  if (start === null || end === null || end <= start) return null;
  return Number(((end - start) / 60).toFixed(2));
}

export function deriveTAHoursStatus(
  storedStatus: TAHoursStatus,
  scheduledDateKey: string,
  scheduledEndTime: string,
  localDateKey: string,
  localTime: string
): TAHoursStatus {
  if (storedStatus !== "SCHEDULED") return storedStatus;
  if (
    scheduledDateKey < localDateKey ||
    (scheduledDateKey === localDateKey && scheduledEndTime <= localTime)
  ) {
    return "AWAITING_CONFIRMATION";
  }
  return "SCHEDULED";
}

export function calculateTAHoursSummary({
  budget,
  allocated,
  worked,
  scheduled,
}: {
  budget: number;
  allocated: number;
  worked: number;
  scheduled: number;
}) {
  return {
    budget,
    allocated,
    worked,
    scheduled,
    unallocated: budget - allocated,
    allocationRemaining: Math.max(0, allocated - worked),
    projectedAllocationRemaining: allocated - worked - scheduled,
  };
}

export function calculateTAHoursBalance(allocated: number, worked: number) {
  const balance = allocated - worked;
  return {
    balance,
    hoursLeft: Math.max(0, balance),
    overtime: Math.max(0, -balance),
  };
}
