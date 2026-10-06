import { describe, expect, it } from "vitest";
import { extractBorrowSearch } from "./borrow-item.shared";

describe("extractBorrowSearch", () => {
  it.each([
    ["I want to borrow one Arduino Nano", "Arduino Nano"],
    ["Borrow 2 units of USB-C Cable", "USB-C Cable"],
    ["Take Makey Kit #003", "Makey Kit #003"],
    ["Borrow one Motor until 2026-10-15", "Motor"],
  ])(
    "preserves item identity while removing action/quantity copy",
    (input, expected) => {
      expect(extractBorrowSearch(input)).toBe(expected);
    }
  );
});
