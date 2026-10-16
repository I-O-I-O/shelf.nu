import { describe, expect, it } from "vitest";
import {
  IOIO_INITIAL_CATEGORY_DEFAULTS,
  orderUntouchedIoioDefaults,
} from "./ioio-categories";

describe("IOIO initial category defaults", () => {
  it("defines the 11 recommended categories in the requested order", () => {
    expect(IOIO_INITIAL_CATEGORY_DEFAULTS.map(({ name }) => name)).toEqual([
      "Electronics",
      "Computers & accessories",
      "Audio & video",
      "Tools & machinery",
      "Prototyping & making",
      "Cables & adapters",
      "Furniture",
      "Office equipment",
      "Supplies & consumables",
      "Safety equipment",
      "Other",
    ]);
    expect(
      IOIO_INITIAL_CATEGORY_DEFAULTS.map(({ name }) => name)
    ).not.toContain("Kits");
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
