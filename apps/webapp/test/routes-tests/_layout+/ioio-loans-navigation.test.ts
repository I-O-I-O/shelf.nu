import { describe, expect, it } from "vitest";

import { getMyLoansPath } from "~/modules/ioio-student/my-loans-navigation";

describe("IOIO My Loans navigation", () => {
  it("keeps student loans on the IOIO student workflow", () => {
    expect(getMyLoansPath("student")).toBe("/ioio/loans");
  });

  it("opens staff personal loans in the shared IOIO borrower flow", () => {
    expect(getMyLoansPath("staff")).toBe("/ioio/loans");
  });
});
