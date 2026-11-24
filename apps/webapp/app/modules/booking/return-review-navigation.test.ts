import { describe, expect, it } from "vitest";
import {
  buildOperationsReturnTo,
  getSafeReturnTo,
  withReturnTo,
} from "./return-review-navigation";

describe("return review navigation", () => {
  it("preserves a known Operations filter", () => {
    const returnTo = buildOperationsReturnTo("returned-with-issues");
    expect(returnTo).toBe("/operations?view=returned-with-issues");
    expect(
      new URL(
        withReturnTo("/bookings/return-check/op-1", returnTo),
        "http://ioio.local"
      ).searchParams.get("returnTo")
    ).toBe(returnTo);
  });

  it("allows the Loans list as an internal origin", () => {
    expect(getSafeReturnTo("/bookings")).toBe("/bookings");
  });

  it.each([
    "https://example.com/",
    "//example.com/",
    "/operations?view=unknown",
    "/operations?view=returns&next=/bookings",
    "/bookings?redirect=https://example.com",
  ])("rejects unsafe or unknown return targets: %s", (value) => {
    expect(getSafeReturnTo(value)).toBe("/operations");
  });
});
