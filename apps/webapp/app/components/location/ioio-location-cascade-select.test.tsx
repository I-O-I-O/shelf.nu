import { fireEvent, render, screen } from "@testing-library/react";
import { vi } from "vitest";

const selectFixture = vi.hoisted(() => ({ locations: [] as any[] }));

// why: This test exercises the cascade's selection state and autofill wiring;
// the Shelf DynamicSelect popover itself is covered by its shared component tests.
vi.mock("../dynamic-select/dynamic-select", () => ({
  default: (props: any) => (
    <label>
      {props.label}
      <select
        aria-label={props.label}
        name={props.fieldName}
        value={props.defaultValue ?? ""}
        disabled={props.disabled}
        onChange={(event) =>
          props.onChange?.(event.currentTarget.value || undefined)
        }
      >
        <option value="" />
        {selectFixture.locations.map((location) => (
          <option key={location.id} value={location.id}>
            {location.name}
          </option>
        ))}
      </select>
    </label>
  ),
}));

import { IoioLocationCascadeSelect } from "./ioio-location-cascade-select";

const locations = [
  { id: "room", name: "B477", parentId: null },
  { id: "section", name: "Section A", parentId: "room" },
  { id: "shelf-1", name: "Shelf A1", parentId: "section" },
  { id: "container", name: "Container A1-13", parentId: "shelf-1" },
  { id: "shelf-2", name: "Shelf A2", parentId: "section" },
];

describe("IOIO asset location cascade quick fill", () => {
  beforeEach(() => {
    selectFixture.locations = locations;
  });

  it("fills the visible hierarchy from a container and allows manual changes", () => {
    render(
      <IoioLocationCascadeSelect
        locations={locations}
        value={null}
        fieldName="newLocationId"
        showQuickLocation
      />
    );

    fireEvent.change(screen.getByRole("combobox", { name: "Quick location" }), {
      target: { value: "A1-13" },
    });
    fireEvent.click(
      screen.getByRole("option", {
        name: /Container A1-13 B477 › Section A › Shelf A1/,
      })
    );

    expect(screen.getByLabelText("Pick a room")).toHaveValue("room");
    expect(screen.getByLabelText("Pick a section")).toHaveValue("section");
    expect(screen.getByLabelText("Pick a shelf")).toHaveValue("shelf-1");
    expect(screen.getByLabelText("Pick a container (optional)")).toHaveValue(
      "container"
    );
    expect(
      screen.getByRole("combobox", { name: "Quick location" })
    ).toHaveValue("");

    fireEvent.change(screen.getByLabelText("Pick a shelf"), {
      target: { value: "shelf-2" },
    });

    expect(screen.getByLabelText("Pick a room")).toHaveValue("room");
    expect(screen.getByLabelText("Pick a section")).toHaveValue("section");
    expect(screen.getByLabelText("Pick a shelf")).toHaveValue("shelf-2");
    expect(screen.queryByLabelText("Pick a container (optional)")).toBeNull();
    expect(screen.getByDisplayValue("shelf-2")).toHaveAttribute(
      "name",
      "newLocationId"
    );
  });

  it("selects a room directly without filling child fields", () => {
    render(
      <IoioLocationCascadeSelect
        locations={locations}
        fieldName="newLocationId"
        showQuickLocation
      />
    );

    fireEvent.change(screen.getByRole("combobox", { name: "Quick location" }), {
      target: { value: "B477" },
    });
    fireEvent.click(
      screen.getByRole("option", { name: /B477 Top level room/ })
    );

    expect(screen.getByLabelText("Pick a room")).toHaveValue("room");
    expect(screen.getByLabelText("Pick a section")).toHaveValue("");
    expect(screen.getByDisplayValue("room")).toHaveAttribute(
      "name",
      "newLocationId"
    );
  });
});
