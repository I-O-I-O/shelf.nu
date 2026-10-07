import { cleanup, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { StaffItemDetail } from "./staff-item-detail";

describe("StaffItemDetail", () => {
  afterEach(() => cleanup());

  it("keeps the general item title separate from its physical units", () => {
    const router = createMemoryRouter(
      [
        {
          path: "/assets/item-1/overview",
          element: (
            <StaffItemDetail
              title="Makey Kit"
              image={<div>Kit image</div>}
              availableQuantity={5}
              unitLabel="units"
              locationPath={["IOIO Lab", "Storage"]}
              physicalUnits={[
                {
                  id: "unit-1",
                  title: "Makey Kit #001",
                  status: "Available",
                  canChangeAvailability: true,
                  unavailableReason: null,
                },
                {
                  id: "unit-2",
                  title: "Makey Kit #002",
                  status: "In use",
                  canChangeAvailability: false,
                  unavailableReason: "This unit is currently in use.",
                },
              ]}
              canEditPhysicalUnits
              physicalUnitsActionUrl="/assets/item-1/overview"
              actions={
                <a href="/assets/item-1/edit?productGroup=1">Edit item</a>
              }
            />
          ),
        },
      ],
      { initialEntries: ["/assets/item-1/overview"] }
    );
    render(<RouterProvider router={router} />);

    expect(screen.getByRole("heading", { name: "Makey Kit" })).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: "Makey Kit #005" })
    ).toBeNull();
    expect(screen.getByText("Physical units")).toBeTruthy();
    expect(screen.getByText("Makey Kit #001")).toBeTruthy();
    expect(screen.getByText("Makey Kit #002")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Edit item" }).getAttribute("href")
    ).toBe("/assets/item-1/edit?productGroup=1");
    expect(
      screen.getByRole("button", { name: "Actions for Makey Kit #001" })
    ).toBeTruthy();
  });
});
