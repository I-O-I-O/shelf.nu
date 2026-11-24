import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { NewAssetDropdown } from "./new-asset-dropdown";

describe("NewAssetDropdown", () => {
  it("keeps the create options available from the compact dropdown button", async () => {
    render(
      <MemoryRouter>
        <NewAssetDropdown canImportAssets={true} />
      </MemoryRouter>
    );

    expect(screen.getByRole("link", { name: "new asset" })).toHaveTextContent(
      "New asset"
    );
    fireEvent.click(
      screen.getByRole("button", { name: "More create options" })
    );

    expect(
      await screen.findByText("Bulk create from model")
    ).toBeInTheDocument();
    expect(screen.getByText("Import from CSV")).toBeInTheDocument();
  });
});
