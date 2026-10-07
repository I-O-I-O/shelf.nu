import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLoaderArgs } from "@mocks/remix";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  requirePermission: vi.fn(),
  getDashboardLabTasks: vi.fn(),
  getTAHours: vi.fn(),
  getPurchasing: vi.fn(),
}));

// why: the loader's database reads are mocked so the fresh-organization case
// can be verified without needing a seeded database.
vi.mock("~/database/db.server", () => ({
  db: {
    user: { findUnique: mocks.findUnique },
  },
}));
// why: route error components import scanner animation code that touches
// canvas APIs unavailable in happy-dom at module initialization.
vi.mock("lottie-react", () => ({ default: () => null }));
vi.mock("~/utils/roles.server", () => ({
  requirePermission: mocks.requirePermission,
}));
vi.mock("~/modules/ioio-staff/lab-tasks.server", () => ({
  getDashboardLabTasks: mocks.getDashboardLabTasks,
}));
vi.mock("~/modules/ioio-staff/ta-hours.server", () => ({
  getTAHoursDashboardSummary: mocks.getTAHours,
}));
vi.mock("~/modules/ioio-staff/purchasing.server", () => ({
  getPurchasingDashboardSummary: mocks.getPurchasing,
}));

import { loader } from "~/routes/_layout+/home";

describe("IOIO staff dashboard loader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requirePermission.mockResolvedValue({
      organizationId: "org-1",
      role: "OWNER",
    });
    mocks.getDashboardLabTasks.mockResolvedValue({ openCount: 0, tasks: [] });
    mocks.getTAHours.mockResolvedValue({
      academicYear: "2026-2027",
      totalHoursBudget: 0,
      allocatedHours: 0,
      workedHours: 0,
      unallocatedHours: 0,
      scheduledHours: 0,
      scheduledThisWeek: 0,
      awaitingConfirmationCount: 0,
      personalAllocatedHours: 0,
      personalWorkedHours: 0,
      personalHoursBalance: 0,
      personalRecentShift: null,
    });
    mocks.getPurchasing.mockResolvedValue({
      academicYear: "2026-2027",
      currency: "SEK",
      budget: 0,
      spent: 0,
      openRequests: 0,
    });
    mocks.findUnique.mockResolvedValue({ staffDashboardPreferences: null });
  });

  it("loads a fresh organization with empty operational data", async () => {
    const result = (await loader(
      createLoaderArgs({
        context: { getSession: () => ({ userId: "user-1" }) } as never,
        request: new Request("http://localhost/home"),
      })
    )) as unknown as {
      isStaff: boolean;
      labTasks: { openCount: number; tasks: unknown[] };
      purchasing: { budget: number; spent: number; openRequests: number };
      taHours: {
        totalHoursBudget: number;
        personalAllocatedHours: number;
        awaitingConfirmationCount: number;
      };
      dashboardPreferences: { hidden: string[] };
    };

    expect(result.isStaff).toBe(true);
    expect(result.labTasks).toEqual({ openCount: 0, tasks: [] });
    expect(result.purchasing).toMatchObject({
      budget: 0,
      spent: 0,
      openRequests: 0,
    });
    expect(result.taHours).toMatchObject({
      totalHoursBudget: 0,
      personalAllocatedHours: 0,
      awaitingConfirmationCount: 0,
    });
    expect(result.dashboardPreferences.hidden).toEqual([]);
  });
});
