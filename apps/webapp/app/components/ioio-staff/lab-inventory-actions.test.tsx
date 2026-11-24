import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";
import { createLabStatus } from "@factories";
import type { LabIssue } from "~/modules/ioio-staff/lab-status.server";
import { LabStatusCard } from "./lab-status";

function inventoryIssue(
  index: number,
  options: { pooled?: boolean; disabled?: boolean } = {}
): LabIssue {
  return {
    id: `report:${index}`,
    kind: "report",
    severity: "critical",
    title: `Equipment report ${index}`,
    detail: "Staff review is required.",
    href: "/operations?view=broken",
    inventoryTarget: {
      assetId: `asset-${index}`,
      title: `Equipment ${index}`,
      pooled: options.pooled ?? false,
      disabled: options.disabled ?? false,
    },
  };
}

function renderDashboard(canManageInventory = true) {
  const issues = [
    inventoryIssue(1),
    inventoryIssue(2, { disabled: true }),
    inventoryIssue(3, { pooled: true }),
    inventoryIssue(4),
  ];
  const submissions: FormData[] = [];
  const router = createMemoryRouter(
    [
      {
        path: "/home",
        Component: () => (
          <LabStatusCard
            status={createLabStatus({ issues })}
            canManageInventory={canManageInventory}
          />
        ),
        action: async ({ request }) => {
          submissions.push(await request.formData());
          return { kind: "lab-inventory-updated", count: 4 };
        },
      },
    ],
    { initialEntries: ["/home"] }
  );
  render(<RouterProvider router={router} />);
  return submissions;
}

describe("Dashboard inventory management", () => {
  it("selects all four targets beyond the preview and confirms the exact count", async () => {
    const user = userEvent.setup();
    const submissions = renderDashboard();
    expect(screen.queryByText("Equipment report 4")).toBeNull();

    await user.click(
      screen.getByRole("checkbox", {
        name: "Select all reported inventory items",
      })
    );
    expect(screen.getByText("4 selected")).toBeInTheDocument();
    expect(screen.getByText("Equipment report 4")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Disable selected (2)" })
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Re-enable selected (1)" })
    ).toBeEnabled();
    await user.click(
      screen.getByRole("button", { name: "Delete selected permanently (4)" })
    );
    const confirmation = screen.getByRole("dialog");
    expect(
      within(confirmation).getByText(/Permanently remove 4 units/)
    ).toBeInTheDocument();
    expect(submissions).toHaveLength(0);
    await user.click(
      within(confirmation).getByRole("button", {
        name: "Delete selected permanently",
      })
    );
    expect(
      await screen.findByText("Inventory updated for 4 items.")
    ).toBeInTheDocument();
    expect(submissions[0]?.getAll("target")).toEqual(["s1", "s2", "p3", "s4"]);
    expect(submissions[0]?.get("confirmed")).toBe("yes");
  });

  it("offers only applicable actions on a disabled unit and cancels without submission", async () => {
    const user = userEvent.setup();
    const submissions = renderDashboard();
    const menu = screen.getByRole("button", {
      name: "Actions for Equipment report 2",
    });
    menu.focus();
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("menuitem", { name: "Disable item" })).toBeNull();
    await user.click(screen.getByRole("menuitem", { name: "Re-enable item" }));
    const confirmation = screen.getByRole("dialog");
    expect(
      within(confirmation).getByText("Restore borrowing for 1 item.")
    ).toBeInTheDocument();
    await user.click(
      within(confirmation).getByRole("button", { name: "Cancel" })
    );
    expect(submissions).toHaveLength(0);
  });

  it("keeps the issue links visible without inventory mutation permission", () => {
    renderDashboard(false);
    expect(
      screen.getByRole("link", { name: /Equipment report 1/ })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Actions for Equipment/ })
    ).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /Select all/ })).toBeNull();
  });
});
