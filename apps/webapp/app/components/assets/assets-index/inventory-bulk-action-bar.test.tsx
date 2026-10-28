import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InventoryBulkActionBar } from "./inventory-bulk-action-bar";

describe("InventoryBulkActionBar", () => {
  afterEach(() => cleanup());

  it.each([
    { canHide: true, canUnhide: false, shown: "Hide", absent: "Unhide" },
    { canHide: false, canUnhide: true, shown: "Unhide", absent: "Hide" },
  ])(
    "shows only the meaningful visibility action: $shown",
    ({ canHide, canUnhide, shown, absent }) => {
      render(
        <InventoryBulkActionBar
          selectedCount={2}
          canUpdate={false}
          canDelete={false}
          canPrintLabels={false}
          canHide={canHide}
          canUnhide={canUnhide}
          onChangeCategory={vi.fn()}
          onChangeLocation={vi.fn()}
          onArchive={vi.fn()}
          onTrash={vi.fn()}
          onHide={vi.fn()}
          onUnhide={vi.fn()}
          onPrintLabels={vi.fn()}
        />
      );

      expect(screen.getByRole("button", { name: shown })).toBeVisible();
      expect(
        screen.queryByRole("button", { name: absent })
      ).not.toBeInTheDocument();
    }
  );

  it("shows the selection count and invokes supported bulk actions", () => {
    const onChangeCategory = vi.fn();
    const onChangeLocation = vi.fn();
    const onArchive = vi.fn();
    const onTrash = vi.fn();
    const onHide = vi.fn();
    const onUnhide = vi.fn();
    const onPrintLabels = vi.fn();

    render(
      <InventoryBulkActionBar
        selectedCount={3}
        canUpdate
        canDelete
        canPrintLabels
        canHide
        canUnhide
        onChangeCategory={onChangeCategory}
        onChangeLocation={onChangeLocation}
        onArchive={onArchive}
        onTrash={onTrash}
        onHide={onHide}
        onUnhide={onUnhide}
        onPrintLabels={onPrintLabels}
      />
    );

    expect(screen.getByText("3 selected")).toBeInTheDocument();
    const actions = screen.getByRole("group", {
      name: "Selected inventory actions",
    });
    expect(actions).toContainElement(
      screen.getByRole("button", { name: "Hide" })
    );
    expect(actions).toContainElement(
      screen.getByRole("button", { name: "Unhide" })
    );
    expect(actions.className).toContain("flex-wrap");
    expect(actions.className).toContain("sm:ml-auto");
    expect(actions.parentElement?.className).toContain("sm:justify-between");
    expect(screen.getByText("3 selected").parentElement).not.toBe(actions);
    fireEvent.click(screen.getByRole("button", { name: "Change category" }));
    fireEvent.click(screen.getByRole("button", { name: "Change location" }));
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    fireEvent.click(screen.getByRole("button", { name: "Unhide" }));
    fireEvent.click(screen.getByRole("button", { name: "Print labels / QR" }));

    expect(onChangeCategory).toHaveBeenCalledOnce();
    expect(onChangeLocation).toHaveBeenCalledOnce();
    expect(onArchive).toHaveBeenCalledOnce();
    expect(onTrash).toHaveBeenCalledOnce();
    expect(onHide).toHaveBeenCalledOnce();
    expect(onUnhide).toHaveBeenCalledOnce();
    expect(onPrintLabels).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole("button", { name: /mark available/i })
    ).toBeNull();
  });

  it("offers an explicit Organize handoff for a valid selected model set", () => {
    const onOrganizeSelected = vi.fn();
    render(
      <InventoryBulkActionBar
        selectedCount={4}
        canUpdate
        canDelete={false}
        canPrintLabels={false}
        canHide={false}
        canUnhide={false}
        canOrganizeSelected
        onOrganizeSelected={onOrganizeSelected}
        onChangeCategory={vi.fn()}
        onChangeLocation={vi.fn()}
        onArchive={vi.fn()}
        onTrash={vi.fn()}
        onHide={vi.fn()}
        onUnhide={vi.fn()}
        onPrintLabels={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Organize selected" }));
    expect(onOrganizeSelected).toHaveBeenCalledOnce();
  });
});
