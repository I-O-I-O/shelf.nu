import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  asset: { findFirst: vi.fn() },
  kit: { findFirst: vi.fn() },
  location: { findFirst: vi.fn() },
  user: { findUniqueOrThrow: vi.fn() },
  ioioWriteOperation: {
    create: vi.fn(),
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

import { prepareReportProblem, reportProblem } from "./report-problem.server";

const context = {};
const request = new Request("http://localhost/ioio/ask");
const authA = {
  userId: "user-a",
  organizationId: "org-a",
  role: "SELF_SERVICE",
};

describe("Milestone 12 durable report safeguards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireStudentReadMock.mockResolvedValue(authA);
    dbMock.asset.findFirst.mockResolvedValue(null);
    dbMock.kit.findFirst.mockResolvedValue(null);
    dbMock.location.findFirst.mockResolvedValue(null);
    dbMock.ioioWriteOperation.create.mockResolvedValue({ id: "op-1" });
    dbMock.ioioWriteOperation.update.mockResolvedValue({});
    enforceRateLimitMock.mockResolvedValue(undefined);
  });

  it.each([
    ["asset", { asset_id: "asset-from-org-b" }],
    ["kit", { kit_id: "kit-from-org-b" }],
    ["location", { location_id: "location-from-org-b" }],
  ])(
    "rejects a %s reference that is not visible in the authenticated organization",
    async (_label, reference) => {
      await expect(
        prepareReportProblem(
          {
            report_type: "ITEM_DAMAGED",
            ...reference,
            description: "The item is damaged",
          },
          { context, request }
        )
      ).rejects.toMatchObject({ status: 403 });
      expect(dbMock.ioioWriteOperation.create).not.toHaveBeenCalled();
    }
  );

  it("allows the existing ADMIN role to prepare the same report workflow", async () => {
    requireStudentReadMock.mockResolvedValue({ ...authA, role: "ADMIN" });

    await expect(
      prepareReportProblem(
        { report_type: "OTHER", description: "Staff test report" },
        { context, request }
      )
    ).resolves.toMatchObject({ reportType: "OTHER" });
    expect(dbMock.ioioWriteOperation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: authA.userId,
          organizationId: authA.organizationId,
          status: "PREPARED",
        }),
      })
    );
  });

  it("rejects a confirmation token bound to another organization before any write", async () => {
    dbMock.ioioWriteOperation.findUnique.mockResolvedValue({
      id: "op-1",
      userId: "user-b",
      organizationId: "org-b",
      status: "PREPARED",
      resultReportId: null,
    });

    await expect(
      reportProblem(
        {
          confirmationToken: "token-from-org-b",
          reportType: "ITEM_DAMAGED",
          description: "The item is damaged",
        },
        { context, request }
      )
    ).rejects.toMatchObject({ status: 403 });
    expect(enforceRateLimitMock).not.toHaveBeenCalled();
    expect(dbMock.$transaction).not.toHaveBeenCalled();
  });

  it("returns the existing result for a replayed successful operation", async () => {
    dbMock.ioioWriteOperation.findUnique.mockResolvedValue({
      id: "op-1",
      userId: authA.userId,
      organizationId: authA.organizationId,
      status: "SUCCEEDED",
      resultReportId: "report-1",
    });

    await expect(
      reportProblem(
        {
          confirmationToken: "already-used-token",
          reportType: "ITEM_DAMAGED",
          description: "The item is damaged",
        },
        { context, request }
      )
    ).resolves.toEqual({
      ok: true,
      status: "duplicate",
      reportId: "report-1",
    });
    expect(enforceRateLimitMock).not.toHaveBeenCalled();
    expect(createReportMock).not.toHaveBeenCalled();
  });

  it("claims the durable operation before creating the native report", async () => {
    dbMock.ioioWriteOperation.findUnique
      .mockResolvedValueOnce({
        id: "op-1",
        userId: authA.userId,
        organizationId: authA.organizationId,
        status: "PREPARED",
        resultReportId: null,
        createdAt: new Date(),
      })
      .mockResolvedValueOnce({
        id: "op-1",
        userId: authA.userId,
        organizationId: authA.organizationId,
        status: "PROCESSING",
        resultReportId: null,
        assetId: null,
        kitId: null,
        locationId: null,
      });
    dbMock.ioioWriteOperation.updateMany.mockResolvedValue({ count: 1 });
    dbMock.user.findUniqueOrThrow.mockResolvedValue({
      email: "ioio.student@example.test",
    });
    createReportMock.mockResolvedValue({ id: "report-1" });
    dbMock.$transaction.mockImplementation((callback) => callback(dbMock));

    await expect(
      reportProblem(
        {
          confirmationToken: "prepared-token",
          reportType: "ITEM_DAMAGED",
          description: "The item is damaged",
        },
        { context, request }
      )
    ).resolves.toEqual({ ok: true, status: "submitted", reportId: "report-1" });
    expect(dbMock.ioioWriteOperation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "PREPARED" }),
        data: expect.objectContaining({ status: "PROCESSING" }),
      })
    );
    expect(createReportMock).toHaveBeenCalledWith(
      expect.objectContaining({
        client: dbMock,
        assetId: undefined,
        kitId: undefined,
      })
    );
    expect(dbMock.ioioWriteOperation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "SUCCEEDED",
          resultReportId: "report-1",
        }),
      })
    );
  });
});
