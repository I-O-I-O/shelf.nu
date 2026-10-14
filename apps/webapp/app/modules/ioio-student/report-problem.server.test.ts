import { describe, expect, it } from "vitest";
import {
  IOIO_REPORT_TYPES,
  IOIO_REPORT_ACKNOWLEDGEMENTS,
  IOIO_REPORTED_UNIT_LOCKING_REPORT_TYPES,
  isIoioPhysicalUnitBlockingReport,
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
      "FOUND_SOMETHING",
      "OTHER",
    ]);
    expect(
      reportProposalSchema.safeParse({
        report_type: "BORROW_ITEM",
        description: "Please borrow this item",
      }).success
    ).toBe(false);
  });

  it("maps the persisted report types to one Student acknowledgement", () => {
    expect(IOIO_REPORT_ACKNOWLEDGEMENTS.ITEM_DAMAGED).toBe(
      "Thanks for reporting the damaged item. Staff will review it."
    );
    expect(IOIO_REPORT_ACKNOWLEDGEMENTS.WRONG_LOCATION).toBe(
      "Thanks for reporting the location issue. Staff will review it."
    );
    expect(IOIO_REPORT_ACKNOWLEDGEMENTS.FOUND_SOMETHING).toBe(
      "Thanks for letting Staff know."
    );
  });

  it("redacts contact data and control characters from descriptions", () => {
    expect(
      sanitizeReportText(
        "Broken item\ncontact student@example.edu or +45 12 34 56 78\u0000"
      )
    ).toBe("Broken item contact [redacted email] or [redacted contact]");
  });

  it("blocks exact units for physical safety reports but not location reports", () => {
    for (const reportType of [
      "ITEM_MISSING",
      "ITEM_DAMAGED",
      "ITEM_NOT_WORKING",
      "PART_MISSING",
      "KIT_INCOMPLETE",
    ]) {
      expect(isIoioPhysicalUnitBlockingReport(reportType)).toBe(true);
    }
    for (const reportType of [
      "WRONG_LOCATION",
      "LOCATION_FULL",
      "CANNOT_FIND",
      "OTHER",
      null,
    ]) {
      expect(isIoioPhysicalUnitBlockingReport(reportType)).toBe(false);
    }
  });

  it("marks only unresolved item-specific reports as report-locked", () => {
    expect([...IOIO_REPORTED_UNIT_LOCKING_REPORT_TYPES].sort()).toEqual(
      [
        "CANNOT_FIND",
        "ITEM_DAMAGED",
        "ITEM_MISSING",
        "ITEM_NOT_WORKING",
        "KIT_INCOMPLETE",
        "PART_MISSING",
      ].sort()
    );
    expect(IOIO_REPORTED_UNIT_LOCKING_REPORT_TYPES.has("WRONG_LOCATION")).toBe(
      false
    );
    expect(IOIO_REPORTED_UNIT_LOCKING_REPORT_TYPES.has("LOCATION_FULL")).toBe(
      false
    );
    expect(IOIO_REPORTED_UNIT_LOCKING_REPORT_TYPES.has("OTHER")).toBe(false);
  });
});
