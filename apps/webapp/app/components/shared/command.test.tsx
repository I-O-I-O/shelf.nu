import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CommandDialog, CommandInput, CommandList } from "./command";

describe("CommandDialog", () => {
  it("uses a safe-area-aware sheet on phones and a centered dialog on desktop", () => {
    render(
      <CommandDialog open onOpenChange={() => undefined}>
        <CommandInput placeholder="Search" />
        <CommandList />
      </CommandDialog>
    );

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveClass("bottom-0", "rounded-t-xl");
    expect(dialog).toHaveClass("sm:left-1/2", "sm:top-1/2", "sm:rounded-xl");
    expect(dialog.className).toContain("safe-area-inset-bottom");
  });
});
