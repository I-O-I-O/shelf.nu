import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  teamMember: { findMany: vi.fn() },
  booking: { findFirst: vi.fn() },
  bookingAsset: { count: vi.fn(), findFirst: vi.fn() },
  custody: { aggregate: vi.fn() },
  consumptionLog: { findMany: vi.fn(), aggregate: vi.fn() },
  ioioWriteOperation: {
    create: vi.fn(),
    findUnique: vi.fn(),
    updateMany: vi.fn(),
  },
  location: { findMany: vi.fn() },
}));
const requireStudentReadMock = vi.hoisted(() => vi.fn());
const checkinMock = vi.hoisted(() => vi.fn());
const rateLimitMock = vi.hoisted(() => vi.fn());
const prepareReportMock = vi.hoisted(() => vi.fn());
const createBorrowedItemProblemReportMock = vi.hoisted(() => vi.fn());

// why: these tests isolate M15 authorization and durable-operation decisions;
// the real native check-in is covered by the gated local integration suite.
vi.mock("~/database/db.server", () => ({ db: dbMock }));
// why: auth is a controlled fixture so each security case can use a distinct
// signed-in user and organization without a browser session.
vi.mock("./route.server", () => ({
  requireStudentRead: requireStudentReadMock,
}));
// why: the native Shelf service is an integration boundary; the unit suite
// asserts that it is called only after the confirmation claim succeeds.
vi.mock("~/modules/booking/service.server", () => ({
  partialCheckinBooking: checkinMock,
}));
// why: persistent quota behavior is verified separately; these tests focus on
// return validation and idempotency.
vi.mock("./rate-limit.server", () => ({
  IOIO_RETURN_OPERATION: "RETURN_ITEM",
  enforceIoioReturnRateLimit: rateLimitMock,
}));
// why: report-problem has its own workflow tests; this verifies the return
// fallback delegates to that existing native report proposal path.
vi.mock("./report-problem.server", () => ({
  prepareReportProblem: prepareReportMock,
  createBorrowedItemProblemReport: createBorrowedItemProblemReportMock,
  sanitizeReportText: (value: string) => value,
}));
vi.mock("~/utils/logger", () => ({
  Logger: { info: vi.fn(), warn: vi.fn() },
}));

import {
  prepareReturnItem,
  prepareReturnProblemReport,
  returnItem,
  submitReturnItem,
} from "./return-item.server";

const context = {};
const request = new Request("http://localhost/ioio/ask");
const auth = {
  userId: "user-a",
  organizationId: "org-a",
  role: "SELF_SERVICE" as const,
};
const booking = {
  id: "booking-a",
  status: "ONGOING" as const,
  from: new Date("2030-01-01T10:00:00.000Z"),
  to: new Date("2030-01-15T10:00:00.000Z"),
};
const bookingAsset = {
  id: "booking-asset-a",
  assetId: "asset-a",
  quantity: 4,
  sourceKitId: null,
  checkedOutAt: new Date("2030-01-01T10:01:00.000Z"),
  checkedInAt: null,
  asset: {
    id: "asset-a",
    title: "Arduino Nano",
    type: "QUANTITY_TRACKED" as const,
    assetLocations: [
      {
        location: {
          id: "assigned-storage",
          name: "B477 / Shelf A1 / A1-13",
        },
      },
    ],
  },
};

function operation(overrides: Record<string, unknown> = {}) {
  return {
    id: "operation-a",
    userId: auth.userId,
    organizationId: auth.organizationId,
    operationType: "RETURN_ITEM",
    status: "PREPARED",
    bookingId: booking.id,
    bookingAssetId: bookingAsset.id,
    assetId: bookingAsset.assetId,
    quantity: 2,
    createdAt: new Date(),
    ...overrides,
  };
}

