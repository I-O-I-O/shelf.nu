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

  it("submits the saved delete operation to Shelf's bulk undo endpoint", async () => {
    const undoAction = {
      operation: "trash" as const,
      createdAt: Date.now(),
      entries: [{ assetId: "unit-1" }],
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

  it("shows a compact singular delete message with Undo", () => {
    const undoAction = {
      operation: "trash" as const,
      createdAt: Date.now(),
      entries: [{ assetId: "unit-1" }],
    };

    const router = createMemoryRouter(
      [
        {
          path: "/assets",
          element: (
            <StaffInventoryUndoNotice action={undoAction} onExpire={vi.fn()} />
          ),
        },
      ],
      { initialEntries: ["/assets"] }
    );
    render(<RouterProvider router={router} />);

    expect(screen.getByText("1 item deleted")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveClass(
      "fixed",
      "bottom-4",
      "left-4",
      "whitespace-nowrap",
      "md:left-[calc(15rem+1.5rem)]"
    );
  });

  it("uses plural copy for multiple deleted items", () => {
    const undoAction = {
      operation: "trash" as const,
      createdAt: Date.now(),
      entries: Array.from({ length: 5 }, (_, index) => ({
        assetId: `unit-${index + 1}`,
      })),
    };

    const router = createMemoryRouter(
      [
        {
          path: "/assets",
          element: (
            <StaffInventoryUndoNotice action={undoAction} onExpire={vi.fn()} />
          ),
        },
      ],
      { initialEntries: ["/assets"] }
    );
    render(<RouterProvider router={router} />);

    expect(screen.getByRole("status")).toHaveTextContent("5 items deleted");
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
  });
});
