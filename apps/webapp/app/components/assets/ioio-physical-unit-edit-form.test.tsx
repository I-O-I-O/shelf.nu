import { cleanup, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { IoioPhysicalUnitEditForm } from "./ioio-physical-unit-edit-form";

describe("IoioPhysicalUnitEditForm", () => {
  afterEach(() => cleanup());

  it("shows direct availability and QR actions without unit number editing", () => {
    const router = createMemoryRouter(
      [
        {
          path: "/assets/unit-3/edit",
          element: (
            <IoioPhysicalUnitEditForm
              id="unit-3"
              title="Makey Kit #003"
              status="AVAILABLE"
              availableToBook
              availabilityBlock={null}
              qrId="qr-3"
            />
          ),
        },
      ],
      { initialEntries: ["/assets/unit-3/edit"] }
    );
    render(<RouterProvider router={router} />);

    expect(
      screen.getByRole("heading", { name: "Makey Kit #003" })
    ).toBeTruthy();
    expect(screen.getByText("Available", { exact: true })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Mark unavailable" })
    ).toBeEnabled();
    expect(
      screen.getByRole("link", { name: "Print unit label" })
    ).toHaveAttribute("href", "/labels?assetId=unit-3");
    expect(screen.queryByLabelText("Unit number")).toBeNull();
    expect(
      screen.queryByRole("link", { name: "Manage availability" })
    ).toBeNull();
  });

  it("locks availability while the unit is checked out", () => {
    const router = createMemoryRouter(
      [
        {
          path: "/assets/unit-3/edit",
          element: (
            <IoioPhysicalUnitEditForm
              id="unit-3"
              title="Makey Kit #003"
              status="CHECKED_OUT"
              availableToBook
              availabilityBlock="This unit is checked out and cannot be marked available until it is returned."
              qrId="qr-3"
            />
          ),
        },
      ],
      { initialEntries: ["/assets/unit-3/edit"] }
    );
    render(<RouterProvider router={router} />);

    expect(screen.getByText("Checked out", { exact: true })).toBeTruthy();
    expect(screen.getByText(/cannot be marked available/)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Availability locked" })
    ).toBeDisabled();
  });
});
