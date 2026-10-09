import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
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
  it("shows only Edit, Print label, and Delete for a location card", () => {
    render(
      <MemoryRouter>
        <LocationQuickActions
          location={{ id: "room-1", name: "IOIO Lab" }}
          className=""
        />
      </MemoryRouter>
    );

    expect(screen.getByRole("link", { name: "Edit location" })).toHaveAttribute(
      "href",
      "/locations/room-1/edit"
    );
    expect(
      screen.getByRole("link", { name: "Print location label" })
    ).toHaveAttribute("href", "/labels?locationId=room-1");
    expect(
      screen.getByRole("button", { name: "Delete location" })
    ).toBeVisible();
    expect(
      screen.queryByRole("link", { name: "Manage location assets" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Scan assets or kits" })
    ).not.toBeInTheDocument();
  });
});
