/** Shared date-range rules for IOIO borrowing and reservation flows. */

export function addCalendarMonth(date: Date) {
  const next = new Date(date);
  const originalDay = next.getUTCDate();
  next.setUTCDate(1);
  next.setUTCMonth(next.getUTCMonth() + 1);
  const lastDay = new Date(
    Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)
  ).getUTCDate();
  next.setUTCDate(Math.min(originalDay, lastDay));
  return next;
}

/**
 * Adds one calendar month to a date-picker's naive local date. Date inputs
 * represent a wall-clock day, so using local getters here prevents a positive
 * or negative timezone offset from moving the maximum date by one day.
 */
export function addCalendarMonthLocal(date: Date) {
  const next = new Date(date);
  const originalDay = next.getDate();
  next.setDate(1);
  next.setMonth(next.getMonth() + 1);
  const lastDay = new Date(
    next.getFullYear(),
    next.getMonth() + 1,
    0
  ).getDate();
  next.setDate(Math.min(originalDay, lastDay));
  return next;
}

export function isWithinOneCalendarMonth(start: Date, end: Date) {
  const endDay = Date.UTC(
    end.getUTCFullYear(),
    end.getUTCMonth(),
    end.getUTCDate()
  );
  const maximumDay = addCalendarMonth(start);
  const maximumDayOnly = Date.UTC(
    maximumDay.getUTCFullYear(),
    maximumDay.getUTCMonth(),
    maximumDay.getUTCDate()
  );
  return endDay <= maximumDayOnly;
}

export function assertStudentBorrowingPeriod(start: Date, end: Date) {
  if (!isWithinOneCalendarMonth(start, end)) {
    throw new Error("Borrowing period can be up to 1 month.");
  }
}

export function addCalendarDaysLocal(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

export function assertConfiguredBorrowingPeriod(
  start: Date,
  end: Date,
  maxBorrowDays: number | null | undefined
) {
  const effectiveMaxBorrowDays = maxBorrowDays ?? 45;
  const maximum = new Date(start);
  maximum.setUTCDate(maximum.getUTCDate() + effectiveMaxBorrowDays);
  const endDay = Date.UTC(
    end.getUTCFullYear(),
    end.getUTCMonth(),
    end.getUTCDate()
  );
  const maximumDay = Date.UTC(
    maximum.getUTCFullYear(),
    maximum.getUTCMonth(),
    maximum.getUTCDate()
  );
  if (endDay > maximumDay) {
    throw new Error(
      `This item can be borrowed for up to ${effectiveMaxBorrowDays} days.`
    );
  }
}

export function dateOnlyToUtcStart(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

export function dateOnlyToUtcEnd(value: string) {
  return new Date(`${value}T23:59:59.999Z`);
}

/**
 * Adds whole calendar days to a canonical UTC date-only due date and returns
 * the end of the resulting calendar day. Loan due dates are stored this way,
 * so extension calculations do not depend on the server or browser timezone.
 */
export function addCalendarDaysUtcEnd(value: Date, days: number) {
  const next = new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate())
  );
  next.setUTCDate(next.getUTCDate() + days);
  next.setUTCHours(23, 59, 59, 999);
  return next;
}

/**
 * Returns the authoritative window for an immediate borrow.
 *
 * The start is the transaction time, while the due date is the end of the
 * calendar day reached after the asset's configured maximum borrowing period.
 * Keeping this calculation server-side prevents a client date picker or an
 * assistant-generated date from changing the loan duration.
 */
export function getImmediateBorrowingWindow(
  maxBorrowDays: number | null | undefined,
  now = new Date()
) {
  const effectiveMaxBorrowDays = maxBorrowDays ?? 45;
  const from = new Date(now);
  const dueDay = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  dueDay.setUTCDate(dueDay.getUTCDate() + effectiveMaxBorrowDays);
  const to = new Date(dueDay);
  to.setUTCHours(23, 59, 59, 999);
  return { from, to };
}
