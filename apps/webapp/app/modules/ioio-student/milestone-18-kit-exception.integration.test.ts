// @vitest-environment node

import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { db as dbExport } from "~/database/db.server";
import type {
  checkinBooking as checkinBookingExport,
  checkoutBooking as checkoutBookingExport,
  createBooking as createBookingExport,
} from "~/modules/booking/service.server";
import type { getMyStudentLoans as getMyStudentLoansExport } from "~/modules/ioio-student/service.server";
import type { init as initSchedulerExport } from "~/utils/scheduler.server";
import type {
  prepareReportProblem as prepareReportProblemExport,
  reportProblem as reportProblemExport,
} from "./report-problem.server";

const runIntegration = process.env.M18_KIT_EXCEPTION_RUN_INTEGRATION === "1";

const auth = vi.hoisted(() => ({
  userId: "",
  organizationId: "",
  role: "SELF_SERVICE",
}));

vi.mock("./route.server", () => ({
  requireStudentRead: vi.fn(() => auth),
}));

let db: typeof dbExport;
let checkinBooking: typeof checkinBookingExport;
let checkoutBooking: typeof checkoutBookingExport;
let createBooking: typeof createBookingExport;
let getMyStudentLoans: typeof getMyStudentLoansExport;
let initScheduler: typeof initSchedulerExport;
let prepareReportProblem: typeof prepareReportProblemExport;
let reportProblem: typeof reportProblemExport;

if (runIntegration) {
  const dotenv = await import("dotenv");
  dotenv.config({
    path: path.resolve(process.cwd(), "../../.env"),
    override: true,
  });
  ({ db } = await import("~/database/db.server"));
  ({ checkinBooking, checkoutBooking, createBooking } = await import(
    "~/modules/booking/service.server"
  ));
  ({ getMyStudentLoans } = await import(
    "~/modules/ioio-student/service.server"
  ));
  ({ init: initScheduler } = await import("~/utils/scheduler.server"));
  ({ prepareReportProblem, reportProblem } = await import(
    "./report-problem.server"
  ));
}

