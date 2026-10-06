// @vitest-environment node

import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { db as dbExport } from "~/database/db.server";
import type { init as initSchedulerExport } from "~/utils/scheduler.server";
import type { borrowItem as borrowItemExport } from "./borrow-item.server";
import type { returnItem as returnItemExport } from "./return-item.server";

const phase = process.env.M15_RESTART_PHASE;
const shouldRun = phase === "first" || phase === "second";
const token = "00000000-0000-4000-8000-000000000015";
const auth = vi.hoisted(() => ({
  userId: "",
  organizationId: "",
  role: "SELF_SERVICE",
}));

vi.mock("./route.server", () => ({
  requireStudentRead: vi.fn(() => auth),
}));

let db: typeof dbExport;
let initScheduler: typeof initSchedulerExport;
let borrowItem: typeof borrowItemExport;
let returnItem: typeof returnItemExport;

if (shouldRun) {
  const dotenv = await import("dotenv");
  dotenv.config({
    path: path.resolve(process.cwd(), "../../.env"),
    override: true,
  });
  ({ db } = await import("~/database/db.server"));
  ({ init: initScheduler } = await import("~/utils/scheduler.server"));
  ({ borrowItem } = await import("./borrow-item.server"));
  ({ returnItem } = await import("./return-item.server"));
}

describe.skipIf(!shouldRun)(
  "Milestone 15 return process restart recovery",
  () => {
    let bookingId = "";
    let operationId = "";

    beforeAll(async () => {
      const membership = await db.userOrganization.findFirst({
        where: { roles: { has: "SELF_SERVICE" } },
        select: { userId: true, organizationId: true },
      });
      if (!membership) throw new Error("No SELF_SERVICE restart fixture");
      auth.userId = membership.userId;
      auth.organizationId = membership.organizationId;
      await initScheduler();
    });

    afterAll(async () => {
      if (phase !== "second") return;
      if (bookingId) {
        const booking = await db.booking.findFirst({
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
        where: {
          organizationId: auth.organizationId,
          id: operationId || undefined,
          idempotencyKey: token,
        },
      });
      await db.ioioRateLimitBucket.deleteMany({
        where: {
          organizationId: auth.organizationId,
          userId: { in: [auth.userId, "*"] },
          operationType: "RETURN_ITEM",
        },
      });
      await db.$disconnect();
    });

    it(
      phase === "first"
        ? "leaves a native return in PROCESSING"
        : "recovers the native return after restart",
      async () => {
        if (phase === "first") {
          const asset = await db.asset.findFirst({
            where: {
              organizationId: auth.organizationId,
              title: "Arduino Nano",
              type: "QUANTITY_TRACKED",
            },
            select: { id: true },
            orderBy: { id: "asc" },
          });
          if (!asset) throw new Error("Arduino Nano restart fixture not found");
          const { prepareBorrowItem } = await import("./borrow-item.server");
          const from = new Date(Date.now() + 2 * 60_000).toISOString();
          const to = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
          const request = new Request("http://localhost/ioio/ask");
          const borrowProposal = await prepareBorrowItem(
            { asset_id: asset.id, kit_id: null, quantity: 1, from, to },
            { context: {}, request }
          );
          const borrowed = await borrowItem(
            {
              confirmationToken: borrowProposal.confirmationToken,
              quantity: 1,
              from: borrowProposal.from,
              to: borrowProposal.to,
            },
            { context: {}, request }
          );
          if (borrowed.status !== "submitted")
            throw new Error("Borrow fixture failed");
          bookingId = borrowed.bookingId;
          const booking = await db.booking.findFirst({
            where: { id: bookingId, organizationId: auth.organizationId },
            select: {
              from: true,
              to: true,
              bookingAssets: {
                where: { assetId: asset.id },
                select: { id: true },
              },
            },
          });
          if (!booking?.bookingAssets[0])
            throw new Error("Booking slice missing");
          const operation = await db.ioioWriteOperation.create({
            data: {
              operationType: "RETURN_ITEM",
              status: "PROCESSING",
              idempotencyKey: token,
              userId: auth.userId,
              organizationId: auth.organizationId,
              reportType: "RETURN_ITEM",
              description: `Return proposal for Shelf asset ${asset.id}`,
              assetId: asset.id,
              quantity: 1,
              bookingId,
              bookingAssetId: booking.bookingAssets[0].id,
              from: booking.from,
              to: booking.to,
            },
            select: { id: true },
          });
          operationId = operation.id;
          const { partialCheckinBooking } = await import(
            "~/modules/booking/service.server"
          );
          await partialCheckinBooking({
            id: bookingId,
            organizationId: auth.organizationId,
            checkins: [
              {
                assetId: asset.id,
                bookingAssetId: booking.bookingAssets[0].id,
                returned: 1,
              },
            ],
            userId: auth.userId,
            hints: { locale: "en-US", timeZone: "UTC" },
          });
          const state = await db.ioioWriteOperation.findUnique({
            where: { id: operation.id, organizationId: auth.organizationId },
            select: { status: true },
          });
          expect(state?.status).toBe("PROCESSING");
          return;
        }

        const operation = await db.ioioWriteOperation.findUnique({
          where: { idempotencyKey: token },
          select: {
            id: true,
            bookingId: true,
            quantity: true,
            status: true,
          },
        });
        if (!operation?.bookingId || operation.status !== "PROCESSING") {
          throw new Error("Missing PROCESSING return restart fixture");
        }
        operationId = operation.id;
        bookingId = operation.bookingId;
        await expect(
          returnItem(
            { confirmationToken: token, quantity: operation.quantity ?? 0 },
            { context: {}, request: new Request("http://localhost/ioio/ask") }
          )
        ).resolves.toMatchObject({
          status: "duplicate",
          bookingId,
          returnedQuantity: 1,
        });
        expect(
          await db.ioioWriteOperation.findUnique({
            where: { id: operation.id, organizationId: auth.organizationId },
            select: { status: true },
          })
        ).toEqual({ status: "SUCCEEDED" });
      }
    );
  }
);
