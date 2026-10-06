import path from "node:path";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import type { db as databaseClient } from "~/database/db.server";
import type { enforceIoioReportRateLimit as rateLimitFunction } from "./rate-limit.server";

const runIntegration = process.env.M12_RUN_INTEGRATION === "1";
let enforceIoioReportRateLimit: typeof rateLimitFunction;
let db: typeof databaseClient;

if (runIntegration) {
  const dotenv = await import("dotenv");
  dotenv.config({
    path: path.resolve(process.cwd(), "../../.env"),
    override: true,
  });
  ({ enforceIoioReportRateLimit } = await import("./rate-limit.server"));
  ({ db } = await import("~/database/db.server"));
}

describe.skipIf(!runIntegration)("Milestone 12 persistent rate limit", () => {
  const userId = "m12-rate-limit-user";
  const organizationId = "m12-rate-limit-org";
  const now = new Date("2030-01-01T00:00:00.000Z");

  beforeAll(async () => {
    await db.ioioRateLimitBucket.deleteMany({
      where: { organizationId, userId: { in: [userId, "*"] } },
    });
  });

  afterAll(async () => {
    await db.ioioRateLimitBucket.deleteMany({
      where: { organizationId, userId: { in: [userId, "*"] } },
    });
    await db.$disconnect();
  });

  it("shares a fixed-window user limit through the database", async () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      await enforceIoioReportRateLimit({ userId, organizationId, now });
    }
    await expect(
      enforceIoioReportRateLimit({ userId, organizationId, now })
    ).rejects.toMatchObject({ status: 429 });

    const buckets = await db.ioioRateLimitBucket.findMany({
      where: { userId, organizationId },
      select: { operationType: true, count: true },
    });
    expect(buckets).toHaveLength(1);
    expect(buckets[0]).toEqual({ operationType: "REPORT_PROBLEM", count: 11 });
  });
});
