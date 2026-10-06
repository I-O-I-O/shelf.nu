import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  booking: { count: vi.fn(), findMany: vi.fn() },
  bookingAsset: { findMany: vi.fn() },
  asset: { findMany: vi.fn() },
  kit: { findMany: vi.fn() },
  location: { findMany: vi.fn() },
  user: { findMany: vi.fn() },
  ioioWriteOperation: {
    count: vi.fn(),
    findMany: vi.fn(),
    findFirst: vi.fn(),
    updateMany: vi.fn(),
  },
  ioioArchivedItem: { findMany: vi.fn() },
  annualAccessApproval: { count: vi.fn() },
}));

// why: the status service test verifies classification and duplicate handling
// without requiring a running local database.
vi.mock("~/database/db.server", () => ({ db: database }));

import { getLabStatus } from "./lab-status.server";

describe("getLabStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    database.booking.count.mockResolvedValue(0);
    database.booking.findMany.mockResolvedValue([]);
    database.bookingAsset.findMany.mockResolvedValue([]);
    database.asset.findMany.mockResolvedValue([]);
    database.kit.findMany.mockResolvedValue([]);
    database.location.findMany.mockResolvedValue([]);
    database.user.findMany.mockResolvedValue([]);
    database.ioioWriteOperation.findMany.mockResolvedValue([]);
    database.ioioWriteOperation.count.mockResolvedValue(0);
    database.ioioWriteOperation.findFirst.mockResolvedValue(null);
    database.ioioWriteOperation.updateMany.mockResolvedValue({ count: 0 });
    database.ioioArchivedItem.findMany.mockResolvedValue([]);
    database.annualAccessApproval.count.mockResolvedValue(0);
  });

  it("returns a healthy status when Shelf has no actionable records", async () => {
    await expect(
      getLabStatus({ organizationId: "org-1" })
    ).resolves.toMatchObject({
      totalIssues: 0,
      severity: "healthy",
      overdueLoans: 0,
      issues: [],
    });
  });

  it("keeps ready pickups as current activity, not as issues needing attention", async () => {
    database.ioioWriteOperation.count.mockImplementation(({ where }) =>
      Promise.resolve(where.status === "READY_FOR_PICKUP" ? 1 : 0)
    );

    await expect(
      getLabStatus({ organizationId: "org-1" })
    ).resolves.toMatchObject({
      totalIssues: 0,
      severity: "healthy",
      readyForPickup: 1,
      issues: [],
    });
  });

  it("separates problem returns from ordinary return checks without double-counting the report", async () => {
    database.ioioWriteOperation.findMany.mockImplementation(({ where }) => {
      if (where.operationType === "RETURN_ITEM") {
        return Promise.resolve([
          {
            id: "return-normal",
            assetId: "asset-1",
            bookingAssetId: "booking-asset-normal",
            reportType: "RETURN_ITEM",
            description: "Return submitted. Waiting for staff check.",
            locationId: "return-zone",
          },
          {
            id: "return-issue",
            assetId: "asset-1",
            bookingAssetId: "booking-asset-issue",
            reportType: "ITEM_DAMAGED",
            description:
              "Return submitted. Issue reported: ITEM_DAMAGED. Cable is loose.",
            locationId: "broken-zone",
          },
        ]);
      }
      if (where.operationType === "REPORT_PROBLEM") {
        return Promise.resolve([
          {
            id: "issue-report",
            source: "IOIO_STUDENT_RETURN",
            reportType: "ITEM_DAMAGED",
            assetId: "asset-1",
            kitId: null,
            locationId: "broken-zone",
            bookingAssetId: "booking-asset-issue",
          },
        ]);
      }
      return Promise.resolve([]);
    });
    database.bookingAsset.findMany.mockResolvedValue([
      {
        id: "booking-asset-normal",
        checkedInAt: null,
        asset: { returnHandling: "RETURN_TO_RETURN_ZONE" },
      },
      {
        id: "booking-asset-issue",
        checkedInAt: null,
        asset: { returnHandling: "RETURN_TO_RETURN_ZONE" },
      },
    ]);
    database.asset.findMany.mockImplementation(({ where }) =>
      Promise.resolve(
        where.id?.in?.length ? [{ id: "asset-1", title: "Makey Kit" }] : []
      )
    );

    const result = await getLabStatus({ organizationId: "org-1" });

    expect(result.returnChecks).toBe(1);
    expect(result.returnedWithIssues).toBe(1);
    expect(result.unresolvedReports).toBe(0);
    expect(result.issues.map((issue) => issue.id)).toEqual([
      "return-check:return-normal",
      "returned-with-issue:return-issue",
    ]);
  });

  it("deduplicates low-stock logical items and separates incomplete kits", async () => {
    database.booking.count.mockResolvedValue(1);
    database.booking.findMany.mockResolvedValue([
      { id: "booking-1", name: "Arduino checkout", to: new Date("2026-09-08") },
    ]);
    database.asset.findMany.mockResolvedValue([
      {
        id: "asset-1",
        title: "Arduino Nano",
        quantity: 2,
        minQuantity: 3,
        availableToBook: true,
        updatedAt: new Date("2026-09-08"),
        category: { name: "Boards & Embedded Systems" },
        assetLocations: [{ location: { name: "Container A1-13" } }],
      },
      {
        id: "asset-duplicate",
        title: "Arduino Nano",
        quantity: 1,
        minQuantity: 3,
        availableToBook: false,
        updatedAt: new Date("2026-09-07"),
        category: { name: "Boards & Embedded Systems" },
        assetLocations: [],
      },
    ]);
    database.ioioWriteOperation.findMany
      .mockResolvedValueOnce([
        {
          id: "report-1",
          reportType: "KIT_INCOMPLETE",
          assetId: null,
          kitId: "kit-1",
          locationId: null,
        },
        {
          id: "report-older",
          reportType: "KIT_INCOMPLETE",
          assetId: null,
          kitId: "kit-1",
          locationId: null,
        },
      ])
      .mockResolvedValueOnce([]);
    database.kit.findMany.mockResolvedValue([
      { id: "kit-1", name: "Arduino Kit #014" },
    ]);

    const result = await getLabStatus({ organizationId: "org-1" });

    expect(result.totalIssues).toBe(3);
    expect(result.lowStock).toBe(1);
    expect(result.incompleteKits).toBe(1);
    expect(result.unresolvedReports).toBe(0);
    expect(result.overdueLoans).toBe(1);
    expect(result.issues.map((issue) => issue.id)).toEqual([
      "report:report-1",
      "overdue-loan:booking-1",
      "low-stock:asset-1",
    ]);
    expect(result.issues.join()).not.toContain("asset-duplicate");
  });

  it("resolves all active duplicate reports for the same task reference", async () => {
    database.ioioWriteOperation.findFirst.mockResolvedValue({
      reportType: "ITEM_DAMAGED",
      assetId: "asset-1",
      kitId: null,
      locationId: null,
    });
    database.ioioWriteOperation.updateMany.mockResolvedValue({ count: 2 });

    await expect(
      (await import("./lab-status.server")).resolveLabIssue({
        organizationId: "org-1",
        operationId: "report-1",
      })
    ).resolves.toEqual({ resolvedCount: 2 });

    expect(database.ioioWriteOperation.findFirst).toHaveBeenCalledWith({
      where: {
        id: "report-1",
        organizationId: "org-1",
        operationType: "REPORT_PROBLEM",
        status: "SUCCEEDED",
      },
      select: {
        reportType: true,
        assetId: true,
        kitId: true,
        locationId: true,
      },
    });
    expect(database.ioioWriteOperation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: "org-1",
          operationType: "REPORT_PROBLEM",
          status: "SUCCEEDED",
          reportType: "ITEM_DAMAGED",
          assetId: "asset-1",
          kitId: null,
          locationId: null,
        }),
        data: expect.objectContaining({ status: "RESOLVED" }),
      })
    );
  });

  it("surfaces cancelled prepared pickups in Staff status notifications", async () => {
    database.ioioWriteOperation.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "pickup-1",
          userId: "student-1",
          assetId: "asset-1",
        },
      ]);
    database.asset.findMany.mockImplementation((args) =>
      args?.where?.id?.in?.includes("asset-1")
        ? [{ id: "asset-1", title: "Makey Kit #001" }]
        : []
    );
    database.user.findMany.mockResolvedValue([
      {
        id: "student-1",
        email: "student@example.test",
        displayName: "IOIO Student",
        firstName: null,
        lastName: null,
      },
    ]);

    const status = await getLabStatus({ organizationId: "org-1" });

    expect(status.cancelledPickups).toBe(1);
    expect(status.issues).toContainEqual(
      expect.objectContaining({
        id: "cancelled-pickup:pickup-1",
        title: "Makey Kit #001 needs to be put back",
        detail: expect.stringContaining("IOIO Student cancelled"),
        href: "/operations?view=cancelled-pickups",
      })
    );
  });
});
