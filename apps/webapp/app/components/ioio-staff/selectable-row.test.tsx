import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SelectableRow } from "./selectable-row";

describe("SelectableRow", () => {
  it("toggles from blank row content and excludes nested controls and links", () => {
    const onToggle = vi.fn();
    render(
      <SelectableRow selected={false} onToggle={onToggle}>
        <span>Location metadata</span>
        <a href="/assets/asset-1">Open asset</a>
        <button type="button">Mark ready</button>
        <input type="checkbox" aria-label="Select row" onChange={onToggle} />
      </SelectableRow>
    );

    fireEvent.click(screen.getByText("Location metadata"));
    expect(onToggle).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("Location metadata"));
    expect(onToggle).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("link", { name: "Open asset" }));
    fireEvent.click(screen.getByRole("button", { name: "Mark ready" }));
    expect(onToggle).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("checkbox", { name: "Select row" }));
    expect(onToggle).toHaveBeenCalledTimes(3);
  });

  it("uses the same selected state for its visual surface", () => {
    render(
      <SelectableRow selected onToggle={vi.fn()}>
        Selected content
      </SelectableRow>
    );

    expect(screen.getByText("Selected content").closest("article")).toHaveClass(
      "bg-red-50/60"
    );
  });
});
