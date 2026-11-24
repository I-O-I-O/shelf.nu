// @vitest-environment node

import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { db as dbExport } from "~/database/db.server";
import type { init as initSchedulerExport } from "~/utils/scheduler.server";
import type { borrowItem as borrowItemExport } from "./borrow-item.server";

const phase = process.env.M14_RESTART_PHASE;
const runIntegration = phase === "first" || phase === "second";
const operationId = "m14_process_restart_borrow";
const token = "00000000-0000-4000-8000-000000000014";

const auth = vi.hoisted(() => ({
  userId: "",
  organizationId: "",
  role: "SELF_SERVICE",
}));

vi.mock("./route.server", () => ({
  requireStudentRead: vi.fn(() => auth),
}));

let db: typeof dbExport;
let borrowItem: typeof borrowItemExport;
let initScheduler: typeof initSchedulerExport;

if (runIntegration) {
  const dotenv = await import("dotenv");
  dotenv.config({
    path: path.resolve(process.cwd(), "../../.env"),
    override: true,
  });
  ({ db } = await import("~/database/db.server"));
  ({ borrowItem } = await import("./borrow-item.server"));
  ({ init: initScheduler } = await import("~/utils/scheduler.server"));
}

describe.skipIf(!runIntegration)(
  "Milestone 14 borrow replay across fresh application processes",
  () => {
    let assetId = "";
    let bookingId = "";
    let from = new Date(0);
    let to = new Date(0);

    beforeAll(async () => {
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

      if (phase === "first") {
        const oldBookings = await db.booking.findMany({
          where: {
            organizationId: auth.organizationId,
            description: { contains: `IOIO_BORROW_OPERATION:${operationId}` },
          },
          select: { id: true },
        });
        await db.booking.deleteMany({
          where: {
            id: { in: oldBookings.map((booking) => booking.id) },
            organizationId: auth.organizationId,
          },
        });
        await db.ioioWriteOperation.deleteMany({
          where: { id: operationId, organizationId: auth.organizationId },
        });
        from = new Date(Date.now() + 2 * 60_000);
        to = new Date(Date.now() + 24 * 60 * 60_000);
        await db.ioioWriteOperation.create({
          data: {
            id: operationId,
            operationType: "BORROW_ITEM",
            status: "PREPARED",
            idempotencyKey: token,
            userId: auth.userId,
            organizationId: auth.organizationId,
            reportType: "BORROW_ITEM",
            description: `Milestone 14 process restart borrow ${assetId}`,
            assetId,
            quantity: 1,
            from,
            to,
          },
        });
      } else {
        const operation = await db.ioioWriteOperation.findUniqueOrThrow({
          where: { id: operationId, organizationId: auth.organizationId },
          select: { assetId: true, quantity: true, from: true, to: true },
        });
        assetId = operation.assetId ?? "";
        from = operation.from ?? new Date(0);
        to = operation.to ?? new Date(0);
      }
      await initScheduler();
    });

    afterAll(async () => {
      if (phase === "second") {
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
        await db.ioioWriteOperation.deleteMany({
          where: { id: operationId, organizationId: auth.organizationId },
        });
        await db.ioioRateLimitBucket.deleteMany({
          where: {
            organizationId: auth.organizationId,
            userId: { in: [auth.userId, "*"] },
            operationType: "BORROW_ITEM",
          },
        });
      }
      await db.$disconnect();
    });

    it("submits once, then replays as a duplicate", async () => {
      const result = await borrowItem(
        {
          confirmationToken: token,
          quantity: 1,
          from: from.toISOString(),
          to: to.toISOString(),
        },
        { context: {}, request: new Request("http://localhost/ioio/ask") }
      );

      if (phase === "first") {
        expect(result.status).toBe("submitted");
        if (result.status !== "submitted") return;
        bookingId = result.bookingId;
        expect(
          await db.ioioWriteOperation.findUnique({
            where: { id: operationId, organizationId: auth.organizationId },
            select: { status: true, bookingId: true },
          })
        ).toMatchObject({ status: "SUCCEEDED", bookingId });
      } else {
        expect(result.status).toBe("duplicate");
        if (result.status !== "duplicate" || !result.bookingId) return;
        bookingId = result.bookingId;
        expect(
          await db.booking.count({
            where: {
              id: bookingId,
              organizationId: auth.organizationId,
              description: { contains: `IOIO_BORROW_OPERATION:${operationId}` },
            },
          })
        ).toBe(1);
        expect(
          await db.bookingAsset.count({ where: { bookingId, assetId } })
        ).toBe(1);
      }
    });
  }
);
