// @vitest-environment node

import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { db as dbExport } from "~/database/db.server";
import type { init as initSchedulerExport } from "~/utils/scheduler.server";
import type {
  borrowItem as borrowItemExport,
  prepareBorrowItem as prepareBorrowItemExport,
} from "./borrow-item.server";
import type {
  prepareReturnItem as prepareReturnItemExport,
  returnItem as returnItemExport,
} from "./return-item.server";
import type { getMyStudentLoans as getMyStudentLoansExport } from "./service.server";

const runIntegration = process.env.M15_RUN_INTEGRATION === "1";
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
let prepareBorrowItem: typeof prepareBorrowItemExport;
let borrowItem: typeof borrowItemExport;
let prepareReturnItem: typeof prepareReturnItemExport;
let returnItem: typeof returnItemExport;
let getMyStudentLoans: typeof getMyStudentLoansExport;

if (runIntegration) {
  const dotenv = await import("dotenv");
  dotenv.config({
    path: path.resolve(process.cwd(), "../../.env"),
    override: true,
  });
  ({ db } = await import("~/database/db.server"));
  ({ init: initScheduler } = await import("~/utils/scheduler.server"));
  ({ prepareBorrowItem, borrowItem } = await import("./borrow-item.server"));
  ({ prepareReturnItem, returnItem } = await import("./return-item.server"));
  ({ getMyStudentLoans } = await import("./service.server"));
}

describe.skipIf(!runIntegration)("Milestone 15 native return roundtrip", () => {
  let assetId = "";
  let borrowOperationId = "";
  let returnOperationId = "";
  let secondReturnOperationId = "";
  let bookingId = "";
  let bookingAssetId = "";
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
        id: {
          in: [borrowOperationId, returnOperationId, secondReturnOperationId],
        },
      },
    });
    await db.ioioRateLimitBucket.deleteMany({
      where: {
        organizationId: auth.organizationId,
        userId: { in: [auth.userId, "*"] },
        operationType: { in: ["BORROW_ITEM", "RETURN_ITEM"] },
        createdAt: { gte: startedAt },
      },
    });
    await db.$disconnect();
  });

  it("borrows, partially returns, fully returns, and safely replays", async () => {
    const from = new Date(Date.now() + 2 * 60_000).toISOString();
    const to = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    const request = new Request("http://localhost/ioio/ask");

    const borrowProposal = await prepareBorrowItem(
      { asset_id: assetId, kit_id: null, quantity: 4, from, to },
      { context: {}, request }
    );
    borrowOperationId = borrowProposal.operationId;
    const borrowed = await borrowItem(
      {
        confirmationToken: borrowProposal.confirmationToken,
        quantity: 4,
        from: borrowProposal.from,
        to: borrowProposal.to,
      },
      { context: {}, request }
    );
    expect(borrowed.status).toBe("submitted");
    if (borrowed.status !== "submitted") return;
    bookingId = borrowed.bookingId;

    const booking = await db.booking.findFirst({
      where: { id: bookingId, organizationId: auth.organizationId },
      select: {
        status: true,
        bookingAssets: {
          where: { assetId },
          select: {
            id: true,
            quantity: true,
            checkedOutAt: true,
            checkedInAt: true,
          },
        },
      },
    });
    expect(booking?.status).toBe("ONGOING");
    expect(booking?.bookingAssets).toHaveLength(1);
    bookingAssetId = booking!.bookingAssets[0].id;
    expect(booking!.bookingAssets[0]).toMatchObject({
      quantity: 4,
      checkedOutAt: expect.any(Date),
      checkedInAt: null,
    });

    const loansAfterBorrow = await getMyStudentLoans({
      organizationId: auth.organizationId,
      userId: auth.userId,
    });
    expect(
      loansAfterBorrow
        .find((loan) => loan.id === bookingId)
        ?.bookingAssets.find((asset) => asset.asset.id === assetId)?.quantity
    ).toBe(4);

    const partialProposal = await prepareReturnItem(
      {
        booking_id: bookingId,
        booking_asset_id: bookingAssetId,
        asset_id: assetId,
        quantity: 2,
      },
      { context: {}, request }
    );
    returnOperationId = partialProposal.operationId;
    const partial = await returnItem(
      { confirmationToken: partialProposal.confirmationToken, quantity: 2 },
      { context: {}, request }
    );
    expect(partial).toMatchObject({ status: "submitted", returnedQuantity: 2 });

    const partialBooking = await db.booking.findFirst({
      where: { id: bookingId, organizationId: auth.organizationId },
      select: {
        status: true,
        bookingAssets: {
          where: { id: bookingAssetId },
          select: { checkedInAt: true },
        },
      },
    });
    expect(partialBooking).toMatchObject({
      status: "ONGOING",
      bookingAssets: [{ checkedInAt: null }],
    });
    expect(
      await db.consumptionLog.aggregate({
        where: {
          bookingId,
          bookingAssetId,
          category: "RETURN",
        },
        _sum: { quantity: true },
      })
    ).toMatchObject({ _sum: { quantity: 2 } });
    expect(
      loansAfterBorrow &&
        (
          await getMyStudentLoans({
            organizationId: auth.organizationId,
            userId: auth.userId,
          })
        )
          .find((loan) => loan.id === bookingId)
          ?.bookingAssets.find((asset) => asset.asset.id === assetId)?.quantity
    ).toBe(2);

    const fullProposal = await prepareReturnItem(
      {
        booking_id: bookingId,
        booking_asset_id: bookingAssetId,
        asset_id: assetId,
        quantity: 2,
      },
      { context: {}, request }
    );
    secondReturnOperationId = fullProposal.operationId;
    const completed = await returnItem(
      { confirmationToken: fullProposal.confirmationToken, quantity: 2 },
      { context: {}, request }
    );
    expect(completed).toMatchObject({
      status: "submitted",
      returnedQuantity: 2,
      isComplete: true,
    });

    const finalBooking = await db.booking.findFirst({
      where: { id: bookingId, organizationId: auth.organizationId },
      select: {
        status: true,
        bookingAssets: {
          where: { id: bookingAssetId },
          select: { checkedInAt: true },
        },
      },
    });
    expect(finalBooking).toMatchObject({
      status: "COMPLETE",
      bookingAssets: [{ checkedInAt: expect.any(Date) }],
    });
    expect(
      (
        await getMyStudentLoans({
          organizationId: auth.organizationId,
          userId: auth.userId,
        })
      ).some((loan) => loan.id === bookingId)
    ).toBe(false);
    expect(
      await db.custody.count({
        where: { assetId, custodian: { userId: auth.userId } },
      })
    ).toBe(0);
    expect(
      await db.asset.findFirst({
        where: { id: assetId, organizationId: auth.organizationId },
        select: { quantity: true, status: true },
      })
    ).toEqual({ quantity: 8, status: "AVAILABLE" });

    await expect(
      returnItem(
        { confirmationToken: fullProposal.confirmationToken, quantity: 2 },
        { context: {}, request }
      )
    ).resolves.toMatchObject({
      status: "duplicate",
      bookingId,
      returnedQuantity: 2,
    });
    expect(
      await db.consumptionLog.count({
        where: { bookingId, bookingAssetId, category: "RETURN" },
      })
    ).toBe(2);
  });
});
