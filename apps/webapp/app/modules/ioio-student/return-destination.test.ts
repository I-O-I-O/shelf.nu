import { describe, expect, it } from "vitest";
import {
  requiresStaffReturnCheck,
  resolveReturnDestination,
  RETURN_HANDLING,
} from "./return-destination";

describe("IOIO return destination policy", () => {
  it("completes a working storage return immediately", () => {
    expect(
      resolveReturnDestination({
        hasProblem: false,
        returnHandling: RETURN_HANDLING.STORAGE,
      })
    ).toBe("STORAGE");
    expect(
      requiresStaffReturnCheck({
        hasProblem: false,
        returnHandling: RETURN_HANDLING.STORAGE,
      })
    ).toBe(false);
  });

  it("sends a configured return-zone item to staff check", () => {
    expect(
      resolveReturnDestination({
        hasProblem: false,
        returnHandling: RETURN_HANDLING.RETURN_ZONE,
      })
    ).toBe("RETURN_ZONE");
    expect(
      requiresStaffReturnCheck({
        hasProblem: false,
        returnHandling: RETURN_HANDLING.RETURN_ZONE,
      })
    ).toBe(true);
  });

  it("always routes a problem to the Broken Zone", () => {
    for (const returnHandling of Object.values(RETURN_HANDLING)) {
      expect(
        resolveReturnDestination({ hasProblem: true, returnHandling })
      ).toBe("BROKEN_ZONE");
      expect(
        requiresStaffReturnCheck({ hasProblem: true, returnHandling })
      ).toBe(true);
    }
  });
});
