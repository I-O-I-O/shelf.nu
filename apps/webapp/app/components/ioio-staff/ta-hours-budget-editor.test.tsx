import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";
import { TAHoursBudgetEditor } from "./ta-hours-budget-editor";

describe("TAHoursBudgetEditor", () => {
  it("shows only hours and builds a save payload without money or a rate", async () => {
    const router = createMemoryRouter(
      [
        {
          path: "/ta-hours",
          Component: () => (
            <TAHoursBudgetEditor
              academicYear="2026-2027"
              hours="100"
              workedHours={0}
              scheduledHours={0}
              action="/ta-hours?year=2026-2027&view=overview"
              onClose={() => undefined}
            />
          ),
        },
      ],
      { initialEntries: ["/ta-hours"] }
    );

    render(<RouterProvider router={router} />);

    expect(
      screen.getByRole("heading", { name: "Edit TA budget" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Edit TA budget" }).parentElement
    ).toHaveClass("pb-2");
    expect(screen.getByLabelText(/Hours/)).toHaveAttribute(
      "name",
      "totalHoursBudget"
    );
    expect(screen.getByLabelText(/Hours/).closest("form")).toHaveClass(
      "space-y-3",
      "pt-2",
      "pb-5"
    );
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();

    expect(
      screen.queryByRole("button", { name: "Budget" })
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Hourly rate/i)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/SEK|Available hours|Required budget/i)
    ).toBeNull();
    expect(
      screen.queryByText(/calculated from your selected input and rate/i)
    ).toBeNull();

    await userEvent.clear(screen.getByLabelText(/Hours/));
    await userEvent.type(screen.getByLabelText(/Hours/), "120");
    const form = screen.getByLabelText(/Hours/).closest("form");
    expect(form).not.toBeNull();
    const submitted = Object.fromEntries(new FormData(form!).entries());
    expect(submitted).toMatchObject({
      intent: "saveBudget",
      academicYear: "2026-2027",
      totalHoursBudget: "120",
    });
    expect(submitted).not.toHaveProperty("budgetMode");
    expect(submitted).not.toHaveProperty("budgetAmountSek");
    expect(submitted).not.toHaveProperty("hourlyRateSekPerHour");
  });
});
