import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { describe, expect, it } from "vitest";
import { OperationsMobileSelector } from "./operations-mobile-selector";

const options = [
  { id: "all", label: "All", href: "/operations" },
  {
    id: "returns",
    label: "Returns to check",
    href: "/operations?view=returns",
  },
  { id: "broken", label: "Broken items", href: "/operations?view=broken" },
] as const;

function RoutedOperationsSelector() {
  const location = useLocation();
  const activeId = new URLSearchParams(location.search).get("view") ?? "all";
  return <OperationsMobileSelector activeId={activeId} options={options} />;
}

describe("OperationsMobileSelector", () => {
  it("shows the active category and opens a choice sheet that closes on selection", () => {
    render(
      <MemoryRouter initialEntries={["/operations"]}>
        <RoutedOperationsSelector />
      </MemoryRouter>
    );

    const trigger = screen.getByRole("button", {
      name: "Choose operation category. Current category: All",
    });
    expect(trigger).toHaveTextContent("All");

    fireEvent.click(trigger);
    expect(
      screen.getByRole("dialog", { name: "Choose a category" })
    ).toBeInTheDocument();

    const returns = screen.getByRole("link", { name: "Returns to check" });
    expect(returns).toHaveAttribute("href", "/operations?view=returns");
    fireEvent.click(returns);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      screen.getByRole("button", {
        name: "Choose operation category. Current category: Returns to check",
      })
    ).toHaveTextContent("Returns to check");
  });
});
