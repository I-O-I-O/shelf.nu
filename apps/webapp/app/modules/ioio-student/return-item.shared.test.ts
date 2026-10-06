import { describe, expect, it } from "vitest";
import { getStudentReturnIssueComment } from "./return-item.shared";

describe("getStudentReturnIssueComment", () => {
  it("extracts the complete issue note after a submitted return", () => {
    expect(
      getStudentReturnIssueComment(
        "Return submitted. Issue reported: ITEM_DAMAGED. Motor cable is loose."
      )
    ).toBe("Motor cable is loose.");
  });

  it("preserves a one-character issue note", () => {
    expect(
      getStudentReturnIssueComment(
        "Return submitted. Issue reported: ITEM_DAMAGED. m"
      )
    ).toBe("m");
  });

  it("does not treat normal return status copy as an issue note", () => {
    expect(
      getStudentReturnIssueComment("Return submitted. Waiting for staff check.")
    ).toBeNull();
    expect(getStudentReturnIssueComment("Return submitted.")).toBeNull();
  });
});
