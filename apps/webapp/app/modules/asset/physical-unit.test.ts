import { describe, expect, it } from "vitest";
import {
  getPhysicalUnitBaseTitle,
  getPhysicalUnitLabelFromTitle,
  getPhysicalUnitNumberFromTitle,
  normalizePhysicalUnitNumber,
} from "./physical-unit";

describe("getPhysicalUnitBaseTitle", () => {
  it("removes a physical unit suffix without changing the product name", () => {
    expect(getPhysicalUnitBaseTitle('"Makey" Kit #001')).toBe('"Makey" Kit');
    expect(getPhysicalUnitBaseTitle("Makey Makey Kit")).toBe("Makey Makey Kit");
  });
});

describe("physical unit numbers", () => {
  it.each(["001", "#001", " 001 ", " #001 ", "1"])(
    "normalizes %s to the canonical three-digit number",
    (value) => {
      expect(normalizePhysicalUnitNumber(value)).toBe("001");
    }
  );

  it("rejects values that are not unit numbers", () => {
    expect(normalizePhysicalUnitNumber("unit-001")).toBeNull();
    expect(normalizePhysicalUnitNumber("#")).toBeNull();
    expect(normalizePhysicalUnitNumber("001/002")).toBeNull();
  });

  it("reads the unit number from an asset title suffix", () => {
    expect(getPhysicalUnitNumberFromTitle("Makey Makey Kit #001")).toBe("001");
    expect(getPhysicalUnitLabelFromTitle("Makey Makey Kit #001")).toBe("#001");
    expect(getPhysicalUnitNumberFromTitle("Makey Makey Kit")).toBeNull();
  });
});
