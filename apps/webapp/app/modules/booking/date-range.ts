export type BookingDateRange = {
  start: Date;
  end: Date;
};

function startOfLocalDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function parseDateOnly(value: string | null) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;

  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);

  return date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day
    ? date
    : null;
}

/**
 * Builds the date-only bounds used by the Loans list and CSV export.
 * The upper bound is exclusive and all dates are local calendar dates, so a
 * YYYY-MM-DD value never shifts when it crosses a UTC boundary.
 */
export function getBookingDateBounds(
  dateRange: string | null,
  options: {
    now?: Date;
    customFrom?: string | null;
    customTo?: string | null;
  } = {}
): BookingDateRange | null {
  if (!dateRange || dateRange === "all") return null;

  const today = startOfLocalDay(options.now ?? new Date());
  const start = new Date(today);

  if (dateRange === "today") {
    // The current calendar day is already the correct start boundary.
  } else if (dateRange === "last-7-days") {
    start.setDate(start.getDate() - 6);
  } else if (dateRange === "last-30-days") {
    start.setDate(start.getDate() - 29);
  } else if (dateRange === "last-day") {
    // Legacy Loans list URLs still use this value.
    start.setDate(start.getDate() - 1);
  } else if (dateRange === "last-week") {
    // Legacy Loans list URLs still use this value.
    start.setDate(start.getDate() - 7);
  } else if (dateRange === "last-month") {
    // Legacy Loans list URLs still use this value.
    start.setMonth(start.getMonth() - 1);
  } else if (dateRange.startsWith("year:")) {
    const year = Number(dateRange.slice("year:".length));
    if (!Number.isInteger(year)) return null;
    start.setFullYear(year, 0, 1);
  } else if (dateRange === "custom") {
    const customFrom = parseDateOnly(options.customFrom ?? null);
    const customTo = parseDateOnly(options.customTo ?? null);
    if (!customFrom || !customTo || customFrom > customTo) return null;

    const end = new Date(customTo);
    end.setDate(end.getDate() + 1);
    return { start: customFrom, end };
  } else {
    return null;
  }

  const end = new Date(today);
  if (dateRange.startsWith("year:")) {
    end.setFullYear(start.getFullYear() + 1, 0, 1);
  } else {
    end.setDate(end.getDate() + 1);
  }

  return { start, end };
}
