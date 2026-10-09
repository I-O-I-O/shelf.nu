import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { LocationForm } from "~/components/location/form";
import { IoioLocationCreationForm } from "~/components/location/ioio-location-creation-form";

// why: the color-selector behavior does not depend on loading dynamic hierarchy choices.
vi.mock("~/components/location/ioio-location-cascade-select", () => ({
  IoioLocationParentPicker: ({
    locations: options,
    onChange,
  }: {
    locations: Array<{ id: string; parentId: string | null }>;
    onChange?: (id?: string) => void;
  }) => (
    <button
      type="button"
      onClick={() =>
        onChange?.(options.find((location) => !location.parentId)?.id)
      }
    >
      Select a room
    </button>
  ),
  IoioLocationPlacementPicker: () => <div />,
}));

const locations = [
  { id: "room", name: "IOIO Lab", parentId: null, color: "#C62828" },
  { id: "section", name: "Section A", parentId: "room", color: "#C62828" },
  { id: "shelf", name: "Shelf A1", parentId: "section", color: "#C62828" },
  { id: "box", name: "Box A1-1", parentId: "shelf", color: "#C62828" },
];

function renderInDataRouter(element: ReactNode) {
  const router = createMemoryRouter(
    [
      {
        path: "/locations",
        element,
        action: () => null,
      },
    ],
    { initialEntries: ["/locations"] }
  );
  return render(<RouterProvider router={router} />);
}

describe("IOIO location forms", () => {
  it("offers a color selector when creating a room", async () => {
    const user = userEvent.setup();
    renderInDataRouter(<IoioLocationCreationForm locations={locations} />);

    await user.click(screen.getByRole("button", { name: "New room" }));

    expect(
      screen.getByRole("heading", { name: "New room" })
    ).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Color" })).toBeInTheDocument();
    expect(screen.getAllByRole("radio").length).toBeGreaterThan(0);
  });

  it.each(["Section", "Shelf", "Box / Container"] as const)(
    "does not offer manual color selection when creating a %s",
    async (typeLabel) => {
      const user = userEvent.setup();
      renderInDataRouter(<IoioLocationCreationForm locations={locations} />);

      await user.click(screen.getByRole("button", { name: "Select a room" }));
      await user.click(
        screen.getByRole("button", { name: new RegExp(typeLabel) })
      );

      expect(screen.queryByText(/location color/i)).not.toBeInTheDocument();
      expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    }
  );

  it.each(["section", "shelf", "container"] as const)(
    "does not offer a color selector when editing a %s",
    (locationType) => {
      renderInDataRouter(
        <LocationForm
          ioioMode
          locationType={locationType}
          locations={locations}
          name={locationType === "room" ? "IOIO Lab" : "Section A"}
          address=""
          description=""
          parentId={locationType === "room" ? null : "room"}
        />
      );

      expect(screen.queryByText(/location color/i)).not.toBeInTheDocument();
      expect(screen.queryByRole("radio")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("group", { name: "Color" })
      ).not.toBeInTheDocument();
    }
  );

  it("offers a color selector when editing a room", () => {
    renderInDataRouter(
      <LocationForm
        ioioMode
        locationType="room"
        locations={locations}
        name="IOIO Lab"
        color="#C62828"
        address=""
        description=""
        parentId={null}
      />
    );

    expect(screen.getByRole("group", { name: "Color" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /red/i })).toBeChecked();
  });
});
