import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  $transaction: vi.fn(),
  booking: { count: vi.fn(), findMany: vi.fn() },
  bookingAsset: { findMany: vi.fn(), findFirst: vi.fn() },
  asset: { findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
  custody: { findFirst: vi.fn() },
  kit: { findMany: vi.fn() },
  location: { findMany: vi.fn() },
  user: { findMany: vi.fn() },
  ioioWriteOperation: {
    count: vi.fn(),
    findMany: vi.fn(),
    findFirst: vi.fn(),
    updateMany: vi.fn(),
  },
  ioioArchivedItem: { findMany: vi.fn(), findFirst: vi.fn() },
  annualAccessApproval: { count: vi.fn() },
  createNote: vi.fn(),
  recordEvent: vi.fn(),
}));

// why: the status service test verifies classification and duplicate handling
// without requiring a running local database.
vi.mock("~/database/db.server", () => ({ db: database }));
vi.mock("~/modules/note/service.server", () => ({
  createNote: database.createNote,
}));
vi.mock("~/modules/activity-event/service.server", () => ({
  recordEvent: database.recordEvent,
}));

import {
  getLabIssueOperationsHref,
  getLabStatus,
  resolveBrokenAssetOutOfService,
  resolveLabIssue,
  returnBrokenAssetToService,
} from "./lab-status.server";

