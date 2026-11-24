import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub, useLocation } from "react-router";
import { describe, expect, it } from "vitest";
import { IoioCalendarFilters } from "./ioio-calendar-filters";

function CalendarFilterProbe() {
  const location = useLocation();
  return (
    <>
      <IoioCalendarFilters />
      <output data-testid="calendar-search">{location.search}</output>
    </>
  );
}

describe("IOIO Calendar filters", () => {
  it("shows only booking search and status, and can clear status without losing date state", async () => {
    const Stub = createRoutesStub([
      {
        path: "/calendar",
        Component: CalendarFilterProbe,
        loader: () => ({
          modelName: { singular: "booking", plural: "bookings" },
          search: "",
        }),
        HydrateFallback: () => <div>Loading filters</div>,
      },
    ]);

    const user = userEvent.setup();
    render(
      <Stub initialEntries={["/calendar?start=2026-10-08T00%3A00%3A00.000Z"]} />
    );

    expect(
      await screen.findByRole("textbox", { name: "Search by booking" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Filter by status" })
    ).toBeInTheDocument();
    expect(screen.queryByText("Custodian")).toBeNull();
    expect(screen.queryByText("Tags")).toBeNull();

    await user.click(
      screen.getByRole("combobox", { name: "Filter by status" })
    );
    await user.click(await screen.findByRole("option", { name: "ONGOING" }));

    await waitFor(() => {
      expect(screen.getByTestId("calendar-search")).toHaveTextContent(
        "status=ONGOING"
      );
      expect(screen.getByTestId("calendar-search")).toHaveTextContent(
        "start=2026-10-08T00%3A00%3A00.000Z"
      );
    });

    await user.click(
      screen.getByRole("combobox", { name: "Filter by status" })
    );
    await user.click(await screen.findByRole("option", { name: "ALL" }));

    await waitFor(() => {
      expect(screen.getByTestId("calendar-search")).toHaveTextContent(
        "start=2026-10-08T00%3A00%3A00.000Z"
      );
      expect(screen.getByTestId("calendar-search")).not.toHaveTextContent(
        "status="
      );
    });
  });
});
