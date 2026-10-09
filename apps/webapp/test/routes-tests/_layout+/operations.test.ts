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
    returnBrokenAssetToService: vi.fn().mockResolvedValue({
      assetId: "asset-1",
      title: "Makey Kit #002",
      status: "AVAILABLE",
    }),
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
  returnBrokenAssetToService: mocks.returnBrokenAssetToService,
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
        if (args.where?.operationType === "IOIO_PREPARATION") return [request];
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
    expect(result.data.summary["to-prepare"]).toBe(1);
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
          title: "Makey Kit #002",
          detail:
            "Broken after return inspection — Disabled after return inspection.",
          createdAt: new Date("2026-10-07T10:00:00Z"),
          assetId: "asset-1",
          physicalUnit: true,
          assetImage: {
            id: "asset-1",
            thumbnailImage: null,
            assetModel: null,
          },
          operationId: "broken-report-1",
          returnToServiceEligible: true,
          locationName: "IOIO Lab - B477 · Shelf A1",
          href: destination.href,
          actionLabel: destination.actionLabel,
        },
      ],
      annualAccessApprovals: { pending: [], access: [] },
    });

    render(createElement(OperationsPage));

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
    expect(screen.getByText("Out of service")).toBeTruthy();
    expect(screen.getByText("Broken after return inspection")).toBeTruthy();
    expect(screen.queryByText("Disabled after return inspection.")).toBeNull();
    expect(screen.getByText("IOIO Lab - B477 · Shelf A1")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Open unit" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Open asset" })).toBeNull();
    expect(screen.queryByText("BROKEN ITEMS")).toBeNull();
    expect(
      screen.getByRole("checkbox", {
        name: "Select Makey Kit #002 for return to service",
      })
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Return to service" })
    ).toBeTruthy();
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