describe("getLabStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    database.booking.count.mockResolvedValue(0);
    database.booking.findMany.mockResolvedValue([]);
    database.bookingAsset.findMany.mockResolvedValue([]);
    database.bookingAsset.findFirst.mockResolvedValue(null);
    database.asset.findMany.mockResolvedValue([]);
    database.kit.findMany.mockResolvedValue([]);
    database.location.findMany.mockResolvedValue([]);
    database.user.findMany.mockResolvedValue([]);
    database.ioioWriteOperation.findMany.mockResolvedValue([]);
    database.ioioWriteOperation.count.mockResolvedValue(0);
    database.ioioWriteOperation.findFirst.mockResolvedValue(null);
    database.ioioWriteOperation.updateMany.mockResolvedValue({ count: 0 });
    database.ioioArchivedItem.findMany.mockResolvedValue([]);
    database.ioioArchivedItem.findFirst.mockResolvedValue(null);
    database.annualAccessApproval.count.mockResolvedValue(0);
    database.$transaction.mockImplementation((callback) => callback(database));
    database.asset.findFirst.mockResolvedValue(null);
    database.asset.update.mockResolvedValue({});
    database.custody.findFirst.mockResolvedValue(null);
    database.createNote.mockResolvedValue({});
    database.recordEvent.mockResolvedValue({});
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

  it("counts the preparation queue organization on Staff Dashboard", async () => {
    database.ioioWriteOperation.findMany.mockImplementation(({ where }) =>
      Promise.resolve(
        where.organizationId === "team-1" &&
          where.operationType === "IOIO_PREPARATION" &&
          where.status === "PENDING_PREPARATION"
          ? [{ quantity: 2 }]
          : []
      )
    );

    const result = await getLabStatus({
      organizationId: "personal-1",
      preparationOrganizationId: "team-1",
    });

    expect(result.preparationTasks).toBe(2);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ title: "2 items to prepare" })
    );
    expect(database.ioioWriteOperation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: "team-1",
          operationType: "IOIO_PREPARATION",
          status: "PENDING_PREPARATION",
          source: { in: ["IOIO_PREPARATION_REQUEST", "IOIO_ASSISTANT"] },
        }),
      })
    );
  });

  it("uses singular grammar for one preparation unit", async () => {
    database.ioioWriteOperation.findMany.mockImplementation(({ where }) =>
      Promise.resolve(
        where.operationType === "IOIO_PREPARATION" &&
          where.status === "PENDING_PREPARATION"
          ? [{ quantity: 1 }]
          : []
      )
    );

    const result = await getLabStatus({ organizationId: "org-1" });
    expect(result.issues).toContainEqual(
      expect.objectContaining({ title: "1 item to prepare" })
    );
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

  it("keeps Student access approvals in actionable Lab status", async () => {
    database.annualAccessApproval.count.mockResolvedValue(2);

    const result = await getLabStatus({ organizationId: "org-1" });

    expect(result).toMatchObject({
      totalIssues: 1,
      annualAccessApprovals: 2,
      issues: [
        expect.objectContaining({
          kind: "annual-access",
          href: "/operations?view=access-approvals",
        }),
      ],
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

  it("classifies wrong-location reports as General instead of broken items", async () => {
    database.ioioWriteOperation.findMany
      .mockResolvedValueOnce([
        {
          id: "wrong-location",
          source: "IOIO_STUDENT_REPORT",
          reportType: "WRONG_LOCATION",
          assetId: null,
          kitId: null,
          locationId: "location-1",
          bookingAssetId: null,
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    database.location.findMany.mockResolvedValue([
      { id: "location-1", name: "Shelf B", parentId: null },
    ]);

    const result = await getLabStatus({ organizationId: "org-1" });

    expect(result.unresolvedReports).toBe(0);
    expect(result.totalIssues).toBe(1);
    expect(result.generalReports).toBe(1);
    expect(database.ioioWriteOperation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: "org-1",
          operationType: "REPORT_PROBLEM",
          status: "SUCCEEDED",
        },
      })
    );
    expect(result.issues[0]).toMatchObject({
      kind: "general-report",
      title: "Wrong location: Shelf B",
      severity: "attention",
      href: "/operations?view=general",
    });
  });

  it("removes a resolved General report from the current attention total", async () => {
    let reportStatus = "SUCCEEDED";
    const report = {
      id: "wrong-location",
      source: "IOIO_STUDENT_REPORT",
      reportType: "WRONG_LOCATION",
      assetId: null,
      kitId: null,
      locationId: "location-1",
      bookingAssetId: null,
    };
    database.ioioWriteOperation.findMany.mockImplementation(({ where }) =>
      Promise.resolve(
        where.operationType === "REPORT_PROBLEM" &&
          where.status === "SUCCEEDED" &&
          reportStatus === "SUCCEEDED"
          ? [report]
          : []
      )
    );
    database.ioioWriteOperation.findFirst.mockResolvedValue({
      reportType: "WRONG_LOCATION",
      assetId: null,
      kitId: null,
      locationId: "location-1",
    });
    database.ioioWriteOperation.updateMany.mockImplementation(({ where }) => {
      expect(where).toMatchObject({
        organizationId: "org-1",
        operationType: "REPORT_PROBLEM",
        status: "SUCCEEDED",
      });
      reportStatus = "RESOLVED";
      return Promise.resolve({ count: 1 });
    });
    database.location.findMany.mockResolvedValue([
      { id: "location-1", name: "Shelf B", parentId: null },
    ]);

    const before = await getLabStatus({ organizationId: "org-1" });
    expect(before).toMatchObject({ totalIssues: 1, generalReports: 1 });

    await resolveLabIssue({ organizationId: "org-1", operationId: report.id });
    const after = await getLabStatus({ organizationId: "org-1" });

    expect(after).toMatchObject({
      totalIssues: 0,
      generalReports: 0,
      issues: [],
    });
  });

  it("shows product-level Kit incomplete reports in the broken-kit Staff queue", async () => {
    const report = {
      id: "kit-incomplete-1",
      source: "IOIO_STUDENT_REPORT",
      reportType: "KIT_INCOMPLETE",
      assetId: null,
      kitId: "grove-kit",
      locationId: null,
      bookingAssetId: null,
    };
    database.ioioWriteOperation.findMany.mockImplementation(({ where }) =>
      Promise.resolve(where.operationType === "REPORT_PROBLEM" ? [report] : [])
    );
    database.kit.findMany.mockResolvedValue([
      { id: "grove-kit", name: "Grove Kit" },
    ]);

    const result = await getLabStatus({ organizationId: "org-1" });

    expect(result).toMatchObject({
      incompleteKits: 1,
      issues: [
        expect.objectContaining({
          kind: "incomplete-kit",
          title: "Kit incomplete: Grove Kit",
          href: "/operations?view=broken",
          targetUnavailable: false,
        }),
      ],
    });
    expect(database.asset.update).not.toHaveBeenCalled();
  });

  it("does not turn low-quantity assets below their minimum into Lab status issues", async () => {
    database.asset.findMany.mockImplementation(({ where }) => {
      if (where.type === "QUANTITY_TRACKED") {
        return Promise.resolve([
          {
            id: "asset-low-quantity-at-minimum",
            title: "IOIO image upload verification",
            quantity: 1,
            minQuantity: 1,
          },
          {
            id: "asset-below-minimum",
            title: "Low quantity asset",
            quantity: 2,
            minQuantity: 5,
          },
        ]);
      }
      return Promise.resolve([]);
    });

    const result = await getLabStatus({ organizationId: "org-1" });

    expect(result).toMatchObject({
      totalIssues: 0,
      severity: "healthy",
      issues: [],
    });
    expect(
      database.asset.findMany.mock.calls.some(
        ([{ where }]) => where.type === "QUANTITY_TRACKED"
      )
    ).toBe(false);
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
    expect(database.asset.update).not.toHaveBeenCalled();
  });

  it("resolves only the selected report when bulk resolution requests exact rows", async () => {
    database.ioioWriteOperation.findFirst.mockResolvedValue({
      reportType: "ITEM_DAMAGED",
      assetId: "asset-1",
      kitId: null,
      locationId: null,
    });
    database.ioioWriteOperation.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      (await import("./lab-status.server")).resolveLabIssue({
        organizationId: "org-1",
        operationId: "selected-report",
        resolveRelatedReports: false,
      })
    ).resolves.toEqual({ resolvedCount: 1 });

    expect(database.ioioWriteOperation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "selected-report",
          organizationId: "org-1",
          operationType: "REPORT_PROBLEM",
          status: "SUCCEEDED",
        },
        data: expect.objectContaining({ status: "RESOLVED" }),
      })
    );
    expect(database.asset.update).not.toHaveBeenCalled();
  });

  it("surfaces cancelled prepared pickups in Staff status notifications", async () => {
    database.ioioWriteOperation.findMany
      .mockResolvedValueOnce([])
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

  it("counts a damaged return inspection in Broken items", async () => {
    database.ioioWriteOperation.findMany.mockImplementation(({ where }) =>
      Promise.resolve(
        where.operationType === "REPORT_PROBLEM"
          ? [
              {
                id: "broken-return-1",
                source: "IOIO_STAFF_RETURN_INSPECTION",
                userId: "staff-1",
                reportType: "ITEM_DAMAGED",
                assetId: "unit-002",
                kitId: null,
                locationId: null,
                bookingAssetId: null,
              },
            ]
          : []
      )
    );

    const status = await getLabStatus({ organizationId: "org-1" });

    expect(status.unresolvedReports).toBe(1);
    expect(status.issues).toContainEqual(
      expect.objectContaining({
        id: "report:broken-return-1",
        kind: "report",
        title: "Item damaged",
        href: "/operations?view=broken",
      })
    );
  });

  it("shows a Not working student report in Staff Broken items", async () => {
    database.ioioWriteOperation.findMany.mockImplementation(({ where }) =>
      Promise.resolve(
        where.operationType === "REPORT_PROBLEM"
          ? [
              {
                id: "not-working-report-1",
                source: "IOIO_STUDENT_RETURN",
                userId: "student-1",
                reportType: "ITEM_NOT_WORKING",
                assetId: "unit-003",
                kitId: null,
                locationId: null,
                bookingAssetId: "booking-asset-1",
              },
            ]
          : []
      )
    );

    const status = await getLabStatus({ organizationId: "org-1" });

    expect(status.issues).toContainEqual(
      expect.objectContaining({
        id: "report:not-working-report-1",
        kind: "report",
        title: "Item not working",
        href: "/operations?view=broken",
      })
    );
  });

  it("shows Found something in the existing Staff general report queue", async () => {
    database.ioioWriteOperation.findMany.mockImplementation(({ where }) =>
      Promise.resolve(
        where.operationType === "REPORT_PROBLEM"
          ? [
              {
                id: "found-report-1",
                source: "IOIO_STUDENT_REPORT",
                userId: "student-1",
                reportType: "FOUND_SOMETHING",
                assetId: null,
                kitId: null,
                locationId: null,
                bookingAssetId: null,
              },
            ]
          : []
      )
    );

    const status = await getLabStatus({ organizationId: "org-1" });

    expect(status.issues).toContainEqual(
      expect.objectContaining({
        id: "report:found-report-1",
        kind: "general-report",
        title: "Found something",
        href: "/operations?view=general",
      })
    );
  });

  it("maps Lab status issue kinds to their Operations queues centrally", () => {
    const cases = [
      ["overdue-loan", "/operations?view=overdue"],
      ["return-check", "/operations?view=returns"],
      ["returned-with-issue", "/operations?view=returned-with-issues"],
      ["report", "/operations?view=broken"],
      ["incomplete-kit", "/operations?view=broken"],
      ["general-report", "/operations?view=general"],
      ["preparation", "/operations?view=to-prepare"],
      ["cancelled-pickup", "/operations?view=cancelled-pickups"],
      ["ready-for-pickup", "/operations?view=ready-for-pickup"],
      ["annual-access", "/operations?view=access-approvals"],
    ] as const;

    expect(cases.map(([kind]) => getLabIssueOperationsHref(kind))).toEqual(
      cases.map(([, href]) => href)
    );
  });
});

describe("returnBrokenAssetToService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    database.$transaction.mockImplementation((callback) => callback(database));
    database.ioioWriteOperation.findMany.mockResolvedValue([]);
    database.ioioWriteOperation.findFirst.mockResolvedValue(null);
    database.ioioWriteOperation.updateMany.mockResolvedValue({ count: 1 });
    database.asset.findFirst.mockResolvedValue({
      id: "unit-002",
      title: "Makey Kit #002",
      status: "AVAILABLE",
      availableToBook: false,
    });
    database.asset.update.mockResolvedValue({});
    database.custody.findFirst.mockResolvedValue(null);
    database.bookingAsset.findFirst.mockResolvedValue(null);
    database.ioioArchivedItem.findFirst.mockResolvedValue(null);
    database.createNote.mockResolvedValue({});
    database.recordEvent.mockResolvedValue({});
  });

  it("resolves the broken report and makes the repaired asset available", async () => {
    database.ioioWriteOperation.findFirst.mockImplementation(({ where }) =>
      Promise.resolve(
        where.id === "broken-report-1"
          ? {
              id: "broken-report-1",
              assetId: "unit-002",
              reportType: "ITEM_DAMAGED",
            }
          : null
      )
    );
    database.asset.findFirst.mockResolvedValue({
      id: "unit-002",
      title: "Makey Kit #002",
      status: "AVAILABLE",
      availableToBook: false,
    });
    database.ioioWriteOperation.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      returnBrokenAssetToService({
        organizationId: "org-1",
        operationId: "broken-report-1",
        staffUserId: "staff-1",
      })
    ).resolves.toEqual({
      assetId: "unit-002",
      title: "Makey Kit #002",
      status: "AVAILABLE",
    });

    expect(database.ioioWriteOperation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "broken-report-1",
          organizationId: "org-1",
          operationType: "REPORT_PROBLEM",
          status: "SUCCEEDED",
          reportType: "ITEM_DAMAGED",
          assetId: "unit-002",
        }),
        data: expect.objectContaining({ status: "RESOLVED" }),
      })
    );
    expect(database.asset.update).toHaveBeenCalledWith({
      where: { id: "unit-002", organizationId: "org-1" },
      data: { availableToBook: true },
    });
    expect(database.bookingAsset.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          assetId: "unit-002",
          booking: expect.objectContaining({
            OR: [
              {
                description: {
                  not: "IOIO staff reservation",
                },
              },
              { description: null },
            ],
          }),
        }),
      })
    );
  });

  it("resolves the reviewed return report but keeps an unrelated open report blocking", async () => {
    database.ioioWriteOperation.findFirst.mockImplementation(({ where }) =>
      Promise.resolve(
        where.id === "return-issue-report"
          ? {
              id: "return-issue-report",
              assetId: "unit-002",
              reportType: "ITEM_DAMAGED",
            }
          : where.operationType === "REPORT_PROBLEM"
          ? {
              id: "unrelated-problem-report",
              assetId: "unit-002",
              reportType: "ITEM_NOT_WORKING",
              status: "SUCCEEDED",
            }
          : null
      )
    );

    await expect(
      returnBrokenAssetToService({
        organizationId: "org-1",
        operationId: "return-issue-report",
        staffUserId: "staff-1",
      })
    ).rejects.toThrow(
      "Resolve the remaining loan, preparation, report, or archive hold"
    );

    expect(database.ioioWriteOperation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          operationType: "REPORT_PROBLEM",
          id: { not: "return-issue-report" },
        }),
      })
    );
    expect(database.ioioWriteOperation.updateMany).not.toHaveBeenCalled();
    expect(database.asset.update).not.toHaveBeenCalled();
  });

  it("keeps an active loan blocked while resolving a returned issue", async () => {
    database.ioioWriteOperation.findFirst.mockImplementation(({ where }) =>
      Promise.resolve(
        where.id === "return-issue-report"
          ? {
              id: "return-issue-report",
              assetId: "unit-002",
              reportType: "ITEM_DAMAGED",
            }
          : null
      )
    );
    database.bookingAsset.findFirst.mockResolvedValue({ id: "active-loan" });

    await expect(
      returnBrokenAssetToService({
        organizationId: "org-1",
        operationId: "return-issue-report",
        staffUserId: "staff-1",
      })
    ).rejects.toThrow(
      "Resolve the remaining loan, preparation, report, or archive hold"
    );

    expect(database.ioioWriteOperation.updateMany).not.toHaveBeenCalled();
    expect(database.asset.update).not.toHaveBeenCalled();
  });

  it("returns a reported unit after its loan ended despite a stale cancelled pickup", async () => {
    database.ioioWriteOperation.findFirst.mockImplementation(({ where }) =>
      Promise.resolve(
        where.id === "returned-issue-report"
          ? {
              id: "returned-issue-report",
              assetId: "unit-002",
              reportType: "ITEM_DAMAGED",
            }
          : where.operationType === "IOIO_PREPARATION" &&
            where.status.in.includes("CANCELLED_PICKUP")
          ? { id: "stale-cancelled-pickup" }
          : null
      )
    );
    database.ioioWriteOperation.findMany.mockResolvedValue([
      { bookingAssetId: "returned-booking-asset" },
    ]);
    database.bookingAsset.findFirst.mockResolvedValue(null);

    await expect(
      returnBrokenAssetToService({
        organizationId: "org-1",
        operationId: "returned-issue-report",
        staffUserId: "staff-1",
      })
    ).resolves.toMatchObject({
      assetId: "unit-002",
      status: "AVAILABLE",
    });

    expect(database.bookingAsset.findFirst).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          id: { in: ["returned-booking-asset"] },
          assetId: "unit-002",
          checkedInAt: null,
          booking: {
            organizationId: "org-1",
            status: { in: ["RESERVED", "CANCELLED"] },
          },
        }),
      })
    );
    expect(database.asset.update).toHaveBeenCalledWith({
      where: { id: "unit-002", organizationId: "org-1" },
      data: { availableToBook: true },
    });
  });

  it("keeps a cancelled pickup blocked while its reserved unit is still staged", async () => {
    database.ioioWriteOperation.findFirst.mockImplementation(({ where }) =>
      Promise.resolve(
        where.id === "returned-issue-report"
          ? {
              id: "returned-issue-report",
              assetId: "unit-002",
              reportType: "ITEM_DAMAGED",
            }
          : null
      )
    );
    database.ioioWriteOperation.findMany.mockResolvedValue([
      { bookingAssetId: "staged-booking-asset" },
    ]);
    database.bookingAsset.findFirst.mockImplementation(({ where }) =>
      Promise.resolve(
        where.id?.in?.includes("staged-booking-asset")
          ? { id: "staged-booking-asset" }
          : null
      )
    );

    await expect(
      returnBrokenAssetToService({
        organizationId: "org-1",
        operationId: "returned-issue-report",
        staffUserId: "staff-1",
      })
    ).rejects.toThrow(
      "Resolve the remaining loan, preparation, report, or archive hold"
    );

    expect(database.bookingAsset.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { in: ["staged-booking-asset"] },
          checkedInAt: null,
          booking: {
            organizationId: "org-1",
            status: { in: ["RESERVED", "CANCELLED"] },
          },
        }),
      })
    );
    expect(database.asset.update).not.toHaveBeenCalled();
  });

  it("resolves a broken report while leaving its exact unit unavailable", async () => {
    database.ioioWriteOperation.findFirst.mockResolvedValue({
      id: "broken-report-1",
      assetId: "unit-002",
      reportType: "ITEM_DAMAGED",
    });
    database.asset.findFirst.mockResolvedValue({
      id: "unit-002",
      availableToBook: false,
    });
    database.ioioWriteOperation.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      resolveBrokenAssetOutOfService({
        organizationId: "org-1",
        operationId: "broken-report-1",
      })
    ).resolves.toEqual({ assetId: "unit-002", status: "OUT_OF_SERVICE" });

    expect(database.ioioWriteOperation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: "org-1",
          assetId: "unit-002",
          status: "SUCCEEDED",
        }),
        data: expect.objectContaining({ status: "RESOLVED" }),
      })
    );
    expect(database.asset.update).toHaveBeenCalledWith({
      where: { id: "unit-002", organizationId: "org-1" },
      data: { availableToBook: false },
    });
  });

  it("returns an explicitly selected out-of-service unit after its report was resolved", async () => {
    database.asset.findFirst.mockResolvedValue({
      id: "unit-004",
      title: "Makey Kit #004",
      status: "AVAILABLE",
      availableToBook: false,
    });

    await expect(
      (await import("./lab-status.server")).returnResolvedAssetToService({
        organizationId: "org-1",
        assetId: "unit-004",
        staffUserId: "staff-1",
      })
    ).resolves.toEqual({
      assetId: "unit-004",
      title: "Makey Kit #004",
      status: "AVAILABLE",
    });

    expect(database.asset.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "unit-004",
          organizationId: "org-1",
          type: "INDIVIDUAL",
        },
      })
    );
    expect(database.asset.update).toHaveBeenCalledWith({
      where: { id: "unit-004", organizationId: "org-1" },
      data: { availableToBook: true },
    });
    expect(database.ioioWriteOperation.updateMany).not.toHaveBeenCalled();
  });

  it("returns a checked-in unit despite its historical assigned request", async () => {
    database.asset.findFirst.mockResolvedValue({
      id: "unit-004",
      title: "Makey Kit #004",
      status: "AVAILABLE",
      availableToBook: false,
    });
    database.ioioWriteOperation.findFirst.mockImplementation(({ where }) =>
      Promise.resolve(
        where.operationType === "IOIO_PREPARATION" &&
          !where.NOT?.source &&
          where.status.in.includes("ASSIGNED")
          ? { id: "historical-assigned-request" }
          : null
      )
    );

    await expect(
      (await import("./lab-status.server")).returnResolvedAssetToService({
        organizationId: "org-1",
        assetId: "unit-004",
        staffUserId: "staff-1",
      })
    ).resolves.toMatchObject({ assetId: "unit-004", status: "AVAILABLE" });

    expect(database.ioioWriteOperation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          operationType: "IOIO_PREPARATION",
          NOT: { source: "IOIO_PREPARATION_REQUEST", status: "ASSIGNED" },
        }),
      })
    );
    expect(database.asset.update).toHaveBeenCalledWith({
      where: { id: "unit-004", organizationId: "org-1" },
      data: { availableToBook: true },
    });
  });

  it("keeps an active physical preparation task blocking return to service", async () => {
    database.asset.findFirst.mockResolvedValue({
      id: "unit-004",
      title: "Makey Kit #004",
      status: "AVAILABLE",
      availableToBook: false,
    });
    database.ioioWriteOperation.findFirst.mockImplementation(({ where }) =>
      Promise.resolve(
        where.operationType === "IOIO_PREPARATION" &&
          where.status.in.includes("READY_FOR_PICKUP")
          ? { id: "active-physical-preparation" }
          : null
      )
    );

    await expect(
      (await import("./lab-status.server")).returnResolvedAssetToService({
        organizationId: "org-1",
        assetId: "unit-004",
        staffUserId: "staff-1",
      })
    ).rejects.toThrow(
      "Resolve the remaining loan, preparation, report, or archive hold"
    );
    expect(database.asset.update).not.toHaveBeenCalled();
  });

  it("does not return a unit while another blocking issue remains open", async () => {
    database.asset.findFirst.mockResolvedValue({
      id: "unit-004",
      title: "Makey Kit #004",
      status: "AVAILABLE",
      availableToBook: false,
    });
    database.ioioWriteOperation.findFirst.mockResolvedValue({ id: "report-2" });

    await expect(
      (await import("./lab-status.server")).returnResolvedAssetToService({
        organizationId: "org-1",
        assetId: "unit-004",
        staffUserId: "staff-1",
      })
    ).rejects.toThrow(
      "Resolve the remaining loan, preparation, report, or archive hold"
    );

    expect(database.asset.update).not.toHaveBeenCalled();
  });

  it("does not return a unit while an active booking remains", async () => {
    database.asset.findFirst.mockResolvedValue({
      id: "unit-004",
      title: "Makey Kit #004",
      status: "AVAILABLE",
      availableToBook: false,
    });
    database.bookingAsset.findFirst.mockResolvedValue({ id: "active-loan" });

    await expect(
      (await import("./lab-status.server")).returnResolvedAssetToService({
        organizationId: "org-1",
        assetId: "unit-004",
        staffUserId: "staff-1",
      })
    ).rejects.toThrow(
      "Resolve the remaining loan, preparation, report, or archive hold"
    );

    expect(database.asset.update).not.toHaveBeenCalled();
  });
});
