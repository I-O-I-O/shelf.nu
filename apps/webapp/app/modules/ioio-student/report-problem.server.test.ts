import { describe, expect, it } from "vitest";
import {
  IOIO_REPORT_TYPES,
  reportProposalSchema,
  sanitizeReportText,
} from "./report-problem.shared";

describe("IOIO problem report safety", () => {
  it("accepts only the fixed report vocabulary", () => {
    expect(IOIO_REPORT_TYPES).toEqual([
      "ITEM_MISSING",
      "ITEM_DAMAGED",
      "ITEM_NOT_WORKING",
      "PART_MISSING",
      "WRONG_LOCATION",
      "LOCATION_FULL",
      "CANNOT_FIND",
      "KIT_INCOMPLETE",
      "OTHER",
    ]);
    expect(
      reportProposalSchema.safeParse({
        report_type: "BORROW_ITEM",
        description: "Please borrow this item",
      }).success
    ).toBe(false);
  });

  it("redacts contact data and control characters from descriptions", () => {
    expect(
      sanitizeReportText(
        "Broken item\ncontact student@example.edu or +45 12 34 56 78\u0000"
      )
    ).toBe("Broken item contact [redacted email] or [redacted contact]");
  });
});
