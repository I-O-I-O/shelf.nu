export type ReportSubmissionFeedback =
  | { ok: true; message: string }
  | { ok: false; message: string };

export type AssistantActionFeedback = ReportSubmissionFeedback;

type AssistantProposalTokens = {
  borrowProposal?: { confirmationToken?: string } | null;
  returnProposal?: { confirmationToken?: string } | null;
  proposal?: { confirmationToken?: string } | null;
};

export function isSubmittedAssistantMessage(
  answer: AssistantProposalTokens | undefined,
  submittedToken: string | null
) {
  if (!answer || !submittedToken) return false;
  return [
    answer.borrowProposal?.confirmationToken,
    answer.returnProposal?.confirmationToken,
    answer.proposal?.confirmationToken,
  ].includes(submittedToken);
}

/** Resolve one final report outcome from the route's authoritative response. */
export function getReportSubmissionFeedback(
  result: unknown
): Extract<ReportSubmissionFeedback, { ok: false }> | null {
  if (!result || typeof result !== "object" || result instanceof Response) {
    return null;
  }

  if ("ok" in result && result.ok === true) return null;

  if ("error" in result) {
    const error = result.error;
    const message =
      error && typeof error === "object" && "message" in error
        ? error.message
        : error;
    return {
      ok: false,
      message:
        typeof message === "string"
          ? message
          : "The report could not be submitted.",
    };
  }

  return null;
}

/** Read an Ask IOIO write result only after its current navigation completes. */
export function getAssistantActionFeedback(
  result: unknown,
  isSubmitting: boolean
): AssistantActionFeedback | null {
  if (
    isSubmitting ||
    !result ||
    typeof result !== "object" ||
    result instanceof Response
  ) {
    return null;
  }

  if (
    "status" in result &&
    ["submitted", "duplicate", "cancelled"].includes(String(result.status))
  ) {
    const kind = "kind" in result ? result.kind : null;
    const status = result.status;
    const message =
      status === "submitted"
        ? kind === "borrow"
          ? "Your borrow was recorded in Shelf."
          : kind === "return"
          ? "Your return was recorded in Shelf."
          : "Your problem report was submitted for TA review."
        : status === "duplicate"
        ? "Shelf already recorded this action; no duplicate was created."
        : "The proposal was cancelled.";
    return { ok: true, message };
  }

  if ("error" in result) {
    const error = result.error;
    const message =
      error && typeof error === "object" && "message" in error
        ? error.message
        : error;
    return {
      ok: false,
      message:
        typeof message === "string"
          ? message
          : "Shelf could not complete that action.",
    };
  }

  return null;
}
