import { describe, expect, it } from "vitest";
import {
  IOIO_INITIAL_CATEGORY_DEFAULTS,
  orderUntouchedIoioDefaults,
} from "./ioio-categories";

describe("IOIO initial category defaults", () => {
  it("defines the recommended lab inventory categories in the requested order", () => {
    expect(IOIO_INITIAL_CATEGORY_DEFAULTS.map(({ name }) => name)).toEqual([
      "Electronics",
      "Motors & Actuators",
      "Sensors",
      "Computing",
      "Power & Batteries",
      "Cables & Adapters",
      "Mechanical",
      "Tools",
      "Prototyping",
      "Other",
    ]);
    expect(
      IOIO_INITIAL_CATEGORY_DEFAULTS.map(({ name }) => name)
    ).not.toContain("Kits");

    const normalizedNames = IOIO_INITIAL_CATEGORY_DEFAULTS.map(({ name }) =>
      name.trim().toLocaleLowerCase("en")
    );
    expect(new Set(normalizedNames).size).toBe(normalizedNames.length);
  });

  it("keeps the requested order for the untouched database default set", () => {
    const records = [...IOIO_INITIAL_CATEGORY_DEFAULTS]
      .reverse()
      .map(({ name }) => ({ id: name, name }));

    expect(orderUntouchedIoioDefaults(records).map(({ name }) => name)).toEqual(
      IOIO_INITIAL_CATEGORY_DEFAULTS.map(({ name }) => name)
    );
  });

  it("preserves Shelf query order after Staff changes the category set", () => {
    const categories = [
      { id: "custom", name: "Robotics" },
      { id: "other", name: "Other" },
      { id: "electronics", name: "Electronics renamed" },
    ];

    expect(orderUntouchedIoioDefaults(categories)).toBe(categories);
  });
});
