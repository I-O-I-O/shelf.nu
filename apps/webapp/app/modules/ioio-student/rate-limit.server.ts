import { db } from "~/database/db.server";
import { ShelfError } from "~/utils/error";

export const IOIO_REPORT_OPERATION = "REPORT_PROBLEM";
export const IOIO_BORROW_OPERATION = "BORROW_ITEM";
export const IOIO_RETURN_OPERATION = "RETURN_ITEM";
const WINDOW_MS = 10 * 60 * 1000;
const REPORT_USER_LIMIT = 10;
const REPORT_ORGANIZATION_LIMIT = 100;
const BORROW_USER_LIMIT = 5;
const BORROW_ORGANIZATION_LIMIT = 100;
const RETURN_USER_LIMIT = 5;
const RETURN_ORGANIZATION_LIMIT = 100;

function rateLimitError(operationType: string, retryAfterSec: number) {
  return new ShelfError({
    cause: null,
    message:
      operationType === IOIO_BORROW_OPERATION
        ? "Too many borrow attempts. Please try again later."
        : operationType === IOIO_RETURN_OPERATION
        ? "Too many return attempts. Please try again later."
        : "Too many problem reports. Please try again later.",
    additionalData: { operationType, retryAfterSec },
    label: "Auth",
    status: 429,
    shouldBeCaptured: false,
  });
}

async function incrementBucket({
  key,
  userId,
  organizationId,
  operationType,
  windowStartedAt,
  windowEndMs,
  limit,
}: {
  key: string;
  userId: string;
  organizationId: string;
  operationType: string;
  windowStartedAt: Date;
  windowEndMs: number;
  limit: number;
}) {
  // Prisma's upsert maps to a database-native unique-key upsert. The count
  // increment is therefore shared across app processes and concurrent calls.
  const bucket = await db.ioioRateLimitBucket.upsert({
    where: { key },
    create: {
      key,
      operationType,
      userId,
      organizationId,
      windowStartedAt,
      count: 1,
    },
    update: { count: { increment: 1 } },
    select: { count: true },
  });

  if (bucket.count > limit) {
    throw rateLimitError(
      operationType,
      Math.max(1, Math.ceil((windowEndMs - Date.now()) / 1000))
    );
  }
}

async function enforceIoioRateLimit({
  userId,
  organizationId,
  operationType,
  userLimit,
  organizationLimit,
  now = new Date(),
}: {
  userId: string;
  organizationId: string;
  operationType: string;
  userLimit: number;
  organizationLimit: number;
  now?: Date;
}) {
  const windowStartMs = Math.floor(now.getTime() / WINDOW_MS) * WINDOW_MS;
  const windowStartedAt = new Date(windowStartMs);
  const windowEndMs = windowStartMs + WINDOW_MS;

  await incrementBucket({
    key: `ioio:${operationType}:user:${organizationId}:${userId}:${windowStartMs}`,
    operationType,
    userId,
    organizationId,
    windowStartedAt,
    windowEndMs,
    limit: userLimit,
  });

  await incrementBucket({
    key: `ioio:${operationType}:organization:${organizationId}:${windowStartMs}`,
    operationType,
    userId: "*",
    organizationId,
    windowStartedAt,
    windowEndMs,
    limit: organizationLimit,
  });
}

export function enforceIoioReportRateLimit(args: {
  userId: string;
  organizationId: string;
  now?: Date;
}) {
  return enforceIoioRateLimit({
    ...args,
    operationType: IOIO_REPORT_OPERATION,
    userLimit: REPORT_USER_LIMIT,
    organizationLimit: REPORT_ORGANIZATION_LIMIT,
  });
}

export function enforceIoioBorrowRateLimit(args: {
  userId: string;
  organizationId: string;
  now?: Date;
}) {
  return enforceIoioRateLimit({
    ...args,
    operationType: IOIO_BORROW_OPERATION,
    userLimit: BORROW_USER_LIMIT,
    organizationLimit: BORROW_ORGANIZATION_LIMIT,
  });
}

export function enforceIoioReturnRateLimit(args: {
  userId: string;
  organizationId: string;
  now?: Date;
}) {
  return enforceIoioRateLimit({
    ...args,
    operationType: IOIO_RETURN_OPERATION,
    userLimit: RETURN_USER_LIMIT,
    organizationLimit: RETURN_ORGANIZATION_LIMIT,
  });
}
