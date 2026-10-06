import type { CardAccessRequestStatus } from "@prisma/client";

/**
 * Keep Card Access status values available to the UI without importing Prisma's
 * generated CommonJS enum object into the browser/server module graph.
 */
export const CARD_ACCESS_REQUEST_STATUS = {
  WAITING_FOR_SUBMISSION: "WAITING_FOR_SUBMISSION",
  SUBMITTED: "SUBMITTED",
  APPROVED: "APPROVED",
  NEEDS_ATTENTION: "NEEDS_ATTENTION",
  CANCELLED: "CANCELLED",
} as const satisfies Record<CardAccessRequestStatus, CardAccessRequestStatus>;

export type CardAccessStatus =
  (typeof CARD_ACCESS_REQUEST_STATUS)[keyof typeof CARD_ACCESS_REQUEST_STATUS];
