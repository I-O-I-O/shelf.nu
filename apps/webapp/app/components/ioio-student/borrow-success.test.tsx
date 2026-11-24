import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { BorrowSuccess } from "./borrow-success";

describe("BorrowSuccess", () => {
  it("renders a server ISO due-date timestamp without crashing", () => {
    render(
      <MemoryRouter>
        <BorrowSuccess
          dashboardPath="/ioio"
          items={[
            {
              itemId: "asset-1",
              title: "Motor",
              quantity: 1,
              dueDate: "2026-11-03T23:59:59.999Z",
            },
          ]}
        />
      </MemoryRouter>
    );

    expect(
      screen.getByRole("heading", { name: "Borrowing complete" })
    ).toBeTruthy();
    expect(screen.getByText(/Due\s+Nov 3, 2026/)).toBeTruthy();
  });
});
