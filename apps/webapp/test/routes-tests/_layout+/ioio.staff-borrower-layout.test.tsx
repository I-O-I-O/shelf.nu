import { render, screen } from "@testing-library/react";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";
import IoioLayout from "~/routes/_layout+/ioio";

function renderIoioRoute(initialEntry: string) {
  const layoutData = {
    isIoioStaff: true,
    currentOrganizationUserRoles: ["ADMIN"],
  };
  const router = createMemoryRouter(
    [
      {
        id: "routes/_layout+/_layout",
        path: "/",
        loader: () => layoutData,
        Component: Outlet,
        children: [
          {
            id: "routes/_layout+/ioio",
            path: "ioio",
            Component: IoioLayout,
            children: [
              { path: "checkout", Component: () => <p>Shared checkout</p> },
              { path: "browse", Component: () => <p>Student browse</p> },
            ],
          },
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

describe("Staff access to IOIO borrower routes", () => {
  it("renders the shared checkout child inside the Staff shell outlet", () => {
    renderIoioRoute("/ioio/checkout");

    expect(screen.getByText("Shared checkout")).toBeInTheDocument();
  });

  it("does not expose the student inventory child to Staff", () => {
    renderIoioRoute("/ioio/browse");

    expect(screen.queryByText("Student browse")).not.toBeInTheDocument();
  });
});
