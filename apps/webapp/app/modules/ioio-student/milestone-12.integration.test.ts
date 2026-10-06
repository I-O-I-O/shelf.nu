import { randomUUID } from "node:crypto";
import path from "node:path";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import type { db as databaseClient } from "~/database/db.server";
import type { reportProblem as reportProblemHandler } from "./report-problem.server";

const runIntegration = process.env.M12_RUN_INTEGRATION === "1";

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
  // why: this test isolates durable idempotency and removes quota state from
  // the database so cleanup cannot affect the local developer rate window.
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
  "Milestone 12 local database integration",
  () => {
    let operationId = "";
    let token = "";
    let reportId: string | undefined;

    beforeAll(async () => {
      const membership = await db.userOrganization.findFirst({
        where: { roles: { has: "SELF_SERVICE" } },
        select: { userId: true, organizationId: true },
      });
      if (!membership)
        throw new Error("No SELF_SERVICE integration fixture found");
      auth.userId = membership.userId;
      auth.organizationId = membership.organizationId;

      operationId = `m12_integration_${Date.now()}`;
      token = randomUUID();
      await db.ioioWriteOperation.create({
        data: {
          id: operationId,
          operationType: "REPORT_PROBLEM",
          status: "PREPARED",
          idempotencyKey: token,
          userId: auth.userId,
          organizationId: auth.organizationId,
          reportType: "ITEM_DAMAGED",
          description: "Milestone 12 integration duplicate test",
        },
      });
    });

    afterAll(async () => {
      if (reportId) {
        await db.reportFound.deleteMany({ where: { id: reportId } });
      }
      if (operationId) {
        await db.ioioWriteOperation.deleteMany({
          where: { id: operationId, organizationId: auth.organizationId },
        });
      }
      await db.$disconnect();
    });

    it("creates one native report for two identical submissions", async () => {
      const first = await reportProblem(
        {
          confirmationToken: token,
          reportType: "ITEM_DAMAGED",
          description: "Milestone 12 integration duplicate test",
        },
        { context: {}, request: new Request("http://localhost/ioio/ask") }
      );
      expect(first.status).toBe("submitted");
      if (first.status !== "submitted") return;
      reportId = first.reportId;

      // The operation and result are durable; reconnect the Prisma client before
      // replaying the same request to model a restarted web process.
      await db.$disconnect();

      const second = await reportProblem(
        {
          confirmationToken: token,
          reportType: "ITEM_DAMAGED",
          description: "Milestone 12 integration duplicate test",
        },
        { context: {}, request: new Request("http://localhost/ioio/ask") }
      );
      expect(second).toEqual({ ok: true, status: "duplicate", reportId });
      expect(
        await db.reportFound.count({
          where: { id: reportId, content: { contains: operationId } },
        })
      ).toBe(1);
      expect(
        await db.ioioWriteOperation.findFirst({
          where: { id: operationId, organizationId: auth.organizationId },
          select: { status: true, resultReportId: true },
        })
      ).toEqual({ status: "SUCCEEDED", resultReportId: reportId });
    });
  }
);
