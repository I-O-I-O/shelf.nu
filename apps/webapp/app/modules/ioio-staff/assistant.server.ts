import type { LoaderFunctionArgs } from "react-router";
import { db } from "~/database/db.server";
import { answerInventoryAssistant } from "~/modules/ioio-student/assistant.server";
import type {
  IoioConversationMessage,
  IoioEntityContext,
} from "~/modules/ioio-student/conversation.shared";
import { classifyAskIoioRequest } from "~/modules/ioio-student/request-routing.shared";
import { Logger } from "~/utils/logger";
import { requireIoioStaffAccess } from "./access.server";
import { getLabStatus } from "./lab-status.server";

type StaffAssistantContext = Pick<LoaderFunctionArgs, "context" | "request">;

const SENSITIVE_IDENTITY_PATTERN =
  /\b(who|which person|whose|borrower|student)\b.*\b(has|have|borrowed|holds|using|name|email)/i;

const INVENTORY_CHANGE_PATTERN =
  /\b(?:import|update|delete|change|edit)\b[\s\S]{0,80}\b(?:inventory|asset|item|kit|quantity|stock)\b/i;
const PROCUREMENT_DOCUMENT_PATTERN =
  /\b(invoice|purchase order|order confirmation|mouser|digikey|farnell|rs components?)\b/i;
const SECRET_PATTERN =
  /\b(database|connection string|password|api key|secret|token|sql|credential)s?\b/i;

function cleanQuestion(value: string) {
  return value.trim().slice(0, 500);
}

async function answerOperationalQuestion({
  organizationId,
  question,
}: {
  organizationId: string;
  question: string;
}) {
  if (
    /\b(lab status|status|alerts?|issues?|needs attention)\b/i.test(question)
  ) {
    const status = await getLabStatus({ organizationId });
    if (!status.totalIssues) return "The lab has no current issues.";
    const summary = [
      { label: "operational reports", count: status.unresolvedReports },
      { label: "incomplete kits", count: status.incompleteKits },
      { label: "overdue loans", count: status.overdueLoans },
      { label: "out-of-stock items", count: status.outOfStock },
      { label: "low-stock items", count: status.lowStock },
      { label: "import warnings", count: status.importWarnings },
    ]
      .filter((item) => item.count > 0)
      .map((item) => String(item.count) + " " + item.label)
      .join(", ");
    return (
      "The lab has " +
      status.totalIssues +
      " current issue" +
      (status.totalIssues === 1 ? "" : "s") +
      ": " +
      summary +
      "."
    );
  }

  if (/\b(report|reports)\b/i.test(question)) {
    const status = await getLabStatus({ organizationId });
    const count = status.unresolvedReports + status.incompleteKits;
    return `There are ${count} submitted operational report${
      count === 1 ? "" : "s"
    } in the staff review queue.`;
  }

  if (/\b(overdue|late)\b/i.test(question)) {
    const count = (await getLabStatus({ organizationId })).overdueLoans;
    return `There ${count === 1 ? "is" : "are"} ${count} overdue booking${
      count === 1 ? "" : "s"
    }.`;
  }

  if (
    /\b(?:active loans?|loans? (?:are )?active|ongoing loans?|currently borrowed|what do we have borrowed)\b/i.test(
      question
    )
  ) {
    const count = await db.booking.count({
      where: { organizationId, status: "ONGOING" },
    });
    return `There ${count === 1 ? "is" : "are"} ${count} active loan${
      count === 1 ? "" : "s"
    }.`;
  }

  return null;
}

/**
 * Staff-only read assistant. It reuses the existing provider-neutral Shelf
 * read tools and provider selection for general questions, while keeping all
 * write actions in the separate review/apply workflow.
 */
export async function answerStaffAssistant({
  context,
  request,
  question,
  history = [],
  entityContext = {},
}: StaffAssistantContext & {
  question: string;
  history?: readonly IoioConversationMessage[];
  entityContext?: IoioEntityContext;
}) {
  const { organizationId, userId } = await requireIoioStaffAccess({
    context,
    request,
  });
  const normalizedQuestion = cleanQuestion(question);
  if (!normalizedQuestion) {
    return {
      answer:
        "Ask me about inventory, locations, loans, reports, or a file to review.",
      provider: "deterministic-shelf",
      toolsUsed: [],
      assets: [],
      entityContext,
    };
  }

  if (SENSITIVE_IDENTITY_PATTERN.test(normalizedQuestion)) {
    return {
      answer:
        "I can show the item or loan status, but I won't disclose another borrower's identity.",
      provider: "policy",
      toolsUsed: [],
      assets: [],
      entityContext,
    };
  }

  if (SECRET_PATTERN.test(normalizedQuestion)) {
    return {
      answer:
        "I cannot provide database credentials, secrets, tokens, SQL, or other internal access details.",
      provider: "policy",
      toolsUsed: [],
      assets: [],
      entityContext,
    };
  }

  const isSupportedLoanAction =
    classifyAskIoioRequest(normalizedQuestion).intent === "action_request" &&
    /\b(?:borrow|check\s*out|return|check\s*in|report|log|flag)\b/i.test(
      normalizedQuestion
    );
  const operationalAnswer = isSupportedLoanAction
    ? null
    : await answerOperationalQuestion({
        organizationId,
        question: normalizedQuestion,
      });
  if (operationalAnswer) {
    Logger.info({
      event: "ioio_staff_assistant",
      provider: "deterministic-shelf",
      model: "shelf-operational-read",
      userId,
      organizationId,
      success: true,
      toolsUsed: [],
    });
    return {
      answer: operationalAnswer,
      provider: "deterministic-shelf",
      toolsUsed: [],
      assets: [],
      entityContext,
    };
  }

  if (INVENTORY_CHANGE_PATTERN.test(normalizedQuestion)) {
    return {
      answer:
        "I can prepare an inventory change proposal from an uploaded CSV, XLSX, or PDF file. Borrow, return, and problem-report actions still use their existing Shelf workflows.",
      provider: "policy",
      toolsUsed: [],
      assets: [],
      entityContext,
    };
  }

  if (PROCUREMENT_DOCUMENT_PATTERN.test(normalizedQuestion)) {
    return {
      answer:
        "Upload the supplier PDF, CSV, or Excel file and I will extract possible inventory changes for staff review. Nothing will change until approved.",
      provider: "policy",
      toolsUsed: [],
      assets: [],
      entityContext,
    };
  }

  const result = await answerInventoryAssistant({
    context,
    request,
    question: normalizedQuestion,
    history,
    entityContext,
    audience: "staff",
  });
  Logger.info({
    event: "ioio_staff_assistant",
    provider: result.mode,
    model: result.providerModel ?? "deterministic-shelf",
    userId,
    organizationId,
    success: true,
    toolsUsed: result.toolsUsed,
  });
  return result;
}
