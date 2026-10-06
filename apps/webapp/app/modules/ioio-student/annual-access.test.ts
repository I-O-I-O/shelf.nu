import { describe, expect, it } from "vitest";
import { getAnnualAccessNoticeEventKey } from "./annual-access";

describe("annual access notice event identity", () => {
  it("keeps the same grant event stable across refreshes", () => {
    const eventAt = new Date("2026-09-29T12:00:00.000Z");
    expect(
      getAnnualAccessNoticeEventKey({
        status: "APPROVED",
        approvalId: "approval-1",
        eventAt,
      })
    ).toBe(
      getAnnualAccessNoticeEventKey({
        status: "APPROVED",
        approvalId: "approval-1",
        eventAt: eventAt.toISOString(),
      })
    );
  });

  it("treats a later re-grant on the same record as a new event", () => {
    const firstGrant = getAnnualAccessNoticeEventKey({
      status: "APPROVED",
      approvalId: "approval-1",
      eventAt: new Date("2026-09-29T12:00:00.000Z"),
    });
    const secondGrant = getAnnualAccessNoticeEventKey({
      status: "APPROVED",
      approvalId: "approval-1",
      eventAt: new Date("2026-10-01T09:00:00.000Z"),
    });

    expect(secondGrant).not.toBe(firstGrant);
  });
});
