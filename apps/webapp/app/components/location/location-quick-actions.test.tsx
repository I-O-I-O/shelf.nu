import { createElement } from "react";
import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import LocationQuickActions from "~/components/location/location-quick-actions";

// why: actions are verified with the existing permission boundary granted without loading user/session state.
vi.mock("~/hooks/user-user-role-helper", () => ({
  useUserRoleHelper: () => ({ roles: ["ADMIN"] }),
}));
vi.mock("~/utils/permissions/permission.validator.client", () => ({
  userHasPermission: () => true,
}));
// why: the delete dialog behavior is tested elsewhere; this test checks that the menu retains its Delete trigger.
vi.mock("./delete-location", () => ({
  DeleteLocation: ({ trigger }: { trigger: ReactNode }) => trigger,
}));

describe("Location quick actions", () => {
  it("keeps edit, move, print, and delete actions in a compact menu", async () => {
    const user = userEvent.setup();
    const onMove = vi.fn();
    render(
      createElement(
        MemoryRouter,
        null,
        createElement(LocationQuickActions, {
          location: { id: "shelf-1", name: "Shelf A1", childCount: 2 },
          onMove,
        })
      )
    );

    await user.click(
      screen.getByRole("button", { name: "Actions for Shelf A1" })
    );
    expect(screen.getByRole("menuitem", { name: "Edit" })).toHaveAttribute(
      "href",
      "/locations/shelf-1/edit"
    );
    await user.click(screen.getByRole("menuitem", { name: "Move..." }));
    expect(onMove).toHaveBeenCalledOnce();
    await user.click(
      screen.getByRole("button", { name: "Actions for Shelf A1" })
    );
    expect(
      screen.getByRole("menuitem", { name: "Print label" })
    ).toHaveAttribute("href", "/labels?locationId=shelf-1");
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeVisible();
  });
});
