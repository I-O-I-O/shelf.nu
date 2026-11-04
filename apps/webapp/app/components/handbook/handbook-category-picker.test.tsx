import { render, screen, within } from "@testing-library/react";
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
        onCreateCategory={vi.fn()}
      />
    );

    await user.click(screen.getByRole("combobox", { name: "Category" }));
    expect(
      within(screen.getByRole("listbox"))
        .getAllByRole("option")
        .map((item) => item.textContent)
    ).toEqual(["Electronics", "Soldering"]);
    const searchInput = await screen.findByRole("combobox", {
      name: "Search Handbook categories",
    });
    expect(searchInput).toHaveAttribute(
      "placeholder",
      "Search or type a new category..."
    );
    await user.type(searchInput, "Elec");

    expect(screen.getByRole("option", { name: "Electronics" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Soldering" })).toBeNull();
    expect(
      within(screen.getByRole("listbox"))
        .getAllByRole("option")
        .map((item) => item.getAttribute("aria-label") ?? item.textContent)
    ).toEqual(["Electronics", 'Create "Elec"']);
    await user.click(screen.getByRole("option", { name: "Electronics" }));
    expect(onChange).toHaveBeenCalledWith("electronics", "");
  });

  it("shows the existing category for a normalized exact name instead of a duplicate action", async () => {
    const user = userEvent.setup();
    const onCreateCategory = vi.fn();
    render(
      <HandbookCategoryPicker
        categories={[{ id: "safety", name: "Workshop Safety" }]}
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
      " WORKSHOP   SAFETY "
    );

    expect(
      screen.getByRole("option", { name: "Workshop Safety" })
    ).toBeTruthy();
    expect(screen.queryByRole("option", { name: /Create|Propose/ })).toBeNull();
    expect(onCreateCategory).not.toHaveBeenCalled();
  });

  it("keeps similar existing categories ahead of the separated create fallback", async () => {
    const user = userEvent.setup();
    render(
      <HandbookCategoryPicker
        categories={[
          { id: "workshop-safety", name: "Workshop Safety" },
          { id: "workshop-processes", name: "Workshop Processes" },
          { id: "machine-guides", name: "Machine Guides" },
        ]}
        value=""
        onChange={vi.fn()}
        onCreateCategory={vi.fn()}
      />
    );

    await user.click(screen.getByRole("combobox", { name: "Category" }));
    await user.type(
      await screen.findByRole("combobox", {
        name: "Search Handbook categories",
      }),
      "work"
    );

    expect(
      within(screen.getByRole("listbox"))
        .getAllByRole("option")
        .map((item) => item.textContent)
    ).toEqual(["Workshop Safety", "Workshop Processes", 'Create "work"']);
    expect(
      screen.getByRole("group", { name: "Can't find the right category?" })
    ).toBeTruthy();
  });

  it("shows similar categories before a non-exact fallback without fuzzy merging", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const onCreateCategory = vi.fn();
    render(
      <HandbookCategoryPicker
        categories={[{ id: "3d-printing", name: "3D Printing" }]}
        value=""
        onChange={onChange}
        onCreateCategory={onCreateCategory}
      />
    );

    await user.click(screen.getByRole("combobox", { name: "Category" }));
    await user.type(
      await screen.findByRole("combobox", {
        name: "Search Handbook categories",
      }),
      "3D Print"
    );

    const options = within(screen.getByRole("listbox")).getAllByRole("option");
    expect(options[0]).toHaveTextContent("3D Printing");
    expect(options[1]).toHaveTextContent('Create "3D Print"');
    expect(onChange).not.toHaveBeenCalled();
    expect(onCreateCategory).not.toHaveBeenCalled();
  });

  it("supports keyboard selection of existing categories and the fallback", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const onCreateCategory = vi.fn();
    render(
      <HandbookCategoryPicker
        categories={[{ id: "workshop-safety", name: "Workshop Safety" }]}
        value=""
        onChange={onChange}
        onCreateCategory={onCreateCategory}
      />
    );

    await user.click(screen.getByRole("combobox", { name: "Category" }));
    await user.type(
      await screen.findByRole("combobox", {
        name: "Search Handbook categories",
      }),
      "work{Enter}"
    );
    expect(onChange).toHaveBeenCalledWith("workshop-safety", "");
    expect(onCreateCategory).not.toHaveBeenCalled();

    await user.click(screen.getByRole("combobox", { name: "Category" }));
    await user.type(
      await screen.findByRole("combobox", {
        name: "Search Handbook categories",
      }),
      "Laser{Enter}"
    );
    expect(onCreateCategory).toHaveBeenCalledWith("Laser");
  });

  it("shows a loading fallback and prevents another create while Staff creation is pending", async () => {
    const user = userEvent.setup();
    const onCreateCategory = vi.fn();
    render(
      <HandbookCategoryPicker
        categories={[]}
        value=""
        creating
        onChange={vi.fn()}
        onCreateCategory={onCreateCategory}
      />
    );

    await user.click(screen.getByRole("combobox", { name: "Category" }));
    await user.type(
      await screen.findByRole("combobox", {
        name: "Search Handbook categories",
      }),
      "Laser Cutting"
    );

    const loadingOption = screen.getByRole("option", {
      name: "Creating Handbook category…",
    });
    expect(loadingOption).toHaveAttribute("aria-disabled", "true");
    await user.keyboard("{Enter}");
    expect(onCreateCategory).not.toHaveBeenCalled();
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
    expect(screen.getByText(/No Handbook categories yet/)).toBeTruthy();
    await user.type(
      await screen.findByRole("combobox", {
        name: "Search Handbook categories",
      }),
      "Workshop Safety"
    );

    const createOption = await screen.findByRole("option", {
      name: 'Create "Workshop Safety"',
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
      screen.getByRole("option", { name: 'Propose "Workshop Safety"' })
    );

    expect(onChange).toHaveBeenCalledWith("", "Workshop Safety");
  });
});
