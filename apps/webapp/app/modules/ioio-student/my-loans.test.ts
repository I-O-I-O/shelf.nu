import { describe, expect, it } from "vitest";
import { splitStudentLoanSections } from "./my-loans";

describe("splitStudentLoanSections", () => {
  it("moves only the exact submitted booking asset into pending returns", () => {
    const loans = [
      {
        id: "booking-1",
        bookingAssets: [{ id: "motor-asset" }, { id: "kit-003" }],
      },
    ];

    const result = splitStudentLoanSections(loans, [
      {
        bookingId: "booking-1",
        bookingAssetId: "kit-003",
      },
    ]);

    expect(result.activeLoans[0]?.bookingAssets).toEqual([
      { id: "motor-asset" },
    ]);
    expect(result.pendingLoanGroups[0]?.bookingAssets).toEqual([
      { id: "kit-003" },
    ]);
  });

  it("does not create a pending section for a successfully completed standalone return", () => {
    const result = splitStudentLoanSections(
      [
        {
          id: "booking-1",
          bookingAssets: [{ id: "motor-asset" }],
        },
      ],
      []
    );

    expect(result.activeLoans).toHaveLength(1);
    expect(result.pendingLoanGroups).toHaveLength(0);
  });

  it("keeps completed loans in the past section", () => {
    const result = splitStudentLoanSections(
      [
        {
          id: "booking-1",
          status: "COMPLETE",
          bookingAssets: [{ id: "motor-asset" }],
        },
      ],
      []
    );

    expect(result.activeLoans).toHaveLength(0);
    expect(result.pendingLoanGroups).toHaveLength(0);
    expect(result.pastLoans).toHaveLength(1);
  });
});
