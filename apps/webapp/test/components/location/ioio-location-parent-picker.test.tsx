import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { IoioLocationParentPicker } from "~/components/location/ioio-location-cascade-select";

const pickerLocations = vi.hoisted(() => [
  { id: "room-a", name: "Room A", parentId: null },
  { id: "room-b", name: "Room B", parentId: null },
  { id: "section-a", name: "Section A", parentId: "room-a" },
  { id: "section-b", name: "Section B", parentId: "room-a" },
  { id: "section-c", name: "Section C", parentId: "room-b" },
  { id: "shelf-a", name: "Shelf A", parentId: "section-a" },
  { id: "shelf-b", name: "Shelf B", parentId: "section-b" },
  { id: "shelf-c", name: "Shelf C", parentId: "section-c" },
]);

// why: this test exercises the parent picker's filtering/state transitions, while the Shelf DynamicSelect data fetching is covered by its own tests.
vi.mock("~/components/dynamic-select/dynamic-select", () => ({
  default: ({
    label,
    fieldName,
    defaultValue,
    excludeItems = [],
    disabled,
    withoutValueItem,
    onChange,
  }: {
    label: string;
    fieldName: string;
    defaultValue?: string;
    excludeItems?: string[];
    disabled?: boolean;
    withoutValueItem?: { id: string; name: string };
    onChange?: (value: string) => void;
  }) => (
    <label>
      {label}
      <select
        aria-label={label}
        name={fieldName}
        disabled={disabled}
        value={defaultValue ?? ""}
        onChange={(event) => onChange?.(event.currentTarget.value)}
      >
        <option value="">Choose</option>
        {withoutValueItem ? (
          <option value={withoutValueItem.id}>{withoutValueItem.name}</option>
        ) : null}
        {pickerLocations
          .filter((location) => !excludeItems.includes(location.id))
          .map((location) => (
            <option key={location.id} value={location.id}>
              {location.name}
            </option>
          ))}
      </select>
    </label>
  ),
}));

describe("IOIO container parent selection", () => {
  it("filters sections and shelves through Room → Section → Shelf and selects the Shelf parent", async () => {
    const user = userEvent.setup();
    render(
      <IoioLocationParentPicker locations={pickerLocations} type="container" />
    );

    await user.selectOptions(screen.getByLabelText("Pick a room"), "room-a");
    expect(
      (screen.getByLabelText("Pick a section") as HTMLSelectElement).value
    ).toBe("");
    expect(
      screen.getByLabelText("Pick a section").querySelectorAll("option")
    ).toHaveLength(3);

    await user.selectOptions(
      screen.getByLabelText("Pick a section"),
      "section-a"
    );
    const shelfSelect = screen.getByLabelText("Pick a shelf");
    expect(shelfSelect).toBeEnabled();
    expect(shelfSelect.querySelectorAll("option")).toHaveLength(2);

    await user.selectOptions(shelfSelect, "shelf-a");
    expect(document.querySelector('input[name="parentId"]')).toHaveValue(
      "shelf-a"
    );
    expect(screen.queryByText("Choose a valid parent location.")).toBeNull();
  });

  it("clears a selected Shelf when its Section changes", async () => {
    const user = userEvent.setup();
    render(
      <IoioLocationParentPicker
        locations={pickerLocations}
        fixedRoomId="room-a"
        type="container"
      />
    );

    await user.selectOptions(
      screen.getByLabelText("Pick a section"),
      "section-a"
    );
    await user.selectOptions(screen.getByLabelText("Pick a shelf"), "shelf-a");
    expect(document.querySelector('input[name="parentId"]')).toHaveValue(
      "shelf-a"
    );

    await user.selectOptions(
      screen.getByLabelText("Pick a section"),
      "section-b"
    );

    expect(screen.getByLabelText("Pick a shelf")).toBeEnabled();
    expect(
      (screen.getByLabelText("Pick a shelf") as HTMLSelectElement).value
    ).toBe("");
    expect(document.querySelector('input[name="parentId"]')).toHaveValue("");
  });

  it("clears incompatible Section and Shelf choices when Room changes", async () => {
    const user = userEvent.setup();
    render(
      <IoioLocationParentPicker locations={pickerLocations} type="container" />
    );

    await user.selectOptions(screen.getByLabelText("Pick a room"), "room-a");
    await user.selectOptions(
      screen.getByLabelText("Pick a section"),
      "section-a"
    );
    await user.selectOptions(screen.getByLabelText("Pick a shelf"), "shelf-a");
    await user.selectOptions(screen.getByLabelText("Pick a room"), "room-b");

    expect(
      (screen.getByLabelText("Pick a section") as HTMLSelectElement).value
    ).toBe("");
    expect(screen.getByLabelText("Pick a shelf")).toBeDisabled();
    await user.selectOptions(
      screen.getByLabelText("Pick a section"),
      "section-c"
    );
    expect(screen.getByLabelText("Pick a shelf")).toBeEnabled();
    expect(
      screen.getByLabelText("Pick a shelf").querySelectorAll("option")
    ).toHaveLength(2);
    expect(document.querySelector('input[name="parentId"]')).toHaveValue("");
  });
});
