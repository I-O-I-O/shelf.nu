import { cleanup, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { StaffItemDetail } from "~/components/ioio-staff/staff-item-detail";
import { StaffAssetDetailShell } from "./staff-asset-detail-shell";

describe("StaffAssetDetailShell", () => {
  afterEach(() => cleanup());

  it("keeps the IOIO detail actions and content without Shelf's extra navigation", () => {
    const router = createMemoryRouter(
      [
        {
          path: "/assets/:assetId",
          element: (
            <StaffAssetDetailShell bookAction={<button>Book</button>}>
              <StaffItemDetail
                title="Makey Kit"
                image={<div>Kit image</div>}
                availableQuantity={2}
                totalQuantity={5}
                unitLabel="kits"
                categoryName="Kits"
                locationPath={["IOIO Lab", "Container A1-1"]}
                maxBorrowDays={45}
                tracking="Individual QR tracking"
                borrowAction={<button type="button">Borrow</button>}
                actions={<a href="/assets/kit-1/edit">Edit general item</a>}
                additionalFields={[
                  { label: "Extension period", value: "14 days" },
                  { label: "Borrowing approval", value: "Required" },
                  { label: "Preparation", value: "TA prepares this item" },
                  { label: "Returns", value: "Assigned storage location" },
                ]}
                physicalUnits={[
                  {
                    id: "unit-1",
                    title: "Makey Kit #001",
                    status: "Available",
                    canChangeAvailability: true,
                    unavailableReason: null,
                  },
                ]}
                canEditPhysicalUnits
                physicalUnitsActionUrl="/assets/kit-1/overview"
              />
            </StaffAssetDetailShell>
          ),
        },
      ],
      { initialEntries: ["/assets/kit-1"] }
    );

    render(<RouterProvider router={router} />);

    expect(screen.getByRole("link", { name: "Overview" })).toBeTruthy();
    expect(screen.queryByText("Activity")).toBeNull();
    expect(screen.queryByText("Bookings")).toBeNull();
    expect(screen.queryByText("Reminders")).toBeNull();
    expect(screen.queryByTestId("assetActionsButton")).toBeNull();
    expect(screen.queryByText("Ask IOIO about this item")).toBeNull();

    expect(
      screen.getByRole("link", { name: "Back to inventory" })
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Makey Kit" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Borrow" })).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Edit general item" })
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Book" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Details" })).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Physical units" })
    ).toBeTruthy();
    expect(screen.getByText("2 / 5 kits available")).toBeTruthy();
    expect(screen.getByText("Preparation")).toBeTruthy();
    expect(screen.getByText("Returns")).toBeTruthy();
    expect(screen.getByText("Extension period")).toBeTruthy();
    expect(screen.getByText("Borrowing approval")).toBeTruthy();
    expect(screen.getByText("Kit image")).toBeTruthy();
    expect(screen.getByText("IOIO Lab")).toBeTruthy();
    expect(screen.getByText(/Container A1-1/u)).toBeTruthy();
    expect(screen.getByText("Kits")).toBeTruthy();
    expect(screen.getByText("45 days")).toBeTruthy();
    expect(screen.getByText("14 days")).toBeTruthy();
    expect(screen.getByText("Individual QR tracking")).toBeTruthy();
  });
});
