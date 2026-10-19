import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { IoioLocationColorPicker } from "./ioio-location-color-picker";

const locations = [
  { id: "room-1", name: "Room B477", parentId: null, color: null },
  { id: "section-a", name: "Section A", parentId: "room-1", color: "#1565C0" },
  { id: "section-b", name: "Section B", parentId: "room-1", color: "#C62828" },
  { id: "room-2", name: "Room B478", parentId: null, color: null },
];

function EditablePicker({
  parentId,
  initialColor,
}: {
  parentId: string;
  initialColor?: string;
}) {
  const [color, setColor] = useState(initialColor);
  return (
    <form data-testid="location-form">
      <IoioLocationColorPicker
        locations={locations}
        parentId={parentId}
        currentLocationId="section-a"
        locationType="section"
        value={color}
        onChange={setColor}
      />
    </form>
  );
}

describe("Section color picker", () => {
  it("disables colors belonging to other Rooms and defaults to the first free color", () => {
    const rooms = [
      { id: "room-a", name: "Room A", parentId: null, color: "#1565C0" },
      { id: "room-b", name: "Room B", parentId: null, color: "#C62828" },
    ];
    const { rerender } = render(
      <form data-testid="room-form">
        <IoioLocationColorPicker locations={rooms} locationType="room" />
      </form>
    );
    expect(screen.getByRole("radio", { name: /Blue/u })).toBeDisabled();
    expect(screen.getByRole("radio", { name: /Red/u })).toBeDisabled();
    expect(new FormData(screen.getByTestId("room-form")).get("color")).toBe(
      "#2E7D32"
    );
    rerender(
      <form data-testid="room-form">
        <IoioLocationColorPicker
          locations={rooms}
          locationType="room"
          currentLocationId="room-a"
          value="#1565C0"
        />
      </form>
    );
    expect(screen.getByRole("radio", { name: /Blue/u })).toBeEnabled();
    expect(screen.getByRole("radio", { name: /Red/u })).toBeDisabled();
  });
  it("submits its own color and disables only other sections' colors in the same room", async () => {
    const user = userEvent.setup();
    render(<EditablePicker parentId="room-1" initialColor="#1565C0" />);
    expect(screen.getByRole("radio", { name: /Blue/u })).toBeEnabled();
    expect(screen.getByRole("radio", { name: /Red/u })).toBeDisabled();
    expect(new FormData(screen.getByTestId("location-form")).get("color")).toBe(
      "#1565C0"
    );

    await user.click(screen.getByRole("radio", { name: /Green/u }));
    expect(new FormData(screen.getByTestId("location-form")).get("color")).toBe(
      "#2E7D32"
    );
  });

  it("allows a color from another room and flags a conflicting color after moving rooms", () => {
    const { rerender } = render(
      <EditablePicker parentId="room-2" initialColor="#1565C0" />
    );
    expect(screen.getByRole("radio", { name: /Blue/u })).toBeEnabled();

    rerender(
      <EditablePicker key="moved" parentId="room-1" initialColor="#C62828" />
    );
    expect(
      screen.getByText(/already used in this room\. Choose another color/u)
    ).toBeInTheDocument();
  });
});
