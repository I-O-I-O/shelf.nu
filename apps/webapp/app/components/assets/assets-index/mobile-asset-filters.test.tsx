import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { MobileAssetFilters } from "./mobile-asset-filters";

describe("MobileAssetFilters", () => {
  it("keeps filter choices behind one compact button and opens a readable sheet", async () => {
    const user = userEvent.setup();
    render(
      <MobileAssetFilters>
        <button type="button">View</button>
        <button type="button">Categories</button>
        <button type="button">Locations</button>
      </MobileAssetFilters>
    );

    expect(
      screen.getByRole("button", { name: "Open asset filters" })
    ).toHaveClass("min-h-11", "w-full");
    expect(screen.queryByRole("button", { name: "Categories" })).toBeNull();

    await user.click(
      screen.getByRole("button", { name: "Open asset filters" })
    );
    const sheet = screen.getByRole("dialog", { name: "Asset filters" });
    expect(sheet).toHaveClass(
      "bg-white",
      "rounded-t-2xl",
      "overscroll-contain"
    );
    expect(
      within(sheet).getByRole("button", { name: "Categories" })
    ).toBeInTheDocument();
    expect(
      within(sheet).getByRole("button", { name: "View" })
    ).toBeInTheDocument();
    expect(
      within(sheet).getByRole("button", { name: "Locations" })
    ).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: "Close" })).toHaveClass(
      "size-11"
    );
  });
});
