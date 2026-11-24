import { createElement } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { LocationMoveDialog } from "./location-move-dialog";

describe("LocationMoveDialog", () => {
  it("submits the chosen target level and contextual parent without replacing the location", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const submitted = vi.fn();
    const locations = [
      { id: "broken", name: "Broken Section", parentId: null },
      { id: "room-b477", name: "IOIO Lab - B477", parentId: null },
    ];
    const router = createMemoryRouter(
      [
        {
          path: "/locations",
          action: async ({ request }) => {
            const formData = await request.formData();
            submitted(Object.fromEntries(formData.entries()));
            return {
              success: true,
              location: {
                id: "broken",
                name: "Broken Section",
                parentId: "room-b477",
              },
            };
          },
          element: createElement(LocationMoveDialog, {
            location: locations[0]!,
            locations,
            open: true,
            onOpenChange,
          }),
        },
      ],
      { initialEntries: ["/locations"] }
    );

    render(createElement(RouterProvider, { router }));
    await user.selectOptions(screen.getByLabelText("Move as"), "section");
    expect(
      screen.getByRole("option", { name: "IOIO Lab - B477" })
    ).toBeVisible();
    await user.selectOptions(screen.getByLabelText("Destination"), "room-b477");
    await user.click(screen.getByRole("button", { name: "Move" }));

    await waitFor(() => expect(submitted).toHaveBeenCalledOnce());
    expect(submitted).toHaveBeenCalledWith({
      intent: "move-location",
      locationId: "broken",
      locationType: "section",
      parentId: "room-b477",
    });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
});
