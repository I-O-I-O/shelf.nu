import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, MemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";
import StaffShell, { StaffNavigation } from "./staff-shell";

function renderStaffShell() {
  const layoutData = {
    isIoioStaff: true,
    isIoioTA: false,
    labStatus: null,
    assignedLabTaskCount: 0,
  };
  const router = createMemoryRouter(
    [
      {
        id: "routes/_layout+/_layout",
        path: "/",
        Component: StaffShell,
        loader: () => layoutData,
        children: [{ path: "home", Component: () => null }],
      },
    ],
    {
      initialEntries: ["/home"],
      hydrationData: {
        loaderData: { "routes/_layout+/_layout": layoutData },
      },
    }
  );

  return render(<RouterProvider router={router} />);
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
  it("selects Loans on the organization loan list only", () => {
    renderNavigation("/bookings");

    expectSelected(screen.getByRole("link", { name: "Loans" }), true);
    expectSelected(screen.getByRole("link", { name: "My Loans" }), false);
  });

  it("selects My Loans for mine=1 while keeping the Loans group expanded", () => {
    renderNavigation("/bookings?mine=1");

    expectSelected(screen.getByRole("link", { name: "Loans" }), false);
    expectSelected(screen.getByRole("link", { name: "My Loans" }), true);
    expect(
      screen.getByRole("button", { name: "Collapse Loans" })
    ).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps nested booking details under Loans even with a mine query", () => {
    renderNavigation("/bookings/loan-123?mine=1");

    expectSelected(screen.getByRole("link", { name: "Loans" }), true);
    expectSelected(screen.getByRole("link", { name: "My Loans" }), false);
  });

  it("does not highlight staff loan links on the student loans route", () => {
    renderNavigation("/ioio/loans");

    expectSelected(screen.getByRole("link", { name: "Loans" }), false);
    expectSelected(screen.getByRole("link", { name: "My Loans" }), false);
    expect(
      screen.getByRole("button", { name: "Collapse Loans" })
    ).toHaveAttribute("aria-expanded", "true");
  });

  it("exposes the existing Operations and staff tool destinations", () => {
    renderNavigation("/operations/tasks", [
      "/operations",
      "/operations/tasks",
      "/purchasing",
      "/ta-hours",
    ]);

    expect(screen.getByRole("link", { name: "Operations" })).toHaveAttribute(
      "href",
      "/operations"
    );
    expect(screen.getByRole("link", { name: "Lab Tasks" })).toHaveAttribute(
      "href",
      "/operations/tasks"
    );
    expect(screen.getByRole("link", { name: "Purchasing" })).toHaveAttribute(
      "href",
      "/purchasing"
    );
    expect(screen.getByRole("link", { name: "TA Hours" })).toHaveAttribute(
      "href",
      "/ta-hours"
    );
  });
});

describe("StaffShell account controls", () => {
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
