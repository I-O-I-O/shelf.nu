import { describe, expect, it } from "vitest";
import {
  inventorySearchScore,
  inventoryWordVariants,
} from "./search-normalization";

describe("inventory search relevance", () => {
  it.each([
    ["battery", "AA batteries"],
    ["batteries", "9V battery"],
    ["cable", "USB cables"],
    ["motor", "servo motors"],
    ["adapter", "USB adapters"],
    ["button", "Push buttons"],
    ["arduino cable", "Arduino USB cables"],
    ["AA battery", "AA batteries"],
    ["BATTERY", "AAA batteries"],
    ["battery", "CR2032 batteries"],
  ])("matches %s against %s", (query, name) => {
    expect(inventorySearchScore(name, query)).toBeGreaterThan(0);
  });

  it("keeps exact names and phrases ahead of token, stem, and partial matches", () => {
    const scores = [
      "Arduino cable",
      "Arduino cable kit",
      "Arduino USB cable",
      "Arduino USB cables",
      "Arduino USB cableway",
    ].map((name) => inventorySearchScore(name, "arduino cable"));
    expect(scores).toEqual([500, 400, 300, 200, 100]);
  });

  it("requires every token and preserves model identifiers", () => {
    expect(inventorySearchScore("AA batteries", "AAA battery")).toBe(0);
    expect(inventorySearchScore("Servo motors", "arduino motor")).toBe(0);
    expect(inventorySearchScore("Arduino UNO R3", "Arduino UNO R3")).toBe(500);
    expect(inventoryWordVariants("CR2032")).toEqual(["cr2032"]);
    expect(inventorySearchScore("anything", " ")).toBe(0);
  });
});
