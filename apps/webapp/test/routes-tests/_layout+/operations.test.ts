import { createElement, type ComponentProps, type ReactNode } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLoaderArgs } from "@mocks/remix";
import { LabStatusCard } from "~/components/ioio-staff/lab-status";
import type { LabStatus } from "~/modules/ioio-staff/lab-status.server";
import OperationsPage, {
  getBrokenItemDestination,
  loader,
} from "~/routes/_layout+/operations";
import { ShelfError } from "~/utils/error";

const mocks = vi.hoisted(() => {
  const methods = {
    findMany: vi.fn().mockResolvedValue([]),
    findFirst: vi.fn().mockResolvedValue(null),
  };
  return {
    methods,
    requirePermission: vi.fn(),
    resolveAssetImages: vi.fn().mockResolvedValue([]),
    getWorkingHours: vi.fn().mockResolvedValue({
      enabled: false,
      weeklySchedule: {},
      overrides: [],
    }),
    getLabStatus: vi.fn().mockResolvedValue({
      overdueLoans: 0,
      returnChecks: 0,
      returnedWithIssues: 0,
      unresolvedReports: 0,
      preparationTasks: 0,
      cancelledPickups: 0,
      readyForPickup: 0,
      annualAccessApprovals: 0,
      issues: [],
      totalIssues: 0,
    }),
    getApprovals: vi.fn().mockResolvedValue([]),
    useLoaderData: vi.fn(),
    useActionData: vi.fn().mockReturnValue(undefined),
    revalidate: vi.fn(),
  };
});

