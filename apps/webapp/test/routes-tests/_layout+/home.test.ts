import { createElement } from "react";
import { render, screen, within } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createActionArgs, createLoaderArgs } from "@mocks/remix";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  requirePermission: vi.fn(),
  getDashboardLabTasks: vi.fn(),
  getTAHours: vi.fn(),
  getPurchasing: vi.fn(),
  getStaffSystemStatus: vi.fn(),
  countPendingHandbookReviews: vi.fn(),
  applyStaffInventoryImport: vi.fn(),
  skipStaffInventoryImportRow: vi.fn(),
  getStaffInventoryImportProposal: vi.fn(),
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
// why: render the Home route's dashboard structure without mounting its independent dialogs and import workflow.
vi.mock("~/components/ioio-staff/dashboard-customizer", () => ({
  DashboardCustomizer: () => null,
}));
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
// why: dashboard status probes use server health/storage resources that this
// route payload test should not touch.
vi.mock("~/modules/ioio-staff/system-status.server", () => ({
  getStaffSystemStatus: mocks.getStaffSystemStatus,
}));
// why: the Home route delegates import execution to the same import engine as
// /staff/import; isolate route payload wiring from the database-backed engine.
vi.mock("~/modules/ioio-staff/inventory-import.server", () => ({
  applyStaffInventoryImport: mocks.applyStaffInventoryImport,
  skipStaffInventoryImportRow: mocks.skipStaffInventoryImportRow,
  cancelStaffInventoryImport: vi.fn(),
  getStaffInventoryImportProposal: mocks.getStaffInventoryImportProposal,
  prepareStaffInventoryImport: vi.fn(),
}));

// why: the dashboard loader delegates the canonical database count to Handbook;
// isolate route authorization and fresh-load wiring from a live database.
vi.mock("~/modules/ioio-handbook/service.server", () => ({
  countPendingHandbookReviews: mocks.countPendingHandbookReviews,
}));

