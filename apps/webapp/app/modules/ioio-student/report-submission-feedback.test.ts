import { describe, expect, it } from "vitest";
import {
  getAssistantActionFeedback,
  getReportSubmissionFeedback,
  isSubmittedAssistantMessage,
} from "./report-submission-feedback";

describe("Student report submission feedback", () => {
  it("does not render a success result inside the Report form", () => {
    expect(getReportSubmissionFeedback({ ok: true })).toBeNull();
  });

  it("shows only the server error when the report failed", () => {
    expect(
      getReportSubmissionFeedback({
        ok: false,
        error: { message: "The report could not be saved." },
      })
    ).toEqual({ ok: false, message: "The report could not be saved." });
  });

  it("does not interpret a successful redirect as an error response", () => {
    expect(
      getReportSubmissionFeedback(
        Response.redirect("http://localhost/ioio/loans?report=submitted")
      )
    ).toBeNull();
  });

  it("does not render success feedback even if a response includes stale error data", () => {
    expect(
      getReportSubmissionFeedback({
        ok: true,
        error: { message: "Stale failure" },
      })
    ).toBeNull();
  });
});

describe("Student Ask action feedback", () => {
  it("keeps only a successful server result after submission completes", () => {
    expect(
      getAssistantActionFeedback({ kind: "report", status: "submitted" }, false)
    ).toEqual({
      ok: true,
      message: "Your problem report was submitted for TA review.",
    });
  });

  it("shows the server error instead of an old success result", () => {
    expect(
      getAssistantActionFeedback(
        { error: { message: "This proposal has expired." } },
        false
      )
    ).toEqual({ ok: false, message: "This proposal has expired." });
  });

  it("suppresses stale feedback while a new proposal is submitting", () => {
    expect(
      getAssistantActionFeedback({ kind: "borrow", status: "submitted" }, true)
    ).toBeNull();
  });

  it("prefers a completed success over stale error fields", () => {
    expect(
      getAssistantActionFeedback(
        {
          kind: "borrow",
          status: "submitted",
          error: { message: "Stale error" },
        },
        false
      )
    ).toEqual({ ok: true, message: "Your borrow was recorded in Shelf." });
  });

  it("does not emit an error from a successful redirect response", () => {
    expect(
      getAssistantActionFeedback(
        Response.redirect("http://localhost/ioio"),
        false
      )
    ).toBeNull();
  });

  it("replaces the matching assistant response with the submission outcome", () => {
    expect(
      isSubmittedAssistantMessage(
        { proposal: { confirmationToken: "current-proposal" } },
        "current-proposal"
      )
    ).toBe(true);
    expect(
      isSubmittedAssistantMessage(
        { proposal: { confirmationToken: "older-proposal" } },
        "current-proposal"
      )
    ).toBe(false);
  });
});
