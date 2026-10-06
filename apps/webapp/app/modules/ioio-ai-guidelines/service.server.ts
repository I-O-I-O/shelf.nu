import type { Prisma } from "@prisma/client";
import { db } from "~/database/db.server";
import { recordEvent } from "~/modules/activity-event/service.server";
import { Logger } from "~/utils/logger";
import { resolveUserDisplayName } from "~/utils/user";
import {
  EMPTY_IOIO_AI_GUIDELINES,
  IOIO_AI_GUIDELINE_SECTIONS,
  type IoioAiGuidelineSections,
} from "./guidelines.shared";

function normalizeSections(value: unknown): IoioAiGuidelineSections {
  const source = value && typeof value === "object" ? value : {};
  return Object.fromEntries(
    IOIO_AI_GUIDELINE_SECTIONS.map(({ key }) => {
      const sectionValue = (source as Record<string, unknown>)[key];
      return [key, typeof sectionValue === "string" ? sectionValue : ""];
    })
  ) as IoioAiGuidelineSections;
}

const sectionSelect = {
  id: true,
  sections: true,
  updatedAt: true,
  updatedBy: {
    select: { displayName: true, firstName: true, lastName: true },
  },
} as const;

export async function getIoioAiGuidelines(organizationId: string) {
  const record = await db.ioioAiGuidelines.findUnique({
    where: { organizationId },
    select: sectionSelect,
  });

  return {
    sections: record
      ? normalizeSections(record.sections)
      : { ...EMPTY_IOIO_AI_GUIDELINES },
    updatedAt: record?.updatedAt.toISOString() ?? null,
    updatedBy: record?.updatedBy
      ? resolveUserDisplayName(record.updatedBy) || null
      : null,
  };
}

/** Optional guidance must never prevent the safeguarded assistant from answering. */
export async function getIoioAiGuidelinesForPrompt(organizationId: string) {
  try {
    return (await getIoioAiGuidelines(organizationId)).sections;
  } catch (cause) {
    const errorName = cause instanceof Error ? cause.name : "UnknownError";
    Logger.warn({
      event: "ioio_ai_guidelines_load_failed",
      error: errorName,
      fallback: "code-owned-safeguards",
    });
    return { ...EMPTY_IOIO_AI_GUIDELINES };
  }
}

export async function saveIoioAiGuidelines({
  organizationId,
  userId,
  sections,
}: {
  organizationId: string;
  userId: string;
  sections: IoioAiGuidelineSections;
}) {
  const jsonSections = sections as Prisma.InputJsonValue;

  await db.$transaction(async (tx) => {
    await tx.ioioAiGuidelines.upsert({
      where: { organizationId },
      create: {
        organizationId,
        sections: jsonSections,
        updatedByUserId: userId,
      },
      update: {
        sections: jsonSections,
        updatedByUserId: userId,
      },
    });

    await recordEvent(
      {
        action: "IOIO_AI_GUIDELINES_UPDATED",
        organizationId,
        actorUserId: userId,
        entityType: "ORGANIZATION",
        entityId: organizationId,
        meta: {
          sectionKeys: IOIO_AI_GUIDELINE_SECTIONS.map(({ key }) => key),
        },
      },
      tx
    );
  });
}
