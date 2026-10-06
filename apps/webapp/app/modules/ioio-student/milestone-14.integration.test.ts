// @vitest-environment node

import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { db as dbExport } from "~/database/db.server";
import type { init as initSchedulerExport } from "~/utils/scheduler.server";
import type {
  borrowItem as borrowItemExport,
  prepareBorrowItem as prepareBorrowItemExport,
} from "./borrow-item.server";
import type { getMyStudentLoans as getMyStudentLoansExport } from "./service.server";

const runIntegration = process.env.M14_RUN_INTEGRATION === "1";

const auth = vi.hoisted(() => ({
  userId: "",
  organizationId: "",
  role: "SELF_SERVICE",
}));

vi.mock("./route.server", () => ({
  requireStudentRead: vi.fn(() => auth),
}));

let db: typeof dbExport;
let prepareBorrowItem: typeof prepareBorrowItemExport;
let borrowItem: typeof borrowItemExport;
let getMyStudentLoans: typeof getMyStudentLoansExport;
let initScheduler: typeof initSchedulerExport;

if (runIntegration) {
  const dotenv = await import("dotenv");
  dotenv.config({
    path: path.resolve(process.cwd(), "../../.env"),
    override: true,
  });
  ({ db } = await import("~/database/db.server"));
  ({ prepareBorrowItem, borrowItem } = await import("./borrow-item.server"));
  ({ getMyStudentLoans } = await import("./service.server"));
  ({ init: initScheduler } = await import("~/utils/scheduler.server"));
}

describe.skipIf(!runIntegration)(
  "Milestone 14 native borrow integration",
  () => {
    let assetId = "";
    let operationId = "";
    let token = "";
    let bookingId = "";
    let startedAt: Date;

    beforeAll(async () => {
      startedAt = new Date();
      const membership = await db.userOrganization.findFirst({
        where: { roles: { has: "SELF_SERVICE" } },
        select: { userId: true, organizationId: true },
      });
      if (!membership) throw new Error("No SELF_SERVICE integration fixture");
      auth.userId = membership.userId;
      auth.organizationId = membership.organizationId;

      const asset = await db.asset.findFirst({
        where: {
          organizationId: auth.organizationId,
          title: "Arduino Nano",
          type: "QUANTITY_TRACKED",
        },
        select: { id: true },
        orderBy: { id: "asc" },
      });
      if (!asset) throw new Error("Arduino Nano integration fixture not found");
      assetId = asset.id;
      await initScheduler();
    });

    afterAll(async () => {
      if (bookingId) {
        const booking = await db.booking.findUnique({
          where: { id: bookingId, organizationId: auth.organizationId },
          select: { id: true, status: true },
        });
        if (booking && ["ONGOING", "OVERDUE"].includes(booking.status)) {
          const { checkinBooking } = await import(
            "~/modules/booking/service.server"
          );
          await checkinBooking({
            id: booking.id,
            organizationId: auth.organizationId,
            userId: auth.userId,
            hints: { locale: "en-US", timeZone: "UTC" },
          });
        }
        await db.booking.deleteMany({
          where: { id: bookingId, organizationId: auth.organizationId },
        });
      }
      if (operationId) {
        await db.ioioWriteOperation.deleteMany({
          where: { id: operationId, organizationId: auth.organizationId },
        });
      }
      await db.ioioRateLimitBucket.deleteMany({
        where: {
          organizationId: auth.organizationId,
          userId: { in: [auth.userId, "*"] },
          operationType: "BORROW_ITEM",
          createdAt: { gte: startedAt },
        },
      });
      await db.$disconnect();
    });

    it("prepares without a booking, confirms one native booking, and replays safely", async () => {
      const from = new Date(Date.now() + 2 * 60_000).toISOString();
      const to = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
      const request = new Request("http://localhost/ioio/ask");

      const before = await db.booking.count({
        where: {
          organizationId: auth.organizationId,
          description: { contains: "IOIO_BORROW_OPERATION:" },
        },
      });
      const proposal = await prepareBorrowItem(
        { asset_id: assetId, kit_id: null, quantity: 1, from, to },
        { context: {}, request }
      );
      operationId = proposal.operationId;
      token = proposal.confirmationToken;

      expect(
        await db.booking.count({
          where: {
            organizationId: auth.organizationId,
            description: { contains: `IOIO_BORROW_OPERATION:${operationId}` },
          },
        })
      ).toBe(0);
      expect(before).toBe(
        await db.booking.count({
          where: {
            organizationId: auth.organizationId,
            description: { contains: "IOIO_BORROW_OPERATION:" },
          },
        })
      );

      const submitted = await borrowItem(
        {
          confirmationToken: token,
          quantity: 1,
          from: proposal.from,
          to: proposal.to,
        },
        { context: {}, request }
      );
      expect(submitted.status).toBe("submitted");
      if (submitted.status !== "submitted") return;
      bookingId = submitted.bookingId;

      const nativeBooking = await db.booking.findUnique({
        where: { id: bookingId, organizationId: auth.organizationId },
        select: {
          id: true,
          status: true,
          custodianUserId: true,
          from: true,
          to: true,
          bookingAssets: { select: { assetId: true, quantity: true } },
        },
      });
      expect(nativeBooking).toMatchObject({
        id: bookingId,
        status: "ONGOING",
        custodianUserId: auth.userId,
        bookingAssets: [{ assetId, quantity: 1 }],
      });
      expect(nativeBooking?.from.getTime()).toBe(
        new Date(proposal.from).getTime()
      );
      expect(nativeBooking?.to.getTime()).toBe(new Date(proposal.to).getTime());

      const operation = await db.ioioWriteOperation.findUnique({
        where: { id: operationId, organizationId: auth.organizationId },
        select: {
          status: true,
          bookingId: true,
          assetId: true,
          quantity: true,
        },
      });
      expect(operation).toEqual({
        status: "SUCCEEDED",
        bookingId,
        assetId,
        quantity: 1,
      });
      expect(
        await db.bookingAsset.count({ where: { bookingId, assetId } })
      ).toBe(1);
      expect(
        await db.asset.findUnique({
          where: { id: assetId, organizationId: auth.organizationId },
          select: { quantity: true },
        })
      ).toEqual({ quantity: 8 });

      const loans = await getMyStudentLoans({
        organizationId: auth.organizationId,
        userId: auth.userId,
      });
      expect(loans.some((loan) => loan.id === bookingId)).toBe(true);

      const replay = await borrowItem(
        {
          confirmationToken: token,
          quantity: 1,
          from: proposal.from,
          to: proposal.to,
        },
        { context: {}, request }
      );
      expect(replay).toEqual({ ok: true, status: "duplicate", bookingId });
      expect(
        await db.booking.count({
          where: {
            organizationId: auth.organizationId,
            description: { contains: `IOIO_BORROW_OPERATION:${operationId}` },
          },
        })
      ).toBe(1);
      expect(
        await db.bookingAsset.count({ where: { bookingId, assetId } })
      ).toBe(1);
    });
  }
);
