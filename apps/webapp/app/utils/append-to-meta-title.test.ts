import { describe, expect, it } from "vitest";
import { appendToMetaTitle } from "./append-to-meta-title";

describe("appendToMetaTitle", () => {
  it("uses IOIO Lab as the browser-tab brand", () => {
    expect(appendToMetaTitle("Inventory")).toBe("Inventory · IOIO Lab");
  });

  it("keeps a branded not-found title when no route title is available", () => {
    expect(appendToMetaTitle(undefined)).toBe("Not found · IOIO Lab");
  });
});
