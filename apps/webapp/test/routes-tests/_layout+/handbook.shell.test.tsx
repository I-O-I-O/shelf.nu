import { render, screen } from "@testing-library/react";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";
import HandbookLayout from "~/routes/_layout+/handbook";

function HandbookRouteContent() {
  return <h1>Handbook route content</h1>;
}

function renderHandbookRoute(path: string, roles: string[] = ["SELF_SERVICE"]) {
  const router = createMemoryRouter(
    [
      {
        id: "routes/_layout+/_layout",
        loader: () => ({
          currentOrganizationUserRoles: roles,
          currentOrganizationId: "organization-1",
          user: { id: "user-1" },
          studentIoioNotifications: [],
          annualAccessApproval: null,
        }),
        Component: Outlet,
        children: [
          {
            path: "handbook",
            Component: HandbookLayout,
            children: [
              { index: true, Component: HandbookRouteContent },
              { path: "new", Component: HandbookRouteContent },
              { path: "my-work", Component: HandbookRouteContent },
              { path: "review", Component: HandbookRouteContent },
              { path: ":slug", Component: HandbookRouteContent },
              { path: ":slug/edit", Component: HandbookRouteContent },
            ],
          },
        ],
      },
    ],
    { initialEntries: [path] }
  );

  return render(<RouterProvider router={router} />);
}

describe("Handbook application shell", () => {
  it.each([
    "/handbook",
    "/handbook/new",
    "/handbook/my-work",
    "/handbook/what-3d-printing-is",
    "/handbook/what-3d-printing-is/edit",
  ])("keeps the student shell and active Handbook link on %s", async (path) => {
    renderHandbookRoute(path);

    expect(
      await screen.findByRole("heading", { name: "Handbook route content" })
    ).toBeTruthy();
    expect(screen.getByText("Student desk")).toBeTruthy();
    const handbookLink = screen.getByRole("link", { name: "Handbook" });
    expect(handbookLink.className).toContain("bg-red-700");
    expect(screen.queryByText("Review contributions")).toBeNull();
    expect(screen.queryByText("Inventory")).toBeNull();
    expect(screen.queryByText("Archive")).toBeNull();
  });

  it("passes Staff routes through to the existing Staff shell", async () => {
    renderHandbookRoute("/handbook/review", ["ADMIN"]);

    expect(
      await screen.findByRole("heading", { name: "Handbook route content" })
    ).toBeTruthy();
    expect(screen.queryByText("Student desk")).toBeNull();
  });
});
