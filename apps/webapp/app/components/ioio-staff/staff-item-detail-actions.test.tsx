import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";
import { StaffItemDetailActions } from "./staff-item-detail-actions";

function renderActions({ edit = false, lifecycle = false } = {}) {
  const router = createMemoryRouter([
    {
      path: "/",
      element: (
        <StaffItemDetailActions
          asset={{ id: "motor-1", title: "Motor", mainImage: null }}
          labelAssetIds={["motor-1", "motor-2"]}
          editAction={
            edit
              ? {
                  to: "/assets/motor-1/edit?productGroup=1",
                  label: "Edit general item",
                }
              : undefined
          }
          canManageLifecycle={lifecycle}
        />
      ),
    },
  ]);
  render(<RouterProvider router={router} />);
}

describe("Staff asset detail actions", () => {
  it("uses the same edit destination in the phone menu and desktop action", async () => {
    const user = userEvent.setup();
    renderActions({ edit: true, lifecycle: true });
    const edit = screen.getByRole("link", { name: "Edit general item" });
    expect(edit).toHaveClass("max-md:hidden");
    const menuTrigger = screen.getByRole("button", {
      name: "More item actions",
    });
    expect(menuTrigger).toHaveClass("max-md:size-11");
    menuTrigger.focus();
    await user.keyboard("{Enter}");
    const mobileEdit = await screen.findByRole("menuitem", {
      name: "Edit general item",
    });
    expect(mobileEdit).toHaveAttribute("href", edit.getAttribute("href"));
    expect(mobileEdit).toHaveClass("md:hidden");
    expect(
      screen.getByRole("link", { name: "Print label / QR" })
    ).toHaveAttribute("href", "/labels?assetIds=motor-1%2Cmotor-2");
    expect(screen.getByRole("button", { name: "Archive" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });

  it("keeps labels reachable without exposing restricted actions", async () => {
    const user = userEvent.setup();
    renderActions();
    await user.click(screen.getByRole("button", { name: "More item actions" }));
    expect(await screen.findByRole("menu")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Print label / QR" })
    ).toBeInTheDocument();
    expect(screen.queryByText(/Edit general item|Archive|Delete/)).toBeNull();
  });
});
