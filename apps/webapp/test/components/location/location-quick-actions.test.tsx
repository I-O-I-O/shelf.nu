import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import LocationQuickActions from "~/components/location/location-quick-actions";

// why: permission decisions are covered by permission-validator tests; this test focuses on action labels and destinations.
vi.mock("~/hooks/user-user-role-helper", () => ({
  useUserRoleHelper: () => ({ roles: [] }),
}));
// why: this test verifies the links rendered for an authorized staff member without duplicating permission rules.
vi.mock("~/utils/permissions/permission.validator.client", () => ({
  userHasPermission: () => true,
}));
// why: the location delete confirmation is tested separately; render its trigger to keep this focused on quick actions.
vi.mock("~/components/location/delete-location", () => ({
  DeleteLocation: ({ trigger }: { trigger: ReactNode }) => trigger,
}));

describe("Location quick actions", () => {
  it("shows Edit, Print label, and Delete in the location action menu", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <LocationQuickActions
          location={{ id: "room-1", name: "IOIO Lab" }}
          className=""
        />
      </MemoryRouter>
    );

    await user.click(
      screen.getByRole("button", { name: "Actions for IOIO Lab" })
    );
    expect(screen.getByRole("menuitem", { name: "Edit" })).toHaveAttribute(
      "href",
      "/locations/room-1/edit"
    );
    expect(
      screen.getByRole("menuitem", { name: "Print label" })
    ).toHaveAttribute("href", "/labels?locationId=room-1");
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeVisible();
    expect(
      screen.queryByRole("link", { name: "Manage location assets" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Scan assets or kits" })
    ).not.toBeInTheDocument();
  });
});
