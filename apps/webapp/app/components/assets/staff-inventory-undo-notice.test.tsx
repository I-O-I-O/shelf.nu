import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StaffInventoryUndoNotice } from "./staff-inventory-undo-notice";

describe("StaffInventoryUndoNotice", () => {
  afterEach(() => cleanup());

  it("submits the saved operation to the bulk undo endpoint", async () => {
    const undoAction = {
      operation: "category" as const,
      createdAt: Date.now(),
      entries: [
        {
          assetId: "unit-1",
          previousCategoryId: "category-old",
          expectedCategoryId: "category-new",
        },
      ],
    };
    const action = vi.fn(() => ({ success: true }));
    const router = createMemoryRouter(
      [
        {
          path: "/assets",
          element: (
            <StaffInventoryUndoNotice action={undoAction} onExpire={vi.fn()} />
          ),
        },
        { path: "/api/assets/bulk-undo", action },
      ],
      { initialEntries: ["/assets"] }
    );
    render(<RouterProvider router={router} />);

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(action).toHaveBeenCalledOnce());
  });
});
