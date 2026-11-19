import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "./modal";

describe("AlertDialog mobile layout", () => {
  it("renders an accessible bottom sheet with safe-area spacing on phones", () => {
    render(
      <AlertDialog open>
        <AlertDialogContent>
          <AlertDialogTitle>Confirm action</AlertDialogTitle>
          <AlertDialogDescription>
            Review this action before continuing.
          </AlertDialogDescription>
        </AlertDialogContent>
      </AlertDialog>
    );

    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveClass("bottom-0", "rounded-t-2xl");
    expect(dialog.className).toContain("safe-area-inset-bottom");
    expect(dialog).toHaveClass("sm:rounded", "sm:p-6");
  });
});
