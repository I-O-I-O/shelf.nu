import path from "node:path";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import type { db as databaseClient } from "~/database/db.server";
import type { reportProblem as reportProblemHandler } from "./report-problem.server";

const phase = process.env.M13_RESTART_PHASE;
const runIntegration = phase === "first" || phase === "second";
const operationId = "m13_process_restart";
const token = "00000000-0000-4000-8000-000000000013";

const auth = vi.hoisted(() => ({
  userId: "",
  organizationId: "",
  role: "SELF_SERVICE",
}));

vi.mock("./route.server", () => ({
  requireStudentRead: vi.fn(() => auth),
}));
vi.mock("./rate-limit.server", () => ({
  IOIO_REPORT_OPERATION: "REPORT_PROBLEM",
  // why: this test isolates persisted replay state; the rate-limit integration
  // test covers quota state separately.
  enforceIoioReportRateLimit: vi.fn(() => undefined),
}));

let db: typeof databaseClient;
let reportProblem: typeof reportProblemHandler;

if (runIntegration) {
  const dotenv = await import("dotenv");
  dotenv.config({
    path: path.resolve(process.cwd(), "../../.env"),
    override: true,
  });
  ({ db } = await import("~/database/db.server"));
  ({ reportProblem } = await import("./report-problem.server"));
}

describe.skipIf(!runIntegration)(
  "Milestone 13 application-process restart idempotency",
  () => {
    let reportId: string | undefined;

    beforeAll(async () => {
      const membership = await db.userOrganization.findFirst({
        where: { roles: { has: "SELF_SERVICE" } },
        select: { userId: true, organizationId: true },
      });
      if (!membership) throw new Error("No SELF_SERVICE integration fixture");
      auth.userId = membership.userId;
      auth.organizationId = membership.organizationId;

      if (phase === "first") {
        const oldOperation = await db.ioioWriteOperation.findFirst({
          where: { id: operationId, organizationId: auth.organizationId },
          select: { resultReportId: true },
        });
        if (oldOperation?.resultReportId) {
          await db.reportFound.deleteMany({
            where: { id: oldOperation.resultReportId },
          });
        }
        await db.ioioWriteOperation.deleteMany({
          where: { id: operationId, organizationId: auth.organizationId },
        });
        await db.ioioWriteOperation.create({
          data: {
            id: operationId,
            operationType: "REPORT_PROBLEM",
            status: "PREPARED",
            idempotencyKey: token,
            userId: auth.userId,
            organizationId: auth.organizationId,
            reportType: "ITEM_DAMAGED",
            description: "Milestone 13 process restart test",
          },
        });
      }
    });

    afterAll(async () => {
      if (phase === "second") {
        if (reportId) {
          await db.reportFound.deleteMany({ where: { id: reportId } });
        }
        await db.ioioWriteOperation.deleteMany({
          where: { id: operationId, organizationId: auth.organizationId },
        });
      }
      await db.$disconnect();
    });

    it("submits once in the first process and replays in the second", async () => {
      const result = await reportProblem(
        {
          confirmationToken: token,
          reportType: "ITEM_DAMAGED",
          description: "Milestone 13 process restart test",
        },
        { context: {}, request: new Request("http://localhost/ioio/ask") }
      );

      if (phase === "first") {
        expect(result.status).toBe("submitted");
        if (result.status === "submitted") {
          expect(
            await db.ioioWriteOperation.findFirst({
              where: { id: operationId, organizationId: auth.organizationId },
              select: { status: true, resultReportId: true },
            })
          ).toMatchObject({ status: "SUCCEEDED" });
        }
      } else {
        expect(result.status).toBe("duplicate");
        if (result.status !== "duplicate" || !result.reportId) return;
        reportId = result.reportId;
        expect(
          await db.reportFound.count({
            where: {
              id: reportId,
              content: { contains: operationId },
            },
          })
        ).toBe(1);
      }
    });
  }
);
