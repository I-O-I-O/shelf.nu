import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, MemoryRouter, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";
import type { StudentCheckoutItemDraft } from "~/components/ioio-student/checkout-context";
import { StudentCheckoutButton } from "~/components/ioio-student/student-ui";
import StaffShell, {
  DEFAULT_STAFF_NAVIGATION_ORDER,
  StaffNavigation,
} from "./staff-shell";

function renderStaffShell({
  initialEntry = "/home",
  userId = "staff-1",
  organizationId = "org-1",
  includeBorrowAction = false,
}: {
  initialEntry?: string;
  userId?: string;
  organizationId?: string;
  includeBorrowAction?: boolean;
} = {}) {
  const layoutData = {
    isIoioStaff: true,
    isIoioTA: false,
    labStatus: null,
    user: { id: userId },
    currentOrganizationId: organizationId,
  };
  const router = createMemoryRouter(
    [
      {
        id: "routes/_layout+/_layout",
        path: "/",
        Component: StaffShell,
        loader: () => layoutData,
        children: [
          { path: "home", Component: () => null },
          {
            path: "assets",
            Component: () =>
              includeBorrowAction ? (
                <StudentCheckoutButton asset={staffBorrowableItem} />
              ) : null,
          },
          {
            path: "ioio/checkout",
            Component: () => <p>Shared IOIO checkout route</p>,
          },
          { path: "settings", Component: () => null },
        ],
      },
    ],
    {
      initialEntries: [initialEntry],
      hydrationData: {
        loaderData: { "routes/_layout+/_layout": layoutData },
      },
    }
  );

  return render(<RouterProvider router={router} />);
}

const staffBorrowableItem: StudentCheckoutItemDraft = {
  id: "motor-1",
  title: "Motor",
  type: "QUANTITY_TRACKED",
  isKit: false,
  mainImage: null,
  thumbnailImage: null,
  quantity: 5,
  borrowQuantity: 1,
  assetModel: null,
  availableQuantity: 5,
  availableToBook: true,
  status: "AVAILABLE",
  maxBorrowDays: 45,
  requiresStaffPreparation: false,
  location: "Container A1-1",
  candidateAssetIds: ["motor-1"],
};

function navigationLabels(nav: HTMLElement) {
  return within(nav)
    .getAllByRole("link")
    .map((link) => link.textContent?.trim())
    .filter((label) => label && label !== "My Loans");
}

function renderNavigation(
  initialEntry: string,
  navigationOrder: readonly string[] = ["/bookings"]
) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <StaffNavigation
        navigationOrder={navigationOrder}
        onReorder={() => undefined}
        canViewLabTasks
      />
    </MemoryRouter>
  );
}

function expectSelected(link: HTMLElement, selected: boolean) {
  if (selected) {
    expect(link).toHaveClass("bg-red-50", "text-red-800");
    expect(link).toHaveAttribute("aria-current", "page");
  } else {
    expect(link).not.toHaveClass("bg-red-50", "text-red-800");
    expect(link).not.toHaveAttribute("aria-current", "page");
  }
}

