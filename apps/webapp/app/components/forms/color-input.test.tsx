import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ColorInput } from "./color-input";

// why: random output is nondeterministic; a fixed color verifies that the
// Generate color action updates both the submitted value and the preview.
vi.mock("~/utils/get-random-color", () => ({
  getRandomColor: () => "#AABBCC",
}));

describe("ColorInput preview", () => {
  it("shows the saved color and tracks manual and generated changes", () => {
    render(
      <ColorInput
        name="color"
        label="Hex color"
        colorFromServer="#112233"
        showPreview
      />
    );

    const input = screen.getByRole("textbox", { name: "Hex color" });
    expect(input).toHaveValue("#112233");
    const control = input.parentElement;
    expect(control).not.toBeNull();
    expect(control).toHaveClass("w-36");
    expect(control).toContainElement(
      screen.getByRole("img", { name: "Selected category color #112233" })
    );
    expect(
      screen.getByRole("img", { name: "Selected category color #112233" }).style
        .backgroundColor
    ).toBe("#112233");

    fireEvent.change(input, { target: { value: "#ABCDEF" } });
    expect(input).toHaveValue("#ABCDEF");
    expect(
      screen.getByRole("img", { name: "Selected category color #ABCDEF" }).style
        .backgroundColor
    ).toBe("#ABCDEF");

    const generateButton = screen.getByRole("button", {
      name: "Generate new color",
    });
    expect(generateButton).toHaveAttribute("aria-label", "Generate new color");
    fireEvent.click(generateButton);
    expect(input).toHaveValue("#AABBCC");
    expect(
      screen.getByRole("img", { name: "Selected category color #AABBCC" }).style
        .backgroundColor
    ).toBe("#AABBCC");
  });
});