describe.skipIf(!runIntegration)(
  "Milestone 18 kit return exception workflow",
  () => {
    let organizationId = "";
    let userId = "";
    let teamMemberId = "";
    let kitId = "";
    let assetId = "";
    let bookingId = "";
    let operationId = "";
    let reportId = "";
    let startedAt: Date;

    beforeAll(async () => {
      startedAt = new Date();
      const membership = await db.userOrganization.findFirst({
        where: { roles: { has: "SELF_SERVICE" } },
        select: { userId: true, organizationId: true },
      });
      if (!membership) throw new Error("No SELF_SERVICE integration fixture");
      organizationId = membership.organizationId;
      userId = membership.userId;
      auth.organizationId = organizationId;
      auth.userId = userId;

      const [teamMember, kit] = await Promise.all([
        db.teamMember.findFirst({
          where: { organizationId, userId, deletedAt: null },
          select: { id: true },
        }),
        db.kit.findFirst({
          where: { organizationId, name: "Arduino Kit #014" },
          select: { id: true },
        }),
      ]);
      if (!teamMember) throw new Error("No SELF_SERVICE team-member fixture");
      if (!kit) throw new Error("Arduino Kit #014 fixture not found");
      teamMemberId = teamMember.id;
      kitId = kit.id;

      const member = await db.assetKit.findFirst({
        where: { organizationId, kitId },
        select: { assetId: true },
      });
      if (!member) throw new Error("Arduino Kit #014 has no member fixture");
      assetId = member.assetId;
      await initScheduler();

      // Clean only the uniquely named fixture left behind if a prior gated run
      // stopped after writing but before its assertions completed.
      await db.reportFound.deleteMany({
        where: {
          kitId,
          content: { contains: "One sensor is missing from the returned kit." },
        },
      });
      await db.ioioWriteOperation.deleteMany({
        where: {
          organizationId,
          userId,
          kitId,
          operationType: "REPORT_PROBLEM",
          reportType: "KIT_INCOMPLETE",
          description: "One sensor is missing from the returned kit.",
        },
      });
      const staleBookings = await db.booking.findMany({
        where: {
          organizationId,
          creatorId: userId,
          name: "Milestone 18 kit exception (temporary)",
          description: "Temporary exception validation booking.",
        },
        select: { id: true, status: true },
      });
      for (const staleBooking of staleBookings) {
        if (["ONGOING", "OVERDUE"].includes(staleBooking.status)) {
          await checkinBooking({
            id: staleBooking.id,
            organizationId,
            userId,
            hints: { locale: "en-US", timeZone: "UTC" },
          });
        }
        await db.booking.deleteMany({
          where: { id: staleBooking.id, organizationId },
        });
      }
    });

    afterAll(async () => {
      if (reportId) {
        await db.reportFound.deleteMany({
          where: { id: reportId },
        });
      }
      if (operationId) {
        await db.ioioWriteOperation.deleteMany({
          where: { id: operationId, organizationId },
        });
      }
      if (bookingId) {
        const booking = await db.booking.findUnique({
          where: { id: bookingId, organizationId },
          select: { id: true, status: true },
        });
        if (booking && ["ONGOING", "OVERDUE"].includes(booking.status)) {
          await checkinBooking({
            id: booking.id,
            organizationId,
            userId,
            hints: { locale: "en-US", timeZone: "UTC" },
          });
        }
        await db.booking.deleteMany({
          where: { id: bookingId, organizationId },
        });
      }
      await db.ioioRateLimitBucket.deleteMany({
        where: {
          organizationId,
          userId: { in: [userId, "*"] },
          operationType: "REPORT_PROBLEM",
          createdAt: { gte: startedAt },
        },
      });
      await db.$disconnect();
    });

    it("reports an incomplete kit without completing its booking", async () => {
      const from = new Date(Date.now() + 2 * 60_000);
      const to = new Date(Date.now() + 24 * 60 * 60_000);
      const hints = { locale: "en-US", timeZone: "UTC" };
      const slices = await (
        await import("~/modules/booking/service.server")
      ).buildKitSlicesForBooking({
        kitIds: [kitId],
        organizationId,
      });
      const booking = await createBooking({
        booking: {
          name: "Milestone 18 kit exception (temporary)",
          description: "Temporary exception validation booking.",
          creatorId: userId,
          custodianUserId: userId,
          custodianTeamMemberId: teamMemberId,
          organizationId,
          from,
          to,
          tags: [],
        },
        assetIds: [],
        kitSlices: slices,
        hints,
      });
      bookingId = booking.id;

      await checkoutBooking({
        id: bookingId,
        organizationId,
        userId,
        hints,
      });

      const proposal = await prepareReportProblem(
        {
          report_type: "KIT_INCOMPLETE",
          kit_id: kitId,
          description: "One sensor is missing from the returned kit.",
        },
        { context: {}, request: new Request("http://localhost/ioio/ask") }
      );
      const operation = await db.ioioWriteOperation.findUnique({
        where: { idempotencyKey: proposal.confirmationToken },
        select: { id: true, status: true, reportType: true, kitId: true },
      });
      operationId = operation?.id ?? "";
      expect(proposal).toMatchObject({
        reportType: "KIT_INCOMPLETE",
        kit: { id: kitId, name: "Arduino Kit #014" },
      });
      expect(operation).toMatchObject({
        status: "PREPARED",
        reportType: "KIT_INCOMPLETE",
        kitId,
      });

      const submitted = await reportProblem(
        {
          confirmationToken: proposal.confirmationToken,
          reportType: proposal.reportType,
          description: proposal.description,
        },
        { context: {}, request: new Request("http://localhost/ioio/ask") }
      );
      expect(submitted.status).toBe("submitted");
      if (submitted.status !== "submitted") return;
      reportId = submitted.reportId;

      const duringException = await Promise.all([
        db.booking.findUnique({
          where: { id: bookingId, organizationId },
          select: { status: true },
        }),
        db.kit.findUnique({
          where: { id: kitId, organizationId },
          select: { status: true },
        }),
        db.asset.findUnique({
          where: { id: assetId, organizationId },
          select: { status: true },
        }),
      ]);
      expect(duringException).toEqual([
        { status: "ONGOING" },
        { status: "CHECKED_OUT" },
        { status: "CHECKED_OUT" },
      ]);
      expect(
        (await getMyStudentLoans({ organizationId, userId })).some(
          (loan) => loan.id === bookingId
        )
      ).toBe(true);

      await expect(
        reportProblem(
          {
            confirmationToken: proposal.confirmationToken,
            reportType: proposal.reportType,
            description: proposal.description,
          },
          { context: {}, request: new Request("http://localhost/ioio/ask") }
        )
      ).resolves.toEqual({
        ok: true,
        status: "duplicate",
        reportId,
      });
      expect(
        await db.reportFound.count({
          where: { id: reportId, kitId },
        })
      ).toBe(1);
    });
  }
);