describe("IOIO staff Loans navigation active state", () => {
  it("uses the shared canonical Staff order by default", () => {
    renderNavigation("/home", DEFAULT_STAFF_NAVIGATION_ORDER);

    expect(
      navigationLabels(
        screen.getByRole("navigation", {
          name: "IOIO staff navigation",
        })
      )
    ).toEqual([
      "Dashboard",
      "Ask IOIO",
      "Handbook",
      "Inventory",
      "Categories",
      "Locations",
      "Loans",
      "Calendar",
      "Analytics",
      "Settings",
      "Archive",
      "Trash",
    ]);
  });

  it("selects Loans on the organization loan list only", () => {
    renderNavigation("/bookings");

    expectSelected(screen.getByRole("link", { name: "Loans" }), true);
    expectSelected(screen.getByRole("link", { name: "My Loans" }), false);
    expect(screen.getByRole("link", { name: "Loans" })).toHaveAttribute(
      "href",
      "/bookings"
    );
    expect(screen.getByRole("link", { name: "My Loans" })).toHaveAttribute(
      "href",
      "/ioio/loans"
    );
  });

  it("keeps the legacy filtered booking list separate from personal My Loans", () => {
    renderNavigation("/bookings?mine=1");

    expectSelected(screen.getByRole("link", { name: "Loans" }), false);
    expectSelected(screen.getByRole("link", { name: "My Loans" }), false);
    expect(
      screen.getByRole("button", { name: "Collapse Loans" })
    ).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps nested booking details under Loans even with a mine query", () => {
    renderNavigation("/bookings/loan-123?mine=1");

    expectSelected(screen.getByRole("link", { name: "Loans" }), true);
    expectSelected(screen.getByRole("link", { name: "My Loans" }), false);
  });

  it("selects personal My Loans on the shared IOIO loans route", () => {
    renderNavigation("/ioio/loans");

    expectSelected(screen.getByRole("link", { name: "Loans" }), false);
    expectSelected(screen.getByRole("link", { name: "My Loans" }), true);
    expect(
      screen.getByRole("button", { name: "Collapse Loans" })
    ).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps the staff navigation and hides the four removed sidebar entries", () => {
    renderNavigation("/bookings", [
      "/home",
      "/staff/ask",
      "/handbook",
      "/assets",
      "/staff/archived",
      "/staff/trash",
      "/categories",
      "/locations",
      "/bookings",
      "/calendar",
      "/reports",
      "/settings",
    ]);

    for (const label of [
      "Dashboard",
      "Ask IOIO",
      "Handbook",
      "Inventory",
      "Archive",
      "Trash",
      "Categories",
      "Locations",
      "Loans",
      "My Loans",
      "Calendar",
      "Analytics",
      "Settings",
    ]) {
      expect(screen.getByRole("link", { name: label })).toBeInTheDocument();
    }
    expect(screen.queryByRole("link", { name: "Import" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Organize" })).toBeNull();

    for (const label of ["Operations", "Lab Tasks", "Purchasing", "TA Hours"]) {
      expect(
        screen.queryByRole("link", { name: label })
      ).not.toBeInTheDocument();
    }
  });
});

describe("StaffShell navigation order persistence", () => {
  beforeEach(() => window.localStorage.clear());

  it("keeps one custom order across navigation and a shell remount", async () => {
    const rendered = renderStaffShell();
    const nav = screen.getByRole("navigation", {
      name: "IOIO staff navigation",
    });
    await waitFor(() => {
      expect(navigationLabels(nav)).toEqual([
        "Dashboard",
        "Ask IOIO",
        "Handbook",
        "Inventory",
        "Categories",
        "Locations",
        "Loans",
        "Calendar",
        "Analytics",
        "Settings",
        "Archive",
        "Trash",
      ]);
    });

    const inventory = within(nav).getByRole("link", { name: "Inventory" });
    const dashboard = within(nav).getByRole("link", { name: "Dashboard" });
    const dataTransfer = {
      effectAllowed: "",
      dropEffect: "",
      setData: () => undefined,
      getData: () => "/assets",
    };
    fireEvent.dragStart(inventory, { dataTransfer });
    fireEvent.drop(dashboard, { dataTransfer });

    await waitFor(() => {
      expect(navigationLabels(nav).slice(0, 5)).toEqual([
        "Dashboard",
        "Inventory",
        "Ask IOIO",
        "Handbook",
        "Categories",
      ]);
    });

    await userEvent.click(within(nav).getByRole("link", { name: "Settings" }));
    await waitFor(() =>
      expect(
        within(nav).getByRole("link", { name: "Settings" })
      ).toHaveAttribute("aria-current", "page")
    );
    expect(navigationLabels(nav).slice(0, 5)).toEqual([
      "Dashboard",
      "Inventory",
      "Ask IOIO",
      "Handbook",
      "Categories",
    ]);

    rendered.unmount();
    renderStaffShell({ initialEntry: "/assets" });
    const refreshedNav = screen.getByRole("navigation", {
      name: "IOIO staff navigation",
    });
    await waitFor(() => {
      expect(navigationLabels(refreshedNav).slice(0, 5)).toEqual([
        "Dashboard",
        "Inventory",
        "Ask IOIO",
        "Handbook",
        "Categories",
      ]);
    });
  });

  it("does not share a saved order between users or organizations", async () => {
    const firstUser = renderStaffShell({
      userId: "staff-1",
      organizationId: "org-1",
    });
    const nav = screen.getByRole("navigation", {
      name: "IOIO staff navigation",
    });
    await waitFor(() =>
      expect(navigationLabels(nav)).toEqual([
        "Dashboard",
        "Ask IOIO",
        "Handbook",
        "Inventory",
        "Categories",
        "Locations",
        "Loans",
        "Calendar",
        "Analytics",
        "Settings",
        "Archive",
        "Trash",
      ])
    );

    const inventory = within(nav).getByRole("link", { name: "Inventory" });
    const dashboard = within(nav).getByRole("link", { name: "Dashboard" });
    const dataTransfer = {
      effectAllowed: "",
      dropEffect: "",
      setData: () => undefined,
      getData: () => "/assets",
    };
    fireEvent.dragStart(inventory, { dataTransfer });
    fireEvent.drop(dashboard, { dataTransfer });
    await waitFor(() => expect(navigationLabels(nav)[1]).toBe("Inventory"));

    firstUser.unmount();
    renderStaffShell({ userId: "staff-2", organizationId: "org-1" });
    const otherUserNav = screen.getByRole("navigation", {
      name: "IOIO staff navigation",
    });
    await waitFor(() =>
      expect(navigationLabels(otherUserNav)[1]).toBe("Ask IOIO")
    );
  });
});

describe("StaffShell account controls", () => {
  it("keeps shell actions and content spacing without a header divider", () => {
    renderStaffShell();

    const header = screen.getByRole("banner");
    expect(header).not.toHaveClass("border-b");
    expect(
      within(header).getByRole("button", {
        name: "Open lab status notifications",
      })
    ).toBeInTheDocument();
    expect(
      within(header).getByRole("link", { name: /Open Basket/ })
    ).toBeInTheDocument();
    expect(within(header).getByText("Basket")).toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveClass("pt-2");
  });

  it("adds a staff inventory item to the shared basket and opens checkout", async () => {
    window.sessionStorage.clear();
    const user = userEvent.setup();
    renderStaffShell({ initialEntry: "/assets", includeBorrowAction: true });

    await user.click(
      screen.getByRole("button", { name: "Add to borrow list" })
    );
    const basketLink = await screen.findByRole("link", {
      name: /Open Basket, 1 selected item/,
    });
    expect(within(basketLink).getByText("1")).toBeInTheDocument();

    await user.click(basketLink);
    expect(
      await screen.findByText("Shared IOIO checkout route")
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(window.sessionStorage.getItem("ioio-student-checkout")).toContain(
        '"id":"motor-1"'
      );
    });
  });

  it("does not expose workspace switching or workspace management", async () => {
    const user = userEvent.setup();
    renderStaffShell();

    await screen.findByRole("region", { name: "Staff account" });
    expect(screen.queryByText("Workspace")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /current workspace/i })
    ).toBeNull();
    expect(
      screen.queryByRole("link", { name: "Manage workspaces" })
    ).toBeNull();
    expect(screen.queryByRole("link", { name: "Invite your team" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Menu" }));

    expect(screen.queryByText("Workspace")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /current workspace/i })
    ).toBeNull();
    expect(
      screen.queryByRole("link", { name: "Manage workspaces" })
    ).toBeNull();
  });
});