import HomePage, { action, loader } from "~/routes/_layout+/home";

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
    mocks.getStaffSystemStatus.mockResolvedValue({
      server: "online",
      storagePercentUsed: 63,
      claude: "unavailable",
    });
    mocks.findUnique.mockResolvedValue({ staffDashboardPreferences: null });
    mocks.countPendingHandbookReviews.mockResolvedValue(0);
  });

  it("routes draft removal separately from inventory Apply", async () => {
    mocks.skipStaffInventoryImportRow.mockResolvedValue({
      operationId: "operation-1",
      rowNumber: 45,
    });
    mocks.getStaffInventoryImportProposal.mockResolvedValue({
      operationId: "operation-1",
      ignoredRowNumbers: [45],
      appliedRowNumbers: Array.from({ length: 44 }, (_, index) => index + 1),
      reviewClosed: true,
    });
    const form = new FormData();
    form.set("intent", "skip-row");
    form.set("operationId", "operation-1");
    form.set("proposalHash", "hash");
    form.set("rowNumber", "45");
    const result = await action(
      createActionArgs({
        request: new Request("http://localhost/staff/import", {
          method: "POST",
          body: form,
        }),
        context: { getSession: () => ({ userId: "staff-1" }) } as never,
      })
    );
    expect(mocks.skipStaffInventoryImportRow).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: "operation-1",
        proposalHash: "hash",
        rowNumber: 45,
      })
    );
    expect(mocks.applyStaffInventoryImport).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      error: null,
      kind: "import-row-skipped",
      proposal: { ignoredRowNumbers: [45], reviewClosed: true },
    });
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
      systemStatus: {
        server: string;
        storagePercentUsed: number;
        claude: string;
      };
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
    expect(result.systemStatus).toEqual({
      server: "online",
      storagePercentUsed: 63,
      claude: "unavailable",
    });
  });

  it("does not load staff system status for students", async () => {
    mocks.requirePermission.mockResolvedValue({
      organizationId: "org-1",
      role: "USER",
    });

    const result = (await loader(
      createLoaderArgs({
        context: { getSession: () => ({ userId: "student-1" }) } as never,
        request: new Request("http://localhost/home"),
      })
    )) as unknown as {
      isStaff: boolean;
      systemStatus: unknown;
      pendingHandbookReviews: unknown;
    };

    expect(result.isStaff).toBe(false);
    expect(result.pendingHandbookReviews).toBeNull();
    expect(mocks.countPendingHandbookReviews).not.toHaveBeenCalled();
    expect(result.systemStatus).toBeNull();
    expect(mocks.getStaffSystemStatus).not.toHaveBeenCalled();
  });

  it("reloads the canonical pending count each time staff opens the dashboard", async () => {
    mocks.countPendingHandbookReviews
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(0);
    const args = () =>
      createLoaderArgs({
        context: { getSession: () => ({ userId: "staff-1" }) } as never,
        request: new Request("http://localhost/home"),
      });
    expect(await loader(args())).toMatchObject({ pendingHandbookReviews: 3 });
    expect(await loader(args())).toMatchObject({ pendingHandbookReviews: 0 });
    expect(mocks.countPendingHandbookReviews).toHaveBeenCalledWith("org-1");
    expect(mocks.countPendingHandbookReviews).toHaveBeenCalledTimes(2);
  });

  it("returns readiness issues from the legacy Home import handler", async () => {
    mocks.applyStaffInventoryImport.mockResolvedValue({
      status: "NEEDS_REVIEW",
      operationId: "operation-1",
      readyCount: 0,
      blockedCount: 1,
      blockedRows: [
        {
          rowNumber: 2,
          title: "Arduino Nano",
          issues: [
            {
              code: "MISSING_CATEGORY",
              message:
                "Arduino Nano needs a category before it can be imported.",
            },
          ],
        },
      ],
    });
    const form = new FormData();
    form.set("intent", "apply-import");
    form.set("operationId", "operation-1");
    form.set("proposalHash", "hash");
    form.set("reviewDecisions", "[]");
    const result = await action(
      createActionArgs({
        request: new Request("http://localhost/home", {
          method: "POST",
          body: form,
        }),
        context: { getSession: () => ({ userId: "staff-1" }) } as never,
      })
    );
    expect(result).toMatchObject({
      kind: "import-review-blocked",
      blockedRows: [{ rowNumber: 2, issues: [{ code: "MISSING_CATEGORY" }] }],
    });
  });

  it("routes the Home Apply form to the shared import engine", async () => {
    const resultData = {
      operationId: "operation-1",
      createdIds: ["asset-1"],
      updatedIds: [],
      reusedIds: [],
      failedRows: [],
      conflictRows: [],
      totalRows: 1,
      succeededRows: 1,
      failedRowsCount: 0,
      conflictedRowsCount: 0,
      ignoredRows: 0,
    };
    mocks.applyStaffInventoryImport.mockResolvedValue(resultData);
    mocks.getStaffInventoryImportProposal.mockResolvedValue({
      appliedRowNumbers: [1],
    });
    const form = new FormData();
    form.set("intent", "apply-import");
    form.set("operationId", "operation-1");
    form.set("proposalHash", "reviewed-hash");
    form.set("reviewDecisions", JSON.stringify([{ rowNumber: 1 }]));
    const request = new Request("http://localhost/home", {
      method: "POST",
      body: form,
    });

    const result = await action(
      createActionArgs({
        request,
        context: { getSession: () => ({ userId: "staff-1" }) } as never,
      })
    );

    expect(mocks.applyStaffInventoryImport).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: "operation-1",
        proposalHash: "reviewed-hash",
        reviewDecisions: expect.any(String),
      })
    );
    expect(result).toMatchObject({
      error: null,
      kind: "import-complete",
      proposal: { appliedRowNumbers: [1] },
      result: resultData,
    });
  });
});

