import { submitHandbookObservation } from "~/modules/ioio-handbook/service.server";
import { Logger } from "~/utils/logger";
import type { IoioConversationMessage } from "./conversation.shared";
import {
  getHandbookContributionSource,
  getHandbookContributionTitle,
} from "./request-routing.shared";

export type HandbookAskOutcome =
  | "pending_observation"
  | "duplicate"
  | "clarification"
  | "storage_unavailable";

export async function submitAskIoioKnowledge({
  organizationId,
  userId,
  question,
  history,
  intent,
  audience = "student",
  requestId,
}: {
  organizationId: string;
  userId: string;
  question: string;
  history: readonly IoioConversationMessage[];
  intent: "knowledge_contribution" | "handbook_update";
  audience?: "student" | "staff";
  requestId?: string;
}) {
  const content = getHandbookContributionSource(question, history, intent);
  if (content.length < 20) {
    return {
      outcome: "clarification" as const,
      relatedCount: 0,
      answer:
        "What specific information should I send to Staff for Handbook review? Nothing has been saved yet.",
    };
  }

  try {
    const result = await submitHandbookObservation({
      organizationId,
      userId,
      title: getHandbookContributionTitle(content),
      content,
    });
    if (result.duplicate) {
      return {
        outcome: "duplicate" as const,
        relatedCount: result.related.length,
        answer:
          result.duplicateKind === "article"
            ? `This matches existing published Handbook material, “${result.duplicateTitle}”. I did not create a duplicate contribution.`
            : `This contribution is already recorded as “${result.duplicateTitle}”. I did not create a duplicate.`,
      };
    }
    const relatedTitles = result.related
      .slice(0, 3)
      .map(({ title }) => `“${title}”`)
      .join(", ");
    const prefix =
      audience === "staff"
        ? "Saved as an unpublished Handbook note for you to review."
        : "Saved as a pending Handbook contribution for Staff review.";
    const relatedCopy = relatedTitles
      ? ` Related existing knowledge: ${relatedTitles}.`
      : "";
    return {
      outcome: "pending_observation" as const,
      relatedCount: result.related.length,
      answer: `${prefix}${relatedCopy} It has not changed the published Handbook.`,
    };
  } catch (cause) {
    const errorName = cause instanceof Error ? cause.name : "UnknownError";
    const errorRecord =
      cause && typeof cause === "object"
        ? (cause as { code?: unknown; message?: unknown; stack?: unknown })
        : null;
    Logger.warn({
      event: "ioio_handbook_contribution_failed",
      requestId,
      audience,
      errorName,
      ...(typeof errorRecord?.code === "string"
        ? { prismaCode: errorRecord.code }
        : {}),
      ...(process.env.NODE_ENV !== "production"
        ? {
            message:
              typeof errorRecord?.message === "string"
                ? errorRecord.message.slice(0, 240)
                : undefined,
            stack:
              typeof errorRecord?.stack === "string"
                ? errorRecord.stack.split("\n").slice(0, 8).join("\n")
                : undefined,
          }
        : {}),
    });
    return {
      outcome: "storage_unavailable" as const,
      relatedCount: 0,
      answer:
        "I couldn't save this Handbook contribution. Nothing was saved or published. Please try again or use the Handbook contribution page.",
    };
  }
}
