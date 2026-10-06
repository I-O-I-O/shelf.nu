import { describe, expect, it } from "vitest";
import {
  addCalendarMonth,
  addCalendarMonthLocal,
  assertConfiguredBorrowingPeriod,
  getImmediateBorrowingWindow,
  isWithinOneCalendarMonth,
} from "./date-range";

describe("IOIO borrowing date rules", () => {
  it("uses a calendar month rather than a fixed number of days", () => {
    const start = new Date("2026-01-31T00:00:00.000Z");
    expect(addCalendarMonth(start).toISOString()).toBe(
      "2026-02-28T00:00:00.000Z"
    );
    expect(
      isWithinOneCalendarMonth(start, new Date("2026-02-28T23:59:59.000Z"))
    ).toBe(true);
  });

  it("accepts an end date inside the calendar-month boundary", () => {
    const start = new Date("2026-09-16T00:00:00.000Z");
    expect(
      isWithinOneCalendarMonth(start, new Date("2026-10-15T23:59:59.000Z"))
    ).toBe(true);
    expect(
      isWithinOneCalendarMonth(start, new Date("2026-10-17T00:00:01.000Z"))
    ).toBe(false);
  });

  it("keeps date-picker month arithmetic on the local calendar day", () => {
    const start = new Date(2026, 8, 30);
    const maximum = addCalendarMonthLocal(start);
    expect(maximum.getFullYear()).toBe(2026);
    expect(maximum.getMonth()).toBe(9);
    expect(maximum.getDate()).toBe(30);
  });

  it("enforces a Kit-specific initial borrowing limit", () => {
    const start = new Date("2026-09-17T00:00:00.000Z");
    expect(() =>
      assertConfiguredBorrowingPeriod(
        start,
        new Date("2026-10-01T23:59:59.000Z"),
        14
      )
    ).not.toThrow();
    expect(() =>
      assertConfiguredBorrowingPeriod(
        start,
        new Date("2026-10-02T00:00:00.000Z"),
        14
      )
    ).toThrow("up to 14 days");
  });

  it("starts immediately and ends on the configured due-date calendar day", () => {
    const now = new Date("2026-09-19T14:30:00.000Z");
    const window = getImmediateBorrowingWindow(14, now);
    expect(window.from).toEqual(now);
    expect(window.to.toISOString()).toBe("2026-10-03T23:59:59.999Z");
  });
});
