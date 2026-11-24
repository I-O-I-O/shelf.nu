import { fireEvent, render, screen } from "@testing-library/react";
import { Provider } from "jotai";
import { describe, expect, it } from "vitest";
import { BulkListCardCheckbox } from "./bulk-list-card-checkbox";

describe("BulkListCardCheckbox", () => {
  it("toggles a selected row with an accessible card-sized control", () => {
    render(
      <Provider>
        <BulkListCardCheckbox item={{ id: "asset-1", title: "Long lens" }} />
      </Provider>
    );

    const checkbox = screen.getByRole("button", { name: "Select Long lens" });
    expect(checkbox).toHaveClass("size-11");
    expect(checkbox).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(checkbox);

    expect(
      screen.getByRole("button", { name: "Deselect Long lens" })
    ).toHaveAttribute("aria-pressed", "true");
  });
});
