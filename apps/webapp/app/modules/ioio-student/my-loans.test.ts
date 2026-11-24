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

  it("orders past loans by their latest return while preserving current loan order", () => {
    const loans = [
      { id: "current-old", status: "ONGOING", bookingAssets: [{ id: "a" }] },
      {
        id: "oct-04",
        status: "COMPLETE",
        bookingAssets: [{ id: "b", returnedAt: "2026-10-04" }],
      },
      {
        id: "oct-21",
        status: "COMPLETE",
        bookingAssets: [{ id: "c", returnedAt: "2026-10-21" }],
      },
      { id: "current-new", status: "ONGOING", bookingAssets: [{ id: "d" }] },
      {
        id: "oct-18",
        status: "COMPLETE",
        bookingAssets: [{ id: "e", returnedAt: "2026-10-18" }],
      },
    ];
    const result = splitStudentLoanSections(loans, []);
    expect(result.pastLoans.map((loan) => loan.id)).toEqual([
      "oct-21",
      "oct-18",
      "oct-04",
    ]);
    expect(result.activeLoans.map((loan) => loan.id)).toEqual([
      "current-old",
      "current-new",
    ]);
  });

  it("falls back to checkout date and then stable id when return timestamps are missing", () => {
    const loans = [
      {
        id: "a",
        status: "COMPLETE",
        bookingAssets: [{ id: "a-asset", checkedOutAt: "2026-10-01" }],
      },
      {
        id: "c",
        status: "COMPLETE",
        bookingAssets: [{ id: "c-asset", checkedOutAt: "2026-10-05" }],
      },
      {
        id: "b",
        status: "COMPLETE",
        bookingAssets: [{ id: "b-asset", checkedOutAt: "2026-10-05" }],
      },
    ];
    expect(
      splitStudentLoanSections(loans, []).pastLoans.map((loan) => loan.id)
    ).toEqual(["c", "b", "a"]);
  });
});