describe("IOIO staff dashboard inventory shortcuts", () => {
  it("shows compact Import and Organize cards without the old explanation", async () => {
    const Stub = createRoutesStub([
      {
        path: "/home",
        Component: HomePage,
        HydrateFallback: () => createElement("div", null, "Loading dashboard"),
        loader: () => ({
          isStaff: true,
          dashboardPreferences: { order: ["inventory_import"], hidden: [] },
          labTasks: null,
          purchasing: null,
          taHours: null,
        }),
      },
    ]);

    render(createElement(Stub, { initialEntries: ["/home"] }));

    expect(
      await screen.findByRole("heading", { name: "Import", level: 2 })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Import inventory" })
    ).toHaveAttribute("href", "/staff/import");
    expect(
      screen.getByRole("heading", { name: "Organize", level: 2 })
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Organize" })).toHaveAttribute(
      "href",
      "/staff/organize"
    );
    expect(screen.queryByText("Inventory tools")).not.toBeInTheDocument();
    expect(screen.queryByText("How the AI works")).not.toBeInTheDocument();
    expect(screen.queryByText("Works best for")).not.toBeInTheDocument();
  });
});

describe("staff dashboard Lab status hierarchy", () => {
  function renderDashboard(isStaff: boolean, pendingHandbookReviews = 0) {
    const Stub = createRoutesStub([
      {
        id: "routes/_layout+/_layout",
        path: "/",
        loader: () => ({
          labStatus: {
            totalIssues: 0,
            severity: "healthy",
            overdueLoans: 0,
            unresolvedReports: 0,
            generalReports: 0,
            incompleteKits: 0,
            importWarnings: 0,
            pendingReservationRequests: 0,
            returnChecks: 0,
            returnedWithIssues: 0,
            preparationTasks: 0,
            cancelledPickups: 0,
            readyForPickup: 0,
            annualAccessApprovals: 0,
            issues: [],
          },
        }),
        children: [
          {
            path: "home",
            Component: HomePage,
            loader: () => ({
              isStaff,
              pendingHandbookReviews,
              dashboardPreferences: { order: ["operations"], hidden: [] },
              labTasks: null,
              purchasing: null,
              taHours: null,
              systemStatus: isStaff
                ? {
                    server: "online",
                    storagePercentUsed: 63,
                    claude: "unavailable",
                  }
                : null,
            }),
          },
        ],
      },
    ]);
    return render(createElement(Stub, { initialEntries: ["/home"] }));
  }

  it("keeps System status above Lab status and places reviews only in its operational grid", async () => {
    renderDashboard(true, 3);
    const lab = await screen.findByRole("region", { name: "Lab status" });
    const status = screen.getByRole("region", { name: "System status" });
    expect(status).toHaveTextContent(/Server\s*Online/u);
    expect(status).toHaveTextContent(/Storage\s*63% used/u);
    expect(status).toHaveTextContent(/Claude\s*Unavailable/u);
    expect(within(status).queryByText("Handbook reviews")).toBeNull();
    expect(status.querySelectorAll("a, button")).toHaveLength(0);
    expect(
      status.compareDocumentPosition(lab) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(lab.contains(status)).toBe(false);
    expect(
      within(lab).getByRole("link", { name: /Handbook reviews/ })
    ).toHaveTextContent("3");
    expect(
      screen.getAllByRole("link", { name: /Handbook reviews/ })
    ).toHaveLength(1);
    expect(screen.getAllByRole("region", { name: "Lab status" })).toHaveLength(
      1
    );
    expect(
      screen.getAllByRole("region", { name: "System status" })
    ).toHaveLength(1);
    expect(
      screen.queryByRole("region", { name: "Handbook reviews" })
    ).toBeNull();
    expect(
      screen.queryByRole("link", { name: "Review submissions" })
    ).toBeNull();
  });

  it.each([0, 3])(
    "links the compact %s pending item to the canonical queue",
    async (count) => {
      renderDashboard(true, count);
      const lab = await screen.findByRole("region", { name: "Lab status" });
      const reviews = within(lab).getByRole("link", {
        name: /Handbook reviews/,
      });
      expect(reviews).toHaveTextContent(String(count));
      expect(reviews).toHaveAttribute("href", "/handbook/review");
      expect(screen.queryByText("No submissions waiting")).toBeNull();
    }
  );

  it("does not show the staff status area or review count to students", async () => {
    renderDashboard(false, 3);
    await screen.findByRole("heading", { name: "Staff Dashboard" });
    expect(screen.queryByRole("region", { name: "Lab status" })).toBeNull();
    expect(screen.queryByRole("region", { name: "System status" })).toBeNull();
    expect(screen.queryByRole("link", { name: /Handbook reviews/ })).toBeNull();
  });
});
