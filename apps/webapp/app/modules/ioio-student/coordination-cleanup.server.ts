import { db } from "~/database/db.server";
import { IOIO_REPORT_OPERATION } from "./rate-limit.server";

const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_RETENTION_MS = RATE_LIMIT_WINDOW_MS * 2;
const PREPARED_RETENTION_MS = 24 * 60 * 60 * 1000;
const TERMINAL_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Safe, repeatable maintenance for IOIO workflow state. It never removes a
 * PROCESSING operation and keeps successful results for audit/idempotency.
 * Run from the deployment's existing daily maintenance scheduler.
 */
export async function cleanupIoioCoordinationRecords(now = new Date()) {
  const preparedBefore = new Date(now.getTime() - PREPARED_RETENTION_MS);
  const terminalBefore = new Date(now.getTime() - TERMINAL_RETENTION_MS);
  const rateLimitBefore = new Date(now.getTime() - RATE_LIMIT_RETENTION_MS);

  return db.$transaction(async (tx) => {
    const expiredPrepared = await tx.ioioWriteOperation.deleteMany({
      where: {
        operationType: IOIO_REPORT_OPERATION,
        status: { in: ["PREPARED", "CANCELLED", "FAILED"] },
        createdAt: { lt: preparedBefore },
      },
    });
    const oldTerminal = await tx.ioioWriteOperation.deleteMany({
      where: {
        operationType: IOIO_REPORT_OPERATION,
        status: { in: ["SUCCEEDED", "RESOLVED"] },
        createdAt: { lt: terminalBefore },
      },
    });
    const oldBuckets = await tx.ioioRateLimitBucket.deleteMany({
      where: {
        operationType: IOIO_REPORT_OPERATION,
        windowStartedAt: { lt: rateLimitBefore },
      },
    });

    return {
      expiredPrepared: expiredPrepared.count,
      oldTerminal: oldTerminal.count,
      oldBuckets: oldBuckets.count,
    };
  });
}

export const IOIO_COORDINATION_RETENTION = {
  preparedDays: 1,
  terminalDays: 90,
  rateLimitWindows: 2,
} as const;
