import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { HandbookCategoryPicker } from "./handbook-category-picker";

describe("HandbookCategoryPicker", () => {
  it("shows existing matches first and selects a canonical Handbook category", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <HandbookCategoryPicker
        categories={[
          { id: "electronics", name: "Electronics" },
          { id: "soldering", name: "Soldering" },
        ]}
        value=""
        onChange={onChange}
      />
    );

    await user.click(screen.getByRole("combobox", { name: "Category" }));
    await user.type(
      await screen.findByRole("combobox", {
        name: "Search Handbook categories",
      }),
      "elec"
    );

    expect(screen.getByRole("option", { name: "Electronics" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Soldering" })).toBeNull();
    await user.click(screen.getByRole("option", { name: "Electronics" }));
    expect(onChange).toHaveBeenCalledWith("electronics", "");
  });

  it("offers inline creation when the organization has no categories", async () => {
    const user = userEvent.setup();
    const onCreateCategory = vi.fn();
    render(
      <HandbookCategoryPicker
        categories={[]}
        value=""
        onChange={vi.fn()}
        onCreateCategory={onCreateCategory}
      />
    );

    await user.click(screen.getByRole("combobox", { name: "Category" }));
    await user.type(
      await screen.findByRole("combobox", {
        name: "Search Handbook categories",
      }),
      "Workshop Safety"
    );

    const createOption = await screen.findByRole("option", {
      name: "Create “Workshop Safety”",
    });
    await user.click(createOption);
    expect(onCreateCategory).toHaveBeenCalledWith("Workshop Safety");
  });

  it("lets students propose a missing category without creating a canonical record", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <HandbookCategoryPicker
        categories={[]}
        value=""
        mode="student"
        onChange={onChange}
      />
    );

    await user.click(screen.getByRole("combobox", { name: "Category" }));
    await user.type(
      await screen.findByRole("combobox", {
        name: "Search Handbook categories",
      }),
      "Workshop Safety"
    );
    await user.click(
      screen.getByRole("option", { name: "Propose “Workshop Safety”" })
    );

    expect(onChange).toHaveBeenCalledWith("", "Workshop Safety");
  });
});
