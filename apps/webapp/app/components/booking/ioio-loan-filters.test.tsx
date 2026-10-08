import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub, useLocation } from "react-router";
import { describe, expect, it } from "vitest";
import { IoioLoanFilters } from "./ioio-loan-filters";

function LoanFilterProbe() {
  const location = useLocation();
  return (
    <>
      <IoioLoanFilters dateYears={[2025, 2026]} />
      <output data-testid="loan-search">{location.search}</output>
    </>
  );
}

describe("IOIO Loans filters", () => {
  it("preserves the My Loans scope while status changes reset only pagination", async () => {
    const Stub = createRoutesStub([
      {
        path: "/bookings",
        Component: LoanFilterProbe,
        loader: () => ({
          modelName: { singular: "loan", plural: "loans" },
          search: "camera",
        }),
        HydrateFallback: () => <div>Loading filters</div>,
      },
    ]);
    const user = userEvent.setup();

    render(
      <Stub
        initialEntries={[
          "/bookings?mine=1&s=camera&page=3&dateRange=year%3A2025",
        ]}
      />
    );

    expect(
      await screen.findByRole("textbox", { name: "Search by loan" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Filter by status" })
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("combobox", { name: "Filter by status" })
    );
    await user.click(await screen.findByRole("option", { name: "OVERDUE" }));

    await waitFor(() => {
      const search = screen.getByTestId("loan-search");
      expect(search).toHaveTextContent("mine=1");
      expect(search).toHaveTextContent("s=camera");
      expect(search).toHaveTextContent("dateRange=year%3A2025");
      expect(search).toHaveTextContent("status=OVERDUE");
      expect(search).not.toHaveTextContent("page=");
    });
  });
});
