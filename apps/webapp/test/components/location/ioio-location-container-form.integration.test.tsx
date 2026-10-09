import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";
import { IoioLocationCreationForm } from "~/components/location/ioio-location-creation-form";

const locations = [
  {
    id: "room-1",
    name: "IOIO Lab - B477",
    parentId: null,
    color: "#455A64",
  },
  {
    id: "room-2",
    name: "IOIO Lab - B478",
    parentId: null,
    color: "#1565C0",
  },
  {
    id: "section-a",
    name: "Section A",
    parentId: "room-1",
    color: null,
  },
  {
    id: "section-b",
    name: "Section B",
    parentId: "room-1",
    color: null,
  },
  {
    id: "shelf-room",
    name: "Shelf Room Level",
    parentId: "room-1",
    color: null,
  },
  { id: "shelf-a1", name: "Shelf A1", parentId: "section-a", color: null },
  { id: "section-c", name: "Section C", parentId: "room-2", color: null },
  { id: "shelf-c", name: "Shelf C", parentId: "section-c", color: null },
];

function renderNewLocationForm() {
  const router = createMemoryRouter(
    [
      {
        path: "/locations/new",
        loader: () => ({ locations, totalLocations: locations.length }),
        element: <IoioLocationCreationForm locations={locations} />,
      },
    ],
    { initialEntries: ["/locations/new"] }
  );

  return render(<RouterProvider router={router} />);
}

async function chooseOption(
  user: ReturnType<typeof userEvent.setup>,
  triggerLabel: string,
  optionName: string
) {
  await user.click(
    await screen.findByRole("button", { name: new RegExp(triggerLabel) })
  );
  await user.click(await screen.findByRole("option", { name: optionName }));
}

describe("New Container hierarchy form", () => {
  it("scopes Shelf A1 to Section A and submits its id as parentId", async () => {
    const user = userEvent.setup();
    renderNewLocationForm();

    await chooseOption(user, "Pick a room", "IOIO Lab - B477");
    await user.click(screen.getByRole("button", { name: /Box \/ Container/ }));
    const shelfTrigger = screen.getByRole("button", { name: /Pick a shelf/ });
    expect(shelfTrigger).toBeEnabled();
    await user.click(shelfTrigger);
    expect(
      await screen.findByRole("option", { name: "Shelf Room Level" })
    ).toBeVisible();
    expect(screen.queryByRole("option", { name: "Shelf A1" })).toBeNull();
    await user.keyboard("{Escape}");

    await chooseOption(user, "Pick a section", "Section A");

    const sectionShelfTrigger = screen.getByRole("button", {
      name: /Pick a shelf/,
    });
    expect(sectionShelfTrigger).toBeEnabled();
    expect(screen.queryByText("No shelves in this location")).toBeNull();
    await user.click(sectionShelfTrigger);
    expect(
      await screen.findByRole("option", { name: "Shelf A1" })
    ).toBeVisible();
    expect(
      screen.queryByRole("option", { name: "Shelf Room Level" })
    ).toBeNull();
    await user.click(screen.getByRole("option", { name: "Shelf A1" }));

    const nameInput = screen.getByLabelText("Box / Container name");
    const form = nameInput.closest("form");
    expect(form).not.toBeNull();
    await waitFor(() => {
      expect(new FormData(form as HTMLFormElement).get("parentId")).toBe(
        "shelf-a1"
      );
    });
  });

  it("clears the selected Shelf when Section changes and reports an empty Section", async () => {
    const user = userEvent.setup();
    renderNewLocationForm();

    await chooseOption(user, "Pick a room", "IOIO Lab - B477");
    await user.click(screen.getByRole("button", { name: /Box \/ Container/ }));
    await chooseOption(user, "Pick a section", "Section A");
    await chooseOption(user, "Pick a shelf", "Shelf A1");
    await chooseOption(user, "Pick a section", "Section B");

    expect(screen.getByRole("status")).toHaveTextContent(
      "No shelves in this section."
    );
    expect(screen.getByRole("button", { name: /Pick a shelf/ })).toBeDisabled();
    const form = screen.getByLabelText("Box / Container name").closest("form");
    expect(form).not.toBeNull();
    expect(new FormData(form as HTMLFormElement).get("parentId")).toBe("");

    await chooseOption(user, "Pick a section", "Section A");
    expect(screen.getByRole("button", { name: /Pick a shelf/ })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: /Pick a shelf/ }));
    expect(
      await screen.findByRole("option", { name: "Shelf A1" })
    ).toBeVisible();
    expect(screen.queryByText("No shelves in this section.")).toBeNull();
  });

  it("clears Section and Shelf when the Room changes", async () => {
    const user = userEvent.setup();
    renderNewLocationForm();

    await chooseOption(user, "Pick a room", "IOIO Lab - B477");
    await user.click(screen.getByRole("button", { name: /Box \/ Container/ }));
    await chooseOption(user, "Pick a section", "Section A");
    await chooseOption(user, "Pick a shelf", "Shelf A1");
    await user.click(screen.getByRole("button", { name: "Change room" }));
    await chooseOption(user, "Pick a room", "IOIO Lab - B478");

    expect(
      screen.getByRole("button", { name: /Pick a section/ })
    ).toHaveTextContent("Pick a section");
    expect(screen.getByRole("button", { name: /Pick a shelf/ })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /Pick a section/ }));
    expect(
      await screen.findByRole("option", { name: "Section C" })
    ).toBeVisible();
    expect(
      screen.queryByRole("option", { name: "Section A" })
    ).not.toBeInTheDocument();
    const form = screen.getByLabelText("Box / Container name").closest("form");
    expect(form).not.toBeNull();
    expect(new FormData(form as HTMLFormElement).get("parentId")).toBe("");
  });
});
