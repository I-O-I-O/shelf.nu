import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InventoryBulkActionBar } from "./inventory-bulk-action-bar";

describe("InventoryBulkActionBar", () => {
  afterEach(() => cleanup());

  it("shows the selection count and invokes supported bulk actions", () => {
    const onChangeCategory = vi.fn();
    const onChangeLocation = vi.fn();
    const onArchive = vi.fn();
    const onTrash = vi.fn();
    const onPrintLabels = vi.fn();

    render(
      <InventoryBulkActionBar
        selectedCount={3}
        canUpdate
        canDelete
        canPrintLabels
        onChangeCategory={onChangeCategory}
        onChangeLocation={onChangeLocation}
        onArchive={onArchive}
        onTrash={onTrash}
        onPrintLabels={onPrintLabels}
      />
    );

    expect(screen.getByText("3 selected")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Change category" }));
    fireEvent.click(screen.getByRole("button", { name: "Change location" }));
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    fireEvent.click(screen.getByRole("button", { name: "Move to trash" }));
    fireEvent.click(screen.getByRole("button", { name: "Print labels / QR" }));

    expect(onChangeCategory).toHaveBeenCalledOnce();
    expect(onChangeLocation).toHaveBeenCalledOnce();
    expect(onArchive).toHaveBeenCalledOnce();
    expect(onTrash).toHaveBeenCalledOnce();
    expect(onPrintLabels).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole("button", { name: /mark available/i })
    ).toBeNull();
  });
});
