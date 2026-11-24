import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StaffInventoryMobileCard } from "./staff-inventory-mobile-card";

describe("StaffInventoryMobileCard", () => {
  it("groups the title, availability, labeled fields, and one overflow action", () => {
    render(
      <StaffInventoryMobileCard
        selectionControl={<input aria-label="Select camera" type="checkbox" />}
        image={<img alt="Camera thumbnail" className="size-full" />}
        title={
          <a href="/assets/camera" className="break-words">
            A long camera name that should wrap without pushing actions away
          </a>
        }
        status={<span>Hidden</span>}
        actions={<button type="button" aria-label="More actions" />}
        category={<span>Very long camera category</span>}
        location={<span>North building, second floor</span>}
        availability={<span>100/100 available</span>}
      />
    );

    const card = screen.getByRole("article");
    expect(card).toHaveClass("w-full", "min-w-0");
    expect(screen.getByRole("img", { name: "Camera thumbnail" })).toHaveClass(
      "size-full"
    );
    expect(
      screen.getByRole("link", {
        name: "A long camera name that should wrap without pushing actions away",
      })
    ).toHaveClass("break-words");
    expect(screen.getByText("Category")).toBeInTheDocument();
    expect(screen.getByText("Location")).toBeInTheDocument();
    expect(screen.getByText("Category").closest("dl")).toHaveClass(
      "grid-cols-1",
      "min-[390px]:grid-cols-2"
    );
    expect(screen.getByText("100/100 available")).toBeInTheDocument();
    expect(
      screen.getByText("100/100 available").closest("header")
    ).toBeInTheDocument();
    expect(within(card).getAllByRole("button")).toHaveLength(1);
    expect(within(card).queryByRole("link", { name: /edit/i })).toBeNull();
  });
});
