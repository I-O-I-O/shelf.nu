import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assetFindFirst: vi.fn(),
  assetUpdate: vi.fn(),
  custodyFindFirst: vi.fn(),
  bookingAssetFindFirst: vi.fn(),
  userFindUniqueOrThrow: vi.fn(),
  operationCreate: vi.fn(),
  transaction: vi.fn(),
  createNote: vi.fn(),
  createReport: vi.fn(),
  recordEvent: vi.fn(),
}));

// why: this service test verifies the transaction writes and organization
// scope; the production note/report/event services are tested separately.
vi.mock("~/database/db.server", () => ({
  db: { $transaction: mocks.transaction },
}));
vi.mock("~/modules/activity-event/service.server", () => ({
  recordEvent: mocks.recordEvent,
}));
vi.mock("~/modules/note/service.server", () => ({
  createNote: mocks.createNote,
}));
vi.mock("~/modules/report-found/service.server", () => ({
  createReport: mocks.createReport,
}));

import { disableReturnedAssetFromUse } from "./return-inspection.server";

describe("disableReturnedAssetFromUse", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation((callback) =>
      callback({
        asset: {
          findFirst: mocks.assetFindFirst,
          update: mocks.assetUpdate,
        },
        custody: { findFirst: mocks.custodyFindFirst },
        bookingAsset: { findFirst: mocks.bookingAssetFindFirst },
        user: { findUniqueOrThrow: mocks.userFindUniqueOrThrow },
        ioioWriteOperation: { create: mocks.operationCreate },
      })
    );
    mocks.assetFindFirst.mockResolvedValue({
      id: "physical-unit-002",
      title: "Makey Kit #002",
      type: "INDIVIDUAL",
      status: "AVAILABLE",
      availableToBook: true,
    });
    mocks.custodyFindFirst.mockResolvedValue(null);
    mocks.bookingAssetFindFirst.mockResolvedValue(null);
    mocks.userFindUniqueOrThrow.mockResolvedValue({
      email: "staff@example.test",
    });
    mocks.createReport.mockResolvedValue({ id: "report-1" });
  });

  it("disables the exact physical unit and creates the Broken items task", async () => {
    await disableReturnedAssetFromUse({
      assetId: "physical-unit-002",
      organizationId: "org-1",
      userId: "staff-1",
      note: "Broken connector",
    });

    expect(mocks.assetFindFirst).toHaveBeenCalledWith({
      where: { id: "physical-unit-002", organizationId: "org-1" },
      select: {
        id: true,
        title: true,
        type: true,
        status: true,
        availableToBook: true,
      },
    });
    expect(mocks.bookingAssetFindFirst).toHaveBeenCalledWith({
      where: {
        assetId: "physical-unit-002",
        checkedOutAt: { not: null },
        checkedInAt: null,
        booking: {
          organizationId: "org-1",
          status: { in: ["ONGOING", "OVERDUE"] },
        },
      },
      select: { id: true },
    });
    expect(mocks.assetUpdate).toHaveBeenCalledWith({
      where: { id: "physical-unit-002", organizationId: "org-1" },
      data: { availableToBook: false },
    });
    expect(mocks.operationCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        operationType: "REPORT_PROBLEM",
        source: "IOIO_STAFF_RETURN_INSPECTION",
        status: "SUCCEEDED",
        reportType: "ITEM_DAMAGED",
        assetId: "physical-unit-002",
        organizationId: "org-1",
      }),
    });
    expect(mocks.createReport).toHaveBeenCalledWith(
      expect.objectContaining({
        assetId: "physical-unit-002",
        content: expect.stringContaining("Broken connector"),
      })
    );
  });

  it("still blocks a unit that has an active physical checkout", async () => {
    mocks.bookingAssetFindFirst.mockResolvedValue({ id: "active-loan" });

    await expect(
      disableReturnedAssetFromUse({
        assetId: "physical-unit-002",
        organizationId: "org-1",
        userId: "staff-1",
      })
    ).rejects.toThrow("still checked out or assigned");

    expect(mocks.assetUpdate).not.toHaveBeenCalled();
    expect(mocks.operationCreate).not.toHaveBeenCalled();
  });
});
