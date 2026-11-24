import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, data, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { DeleteLocation } from "~/components/location/delete-location";

describe("DeleteLocation", () => {
  it("shows a controlled inline message when deletion is blocked", async () => {
    const user = userEvent.setup();
    const action = vi.fn(() =>
      data(
        {
          error: {
            message:
              "This location contains child locations. Move or delete them first.",
          },
        },
        { status: 409 }
      )
    );
    const router = createMemoryRouter(
      [
        {
          path: "/locations/:locationId",
          element: (
            <DeleteLocation location={{ id: "section-1", name: "Section A" }} />
          ),
          action,
        },
      ],
      { initialEntries: ["/locations/section-1"] }
    );

    render(<RouterProvider router={router} />);
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await screen.findByRole("alertdialog");
    fireEvent.click(
      document.querySelector<HTMLElement>(
        '[data-test-id="confirmdeleteLocationButton"]'
      )!
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This location contains child locations. Move or delete them first."
    );
    expect(screen.getByText("Delete Section A")).toBeInTheDocument();
    expect(action).toHaveBeenCalledTimes(1);
  });
});
