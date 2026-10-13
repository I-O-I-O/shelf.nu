import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const transaction = {
    ioioWriteOperation: {
      findFirst: vi.fn(),
      create: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
    asset: {
      findFirst: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
    user: { findUniqueOrThrow: vi.fn() },
  };
  return {
    transaction,
    db: {
      ioioWriteOperation: { findUnique: vi.fn() },
      asset: { findFirst: vi.fn() },
      $transaction: vi.fn((callback: (tx: typeof transaction) => unknown) =>
        Promise.resolve(callback(transaction))
      ),
    },
    requireStudentRead: vi.fn(),
    enforceReportRateLimit: vi.fn(),
    createReport: vi.fn(),
  };
});

// why: this test isolates the report transaction and exact-unit availability
// policy; database and report persistence are represented by transaction spies.
vi.mock("~/database/db.server", () => ({ db: mocks.db }));
vi.mock("./route.server", () => ({
  requireStudentRead: mocks.requireStudentRead,
}));
vi.mock("./rate-limit.server", () => ({
  enforceIoioReportRateLimit: mocks.enforceReportRateLimit,
  IOIO_REPORT_OPERATION: "REPORT_PROBLEM",
}));
vi.mock("~/modules/report-found/service.server", () => ({
  createReport: mocks.createReport,
}));
vi.mock("~/utils/logger", () => ({ Logger: { info: vi.fn(), warn: vi.fn() } }));

import { prepareReportProblem, reportProblem } from "./report-problem.server";

describe("IOIO report availability policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireStudentRead.mockResolvedValue({
      userId: "student-1",
      organizationId: "team-1",
      role: "SELF_SERVICE",
    });
    mocks.db.ioioWriteOperation.findUnique.mockResolvedValue({
      id: "operation-1",
      userId: "student-1",
      organizationId: "team-1",
      status: "PREPARED",
      resultReportId: null,
      source: "IOIO_ASSISTANT",
      createdAt: new Date(),
    });
    mocks.transaction.ioioWriteOperation.findUnique.mockResolvedValue({
      id: "operation-1",
      userId: "student-1",
      organizationId: "team-1",
      status: "PROCESSING",
      resultReportId: null,
      source: "IOIO_ASSISTANT",
      assetId: "unit-002",
      kitId: null,
      locationId: null,
    });
    mocks.transaction.asset.findFirst.mockResolvedValue({ id: "unit-002" });
    mocks.transaction.ioioWriteOperation.findFirst.mockResolvedValue(null);
    mocks.db.asset.findFirst.mockResolvedValue({
      id: "unit-002",
      title: "Makey Kit #002",
      type: "INDIVIDUAL",
    });
    mocks.transaction.user.findUniqueOrThrow.mockResolvedValue({
      email: "student@example.test",
    });
    mocks.createReport.mockResolvedValue({ id: "report-1" });
  });

  it("marks only the reported physical unit unavailable for serious reports", async () => {
    await reportProblem(
      {
        confirmationToken: "token-1",
        reportType: "ITEM_DAMAGED",
        description: "The unit casing is cracked.",
      },
      {
        context: {} as never,
        request: new Request("http://localhost/ioio/ask"),
      }
    );

    expect(mocks.transaction.asset.update).toHaveBeenCalledWith({
      where: { id: "unit-002", organizationId: "team-1" },
      data: { availableToBook: false },
    });
  });

  it("leaves a healthy unit borrowable for a wrong-location report", async () => {
    await reportProblem(
      {
        confirmationToken: "token-1",
        reportType: "WRONG_LOCATION",
        description: "It is stored on Shelf A1.",
      },
      {
        context: {} as never,
        request: new Request("http://localhost/ioio/ask"),
      }
    );

    expect(mocks.transaction.asset.update).not.toHaveBeenCalled();
  });

  it("does not lock or disable a representative unit when no exact unit was reported", async () => {
    mocks.transaction.ioioWriteOperation.findUnique.mockResolvedValue({
      id: "operation-1",
      userId: "student-1",
      organizationId: "team-1",
      status: "PROCESSING",
      resultReportId: null,
      source: "IOIO_STUDENT_REPORT",
      assetId: null,
      kitId: null,
      locationId: null,
    });

    await reportProblem(
      {
        confirmationToken: "token-1",
        reportType: "CANNOT_FIND",
        description: "Makey Kit (exact unit not specified): Cannot find it.",
      },
      {
        context: {} as never,
        request: new Request("http://localhost/ioio/report"),
      }
    );

    expect(mocks.transaction.asset.update).not.toHaveBeenCalled();
  });

  it("rejects a second unresolved report for the same exact unit", async () => {
    mocks.transaction.ioioWriteOperation.findFirst.mockResolvedValue({
      id: "existing-report",
    });

    await expect(
      prepareReportProblem(
        {
          report_type: "ITEM_DAMAGED",
          asset_id: "unit-002",
          description: "The casing is cracked.",
        },
        {
          context: {} as never,
          request: new Request("http://localhost/ioio/report"),
        },
        { source: "IOIO_STUDENT_REPORT" }
      )
    ).rejects.toThrow(
      "This unit has already been reported and is waiting for Staff review."
    );

    expect(mocks.transaction.ioioWriteOperation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: "team-1",
          assetId: "unit-002",
          status: { in: ["SUCCEEDED", "PROCESSING"] },
        }),
      })
    );
    expect(mocks.transaction.ioioWriteOperation.create).not.toHaveBeenCalled();
  });
});
