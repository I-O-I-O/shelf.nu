import { createElement, type ComponentProps, type ReactNode } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createActionArgs, createLoaderArgs } from "@mocks/remix";
import { LabStatusCard } from "~/components/ioio-staff/lab-status";
import type { LabStatus } from "~/modules/ioio-staff/lab-status.server";
import OperationsPage, {
  action,
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
    setSelectedOrganizationIdCookie: vi.fn((id: string) => Promise.resolve(id)),
    resolveAssetImages: vi.fn().mockResolvedValue([]),
    getWorkingHours: vi.fn().mockResolvedValue({
      enabled: false,
      weeklySchedule: {},
      overrides: [],
    }),
    getBrokenSection: vi.fn().mockResolvedValue({
      id: "broken-location",
      name: "Shelf B",
      path: "Room 5 · Equipment area · Shelf B",
      imageUrl: "https://images.example.test/broken.jpg",
      thumbnailUrl: "https://images.example.test/broken-thumb.jpg",
    }),
    getLabStatus: vi.fn().mockResolvedValue({
      overdueLoans: 0,
      returnChecks: 0,
      returnedWithIssues: 0,
      unresolvedReports: 0,
      generalReports: 0,
      preparationTasks: 0,
      cancelledPickups: 0,
      readyForPickup: 0,
      annualAccessApprovals: 0,
      issues: [],
      totalIssues: 0,
    }),
    returnBrokenAssetToService: vi.fn().mockResolvedValue({
      assetId: "asset-1",
      title: "Makey Kit #002",
      status: "AVAILABLE",
    }),
    resolveBrokenAssetOutOfService: vi.fn(),
    resolveLabIssue: vi.fn().mockResolvedValue({ resolvedCount: 1 }),
    completeSubmittedReturn: vi.fn().mockResolvedValue({ ok: true }),
    disableReturnedAssetFromUse: vi.fn().mockResolvedValue(undefined),
    getIoioAvailability: vi.fn().mockResolvedValue({
      totalActive: 1,
      availableCount: 1,
      availableUnitIds: ["unit-1"],
      availableUnitIdsWithoutStaffReservations: ["unit-1"],
      conflicts: [],
      staffReservedCount: 0,
      staffReservationBookingIds: [],
      staffReservationFrom: null,
      staffReservationTo: null,
      availableWithoutStaffReservations: 1,
    }),
    getApprovals: vi.fn().mockResolvedValue([]),
    declineApproval: vi.fn().mockResolvedValue({ declined: true }),
    reviewApprovals: vi.fn().mockResolvedValue({ approvedCount: 0 }),
    useLoaderData: vi.fn(),
    useActionData: vi.fn().mockReturnValue(undefined),
    revalidate: vi.fn(),
    submit: vi.fn(),
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
    useFetcher: () => ({
      state: "idle",
      data: null,
      submit: mocks.submit,
      Form: ({ children, ...props }: ComponentProps<"form">) =>
        createElement("form", props, children),
    }),
    useRevalidator: () => ({ revalidate: mocks.revalidate }),
  };
});
vi.mock("~/components/layout/header", () => ({ default: () => null }));
vi.mock("~/modules/ioio-lab-information/broken-section.server", () => ({
  getConfiguredBrokenSection: mocks.getBrokenSection,
}));
vi.mock("~/components/layout/dialog", () => ({
  Dialog: ({ children, open }: { children: ReactNode; open?: boolean }) =>
    open ? children : null,
  DialogPortal: ({ children }: { children: ReactNode }) => children,
}));
// why: the Operations row test checks the separate overflow action without
// depending on Radix portal and pointer behavior in happy-dom.
vi.mock("~/components/shared/dropdown", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  DropdownMenuContent: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  DropdownMenuItem: ({
    children,
    onSelect,
  }: {
    children: ReactNode;
    onSelect?: () => void;
  }) =>
    createElement("button", { type: "button", onClick: onSelect }, children),
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("~/components/ioio-staff/selectable-row", () => ({
  SelectableRow: ({
    children,
    className,
  }: {
    children: ReactNode;
    className?: string;
  }) => createElement("div", { className }, children),
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
// why: the route test verifies the selected workspace redirect without
// depending on the application session secret used to sign the cookie.
vi.mock("~/modules/organization/context.server", () => ({
  setSelectedOrganizationIdCookie: mocks.setSelectedOrganizationIdCookie,
}));
vi.mock("~/modules/asset/service.server", () => ({
  resolveAssetImagesForPresentation: mocks.resolveAssetImages,
}));
vi.mock("~/modules/working-hours/service.server", () => ({
  getWorkingHoursForOrganization: mocks.getWorkingHours,
}));
vi.mock("~/modules/ioio-staff/lab-status.server", () => ({
  getLabStatus: mocks.getLabStatus,
  resolveBrokenAssetOutOfService: mocks.resolveBrokenAssetOutOfService,
  returnBrokenAssetToService: mocks.returnBrokenAssetToService,
  resolveLabIssue: mocks.resolveLabIssue,
}));
vi.mock("~/modules/ioio-student/return-item.server", () => ({
  completeSubmittedReturn: mocks.completeSubmittedReturn,
}));
vi.mock("~/modules/ioio-staff/return-inspection.server", () => ({
  disableReturnedAssetFromUse: mocks.disableReturnedAssetFromUse,
}));
vi.mock("~/modules/ioio-student/availability.server", () => ({
  getIoioAvailability: mocks.getIoioAvailability,
  IOIO_STAFF_RESERVATION_DESCRIPTION: "IOIO staff reservation",
}));
vi.mock("~/modules/ioio-student/annual-access.server", () => ({
  formatApprovalDate: (date: Date) => date.toISOString(),
  getStaffAnnualAccessApprovals: mocks.getApprovals,
  reviewAnnualAccessApprovals: mocks.reviewApprovals,
  declineAnnualAccessApproval: mocks.declineApproval,
  reapproveAnnualAccessApproval: vi.fn(),
  revokeAnnualAccessApproval: vi.fn(),
}));

const views = [
  "all",
  "overdue",
  "returns",
  "returned-with-issues",
  "broken",
  "general",
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
    mocks.requirePermission.mockResolvedValue({
      organizationId: "org-1",
      role: "OWNER",
      currentOrganization: { type: "TEAM" },
      userOrganizations: [],
    });
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
    mocks.getIoioAvailability.mockResolvedValue({
      totalActive: 1,
      availableCount: 1,
      availableUnitIds: ["unit-1"],
      availableUnitIdsWithoutStaffReservations: ["unit-1"],
      conflicts: [],
      staffReservedCount: 0,
      staffReservationBookingIds: [],
      staffReservationFrom: null,
      staffReservationTo: null,
      availableWithoutStaffReservations: 1,
    });
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

  it("shows a Student's pending preparation request as an actionable task in the active organization", async () => {
    const request = {
      id: "preparation-request-1",
      userId: "student-1",
      assetId: "product-1",
      bookingId: null,
      bookingAssetId: null,
      source: "IOIO_PREPARATION_REQUEST",
      selectedAssetIds: ["unit-1"],
      quantity: 1,
      from: new Date("2026-10-12T00:00:00.000Z"),
      to: new Date("2026-10-16T23:59:59.999Z"),
      locationId: null,
      createdAt: new Date("2026-10-09T10:00:00.000Z"),
      status: "PENDING_PREPARATION",
      reviewComment: null,
    };
    const secondRequest = {
      ...request,
      id: "preparation-request-2",
      selectedAssetIds: ["unit-2"],
    };
    const product = {
      id: "product-1",
      title: "Makey Kit #005",
      type: "INDIVIDUAL",
      sequentialId: "005",
      mainImage: null,
      thumbnailImage: null,
      mainImageStoragePath: null,
      thumbnailImageStoragePath: null,
      assetModel: {
        name: "Makey Kit",
        image: null,
        thumbnailImage: null,
        imageStoragePath: null,
        thumbnailImageStoragePath: null,
      },
      assetKits: [],
      assetLocations: [],
    };
    mocks.methods.findMany.mockImplementation(
      (args: {
        where?: {
          operationType?: string;
          userOrganizations?: unknown;
          id?: { in?: string[] };
        };
      }) => {
        if (args.where?.operationType === "IOIO_PREPARATION") {
          return [request, secondRequest];
        }
        if (args.where?.userOrganizations) {
          return [
            {
              id: "student-1",
              email: "student@example.test",
              firstName: "Student",
              lastName: "Borrower",
              displayName: null,
            },
          ];
        }
        if (args.where?.id?.in?.includes("product-1")) return [product];
        return [];
      }
    );
    mocks.resolveAssetImages.mockImplementation(
      (assets: unknown[]) => assets as never
    );

    const result = (await loader(
      createLoaderArgs({
        context: { getSession: () => ({ userId: "staff-1" }) } as never,
        request: new Request("http://localhost/operations?view=to-prepare"),
      })
    )) as unknown as {
      data: {
        summary: { "to-prepare": number };
        tasks: Array<{
          id: string;
          kind: string;
          title: string;
          operationId?: string;
          borrowerName?: string;
          quantity?: number;
          preparationRequest?: boolean;
          bulkReadyEligible?: boolean;
          requestedPeriod?: string;
          availableForRequestedPeriod?: number;
          availableNow?: number;
          totalPhysicalUnits?: number;
          physicalUnitAssignment?: string;
        }>;
      };
    };

    const task = result.data.tasks.find(
      (entry) => entry.operationId === request.id
    );
    expect(result.data.summary["to-prepare"]).toBe(2);
    expect(task).toMatchObject({
      id: request.id,
      kind: "to-prepare",
      title: "Makey Kit",
      borrowerName: "Student Borrower",
      quantity: 1,
      preparationRequest: true,
      bulkReadyEligible: true,
      availableForRequestedPeriod: 1,
      availableNow: 1,
      totalPhysicalUnits: 1,
      physicalUnitAssignment: "No unit assigned yet",
      requestedPeriod: "Oct 12 – Oct 16, 2026",
    });
    expect(
      result.data.tasks.filter((entry) => entry.kind === "to-prepare")
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ operationId: request.id }),
        expect.objectContaining({ operationId: secondRequest.id }),
      ])
    );
    expect(mocks.methods.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: "org-1",
          operationType: "IOIO_PREPARATION",
          status: "PENDING_PREPARATION",
          source: { in: ["IOIO_PREPARATION_REQUEST", "IOIO_ASSISTANT"] },
        }),
      })
    );
  });

  it("opens the only authorized Team preparation queue when Staff lands in Personal", async () => {
    mocks.requirePermission.mockResolvedValue({
      organizationId: "personal-1",
      currentOrganization: { type: "PERSONAL" },
      userOrganizations: [
        {
          organization: { id: "team-1", type: "TEAM" },
          roles: ["OWNER"],
        },
      ],
    });
    mocks.methods.findMany.mockImplementation(
      (args: {
        where?: {
          organizationId?: { in?: string[] } | string;
          operationType?: string;
          source?: string | { in?: string[] };
          status?: string;
        };
      }) =>
        args.where?.operationType === "IOIO_PREPARATION" &&
        args.where?.source !== undefined &&
        typeof args.where.source === "object" &&
        args.where.source.in?.includes("IOIO_PREPARATION_REQUEST") &&
        args.where.organizationId !== "personal-1" &&
        args.where.organizationId?.in?.includes("team-1")
          ? [{ organizationId: "team-1" }]
          : []
    );

    const result = await loader(
      createLoaderArgs({
        context: { getSession: () => ({ userId: "staff-1" }) } as never,
        request: new Request("http://localhost/operations?view=to-prepare"),
      })
    );

    expect(result).toMatchObject({ status: 302 });
    expect(result.headers.get("Location")).toBe(
      "http://localhost/operations?view=to-prepare"
    );
    expect(mocks.setSelectedOrganizationIdCookie).toHaveBeenCalledWith(
      "team-1"
    );
    expect(mocks.methods.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: { in: ["team-1"] },
          operationType: "IOIO_PREPARATION",
          status: "PENDING_PREPARATION",
          source: { in: ["IOIO_PREPARATION_REQUEST", "IOIO_ASSISTANT"] },
        }),
      })
    );
  });

  it("does not return a Team preparation request in another active organization", async () => {
    const request = {
      id: "preparation-request-team-1",
      userId: "student-team-1",
      assetId: "product-team-1",
      bookingId: null,
      bookingAssetId: null,
      source: "IOIO_PREPARATION_REQUEST",
      selectedAssetIds: ["unit-team-1"],
      quantity: 1,
      from: new Date("2026-10-12T00:00:00.000Z"),
      to: new Date("2026-10-16T23:59:59.999Z"),
      locationId: null,
      createdAt: new Date("2026-10-09T10:00:00.000Z"),
      status: "PENDING_PREPARATION",
      reviewComment: null,
    };
    mocks.requirePermission.mockResolvedValue({
      organizationId: "team-2",
      currentOrganization: { type: "TEAM" },
      userOrganizations: [],
    });
    mocks.methods.findMany.mockImplementation(
      (args: {
        where?: {
          organizationId?: string;
          operationType?: string;
        };
      }) =>
        args.where?.operationType === "IOIO_PREPARATION" &&
        args.where.organizationId === "team-1"
          ? [request]
          : []
    );

    const result = (await loader(
      createLoaderArgs({
        context: { getSession: () => ({ userId: "staff-2" }) } as never,
        request: new Request("http://localhost/operations?view=to-prepare"),
      })
    )) as unknown as {
      data: { summary: { "to-prepare": number }; tasks: unknown[] };
    };

    expect(result.data.summary["to-prepare"]).toBe(0);
    expect(result.data.tasks).toEqual([]);
    expect(mocks.methods.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: "team-2",
          operationType: "IOIO_PREPARATION",
          status: "PENDING_PREPARATION",
        }),
      })
    );
  });

  it("renders Lab status without the Operations heading or subtitle", () => {
    mocks.useLoaderData.mockReturnValue({
      header: { title: "Operations" },
      view: "all",
      summary: {
        overdue: 0,
        returns: 0,
        "returned-with-issues": 0,
        broken: 0,
        general: 0,
        "to-prepare": 0,
        "cancelled-pickups": 0,
        "ready-for-pickup": 0,
        "access-approvals": 0,
      },
      tasks: [],
      annualAccessApprovals: { pending: [], access: [] },
    });

    render(createElement(OperationsPage));

    expect(
      screen.getByRole("heading", { name: "Lab status", level: 1 })
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Operations" })).toBeNull();
    expect(screen.queryByText("Current lab operations and tasks.")).toBeNull();

    const filters = within(screen.getByLabelText("Operations filters"));
    expect(
      filters.getAllByRole("link").map((link) => link.textContent)
    ).toEqual([
      "All",
      "Overdue loans",
      "Returns to check",
      "Returned with issues",
      "Broken items",
      "General",
      "Items to prepare",
      "Cancelled pickups",
      "Ready for pickup",
      "Student access approvals",
    ]);
    expect(
      filters.getByRole("link", { name: "All" }).getAttribute("aria-current")
    ).toBe("page");
    expect(filters.getByRole("link", { name: "All" }).className).toContain(
      "bg-red-700"
    );
    expect(filters.queryByRole("link", { name: "Requests" })).toBeNull();
    expect(screen.getByText("No items need attention.")).toBeTruthy();
  });

  it("renders a general report with human-readable details and no broken status", () => {
    const destination = getBrokenItemDestination(
      { assetId: "asset-1", kitId: null, locationId: null },
      new Map([["asset-1", {}]]),
      new Map(),
      new Map()
    );
    mocks.useLoaderData.mockReturnValue({
      header: { title: "Operations" },
      view: "all",
      summary: {
        overdue: 0,
        returns: 0,
        "returned-with-issues": 0,
        broken: 0,
        general: 1,
        "to-prepare": 0,
        "cancelled-pickups": 0,
        "ready-for-pickup": 0,
        "access-approvals": 0,
      },
      tasks: [
        {
          id: "report-1",
          kind: "general",
          title: "Makey Kit #002",
          detail: "The unit is on Shelf A1, not the listed location.",
          reportLabel: "Wrong location",
          reporterName: "Michael Jordan",
          reportDescription:
            "The unit is on Shelf A1, not the listed location.",
          createdAt: new Date("2026-10-07T10:00:00Z"),
          assetId: "asset-1",
          physicalUnit: true,
          assetImage: {
            id: "asset-1",
            thumbnailImage: null,
            assetModel: null,
          },
          operationId: "broken-report-1",
          returnToServiceEligible: false,
          reportedLocation: "IOIO Lab - B477 · Shelf A1",
          href: destination.href,
          actionLabel: destination.actionLabel,
        },
      ],
      annualAccessApprovals: { pending: [], access: [] },
    });

    render(createElement(OperationsPage));

    const selectedFilter = screen.getByRole("link", {
      name: "All",
    });
    expect(selectedFilter.getAttribute("aria-current")).toBe("page");
    expect(selectedFilter.className).toContain("bg-red-700");

    expect(
      screen
        .getByRole("link", {
          name: "Open unit image: Makey Kit #002",
        })
        .getAttribute("href")
    ).toBe("/assets/asset-1");
    const titleLink = screen.getByRole("link", { name: "Makey Kit #002" });
    expect(titleLink.getAttribute("href")).toBe("/assets/asset-1");
    expect(titleLink.className).not.toContain("truncate");
    expect(screen.queryByText("Out of service")).toBeNull();
    expect(screen.getByText("Wrong location")).toBeTruthy();
    expect(screen.getByLabelText("Select Makey Kit #002 general")).toBeTruthy();
    expect(screen.getByText("Reported by Michael Jordan")).toBeTruthy();
    expect(
      screen.getByText("“The unit is on Shelf A1, not the listed location.”")
    ).toBeTruthy();
    expect(screen.getByText("IOIO Lab - B477 · Shelf A1")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Open unit" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Open asset" })).toBeNull();
    expect(screen.queryByText("BROKEN ITEMS")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Return to service" })
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Resolve report" })).toBeTruthy();
    const reportGrid = titleLink.closest("div.grid");
    expect(reportGrid?.className).toContain("minmax(0,1fr)");
    expect(reportGrid?.className).not.toContain("minmax(240px");
    expect(reportGrid?.className).not.toContain("minmax(180px");
  });

  it("selects only visible General reports and exposes a matching bulk resolve action", () => {
    const generalData = {
      header: { title: "Operations" },
      view: "general",
      summary: {
        overdue: 0,
        returns: 0,
        "returned-with-issues": 0,
        broken: 0,
        general: 2,
        "to-prepare": 0,
        "cancelled-pickups": 0,
        "ready-for-pickup": 0,
        "access-approvals": 0,
      },
      tasks: ["one", "two"].map((id) => ({
        id,
        kind: "general",
        title: `Report ${id}`,
        detail: "Needs review",
        reportLabel: "Wrong location",
        reportDescription: "Needs review",
        reporterName: "Student",
        createdAt: new Date("2026-10-07T10:00:00Z"),
        operationId: `op-${id}`,
        href: "/operations?view=general",
        actionLabel: "Resolve report",
      })),
      annualAccessApprovals: { pending: [], access: [] },
    };
    mocks.useLoaderData.mockReturnValue(generalData);

    const { rerender } = render(createElement(OperationsPage));
    fireEvent.click(screen.getByLabelText("Select Report one general report"));
    expect(screen.getByText("1 selected")).toBeTruthy();
    fireEvent.click(
      screen.getByLabelText("Select all visible general reports")
    );

    expect(screen.getByText("2 selected")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Resolve selected" })
    ).toBeTruthy();
    const form = screen
      .getByRole("button", { name: "Resolve selected" })
      .closest("form");
    expect(
      Array.from(form!.querySelectorAll('[name="operationIds"]')).map(
        (input) => (input as HTMLInputElement).value
      )
    ).toEqual(["op-one", "op-two"]);
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(screen.queryByText("2 selected")).toBeNull();

    fireEvent.click(screen.getByLabelText("Select Report one general report"));
    expect(screen.getByText("1 selected")).toBeTruthy();
    mocks.useLoaderData.mockReturnValue({
      ...generalData,
      view: "broken",
      summary: { ...generalData.summary, general: 0 },
      tasks: [],
    });
    rerender(createElement(OperationsPage));
    expect(screen.queryByText("1 selected")).toBeNull();
  });

  it("selects actionable All rows and resolves mixed operational reports safely", () => {
    mocks.useLoaderData.mockReturnValue({
      header: { title: "Operations" },
      view: "all",
      summary: {
        overdue: 0,
        returns: 1,
        "returned-with-issues": 0,
        broken: 1,
        general: 2,
        "to-prepare": 0,
        "cancelled-pickups": 0,
        "ready-for-pickup": 0,
        "access-approvals": 1,
      },
      tasks: [
        {
          id: "general-row",
          kind: "general",
          title: "General report",
          detail: "Needs review",
          reportLabel: "Wrong location",
          reportDescription: "It is in the wrong room.",
          operationId: "same-id",
          createdAt: new Date("2026-10-07T10:00:00Z"),
          href: "/operations?view=general",
          actionLabel: "Resolve report",
        },
        {
          id: "general-row-2",
          kind: "general",
          title: "Location full report",
          detail: "Shelf B is full.",
          reportLabel: "Location full",
          reportDescription: "Shelf B is full.",
          operationId: "general-report-2",
          createdAt: new Date("2026-10-07T10:01:00Z"),
          href: "/operations?view=general",
          actionLabel: "Resolve report",
        },
        {
          id: "broken-row",
          kind: "broken",
          title: "Makey Kit #003",
          detail: "Item damaged",
          reportLabel: "Item damaged",
          operationId: "damage-report-3",
          assetId: "same-id",
          physicalUnit: true,
          returnToServiceEligible: true,
          createdAt: new Date("2026-10-07T10:00:00Z"),
          href: "/assets/same-id",
          actionLabel: "Return to service",
        },
        {
          id: "return-row",
          kind: "returns",
          title: "Camera #001",
          detail: "Returned item",
          operationId: "return-operation-1",
          returnCheckEligible: true,
          createdAt: new Date("2026-10-07T10:00:00Z"),
          href: "/operations?view=returns",
          actionLabel: "Mark checked",
        },
      ],
      annualAccessApprovals: {
        pending: [
          {
            id: "approval-1",
            requestedAt: new Date("2026-10-07T10:00:00Z"),
            student: {
              displayName: "Taylor Student",
              firstName: "Taylor",
              lastName: "Student",
              email: "taylor@example.test",
            },
          },
        ],
        access: [],
      },
    });

    render(createElement(OperationsPage));
    expect(screen.getByLabelText("Select General report general")).toBeTruthy();
    expect(
      screen.getByLabelText("Select Location full report general")
    ).toBeTruthy();
    expect(screen.getByLabelText("Select Makey Kit #003 broken")).toBeTruthy();
    expect(screen.getByLabelText("Select Camera #001 returns")).toBeTruthy();
    expect(
      screen.getByLabelText("Select Taylor Student access-approvals")
    ).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Select General report general"));
    const bulkBar = screen
      .getByLabelText("Select all visible Operations rows")
      .closest("label")!.parentElement!.parentElement!;
    expect(bulkBar.className).toContain("justify-between");
    expect(
      screen.getByRole("button", { name: "Resolve selected" }).parentElement
        ?.parentElement?.className
    ).toContain("ml-auto");
    expect(
      screen.getByRole("button", { name: "Resolve selected" })
    ).toBeTruthy();
    fireEvent.click(
      screen.getByLabelText("Select Location full report general")
    );
    expect(screen.getByText("2 selected")).toBeTruthy();
    const resolveForm = screen
      .getByRole("button", { name: "Resolve selected" })
      .closest("form");
    expect(
      Array.from(resolveForm!.querySelectorAll('[name="operationIds"]')).map(
        (input) => (input as HTMLInputElement).value
      )
    ).toEqual(["same-id", "general-report-2"]);
    fireEvent.click(screen.getByLabelText("Select Makey Kit #003 broken"));
    expect(screen.getByText("3 selected")).toBeTruthy();
    expect(screen.queryByText(/same workflow/i)).toBeNull();
    const mixedReportResolveForm = screen
      .getByRole("button", { name: "Resolve selected" })
      .closest("form");
    expect(
      Array.from(
        mixedReportResolveForm!.querySelectorAll('[name="operationIds"]')
      ).map((input) => (input as HTMLInputElement).value)
    ).toEqual(["same-id", "general-report-2", "damage-report-3"]);

    fireEvent.click(
      screen.getByLabelText("Select all visible Operations rows")
    );
    expect(screen.getByText("5 selected")).toBeTruthy();
    expect(screen.queryByText(/same workflow/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(screen.queryByText("5 selected")).toBeNull();

    fireEvent.click(screen.getByLabelText("Select Makey Kit #003 broken"));
    const brokenToolbar =
      screen.getByText("1 selected").parentElement!.parentElement!;
    const brokenBulkButton = within(brokenToolbar).getByRole("button", {
      name: "Return to service",
    });
    expect(
      Array.from(
        brokenBulkButton.closest("form")!.querySelectorAll('[name="assetIds"]')
      ).map((input) => (input as HTMLInputElement).value)
    ).toEqual(["same-id"]);

    fireEvent.click(
      within(brokenToolbar).getByRole("button", { name: "Clear selection" })
    );
    fireEvent.click(screen.getByLabelText("Select Camera #001 returns"));
    const returnToolbar =
      screen.getByText("1 selected").parentElement!.parentElement!;
    const markCheckedForm = within(returnToolbar)
      .getByRole("button", { name: "Mark checked" })
      .closest("form")!;
    expect(
      Array.from(markCheckedForm.querySelectorAll('[name="operationIds"]')).map(
        (input) => (input as HTMLInputElement).value
      )
    ).toEqual(["return-operation-1"]);

    fireEvent.click(
      within(returnToolbar).getByRole("button", { name: "Clear selection" })
    );
    fireEvent.click(screen.getByLabelText("Select General report general"));
    fireEvent.click(screen.getByLabelText("Select Camera #001 returns"));
    expect(screen.getByText("2 selected")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Resolve selected" })
    ).toBeNull();
    expect(
      within(
        screen.getByText("2 selected").parentElement!.parentElement!
      ).queryByRole("button", { name: "Mark checked" })
    ).toBeNull();
  });

  it("selects physical broken units and confirms one bulk return-to-service action", () => {
    mocks.useLoaderData.mockReturnValue({
      header: { title: "Operations" },
      view: "broken",
      summary: {
        overdue: 0,
        returns: 0,
        "returned-with-issues": 0,
        broken: 2,
        "to-prepare": 0,
        "cancelled-pickups": 0,
        "ready-for-pickup": 0,
        "access-approvals": 0,
      },
      tasks: [2, 4].map((unit) => ({
        id: `broken-${unit}`,
        kind: "broken",
        title: `Makey Kit #00${unit}`,
        detail: "Broken after return inspection",
        createdAt: new Date("2026-10-09T10:00:00Z"),
        assetId: `physical-${unit}`,
        operationId: `report-${unit}`,
        physicalUnit: true,
        returnToServiceEligible: true,
        href: `/assets/physical-${unit}`,
        actionLabel: "Open unit",
      })),
      annualAccessApprovals: { pending: [], access: [] },
    });

    render(createElement(OperationsPage));
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Select Makey Kit #002 for return to service",
      })
    );
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Select Makey Kit #004 for return to service",
      })
    );

    expect(screen.getByText("2 selected")).toBeTruthy();
    const bulkButton = screen.getAllByRole("button", {
      name: "Return to service",
    })[0];
    fireEvent.click(bulkButton);
    const confirmation = screen.getByText(
      "These items will become available for borrowing again."
    );
    expect(confirmation).toBeTruthy();
    const confirmationForm = confirmation.closest("form");
    const selectedAssetInputs = confirmationForm?.querySelectorAll(
      'input[name="assetIds"]'
    );
    expect(selectedAssetInputs).toHaveLength(2);
    expect(
      Array.from(selectedAssetInputs ?? []).map(
        (input) => (input as HTMLInputElement).value
      )
    ).toEqual(["physical-2", "physical-4"]);
  });

  it("shows Return to service for a blocking physical-unit report", () => {
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
          title: "Makey Kit #002",
          detail: "ITEM_DAMAGED reported by Student",
          createdAt: new Date("2026-10-07T10:00:00Z"),
          operationId: "report-op-1",
          assetId: "unit-2",
          physicalUnit: true,
          returnToServiceEligible: true,
          brokenSectionRelevant: true,
          brokenSection: {
            name: "Shelf B",
            path: "Room 5 · Equipment area · Shelf B",
            imageUrl: "https://images.example.test/broken.jpg",
            thumbnailUrl: "https://images.example.test/broken-thumb.jpg",
          },
        },
      ],
      annualAccessApprovals: { pending: [], access: [] },
    });

    render(createElement(OperationsPage));

    expect(
      screen.getByRole("button", { name: "Return to service" })
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "More actions for Makey Kit #002" })
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Keep out of service" })
    );
    expect(mocks.submit).toHaveBeenCalledWith(
      {
        intent: "resolve-broken-report-out-of-service",
        operationId: "report-op-1",
      },
      { method: "post" }
    );
    expect(screen.getByText("Room 5 · Equipment area · Shelf B")).toBeTruthy();
    expect(
      screen.queryByText(
        /Not configured\. Ask Staff where to place this unit\./
      )
    ).toBeNull();
  });

  it("omits Broken section metadata when no location is configured", () => {
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
          id: "report-no-location",
          kind: "broken",
          title: "Camera #001",
          detail: "Item damaged",
          operationId: "report-op-no-location",
          assetId: "camera-1",
          physicalUnit: true,
          returnToServiceEligible: true,
          brokenSectionRelevant: true,
          brokenSection: null,
        },
      ],
      annualAccessApprovals: { pending: [], access: [] },
    });

    render(createElement(OperationsPage));

    expect(screen.queryByText("Broken section")).toBeNull();
    expect(
      screen.queryByText(
        /Not configured\. Ask Staff where to place this unit\./
      )
    ).toBeNull();
  });

  it("offers direct Mark checked and Remove from service actions for a returned item", () => {
    mocks.useLoaderData.mockReturnValue({
      header: { title: "Operations" },
      view: "returns",
      summary: {
        overdue: 0,
        returns: 1,
        "returned-with-issues": 0,
        broken: 0,
        "to-prepare": 0,
        "cancelled-pickups": 0,
        "ready-for-pickup": 0,
        "access-approvals": 0,
      },
      tasks: [
        {
          id: "return-1",
          kind: "returns",
          title: "Makey Kit #002",
          detail: "Return submitted by Zans Zalik",
          createdAt: new Date("2026-10-09T10:00:00Z"),
          operationId: "return-1",
          returnCheckEligible: true,
          quantity: 1,
          href: "/bookings/return-check/return-1?returnTo=%2Foperations%3Fview%3Dreturns",
          returnLocation: "IOIO Lab - B477 · Returns",
          borrowerName: "Zans Zalik",
        },
      ],
      annualAccessApprovals: { pending: [], access: [] },
    });

    render(createElement(OperationsPage));

    expect(
      screen.getAllByRole("button", { name: "Mark checked" })
    ).toHaveLength(1);
    expect(
      screen.getAllByRole("button", { name: "Remove from service" })
    ).toHaveLength(1);
    expect(screen.queryByRole("link", { name: "Review return" })).toBeNull();
  });

  it("shows only service resolution actions and the issue report for a returned issue", () => {
    mocks.useLoaderData.mockReturnValue({
      header: { title: "Operations" },
      view: "returned-with-issues",
      summary: {
        overdue: 0,
        returns: 0,
        "returned-with-issues": 1,
        broken: 0,
        "to-prepare": 0,
        "cancelled-pickups": 0,
        "ready-for-pickup": 0,
        "access-approvals": 0,
      },
      tasks: [
        {
          id: "return-issue-1",
          kind: "returned-with-issues",
          title: "Makey Kit #002",
          detail: "Returned with issue · Student",
          createdAt: new Date("2026-10-07T10:00:00Z"),
          operationId: "return-op-1",
          returnIssueOperationId: "report-op-1",
          returnToServiceEligible: true,
          assetId: "unit-2",
          href: "/bookings/return-check/return-op-1",
          borrowerName: "Michael Jordan",
          returnLocation: "Broken Zone",
          returnIssue: "jj",
        },
      ],
      annualAccessApprovals: { pending: [], access: [] },
    });

    render(createElement(OperationsPage));

    expect(screen.queryByRole("link", { name: "Review return" })).toBeNull();
    expect(screen.getByText("Makey Kit #002")).toBeTruthy();
    expect(screen.getByText("Michael Jordan")).toBeTruthy();
    expect(screen.getByText(/Returned .* · Broken Zone/)).toBeTruthy();
    expect(
      screen.getByText("Returned with issue · awaiting TA review")
    ).toBeTruthy();
    expect(screen.getByText("“jj”")).toBeTruthy();

    const issuePanel = screen.getByText(
      "Returned with issue · awaiting TA review"
    ).parentElement;
    expect(issuePanel?.className).toContain("rounded-xl");
    const returnToService = screen.getByRole("button", {
      name: "Return to service",
    });
    const removeFromService = screen.getByRole("button", {
      name: "Remove from service",
    });
    expect(returnToService.className).toContain("h-10");
    expect(returnToService.className).toContain("bg-red-700");
    expect(removeFromService.className).toContain("h-10");
    expect(removeFromService.className).toContain("border-red-300");
    const actionGroup = returnToService.parentElement?.parentElement;
    expect(actionGroup?.className).toContain("ml-auto");
    expect(actionGroup?.className).toContain("shrink-0");
    expect(actionGroup?.className).toContain("items-center");
    expect(actionGroup?.parentElement?.className).toBe("contents");
    expect(actionGroup?.parentElement?.parentElement?.className).toContain(
      "flex-wrap items-center"
    );
  });

  it("does not show Review return for returned issues in the combined Lab status view", () => {
    mocks.useLoaderData.mockReturnValue({
      header: { title: "Operations" },
      view: "all",
      summary: {
        overdue: 0,
        returns: 0,
        "returned-with-issues": 1,
        broken: 0,
        general: 0,
        "to-prepare": 0,
        "cancelled-pickups": 0,
        "ready-for-pickup": 0,
        "access-approvals": 0,
      },
      tasks: [
        {
          id: "return-issue-1",
          kind: "returned-with-issues",
          title: "Makey Kit #002",
          detail: "Returned with issue · Student",
          createdAt: new Date("2026-10-07T10:00:00Z"),
          operationId: "return-op-1",
          returnIssueOperationId: "report-op-1",
          returnToServiceEligible: true,
          assetId: "unit-2",
          href: "/bookings/return-check/return-op-1",
          actionLabel: "Review return",
          borrowerName: "Michael Jordan",
          returnLocation: "Broken Zone",
          returnIssue: "jj",
        },
      ],
      annualAccessApprovals: { pending: [], access: [] },
    });

    render(createElement(OperationsPage));

    expect(screen.queryByRole("link", { name: "Review return" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Return to service" })
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Remove from service" })
    ).toBeTruthy();
  });

  it("keeps Review return for Returns to check items that need manual review", () => {
    mocks.useLoaderData.mockReturnValue({
      header: { title: "Operations" },
      view: "returns",
      summary: {
        overdue: 0,
        returns: 1,
        "returned-with-issues": 0,
        broken: 0,
        "to-prepare": 0,
        "cancelled-pickups": 0,
        "ready-for-pickup": 0,
        "access-approvals": 0,
      },
      tasks: [
        {
          id: "return-manual-review",
          kind: "returns",
          title: "Makey Kit #003",
          detail: "Return submitted by Michael Jordan",
          createdAt: new Date("2026-10-19T10:00:00Z"),
          operationId: "return-op-manual-review",
          returnCheckEligible: false,
          quantity: 1,
          href: "/bookings/return-check/return-op-manual-review",
          borrowerName: "Michael Jordan",
        },
      ],
      annualAccessApprovals: { pending: [], access: [] },
    });

    render(createElement(OperationsPage));

    expect(screen.getByRole("link", { name: "Review return" })).toBeTruthy();
  });

  it("shows Mark checked and Remove from service in the bulk toolbar", () => {
    mocks.useLoaderData.mockReturnValue({
      header: { title: "Operations" },
      view: "returns",
      summary: {
        overdue: 0,
        returns: 3,
        "returned-with-issues": 0,
        broken: 0,
        "to-prepare": 0,
        "cancelled-pickups": 0,
        "ready-for-pickup": 0,
        "access-approvals": 0,
      },
      tasks: [1, 2, 3].map((unit) => ({
        id: `return-${unit}`,
        kind: "returns",
        title: `Makey Kit #00${unit}`,
        detail: "Return submitted by Student",
        createdAt: new Date("2026-10-09T10:00:00Z"),
        operationId: `return-${unit}`,
        returnCheckEligible: true,
        quantity: 1,
        href: `/bookings/return-check/return-${unit}`,
      })),
      annualAccessApprovals: { pending: [], access: [] },
    });

    render(createElement(OperationsPage));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all" }));

    expect(screen.getByText("3 selected")).toBeTruthy();
    expect(
      screen.getAllByRole("button", { name: "Mark checked" })
    ).toHaveLength(4);
    expect(
      screen.getAllByRole("button", { name: "Remove from service" })
    ).toHaveLength(4);
    expect(screen.getByRole("button", { name: "Clear" })).toBeTruthy();
    fireEvent.click(
      screen.getAllByRole("button", { name: "Remove from service" })[0]
    );
    expect(
      screen.getByText(
        "These items will move to Broken items and remain unavailable for borrowing until repaired."
      )
    ).toBeTruthy();
  });

  it("disables a returned unit directly from Operations", async () => {
    mocks.methods.findFirst.mockResolvedValue({
      id: "return-1",
      assetId: "physical-unit-002",
    });

    const result = await action(
      createActionArgs({
        context: { getSession: () => ({ userId: "staff-1" }) } as never,
        request: new Request("http://localhost/operations?view=returns", {
          method: "POST",
          body: new URLSearchParams({
            intent: "disable-return",
            operationId: "return-1",
          }),
        }),
      })
    );

    expect(mocks.completeSubmittedReturn).toHaveBeenCalledWith(
      { operationId: "return-1" },
      expect.objectContaining({
        auth: { organizationId: "org-1", userId: "staff-1", role: "OWNER" },
      })
    );
    expect(mocks.disableReturnedAssetFromUse).toHaveBeenCalledWith({
      assetId: "physical-unit-002",
      organizationId: "org-1",
      userId: "staff-1",
      note: "",
    });
    expect(result).toMatchObject({
      data: { ok: true, intent: "disable-return", succeeded: 1 },
    });
  });

  it("disables selected returns in bulk and reports per-item results", async () => {
    mocks.methods.findMany.mockResolvedValue([
      { id: "return-1", assetId: "physical-unit-002" },
      { id: "return-2", assetId: "physical-unit-004" },
    ]);

    const result = await action(
      createActionArgs({
        context: { getSession: () => ({ userId: "staff-1" }) } as never,
        request: new Request("http://localhost/operations?view=returns", {
          method: "POST",
          body: new URLSearchParams([
            ["intent", "disable-return-bulk"],
            ["operationIds", "return-1"],
            ["operationIds", "return-2"],
          ]),
        }),
      })
    );

    expect(mocks.completeSubmittedReturn).toHaveBeenCalledTimes(2);
    expect(mocks.disableReturnedAssetFromUse).toHaveBeenCalledTimes(2);
    expect(mocks.disableReturnedAssetFromUse).toHaveBeenNthCalledWith(1, {
      assetId: "physical-unit-002",
      organizationId: "org-1",
      userId: "staff-1",
    });
    expect(mocks.disableReturnedAssetFromUse).toHaveBeenNthCalledWith(2, {
      assetId: "physical-unit-004",
      organizationId: "org-1",
      userId: "staff-1",
    });
    expect(result).toMatchObject({
      data: {
        ok: true,
        intent: "disable-return-bulk",
        succeeded: 2,
        failed: 0,
      },
    });
  });

  it("marks selected eligible returns checked in bulk", async () => {
    mocks.methods.findMany
      .mockResolvedValueOnce([
        {
          id: "return-1",
          reportType: "RETURN_ITEM",
          bookingAssetId: "booking-asset-1",
        },
        {
          id: "return-2",
          reportType: "RETURN_ITEM",
          bookingAssetId: "booking-asset-2",
        },
      ])
      .mockResolvedValueOnce([]);

    const result = await action(
      createActionArgs({
        context: { getSession: () => ({ userId: "staff-1" }) } as never,
        request: new Request("http://localhost/operations?view=returns", {
          method: "POST",
          body: new URLSearchParams([
            ["intent", "complete-return-bulk"],
            ["operationIds", "return-1"],
            ["operationIds", "return-2"],
          ]),
        }),
      })
    );

    expect(mocks.completeSubmittedReturn).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      data: {
        ok: true,
        intent: "complete-return-bulk",
        succeeded: 2,
        failed: 0,
      },
    });
  });

  it.each([
    "complete-return",
    "complete-return-bulk",
    "disable-return",
    "disable-return-bulk",
  ])("does not allow a Student to invoke %s", async (intent) => {
    mocks.requirePermission.mockResolvedValue({
      organizationId: "org-1",
      role: "SELF_SERVICE",
    });

    await expect(
      action(
        createActionArgs({
          context: { getSession: () => ({ userId: "student-1" }) } as never,
          request: new Request("http://localhost/operations?view=returns", {
            method: "POST",
            body: new URLSearchParams({
              intent,
              operationId: "return-1",
              operationIds: "return-1",
            }),
          }),
        })
      )
    ).rejects.toMatchObject({ status: 403 });
    expect(mocks.completeSubmittedReturn).not.toHaveBeenCalled();
    expect(mocks.disableReturnedAssetFromUse).not.toHaveBeenCalled();
  });

  it("returns a repaired broken item to service through the Staff action", async () => {
    const result = await action(
      createActionArgs({
        context: { getSession: () => ({ userId: "staff-1" }) } as never,
        request: new Request("http://localhost/operations?view=broken", {
          method: "POST",
          body: new URLSearchParams({
            intent: "return-to-service",
            operationId: "broken-report-1",
          }),
        }),
      })
    );

    expect(mocks.returnBrokenAssetToService).toHaveBeenCalledWith({
      organizationId: "org-1",
      operationId: "broken-report-1",
      staffUserId: "staff-1",
    });
    expect(result).toMatchObject({
      data: { ok: true, intent: "return-to-service" },
    });
  });

  it("keeps a returned problem report open until its exact service resolution", async () => {
    mocks.methods.findFirst
      .mockResolvedValueOnce({
        id: "return-1",
        assetId: "physical-unit-1",
        bookingAssetId: "booking-asset-1",
      })
      .mockResolvedValueOnce({
        id: "return-report-1",
        assetId: "physical-unit-1",
        bookingAssetId: "booking-asset-1",
        reportType: "ITEM_DAMAGED",
      });

    const result = await action(
      createActionArgs({
        context: { getSession: () => ({ userId: "staff-1" }) } as never,
        request: new Request(
          "http://localhost/operations?view=returned-with-issues",
          {
            method: "POST",
            body: new URLSearchParams({
              intent: "return-issue-to-service",
              operationId: "return-1",
              reportOperationId: "return-report-1",
            }),
          }
        ),
      })
    );

    expect(mocks.completeSubmittedReturn).toHaveBeenCalledWith(
      { operationId: "return-1", keepProblemReportOpen: true },
      expect.objectContaining({
        auth: { organizationId: "org-1", userId: "staff-1", role: "OWNER" },
      })
    );
    expect(mocks.returnBrokenAssetToService).toHaveBeenCalledWith({
      organizationId: "org-1",
      operationId: "return-report-1",
      staffUserId: "staff-1",
    });
    expect(result).toMatchObject({
      data: {
        ok: true,
        intent: "return-issue-to-service",
        operationId: "return-1",
      },
    });
  });

  it("resolves an operational report within the selected TEAM organization", async () => {
    mocks.methods.findFirst.mockResolvedValueOnce({
      id: "wrong-location-report",
      reportType: "WRONG_LOCATION",
    });
    const result = await action(
      createActionArgs({
        context: { getSession: () => ({ userId: "staff-1" }) } as never,
        request: new Request("http://localhost/operations?view=all", {
          method: "POST",
          body: new URLSearchParams({
            intent: "resolve-report",
            operationId: "wrong-location-report",
          }),
        }),
      })
    );

    expect(mocks.resolveLabIssue).toHaveBeenCalledWith({
      organizationId: "org-1",
      operationId: "wrong-location-report",
    });
    expect(mocks.methods.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "wrong-location-report",
          organizationId: "org-1",
          operationType: "REPORT_PROBLEM",
          status: "SUCCEEDED",
        }),
      })
    );
    expect(result).toMatchObject({
      data: { ok: true, intent: "resolve-report" },
    });
  });

  it("bulk resolves General and damaged reports without changing inventory status", async () => {
    mocks.methods.findMany.mockResolvedValueOnce([
      { id: "wrong-location", reportType: "WRONG_LOCATION" },
      { id: "damaged", reportType: "ITEM_DAMAGED" },
    ]);
    const body = new FormData();
    body.set("intent", "resolve-report-bulk");
    body.append("operationIds", "wrong-location");
    body.append("operationIds", "damaged");

    const result = await action(
      createActionArgs({
        context: { getSession: () => ({ userId: "staff-1" }) } as never,
        request: new Request("http://localhost/operations?view=general", {
          method: "POST",
          body,
        }),
      })
    );

    expect(mocks.resolveLabIssue).toHaveBeenCalledTimes(2);
    expect(mocks.resolveLabIssue).toHaveBeenCalledWith({
      organizationId: "org-1",
      operationId: "damaged",
      resolveRelatedReports: false,
    });
    expect(mocks.returnBrokenAssetToService).not.toHaveBeenCalled();
    expect(mocks.resolveBrokenAssetOutOfService).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      data: {
        intent: "resolve-report-bulk",
        succeeded: 2,
        failed: 0,
      },
    });
  });

  it("rejects selected access requests through the organization-scoped approval service", async () => {
    const body = new FormData();
    body.set("intent", "decline-access-bulk");
    body.append("requestIds", "request-1");
    body.append("requestIds", "request-2");

    const result = await action(
      createActionArgs({
        context: { getSession: () => ({ userId: "staff-1" }) } as never,
        request: new Request(
          "http://localhost/operations?view=access-approvals",
          {
            method: "POST",
            body,
          }
        ),
      })
    );

    expect(mocks.declineApproval).toHaveBeenCalledTimes(2);
    expect(mocks.declineApproval).toHaveBeenNthCalledWith(1, {
      organizationId: "org-1",
      staffUserId: "staff-1",
      requestId: "request-1",
      staffComment: "",
    });
    expect(result).toMatchObject({
      data: {
        intent: "decline-access-bulk",
        result: { succeeded: 2, failed: 0 },
      },
    });
  });

  it("returns selected physical asset IDs to service through the bulk Staff action", async () => {
    mocks.methods.findMany
      .mockResolvedValueOnce([{ id: "physical-2" }, { id: "physical-4" }])
      .mockResolvedValueOnce([
        { id: "report-2", assetId: "physical-2" },
        { id: "report-4", assetId: "physical-4" },
      ]);

    const result = await action(
      createActionArgs({
        context: { getSession: () => ({ userId: "staff-1" }) } as never,
        request: new Request("http://localhost/operations?view=broken", {
          method: "POST",
          body: new URLSearchParams([
            ["intent", "return-to-service-bulk"],
            ["assetIds", "physical-2"],
            ["assetIds", "physical-4"],
          ]),
        }),
      })
    );

    expect(mocks.methods.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: "org-1",
          id: { in: ["physical-2", "physical-4"] },
          type: "INDIVIDUAL",
        }),
      })
    );
    expect(mocks.returnBrokenAssetToService).toHaveBeenCalledTimes(2);
    expect(mocks.returnBrokenAssetToService).toHaveBeenNthCalledWith(1, {
      organizationId: "org-1",
      operationId: "report-2",
      staffUserId: "staff-1",
    });
    expect(mocks.returnBrokenAssetToService).toHaveBeenNthCalledWith(2, {
      organizationId: "org-1",
      operationId: "report-4",
      staffUserId: "staff-1",
    });
    expect(result).toMatchObject({
      data: {
        ok: true,
        intent: "return-to-service-bulk",
        succeeded: 2,
        failed: 0,
      },
    });
  });

  it("passes Staff authorization into the return-check service from Operations", async () => {
    mocks.methods.findFirst.mockImplementation(({ where }) =>
      Promise.resolve(
        where.operationType === "RETURN_ITEM"
          ? {
              id: "return-1",
              reportType: "RETURN_ITEM",
              bookingAssetId: "booking-asset-1",
            }
          : null
      )
    );

    const result = await action(
      createActionArgs({
        context: { getSession: () => ({ userId: "staff-1" }) } as never,
        request: new Request("http://localhost/operations?view=returns", {
          method: "POST",
          body: new URLSearchParams({
            intent: "complete-return",
            operationId: "return-1",
          }),
        }),
      })
    );

    expect(mocks.completeSubmittedReturn).toHaveBeenCalledWith(
      { operationId: "return-1" },
      expect.objectContaining({
        auth: { organizationId: "org-1", userId: "staff-1", role: "OWNER" },
      })
    );
    expect(result).toMatchObject({
      data: { ok: true, intent: "complete-return", succeeded: 1 },
    });
  });

  it("does not allow a Student to return a broken item to service", async () => {
    mocks.requirePermission.mockResolvedValue({
      organizationId: "org-1",
      role: "SELF_SERVICE",
    });

    await expect(
      action(
        createActionArgs({
          context: { getSession: () => ({ userId: "student-1" }) } as never,
          request: new Request("http://localhost/operations?view=broken", {
            method: "POST",
            body: new URLSearchParams({
              intent: "return-to-service",
              operationId: "broken-report-1",
            }),
          }),
        })
      )
    ).rejects.toMatchObject({ status: 403 });
    expect(mocks.returnBrokenAssetToService).not.toHaveBeenCalled();
  });

  it("does not allow a Student to bulk return physical units to service", async () => {
    mocks.requirePermission.mockResolvedValue({
      organizationId: "org-1",
      role: "SELF_SERVICE",
    });

    await expect(
      action(
        createActionArgs({
          context: { getSession: () => ({ userId: "student-1" }) } as never,
          request: new Request("http://localhost/operations?view=broken", {
            method: "POST",
            body: new URLSearchParams({
              intent: "return-to-service-bulk",
              assetIds: "physical-2",
            }),
          }),
        })
      )
    ).rejects.toMatchObject({ status: 403 });
    expect(mocks.returnBrokenAssetToService).not.toHaveBeenCalled();
  });

  it("renders the legacy preparation card hierarchy when units are available", () => {
    const itemName =
      "Makey Kit classroom electronics and robotics teaching collection";

    mocks.useLoaderData.mockReturnValue({
      header: { title: "Operations" },
      view: "to-prepare",
      summary: {
        overdue: 0,
        returns: 0,
        "returned-with-issues": 0,
        broken: 0,
        "to-prepare": 1,
        "cancelled-pickups": 0,
        "ready-for-pickup": 0,
        "access-approvals": 0,
      },
      tasks: [
        {
          id: "preparation-1",
          kind: "to-prepare",
          title: itemName,
          detail: "Preparation requested",
          createdAt: new Date("2026-10-09T08:00:00Z"),
          operationId: "preparation-1",
          preparationStatus: "PENDING_PREPARATION",
          preparationRequest: true,
          bulkReadyEligible: true,
          quantity: 1,
          requestedPeriod: "Oct 9 – Nov 23, 2026",
          availableForRequestedPeriod: 4,
          availableNow: 5,
          totalPhysicalUnits: 5,
          physicalUnitAssignment: "No unit assigned yet",
          borrowerName: "Zans Zalik",
          locationName: null,
          assetId: "makey-kit-1",
          href: "/operations?view=to-prepare",
          actionLabel: "Mark prepared",
        },
      ],
      annualAccessApprovals: { pending: [], access: [] },
    });

    render(createElement(OperationsPage));

    expect(screen.getByText(itemName)).toBeTruthy();
    expect(screen.getByText("1 item")).toBeTruthy();
    expect(screen.getByText("Location not set")).toBeTruthy();
    expect(screen.getByText("Zans Zalik")).toBeTruthy();
    expect(screen.getByText("Oct 9 – Nov 23, 2026")).toBeTruthy();
    expect(screen.getByText("4 of 5 available for these dates")).toBeTruthy();
    expect(screen.getByText("5 of 5 available now")).toBeTruthy();
    expect(screen.getByText("No unit assigned yet")).toBeTruthy();
    expect(screen.queryByText(/2026Period:/)).toBeNull();
    expect(screen.getByRole("button", { name: "Mark prepared" })).toBeTruthy();

    const overflow = screen.getByRole("button", {
      name: `Actions for ${itemName}`,
    });
    expect(overflow).toBeTruthy();
    fireEvent.click(overflow);
    expect(screen.getByText("Decline request")).toBeTruthy();

    const row = screen.getByText(itemName).closest(".grid");
    expect(row?.className).toContain("md:grid-cols-[auto_minmax(160px");
    expect(row?.className).toContain("xl:grid-cols-[auto_minmax(220px");
  });

  it("keeps the preparation card structure and shows a compact unavailable status", () => {
    const itemName = "Makey Kit";
    const serviceExplanation =
      "Not enough requested items are currently available.";
    mocks.useLoaderData.mockReturnValue({
      header: { title: "Operations" },
      view: "to-prepare",
      summary: {
        overdue: 0,
        returns: 0,
        "returned-with-issues": 0,
        broken: 0,
        "to-prepare": 1,
        "cancelled-pickups": 0,
        "ready-for-pickup": 0,
        "access-approvals": 0,
      },
      tasks: [
        {
          id: "preparation-unavailable",
          kind: "to-prepare",
          title: itemName,
          detail: "Preparation requested",
          createdAt: new Date("2026-10-09T08:00:00Z"),
          operationId: "preparation-unavailable",
          preparationStatus: "PENDING_PREPARATION",
          preparationRequest: true,
          bulkReadyEligible: false,
          preparationBlockedReason: serviceExplanation,
          availableForRequestedPeriod: 0,
          availableNow: 5,
          totalPhysicalUnits: 5,
          physicalUnitAssignment: "No unit assigned yet",
          quantity: 1,
          requestedPeriod: "Oct 9 – Nov 23, 2026",
          borrowerName: "Zans Zalik",
          locationName: null,
          assetId: "makey-kit-1",
          href: "/operations?view=to-prepare",
          actionLabel: "Mark prepared",
        },
      ],
      annualAccessApprovals: { pending: [], access: [] },
    });

    render(createElement(OperationsPage));

    expect(screen.getByText(itemName)).toBeTruthy();
    expect(screen.getByText("1 item")).toBeTruthy();
    expect(screen.getByText("Location not set")).toBeTruthy();
    expect(screen.getByText("Zans Zalik")).toBeTruthy();
    expect(screen.getByText("Oct 9 – Nov 23, 2026")).toBeTruthy();
    expect(screen.getByText("0 of 5 available for these dates")).toBeTruthy();
    expect(screen.getByText("5 of 5 available now")).toBeTruthy();
    expect(screen.getByText("No unit assigned yet")).toBeTruthy();
    expect(screen.getByText("Unavailable")).toBeTruthy();
    expect(screen.queryByText(serviceExplanation)).toBeNull();
    expect(screen.queryByText(/2026Period:/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Mark prepared" })).toBeNull();
    const taskCheckbox = screen.getByRole("checkbox", {
      name: `Select ${itemName} for bulk ready`,
    });
    expect((taskCheckbox as HTMLInputElement).disabled).toBe(false);
    fireEvent.click(taskCheckbox);
    expect(screen.getByText("1 selected")).toBeTruthy();
    expect(
      screen.getByText("No selected tasks are available for preparation.")
    ).toBeTruthy();
    expect(screen.getByText("Decline request")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: `Actions for ${itemName}` })
    ).toBeTruthy();

    const unavailableStatus = screen.getByText("Unavailable");
    expect(unavailableStatus.getAttribute("title")).toBe(
      "No units are reservable for the requested period."
    );

    const row = screen.getByText(itemName).closest(".grid");
    expect(row?.className).toContain("md:grid-cols-[auto_minmax(160px");
    expect(row?.className).toContain("xl:grid-cols-[auto_minmax(220px");
  });

  it("shows every assigned unit number on ready preparation rows", () => {
    mocks.useLoaderData.mockReturnValue({
      header: { title: "Operations" },
      view: "ready-for-pickup",
      summary: {
        overdue: 0,
        returns: 0,
        "returned-with-issues": 0,
        broken: 0,
        "to-prepare": 0,
        "cancelled-pickups": 0,
        "ready-for-pickup": 2,
        "access-approvals": 0,
      },
      tasks: ["002", "003"].map((unitNumber) => ({
        id: `ready-${unitNumber}`,
        kind: "ready-for-pickup",
        operationId: `ready-op-${unitNumber}`,
        title: `Makey Kit #${unitNumber}`,
        detail: "Waiting for Zans Zalik to collect.",
        createdAt: new Date("2026-10-09T08:00:00Z"),
        href: "/bookings/booking-1",
        actionLabel: "View booking",
        quantity: 1,
        physicalUnitAssignment: `Assigned: Makey Kit #${unitNumber}`,
      })),
      annualAccessApprovals: { pending: [], access: [] },
    });

    render(createElement(OperationsPage));

    expect(screen.getByText("Assigned: Makey Kit #002")).toBeTruthy();
    expect(screen.getByText("Assigned: Makey Kit #003")).toBeTruthy();
    expect(
      screen.getAllByRole("button", { name: "Confirm pickup" })
    ).toHaveLength(2);
    expect(
      screen.getAllByRole("button", { name: "Cancel pickup" })
    ).toHaveLength(2);
    expect(screen.getAllByRole("link", { name: "View loan" })).toHaveLength(2);
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

    const dashboardSummary = screen
      .getByText("Student access approvals")
      .closest("a");
    expect(dashboardSummary?.className).toContain("h-full");
    expect(dashboardSummary?.className).toContain("min-w-0");

    expect(screen.getByText("Current activity")).toBeTruthy();
    expect(screen.getByText("2 items are ready for pickup.")).toBeTruthy();
    const attention = screen.getByRole("region", { name: "Needs attention" });
    const activity = screen.getByRole("region", { name: "Current activity" });
    expect(attention.contains(activity)).toBe(false);
  });

  it("keeps Dashboard Lab status compact and links General to Operations", () => {
    const status = {
      severity: "attention",
      totalIssues: 5,
      issues: Array.from({ length: 5 }, (_, index) => ({
        id: `general-${index}`,
        kind: "general-report" as const,
        severity: "attention" as const,
        title: `Report ${index}`,
        detail: "Needs review",
        href: "/operations?view=general",
      })),
      overdueLoans: 0,
      returnChecks: 0,
      returnedWithIssues: 0,
      unresolvedReports: 0,
      generalReports: 5,
      preparationTasks: 0,
      cancelledPickups: 0,
      readyForPickup: 0,
      annualAccessApprovals: 0,
      pendingReservationRequests: 0,
      incompleteKits: 0,
      outOfStock: 0,
      lowStock: 0,
      importWarnings: 0,
    } satisfies LabStatus;

    render(createElement(LabStatusCard, { status }));

    expect(screen.getByRole("heading", { name: "Lab status" })).toBeTruthy();
    expect(screen.queryByText("Operations", { selector: "p" })).toBeNull();
    expect(screen.getByText("5").closest("a")?.getAttribute("href")).toBe(
      "/operations?view=general"
    );
    expect(
      screen
        .getByRole("list", { name: "Current lab issues" })
        .querySelectorAll("li")
    ).toHaveLength(3);
    expect(screen.getByText("Showing 3 of 5 items.")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "View all" }).getAttribute("href")
    ).toBe("/operations");
  });

  it("routes Dashboard attention rows to Lab status queues without actions", () => {
    const status = {
      severity: "attention",
      totalIssues: 4,
      issues: [
        {
          id: "general-report",
          kind: "general-report",
          severity: "attention",
          title: "Wrong location",
          detail: "Staff review is required.",
          href: "/operations?view=general",
        },
        {
          id: "broken-report",
          kind: "report",
          severity: "critical",
          title: "Item damaged",
          detail: "Staff review is required.",
          href: "/operations?view=broken",
        },
        {
          id: "return-check",
          kind: "return-check",
          severity: "attention",
          title: "Makey Kit #003",
          detail: "Return waiting for inspection.",
          href: "/operations?view=returns",
        },
        {
          id: "access-approval",
          kind: "annual-access",
          severity: "attention",
          title: "Student access approval",
          detail: "Review access.",
          href: "/operations?view=access-approvals",
        },
      ],
      overdueLoans: 0,
      lowStock: 0,
      outOfStock: 0,
      unresolvedReports: 1,
      generalReports: 1,
      incompleteKits: 0,
      importWarnings: 0,
      pendingReservationRequests: 0,
      returnChecks: 1,
      returnedWithIssues: 0,
      preparationTasks: 0,
      cancelledPickups: 0,
      readyForPickup: 0,
      annualAccessApprovals: 1,
    } satisfies LabStatus;

    const { rerender } = render(createElement(LabStatusCard, { status }));

    const rows = screen.getByRole("list", { name: "Current lab issues" });
    expect(
      within(rows)
        .getByRole("link", {
          name: "Wrong location: Staff review is required.",
        })
        .getAttribute("href")
    ).toBe("/operations?view=general");
    expect(
      within(rows)
        .getByRole("link", { name: "Item damaged: Staff review is required." })
        .getAttribute("href")
    ).toBe("/operations?view=broken");
    expect(
      within(rows)
        .getByRole("link", {
          name: "Makey Kit #003: Return waiting for inspection.",
        })
        .getAttribute("href")
    ).toBe("/operations?view=returns");
    expect(within(rows).queryByRole("button")).toBeNull();
    expect(within(rows).queryByText("Mark complete")).toBeNull();

    rerender(
      createElement(LabStatusCard, {
        status: { ...status, totalIssues: 1, issues: [status.issues[3]] },
      })
    );
    expect(
      screen
        .getByRole("link", {
          name: "Student access approval: Review access.",
        })
        .getAttribute("href")
    ).toBe("/operations?view=access-approvals");
  });
});
