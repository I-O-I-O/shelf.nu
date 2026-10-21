import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { getLocationHierarchyPath, LocationSelect } from "./location-select";

const { dynamicSelectProps } = vi.hoisted(() => ({
  dynamicSelectProps: vi.fn(),
}));

// why: this test checks the Shelf selector's form wiring without mounting its
// separate popover and model-filter interaction tests.
vi.mock("../dynamic-select/dynamic-select", () => ({
  default: (props: Record<string, unknown>) => {
    dynamicSelectProps(props);
    return <div aria-label="Dynamic location select" />;
  },
}));

// why: the component only needs an idle navigation state for this wiring test.
vi.mock("react-router", async () => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await vi.importActual("react-router");
  return { ...actual, useNavigation: () => ({ state: "idle" }) };
});

describe("LocationSelect", () => {
  it("shows the canonical room-to-container ancestry", () => {
    expect(
      getLocationHierarchyPath({
        name: "Container 3",
        parent: {
          name: "Shelf 2",
          parent: {
            name: "Section 1",
            parent: { name: "Room A" },
          },
        },
      })
    ).toEqual(["Room A", "Section 1", "Shelf 2", "Container 3"]);
  });

  it("keeps the current value, supports clearing, and disables while saving", () => {
    const { container } = render(
      <LocationSelect
        isBulk={false}
        locationId="location-1"
        forceServerSearch
        disabled
      />
    );

    expect(
      container.querySelector<HTMLInputElement>(
        'input[name="currentLocationId"]'
      )?.value
    ).toBe("location-1");
    expect(dynamicSelectProps).toHaveBeenCalledWith(
      expect.objectContaining({
        fieldName: "newLocationId",
        defaultValue: "location-1",
        allowClear: true,
        forceServerSearch: true,
        disabled: true,
      })
    );
  });

  it("omits the current-location comparison field for a new asset", () => {
    const { container } = render(
      <LocationSelect
        isBulk={false}
        hideCurrentLocationInput
        forceServerSearch
      />
    );

    expect(
      container.querySelector('input[name="currentLocationId"]')
    ).toBeNull();
    expect(dynamicSelectProps).toHaveBeenCalledWith(
      expect.objectContaining({
        fieldName: "newLocationId",
        forceServerSearch: true,
      })
    );
  });
});
