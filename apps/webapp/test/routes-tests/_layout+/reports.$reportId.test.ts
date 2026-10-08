import type { LoaderFunctionArgs } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLoaderArgs } from "@mocks/remix";
import { loader as reportLoader } from "~/routes/_layout+/reports.$reportId";

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  resolveTimeframe: vi.fn(),
  bookingComplianceReport: vi.fn(),
  overdueItemsReport: vi.fn(),
  idleAssetsReport: vi.fn(),
  custodySnapshotReport: vi.fn(),
  topBookedAssetsReport: vi.fn(),
  topBookedKitsReport: vi.fn(),
  assetDistributionReport: vi.fn(),
  assetInventoryReport: vi.fn(),
  monthlyBookingTrendsReport: vi.fn(),
  assetUtilizationReport: vi.fn(),
  assetActivityReport: vi.fn(),
  resolveUserFormatPrefsById: vi.fn(),
  getClientHint: vi.fn(),
}));

// why: report helpers are database-backed; this route test verifies how the loader scopes and combines their results.
vi.mock("~/modules/reports/helpers.server", () => ({
  resolveTimeframe: mocks.resolveTimeframe,
  bookingComplianceReport: mocks.bookingComplianceReport,
  overdueItemsReport: mocks.overdueItemsReport,
  idleAssetsReport: mocks.idleAssetsReport,
  custodySnapshotReport: mocks.custodySnapshotReport,
  topBookedAssetsReport: mocks.topBookedAssetsReport,
  topBookedKitsReport: mocks.topBookedKitsReport,
  assetDistributionReport: mocks.assetDistributionReport,
  assetInventoryReport: mocks.assetInventoryReport,
  monthlyBookingTrendsReport: mocks.monthlyBookingTrendsReport,
  assetUtilizationReport: mocks.assetUtilizationReport,
  assetActivityReport: mocks.assetActivityReport,
}));

// why: permissions and user format preferences are external to report composition.
vi.mock("~/utils/roles.server", () => ({
  requirePermission: mocks.requirePermission,
}));
vi.mock("~/utils/date-format.server", () => ({
  resolveUserFormatPrefsById: mocks.resolveUserFormatPrefsById,
}));
vi.mock("~/utils/client-hints", () => ({
  getClientHint: mocks.getClientHint,
}));

describe("IOIO combined Asset Usage & Distribution report", () => {
  const context = {
    getSession: () => ({ userId: "staff-1" }),
  } as LoaderFunctionArgs["context"];
  const timeframe = {
    preset: "last_90d",
    label: "Last 90 days",
    from: new Date("2026-07-01T00:00:00.000Z"),
    to: new Date("2026-09-29T23:59:59.999Z"),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requirePermission.mockResolvedValue({
      organizationId: "team-1",
      currentOrganization: { currency: "DKK" },
    });
    mocks.resolveTimeframe.mockReturnValue(timeframe);
    mocks.getClientHint.mockReturnValue({});
    mocks.resolveUserFormatPrefsById.mockResolvedValue({
      dateFormat: "DD/MM/YYYY",
      timeFormat: "24h",
      timeZone: "Europe/Copenhagen",
      weekStartsOn: 1,
    });
    mocks.assetUtilizationReport.mockResolvedValue({
      report: { id: "asset-utilization", title: "Usage", description: "" },
      filters: { timeframe, filters: [] },
      kpis: [
        {
          id: "avg_utilization",
          label: "Average usage",
          value: "0%",
          rawValue: 0,
        },
      ],
      rows: [],
      computedMs: 3,
      totalRows: 0,
      page: 2,
      pageSize: 10,
    });
    mocks.assetDistributionReport.mockResolvedValue({
      report: { id: "distribution", title: "Distribution", description: "" },
      filters: { timeframe, filters: [] },
      kpis: [
        { id: "total_assets", label: "Total assets", value: "0", rawValue: 0 },
      ],
      rows: [],
      computedMs: 4,
      totalRows: 0,
      page: 1,
      pageSize: 10000,
      distributionBreakdown: {
        byCategory: [],
        byLocation: [],
        byStatus: [],
      },
    });
  });

  it("combines usage and distribution with the selected filters and organization scope", async () => {
    const args = createLoaderArgs({
      context,
      request: new Request(
        "http://localhost/reports/asset-usage-distribution?timeframe=last_90d&category=cat-1&location=loc-1&page=2&pageSize=10"
      ),
      params: { reportId: "asset-usage-distribution" },
    });

    const result = await reportLoader(args);

    expect(mocks.requirePermission).toHaveBeenCalledOnce();
    expect(mocks.assetUtilizationReport).toHaveBeenCalledWith({
      organizationId: "team-1",
      timeframe,
      categoryId: "cat-1",
      locationId: "loc-1",
      page: 2,
      pageSize: 10,
    });
    expect(mocks.assetDistributionReport).toHaveBeenCalledWith({
      organizationId: "team-1",
      currency: "DKK",
      page: 1,
      pageSize: 10000,
    });
    expect(result).toMatchObject({
      data: {
        reportId: "asset-usage-distribution",
        report: { title: "Asset Usage & Distribution" },
        distributionKpis: expect.any(Array),
        distributionBreakdown: {
          byCategory: [],
          byLocation: [],
          byStatus: [],
        },
      },
    });
  });
});
