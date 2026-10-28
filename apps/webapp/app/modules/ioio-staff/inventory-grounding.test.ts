import { describe, expect, it } from "vitest";
import {
  findMentionedProducts,
  resolveInventoryReference,
} from "./inventory-grounding";
const catalog = [
  { id: "usb", name: "USB-C Cable" },
  { id: "nano", name: "Arduino Nano" },
  { id: "motor", name: "Motor" },
  { id: "motor-driver", name: "Motor Driver" },
  { id: "smalaa", name: "Smalaa" },
  { id: "unrequested", name: "Makey Kit" },
];
describe("canonical inventory reference grounding", () => {
  it.each([
    "Arduino Nano",
    "the Arduino Nano",
    "find a place for Arduino Nano",
    "where should we put the Arduino Nano?",
    "Arduino Nano currently in Container A1-1.1",
  ])(
    "grounds canonical spans independently of sentence wording: %s",
    (instruction) => {
      expect(findMentionedProducts(instruction, catalog)).toEqual([
        { name: "Arduino Nano" },
      ]);
    }
  );
  it("does not include quantities or overlapping product names", () => {
    expect(
      findMentionedProducts(
        "USB-C Cable quantity 20, Arduino Nano quantity 5, Motor quantity 10. Also review Smalaa.",
        catalog
      )
    ).toEqual(
      ["USB-C Cable", "Arduino Nano", "Motor", "Smalaa"].map((name) => ({
        name,
      }))
    );
    expect(findMentionedProducts("Motor Driver", catalog)).toEqual([
      { name: "Motor Driver" },
    ]);
  });
  it("resolves exact, normalized and uniquely misspelled references", () => {
    expect(resolveInventoryReference({ name: "motor" }, catalog)).toMatchObject(
      { status: "EXACT", modelId: "motor" }
    );
    expect(
      resolveInventoryReference({ name: "USB C cable" }, catalog)
    ).toMatchObject({ status: "NORMALIZED", modelId: "usb" });
    expect(
      resolveInventoryReference({ name: "Arduinio Nano" }, catalog)
    ).toMatchObject({ status: "FUZZY_UNIQUE", modelId: "nano" });
  });
  it("leaves missing and ambiguous names unresolved", () => {
    expect(
      resolveInventoryReference({ name: "Unknown Widget" }, catalog)
    ).toMatchObject({ status: "NOT_FOUND", modelId: null });
    expect(
      resolveInventoryReference({ name: "Motor" }, [
        ...catalog,
        { id: "duplicate", name: "Motor" },
      ])
    ).toMatchObject({ status: "AMBIGUOUS", modelId: null });
  });
});
