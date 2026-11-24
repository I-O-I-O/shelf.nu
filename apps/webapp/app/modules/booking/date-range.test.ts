import { describe, expect, it } from "vitest";
import { getBookingDateBounds } from "./date-range";

describe("Loans date ranges", () => {
  const now = new Date(2026, 8, 20, 15, 30);

  it("uses seven inclusive local calendar days", () => {
    const bounds = getBookingDateBounds("last-7-days", { now });

    expect(bounds?.start).toEqual(new Date(2026, 8, 14));
    expect(bounds?.end).toEqual(new Date(2026, 8, 21));
  });

  it("uses the current local calendar day for Today", () => {
    const bounds = getBookingDateBounds("today", { now });

    expect(bounds?.start).toEqual(new Date(2026, 8, 20));
    expect(bounds?.end).toEqual(new Date(2026, 8, 21));
  });

  it("includes both endpoints in a custom date range", () => {
    const bounds = getBookingDateBounds("custom", {
      customFrom: "2026-09-18",
      customTo: "2026-09-20",
    });

    expect(bounds?.start).toEqual(new Date(2026, 8, 18));
    expect(bounds?.end).toEqual(new Date(2026, 8, 21));
  });

  it("rejects an invalid custom range", () => {
    expect(
      getBookingDateBounds("custom", {
        customFrom: "2026-09-21",
        customTo: "2026-09-20",
      })
    ).toBeNull();
  });
});
