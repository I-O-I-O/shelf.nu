import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InventoryViewSelect,
  INVENTORY_FILTER_TRIGGER_CLASS_NAME,
} from "./inventory-view-select";

describe("InventoryViewSelect", () => {
  afterEach(() => cleanup());

  it("provides one View dropdown with the four inventory views", () => {
    render(<InventoryViewSelect value="all" onChange={vi.fn()} />);

    const trigger = screen.getByRole("combobox", { name: "View" });
    expect(trigger).toHaveTextContent("View");
    expect(trigger.className).toContain("h-9");
    expect(trigger.className).toContain("w-[170px]");
    expect(trigger.className).toContain("px-3");
    expect(trigger.className).toContain("text-left");
    expect(INVENTORY_FILTER_TRIGGER_CLASS_NAME).toContain("h-9");
    expect(screen.getAllByRole("combobox")).toHaveLength(1);
    fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });

    expect(screen.getByRole("option", { name: "All" })).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Available" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Checked out" })
    ).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Kits" })).toBeInTheDocument();
  });

  it("allows View to fill the mobile filter sheet without changing desktop sizing", () => {
    render(
      <InventoryViewSelect
        value="all"
        className="h-11 min-h-11 w-full"
        onChange={vi.fn()}
      />
    );

    expect(screen.getByRole("combobox", { name: "View" })).toHaveClass(
      "h-11",
      "min-h-11",
      "w-full"
    );
    expect(INVENTORY_FILTER_TRIGGER_CLASS_NAME).toContain("w-[170px]");
  });
});