describe("IOIO return_item", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireStudentReadMock.mockResolvedValue(auth);
    dbMock.teamMember.findMany.mockResolvedValue([{ id: "team-a" }]);
    dbMock.booking.findFirst.mockResolvedValue({
      ...booking,
      bookingAssets: [bookingAsset],
    });
    dbMock.bookingAsset.count.mockResolvedValue(1);
    dbMock.consumptionLog.findMany.mockResolvedValue([]);
    dbMock.consumptionLog.aggregate.mockResolvedValue({
      _sum: { quantity: null },
    });
    dbMock.custody.aggregate.mockResolvedValue({ _sum: { quantity: 2 } });
    dbMock.ioioWriteOperation.create.mockResolvedValue({ id: "operation-a" });
    dbMock.ioioWriteOperation.updateMany.mockResolvedValue({ count: 1 });
    dbMock.location.findMany.mockResolvedValue([
      { id: "broken-zone", name: "Broken Zone" },
      { id: "return-zone", name: "Return Zone" },
    ]);
    createBorrowedItemProblemReportMock.mockResolvedValue({
      ok: true,
      reportId: "report-a",
    });
    rateLimitMock.mockResolvedValue(undefined);
    checkinMock.mockResolvedValue({
      booking: { id: booking.id },
      isComplete: false,
    });
  });

  it("prepares from the signed-in user's own loan without native writes", async () => {
    const proposal = await prepareReturnItem(
      {
        booking_id: booking.id,
        booking_asset_id: bookingAsset.id,
        asset_id: bookingAsset.assetId,
        quantity: 2,
      },
      { context, request }
    );

    expect(proposal).toMatchObject({
      operationId: "operation-a",
      bookingAssetId: bookingAsset.id,
      borrowedQuantity: 4,
      heldQuantity: 4,
      quantity: 2,
      returnLocation: "B477 / Shelf A1 / A1-13",
    });
    expect(checkinMock).not.toHaveBeenCalled();
    expect(dbMock.ioioWriteOperation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          operationType: "RETURN_ITEM",
          bookingId: booking.id,
          bookingAssetId: bookingAsset.id,
          quantity: 2,
          locationId: "assigned-storage",
        }),
      })
    );
  });

  it("stores the one issue note and Broken Zone on the return proposal", async () => {
    await prepareReturnItem(
      {
        booking_id: booking.id,
        booking_asset_id: bookingAsset.id,
        asset_id: bookingAsset.assetId,
        quantity: 1,
      },
      { context, request },
      {
        issueState: "problem",
        reportType: "ITEM_DAMAGED",
        issueComment: "Motor cable is loose",
      }
    );

    expect(dbMock.ioioWriteOperation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          reportType: "ITEM_DAMAGED",
          description: "Issue reported: ITEM_DAMAGED. Motor cable is loose",
          locationId: "broken-zone",
        }),
      })
    );
  });

  it("keeps the captured auth actor across a return request", async () => {
    requireStudentReadMock.mockRejectedValue(
      new Error("return code must not re-read the session")
    );

    await expect(
      prepareReturnItem(
        {
          booking_id: booking.id,
          booking_asset_id: bookingAsset.id,
          asset_id: bookingAsset.assetId,
          quantity: 2,
        },
        { context, request, auth }
      )
    ).resolves.toMatchObject({ operationId: "operation-a" });

    expect(requireStudentReadMock).not.toHaveBeenCalled();
    expect(dbMock.ioioWriteOperation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: auth.userId,
          organizationId: auth.organizationId,
        }),
      })
    );
  });

  it("rejects an over-return before creating a proposal", async () => {
    await expect(
      prepareReturnItem(
        {
          booking_id: booking.id,
          booking_asset_id: bookingAsset.id,
          asset_id: bookingAsset.assetId,
          quantity: 5,
        },
        { context, request }
      )
    ).rejects.toMatchObject({ status: 409 });
    expect(dbMock.ioioWriteOperation.create).not.toHaveBeenCalled();
  });

  it("rejects a confirmation whose quantity was changed", async () => {
    dbMock.ioioWriteOperation.findUnique.mockResolvedValue(operation());

    await expect(
      returnItem(
        { confirmationToken: "token-a", quantity: 1 },
        { context, request }
      )
    ).rejects.toMatchObject({ status: 409 });
    expect(rateLimitMock).not.toHaveBeenCalled();
    expect(checkinMock).not.toHaveBeenCalled();
  });

  it("completes a standalone successful return immediately", async () => {
    dbMock.ioioWriteOperation.findUnique.mockResolvedValue(
      operation({ reportType: "RETURN_ITEM" })
    );

    const result = await submitReturnItem(
      { confirmationToken: "token-a", quantity: 2 },
      { context, request }
    );

    expect(result).toMatchObject({
      status: "completed",
      bookingId: booking.id,
    });
    expect(checkinMock).toHaveBeenCalledTimes(1);
    expect(dbMock.ioioWriteOperation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "SUCCEEDED" }),
      })
    );
  });

  it("keeps a successful Kit return pending Staff inspection", async () => {
    dbMock.booking.findFirst.mockResolvedValue({
      ...booking,
      bookingAssets: [
        {
          ...bookingAsset,
          sourceKitId: "kit-a",
          asset: {
            ...bookingAsset.asset,
            returnHandling: "RETURN_TO_RETURN_ZONE",
          },
        },
      ],
    });
    dbMock.ioioWriteOperation.findUnique.mockResolvedValue(
      operation({ reportType: "RETURN_ITEM" })
    );

    const result = await submitReturnItem(
      { confirmationToken: "token-a", quantity: 2 },
      { context, request }
    );

    expect(result).toMatchObject({
      status: "submitted",
      bookingId: booking.id,
    });
    expect(checkinMock).not.toHaveBeenCalled();
    expect(dbMock.ioioWriteOperation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "SUBMITTED" }),
      })
    );
  });

  it("keeps a problem return pending Staff inspection", async () => {
    dbMock.ioioWriteOperation.findUnique.mockResolvedValue(
      operation({
        reportType: "ITEM_DAMAGED",
        description: "Issue reported: ITEM_DAMAGED. m",
      })
    );

    const result = await submitReturnItem(
      { confirmationToken: "token-a", quantity: 2 },
      { context, request }
    );

    expect(result).toMatchObject({
      status: "submitted",
      bookingId: booking.id,
    });
    expect(checkinMock).not.toHaveBeenCalled();
    expect(dbMock.ioioWriteOperation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "SUBMITTED",
          description: "Return submitted. Issue reported: ITEM_DAMAGED. m",
        }),
      })
    );
    expect(createBorrowedItemProblemReportMock).toHaveBeenCalledWith(
      expect.objectContaining({
        reportType: "ITEM_DAMAGED",
        description: "m",
      }),
      expect.anything(),
      expect.objectContaining({ source: "IOIO_STUDENT_RETURN" })
    );
  });

  it("retries creation of a problem report for an already submitted return", async () => {
    dbMock.ioioWriteOperation.findUnique.mockResolvedValue(
      operation({
        status: "SUBMITTED",
        reportType: "ITEM_DAMAGED",
        description: "Return submitted. Issue reported: ITEM_DAMAGED. m",
      })
    );

    await expect(
      submitReturnItem(
        { confirmationToken: "token-a", quantity: 2 },
        { context, request }
      )
    ).resolves.toMatchObject({ status: "submitted" });
    expect(checkinMock).not.toHaveBeenCalled();
    expect(createBorrowedItemProblemReportMock).toHaveBeenCalledTimes(1);
  });

  it("calls native partial check-in only after claiming confirmation", async () => {
    dbMock.ioioWriteOperation.findUnique.mockResolvedValue(operation());
    const result = await returnItem(
      { confirmationToken: "token-a", quantity: 2 },
      { context, request }
    );

    expect(result).toMatchObject({ status: "submitted", returnedQuantity: 2 });
    expect(checkinMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: booking.id,
        organizationId: auth.organizationId,
        checkins: [
          {
            assetId: bookingAsset.assetId,
            bookingAssetId: bookingAsset.id,
            returned: 2,
          },
        ],
      })
    );
    expect(dbMock.ioioWriteOperation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "SUCCEEDED" }),
      })
    );
  });

  it("replays a succeeded operation without a second native check-in", async () => {
    dbMock.ioioWriteOperation.findUnique.mockResolvedValue(
      operation({ status: "SUCCEEDED" })
    );

    await expect(
      returnItem(
        { confirmationToken: "token-a", quantity: 2 },
        { context, request }
      )
    ).resolves.toMatchObject({ status: "duplicate", bookingId: booking.id });
    expect(checkinMock).not.toHaveBeenCalled();
    expect(rateLimitMock).not.toHaveBeenCalled();
  });

  it("prepares the existing report-problem fallback without completing return", async () => {
    dbMock.ioioWriteOperation.findUnique.mockResolvedValue(operation());
    prepareReportMock.mockResolvedValue({ confirmationToken: "report-token" });

    await expect(
      prepareReturnProblemReport("token-a", { context, request })
    ).resolves.toEqual({ confirmationToken: "report-token" });
    expect(prepareReportMock).toHaveBeenCalledWith(
      expect.objectContaining({ asset_id: bookingAsset.assetId }),
      expect.anything()
    );
    expect(checkinMock).not.toHaveBeenCalled();
  });
});