// why: the component test supplies loader data directly and renders links as
// anchors, avoiding a full data-router setup while exercising the route UI.
vi.mock("react-router", async () => {
  const actual = await vi.importActual("react-router");
  return {
    ...actual,
    Link: ({ to, children, ...props }: ComponentProps<"a"> & { to: string }) =>
      createElement("a", { ...props, href: to }, children),
    Form: ({ children, ...props }: ComponentProps<"form">) =>
      createElement("form", props, children),
    useLoaderData: mocks.useLoaderData,
    useActionData: mocks.useActionData,
    useFetcher: () => ({ state: "idle", data: null }),
    useRevalidator: () => ({ revalidate: mocks.revalidate }),
  };
});
vi.mock("~/components/layout/header", () => ({ default: () => null }));
vi.mock("~/components/layout/dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => children,
  DialogPortal: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("~/components/ioio-staff/selectable-row", () => ({
  SelectableRow: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  toggleSelectionId: (current: string[], id: string) =>
    current.includes(id)
      ? current.filter((entry) => entry !== id)
      : [...current, id],
}));

// why: operations reads multiple Shelf and IOIO tables; empty query results let
// the route's own filtering and empty-state payload behavior be exercised.
vi.mock("~/database/db.server", () => ({
  db: new Proxy(
    {},
    {
      get: () => mocks.methods,
    }
  ),
}));
// why: route error components import scanner animation code that touches
// canvas APIs unavailable in happy-dom at module initialization.
vi.mock("lottie-react", () => ({ default: () => null }));
vi.mock("~/utils/roles.server", () => ({
  requirePermission: mocks.requirePermission,
}));
vi.mock("~/modules/asset/service.server", () => ({
  resolveAssetImagesForPresentation: mocks.resolveAssetImages,
}));
vi.mock("~/modules/working-hours/service.server", () => ({
  getWorkingHoursForOrganization: mocks.getWorkingHours,
}));
vi.mock("~/modules/ioio-staff/lab-status.server", () => ({
  getLabStatus: mocks.getLabStatus,
}));
vi.mock("~/modules/ioio-student/annual-access.server", () => ({
  formatApprovalDate: (date: Date) => date.toISOString(),
  getStaffAnnualAccessApprovals: mocks.getApprovals,
  reviewAnnualAccessApprovals: vi.fn(),
  declineAnnualAccessApproval: vi.fn(),
  reapproveAnnualAccessApproval: vi.fn(),
  revokeAnnualAccessApproval: vi.fn(),
}));

const views = [
  "all",
  "overdue",
  "returns",
  "returned-with-issues",
  "broken",
  "to-prepare",
  "cancelled-pickups",
  "ready-for-pickup",
  "access-approvals",
] as const;

describe("Operations loader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.methods.findMany.mockResolvedValue([]);
    mocks.methods.findFirst.mockResolvedValue(null);
    mocks.requirePermission.mockResolvedValue({ organizationId: "org-1" });
    mocks.resolveAssetImages.mockResolvedValue([]);
    mocks.getWorkingHours.mockResolvedValue({
      enabled: false,
      weeklySchedule: {},
      overrides: [],
    });
    mocks.getLabStatus.mockResolvedValue({
      overdueLoans: 0,
      returnChecks: 0,
      returnedWithIssues: 0,
      unresolvedReports: 0,
      preparationTasks: 0,
      cancelledPickups: 0,
      readyForPickup: 0,
      annualAccessApprovals: 0,
      issues: [],
      totalIssues: 0,
    });
    mocks.getApprovals.mockResolvedValue([]);
    mocks.useActionData.mockReturnValue(undefined);
  });

  afterEach(() => cleanup());

  it("requires modern Shelf report permission", async () => {
    mocks.requirePermission.mockRejectedValue(
      new ShelfError({
        cause: null,
        message: "Forbidden",
        label: "Permission",
        status: 403,
        shouldBeCaptured: false,
      })
    );
    const refusal = await loader(
      createLoaderArgs({
        context: { getSession: () => ({ userId: "user-1" }) } as never,
        request: new Request("http://localhost/operations"),
      })
    ).catch((cause) => cause as { data?: { error?: { message?: string } } });
    expect(refusal.data?.error?.message).toBe("Forbidden");
    expect(mocks.requirePermission).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1" })
    );
  });

  it.each(views)("returns an empty payload for the %s view", async (view) => {
    const result = (await loader(
      createLoaderArgs({
        context: { getSession: () => ({ userId: "user-1" }) } as never,
        request: new Request(`http://localhost/operations?view=${view}`),
      })
    )) as unknown as {
      data: {
        view: string;
        tasks: unknown[];
        annualAccessApprovals: unknown[];
      };
    };

    expect(result.data.view).toBe(view);
    expect(result.data.tasks).toEqual([]);
    expect(result.data.annualAccessApprovals).toEqual([]);
  });

  it("does not expose a generic requests view", async () => {
    const result = (await loader(
      createLoaderArgs({
        context: { getSession: () => ({ userId: "user-1" }) } as never,
        request: new Request("http://localhost/operations?view=requests"),
      })
    )) as unknown as { data: { view: string } };

    expect(result.data.view).toBe("all");
  });

  it("renders all intended views and an empty Operations state", () => {
    mocks.useLoaderData.mockReturnValue({
      header: { title: "Operations" },
      view: "all",
      summary: {
        overdue: 0,
        returns: 0,
        "returned-with-issues": 0,
        broken: 0,
        "to-prepare": 0,
        "cancelled-pickups": 0,
        "ready-for-pickup": 0,
        "access-approvals": 0,
      },
      tasks: [],
      annualAccessApprovals: { pending: [], access: [] },
    });

    render(createElement(OperationsPage));

    const filters = within(screen.getByLabelText("Operations filters"));
    for (const label of [
      "Overdue loans",
      "Returns to check",
      "Returned with issues",
      "Broken items",
      "Items to prepare",
      "Cancelled pickups",
      "Ready for pickup",
      "Student access approvals",
      "All",
    ]) {
      expect(filters.getByRole("link", { name: label })).toBeTruthy();
    }
    expect(filters.queryByRole("link", { name: "Requests" })).toBeNull();
    expect(screen.getByText("No items need attention.")).toBeTruthy();
  });

  it("renders a broken row with its concrete destination", () => {
    const destination = getBrokenItemDestination(
      { assetId: "asset-1", kitId: null, locationId: null },
      new Map([["asset-1", {}]]),
      new Map(),
      new Map()
    );
    mocks.useLoaderData.mockReturnValue({
      header: { title: "Operations" },
      view: "broken",
      summary: {
        overdue: 0,
        returns: 0,
        "returned-with-issues": 0,
        broken: 1,
        "to-prepare": 0,
        "cancelled-pickups": 0,
        "ready-for-pickup": 0,
        "access-approvals": 0,
      },
      tasks: [
        {
          id: "report-1",
          kind: "broken",
          title: "Oscilloscope",
          detail: "ITEM_DAMAGED reported by Student",
          createdAt: new Date("2026-10-07T10:00:00Z"),
          assetId: "asset-1",
          href: destination.href,
          actionLabel: destination.actionLabel,
        },
      ],
      annualAccessApprovals: { pending: [], access: [] },
    });

    render(createElement(OperationsPage));

    expect(
      screen.getByRole("link", { name: "Oscilloscope" }).getAttribute("href")
    ).toBe("/assets/asset-1");
    expect(
      screen.getByRole("link", { name: "Open asset" }).getAttribute("href")
    ).toBe("/assets/asset-1");
  });

  it("falls back to the broken-items queue when a report target is gone", () => {
    expect(
      getBrokenItemDestination(
        { assetId: "deleted-asset", kitId: null, locationId: null },
        new Map(),
        new Map(),
        new Map()
      )
    ).toEqual({
      href: "/operations?view=broken",
      actionLabel: "Review report",
    });
  });

  it("uses current kit and location detail routes when those targets exist", () => {
    expect(
      getBrokenItemDestination(
        { assetId: null, kitId: "kit-1", locationId: "location-1" },
        new Map(),
        new Map([["kit-1", {}]]),
        new Map([["location-1", {}]])
      )
    ).toEqual({ href: "/kits/kit-1", actionLabel: "Open kit" });
    expect(
      getBrokenItemDestination(
        { assetId: null, kitId: null, locationId: "location-1" },
        new Map(),
        new Map(),
        new Map([["location-1", {}]])
      )
    ).toEqual({ href: "/locations/location-1", actionLabel: "Open location" });
  });

  it("keeps ready pickups in Current activity, outside Needs attention", () => {
    const status = {
      severity: "attention",
      totalIssues: 1,
      issues: [
        {
          id: "issue-1",
          kind: "report",
          severity: "attention",
          title: "Broken microscope",
          detail: "A report needs review",
          href: "/operations?view=broken",
        },
      ],
      overdueLoans: 0,
      returnChecks: 0,
      returnedWithIssues: 0,
      unresolvedReports: 0,
      preparationTasks: 0,
      cancelledPickups: 0,
      readyForPickup: 2,
      annualAccessApprovals: 0,
      pendingReservationRequests: 0,
      incompleteKits: 0,
      outOfStock: 0,
      lowStock: 0,
      importWarnings: 0,
    } satisfies LabStatus;

    render(createElement(LabStatusCard, { status }));

    expect(screen.getByText("Current activity")).toBeTruthy();
    expect(screen.getByText("2 items are ready for pickup.")).toBeTruthy();
    const attention = screen.getByRole("region", { name: "Needs attention" });
    const activity = screen.getByRole("region", { name: "Current activity" });
    expect(attention.contains(activity)).toBe(false);
  });
});
