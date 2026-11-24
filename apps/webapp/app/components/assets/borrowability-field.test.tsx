import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { assetBorrowabilitySchema } from "~/modules/asset/borrowability";
import { BorrowabilityField } from "./borrowability-field";

it("submits the canonical false flag when staff enables Can't borrow and restores true when disabled", () => {
  const { container } = render(
    <form>
      <BorrowabilityField availableToBook />
    </form>
  );
  const form = container.querySelector("form")!;
  // Unedited product-group forms must preserve mixed per-unit values.
  expect(new FormData(form).has("availableToBook")).toBe(false);
  fireEvent.click(screen.getByRole("checkbox", { name: "Can't borrow" }));
  expect(new FormData(form).get("availableToBook")).toBe("false");
  expect(assetBorrowabilitySchema.parse("false")).toBe(false);
  fireEvent.click(screen.getByRole("checkbox", { name: "Can't borrow" }));
  expect(new FormData(form).get("availableToBook")).toBe("true");
  expect(assetBorrowabilitySchema.parse("true")).toBe(true);
});
it("shows the persisted non-borrowable value after reloading the form", () => {
  const { unmount } = render(<BorrowabilityField availableToBook />);
  unmount();
  render(<BorrowabilityField availableToBook={false} />);
  expect(screen.getByRole("checkbox", { name: "Can't borrow" })).toBeChecked();
});
it("rejects invalid flag values and preserves an omitted value", () => {
  expect(assetBorrowabilitySchema.parse(undefined)).toBeUndefined();
  expect(assetBorrowabilitySchema.safeParse("yes").success).toBe(false);
});
