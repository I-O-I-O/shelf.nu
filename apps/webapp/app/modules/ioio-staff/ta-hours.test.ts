import { describe, expect, it } from "vitest";
import {
  calculateTAHoursSummary,
  calculateTAHoursBalance,
  deriveTAHoursStatus,
  getAvailableAcademicYears,
  getAcademicPeriodDateKeys,
  getNextAcademicYear,
  getScheduledHours,
  getTimeMinutes,
  isValidDateKey,
} from "./ta-hours";

describe("TA Hours helpers", () => {
  it("uses the September to August academic-year boundaries", () => {
    expect(getAcademicPeriodDateKeys("2026-2027")).toEqual({
      startDateKey: "2026-09-01",
      endDateKey: "2027-08-31",
    });
    expect(getAcademicPeriodDateKeys("2026-2028")).toBeNull();
  });

  it("lists only valid existing academic periods with the active period first", () => {
    expect(
      getAvailableAcademicYears(
        ["2024-2025", "2026-2027", "invalid", "2025-2027"],
        "2025-2026"
      )
    ).toEqual(["2026-2027", "2025-2026", "2024-2025"]);
  });

  it("calculates the next period without carrying over allocations", () => {
    expect(getNextAcademicYear("2026-2027")).toBe("2027-2028");
    expect(getNextAcademicYear("invalid")).toBeNull();
  });

  it("validates date-only values without local timezone conversion", () => {
    expect(isValidDateKey("2026-09-23")).toBe(true);
    expect(isValidDateKey("2026-02-30")).toBe(false);
  });

  it("calculates scheduled hours from wall-clock times", () => {
    expect(getTimeMinutes("13:00")).toBe(780);
    expect(getScheduledHours("13:00", "16:00")).toBe(3);
    expect(getScheduledHours("13:05", "15:35")).toBe(2.5);
    expect(getScheduledHours("16:00", "13:00")).toBeNull();
  });

  it("keeps past shifts awaiting confirmation until actual time is saved", () => {
    expect(
      deriveTAHoursStatus(
        "SCHEDULED",
        "2026-09-23",
        "16:00",
        "2026-09-23",
        "16:00"
      )
    ).toBe("AWAITING_CONFIRMATION");
    expect(
      deriveTAHoursStatus(
        "SCHEDULED",
        "2026-09-23",
        "16:00",
        "2026-09-23",
        "15:59"
      )
    ).toBe("SCHEDULED");
  });

  it("keeps worked hours separate from scheduled hours in summaries", () => {
    expect(
      calculateTAHoursSummary({
        budget: 320,
        allocated: 80,
        worked: 42.5,
        scheduled: 12,
      })
    ).toEqual({
      budget: 320,
      allocated: 80,
      worked: 42.5,
      scheduled: 12,
      unallocated: 240,
      allocationRemaining: 37.5,
      projectedAllocationRemaining: 25.5,
    });
  });

  it("keeps unallocated budget separate from worked hours", () => {
    expect(
      calculateTAHoursSummary({
        budget: 160,
        allocated: 34,
        worked: 10,
        scheduled: 12,
      })
    ).toMatchObject({
      unallocated: 126,
      allocationRemaining: 24,
      projectedAllocationRemaining: 12,
    });
  });

  it("does not let worked or scheduled hours change the unallocated budget", () => {
    expect(
      calculateTAHoursSummary({
        budget: 160,
        allocated: 34,
        worked: 38,
        scheduled: 12,
      })
    ).toMatchObject({ unallocated: 126, allocationRemaining: 0 });
  });

  it("turns a negative allocation balance into positive overtime", () => {
    expect(calculateTAHoursBalance(18, 17)).toEqual({
      balance: 1,
      hoursLeft: 1,
      overtime: 0,
    });
    expect(calculateTAHoursBalance(18, 20)).toEqual({
      balance: -2,
      hoursLeft: 0,
      overtime: 2,
    });
    expect(calculateTAHoursBalance(18, 18)).toEqual({
      balance: 0,
      hoursLeft: 0,
      overtime: 0,
    });
  });
});
