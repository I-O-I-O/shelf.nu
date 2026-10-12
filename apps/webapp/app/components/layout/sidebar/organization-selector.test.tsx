import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SidebarProvider } from "~/components/layout/sidebar/sidebar";
import { CHANGE_CURRENT_ORGANIZATION_ACTION } from "~/modules/organization/constants";
import type { OrganizationFromUser } from "~/modules/organization/service.server";
import OrganizationSelector from "./organization-selector";

const organizations = [
  {
    id: "personal-workspace-id",
    name: "Personal workspace",
    type: "PERSONAL",
    imageId: null,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  },
  {
    id: "ioio-lab-dev-id",
    name: "IOIO Lab Dev",
    type: "TEAM",
    imageId: null,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  },
] as unknown as OrganizationFromUser[];

function renderSelector() {
  function AuthenticatedLayout() {
    return (
      <SidebarProvider>
        <Outlet />
      </SidebarProvider>
    );
  }

  const router = createMemoryRouter(
    [
      {
        id: "routes/_layout+/_layout",
        path: "/",
        loader: () => ({
          organizations,
          currentOrganizationId: "personal-workspace-id",
        }),
        Component: AuthenticatedLayout,
        children: [
          {
            path: "ioio",
            Component: () => <OrganizationSelector variant="ioio" />,
          },
        ],
      },
    ],
    {
      initialEntries: ["/ioio"],
      hydrationData: {
        loaderData: {
          "routes/_layout+/_layout": {
            organizations,
            currentOrganizationId: "personal-workspace-id",
          },
        },
      },
    }
  );

  return render(<RouterProvider router={router} />);
}

describe("IOIO workspace selector", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the current workspace and only workspaces supplied by the loader", async () => {
    const user = userEvent.setup();
    renderSelector();

    expect(
      screen.getByRole("button", {
        name: "Current workspace: Personal workspace. Switch workspace",
      })
    ).toHaveTextContent("Personal workspace");

    await user.click(
      screen.getByRole("button", {
        name: "Current workspace: Personal workspace. Switch workspace",
      })
    );

    expect(
      await screen.findByRole("menuitem", { name: "IOIO Lab Dev" })
    ).toBeTruthy();
    expect(
      screen.getByRole("menuitem", { name: "Personal workspace" })
    ).toBeTruthy();
    expect(
      screen.queryByRole("menuitem", { name: "Other user's workspace" })
    ).toBeNull();
  });

  it("submits the selected workspace through Shelf's native organization action", async () => {
    const user = userEvent.setup();
    const submittedForms: HTMLFormElement[] = [];
    vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(function (
      this: HTMLFormElement
    ) {
      submittedForms.push(this);
    });
    renderSelector();

    await user.click(
      screen.getByRole("button", {
        name: "Current workspace: Personal workspace. Switch workspace",
      })
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "IOIO Lab Dev" })
    );

    await waitFor(() => expect(submittedForms).toHaveLength(1));
    const form = submittedForms[0];
    expect(form.action).toContain(CHANGE_CURRENT_ORGANIZATION_ACTION);
    expect(form.method).toBe("post");
    expect(form.querySelector('input[name="organizationId"]')).toHaveValue(
      "ioio-lab-dev-id"
    );
  });
});
