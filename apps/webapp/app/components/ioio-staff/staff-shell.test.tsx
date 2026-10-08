import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { StaffNavigation } from "./staff-shell";

function renderNavigation(initialEntry: string) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <StaffNavigation
        navigationOrder={["/bookings"]}
        onReorder={() => undefined}
        canViewLabTasks={false}
        toolsOnly={false}
      />
    </MemoryRouter>
  );
}

function expectSelected(link: HTMLElement, selected: boolean) {
  if (selected) {
    expect(link).toHaveClass("bg-red-50", "text-red-800");
    expect(link).toHaveAttribute("aria-current", "page");
  } else {
    expect(link).not.toHaveClass("bg-red-50", "text-red-800");
    expect(link).not.toHaveAttribute("aria-current", "page");
  }
}

describe("IOIO staff Loans navigation active state", () => {
  it("selects Loans on the organization loan list only", () => {
    renderNavigation("/bookings");

    expectSelected(screen.getByRole("link", { name: "Loans" }), true);
    expectSelected(screen.getByRole("link", { name: "My Loans" }), false);
  });

  it("selects My Loans for mine=1 while keeping the Loans group expanded", () => {
    renderNavigation("/bookings?mine=1");

    expectSelected(screen.getByRole("link", { name: "Loans" }), false);
    expectSelected(screen.getByRole("link", { name: "My Loans" }), true);
    expect(
      screen.getByRole("button", { name: "Collapse Loans" })
    ).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps nested booking details under Loans even with a mine query", () => {
    renderNavigation("/bookings/loan-123?mine=1");

    expectSelected(screen.getByRole("link", { name: "Loans" }), true);
    expectSelected(screen.getByRole("link", { name: "My Loans" }), false);
  });

  it("does not highlight staff loan links on the student loans route", () => {
    renderNavigation("/ioio/loans");

    expectSelected(screen.getByRole("link", { name: "Loans" }), false);
    expectSelected(screen.getByRole("link", { name: "My Loans" }), false);
    expect(
      screen.getByRole("button", { name: "Collapse Loans" })
    ).toHaveAttribute("aria-expanded", "true");
  });
});
