import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  asset: { findFirst: vi.fn() },
  kit: { findFirst: vi.fn() },
  location: { findFirst: vi.fn() },
  user: { findUniqueOrThrow: vi.fn() },
  ioioWriteOperation: {
    findUnique: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  $transaction: vi.fn(),
}));
const requireStudentReadMock = vi.hoisted(() => vi.fn());
const enforceRateLimitMock = vi.hoisted(() => vi.fn());
const createReportMock = vi.hoisted(() => vi.fn());

vi.mock("~/database/db.server", () => ({ db: dbMock }));
vi.mock("./route.server", () => ({
  requireStudentRead: requireStudentReadMock,
}));
vi.mock("./rate-limit.server", () => ({
  IOIO_REPORT_OPERATION: "REPORT_PROBLEM",
  enforceIoioReportRateLimit: enforceRateLimitMock,
}));
vi.mock("~/modules/report-found/service.server", () => ({
  createReport: createReportMock,
}));
vi.mock("~/utils/logger", () => ({
  Logger: { info: vi.fn(), warn: vi.fn() },
}));

import { reportProblem } from "./report-problem.server";

const context = {};
const request = new Request("http://localhost/ioio/ask");
const auth = {
  userId: "user-a",
  organizationId: "org-a",
  role: "SELF_SERVICE",
};

describe("Milestone 13 controlled-write fault handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireStudentReadMock.mockResolvedValue(auth);
    enforceRateLimitMock.mockResolvedValue(undefined);
    dbMock.ioioWriteOperation.updateMany.mockResolvedValue({ count: 1 });
    dbMock.ioioWriteOperation.update.mockResolvedValue({});
  });

  it("A: does not claim or write when the pre-claim read fails", async () => {
    const databaseFailure = new Error("database unavailable before claim");
    dbMock.ioioWriteOperation.findUnique.mockRejectedValue(databaseFailure);

    await expect(
      reportProblem(
        {
          confirmationToken: "fault-a-token",
          reportType: "ITEM_DAMAGED",
          description: "The item is damaged",
        },
        { context, request }
      )
    ).rejects.toBe(databaseFailure);

    expect(dbMock.ioioWriteOperation.updateMany).not.toHaveBeenCalled();
    expect(createReportMock).not.toHaveBeenCalled();
    expect(dbMock.$transaction).not.toHaveBeenCalled();
  });

  it("B: does not create a native report when the claimed transaction fails first", async () => {
    dbMock.ioioWriteOperation.findUnique
      .mockResolvedValueOnce({
        id: "op-b",
        userId: auth.userId,
        organizationId: auth.organizationId,
        status: "PREPARED",
        resultReportId: null,
        createdAt: new Date(),
      })
      .mockResolvedValueOnce({
        id: "op-b",
        userId: auth.userId,
        organizationId: auth.organizationId,
        status: "PROCESSING",
        resultReportId: null,
        assetId: null,
        kitId: null,
        locationId: null,
      });
    dbMock.user.findUniqueOrThrow.mockRejectedValue(
      new Error("database unavailable after claim")
    );
    dbMock.$transaction.mockImplementation((callback) => callback(dbMock));

    await expect(
      reportProblem(
        {
          confirmationToken: "fault-b-token",
          reportType: "ITEM_DAMAGED",
          description: "The item is damaged",
        },
        { context, request }
      )
    ).rejects.toThrow("database unavailable after claim");

    expect(dbMock.ioioWriteOperation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "PROCESSING" }),
      })
    );
    expect(createReportMock).not.toHaveBeenCalled();
  });

  it("C: keeps the native report and operation marker in one transaction boundary", async () => {
    dbMock.ioioWriteOperation.findUnique
      .mockResolvedValueOnce({
        id: "op-c",
        userId: auth.userId,
        organizationId: auth.organizationId,
        status: "PREPARED",
        resultReportId: null,
        createdAt: new Date(),
      })
      .mockResolvedValueOnce({
        id: "op-c",
        userId: auth.userId,
        organizationId: auth.organizationId,
        status: "PROCESSING",
        resultReportId: null,
        assetId: null,
        kitId: null,
        locationId: null,
      });
    dbMock.user.findUniqueOrThrow.mockResolvedValue({
      email: "ioio.student@example.test",
    });
    createReportMock.mockResolvedValue({ id: "report-c" });
    dbMock.ioioWriteOperation.update.mockRejectedValue(
      new Error("database unavailable before operation completion")
    );
    dbMock.$transaction.mockImplementation((callback) => callback(dbMock));

    await expect(
      reportProblem(
        {
          confirmationToken: "fault-c-token",
          reportType: "ITEM_DAMAGED",
          description: "The item is damaged",
        },
        { context, request }
      )
    ).rejects.toThrow("database unavailable before operation completion");

    expect(createReportMock).toHaveBeenCalledWith(
      expect.objectContaining({ client: dbMock })
    );
    expect(dbMock.ioioWriteOperation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "SUCCEEDED",
          resultReportId: "report-c",
        }),
      })
    );
    // The real Prisma transaction rolls both writes back when the marker update
    // fails. This unit test verifies that both writes share the tx boundary.
  });

  it("E: expires an old proposal before rate-limit or write work", async () => {
    dbMock.ioioWriteOperation.findUnique.mockResolvedValue({
      id: "op-e",
      userId: auth.userId,
      organizationId: auth.organizationId,
      status: "PREPARED",
      resultReportId: null,
      createdAt: new Date(Date.now() - 11 * 60 * 1000),
    });

    await expect(
      reportProblem(
        {
          confirmationToken: "fault-e-token",
          reportType: "ITEM_DAMAGED",
          description: "The item is damaged",
        },
        { context, request }
      )
    ).rejects.toMatchObject({ status: 404 });

    expect(dbMock.ioioWriteOperation.updateMany).toHaveBeenCalledWith({
      where: { idempotencyKey: "fault-e-token", status: "PREPARED" },
      data: { status: "CANCELLED", completedAt: expect.any(Date) },
    });
    expect(enforceRateLimitMock).not.toHaveBeenCalled();
    expect(dbMock.$transaction).not.toHaveBeenCalled();
  });
});
