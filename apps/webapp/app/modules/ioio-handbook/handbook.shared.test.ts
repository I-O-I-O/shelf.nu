import { describe, expect, it } from "vitest";
import {
  getKnowledgeOverlap,
  getKnowledgeTerms,
  makeHandbookSlug,
  normalizeSourceUrl,
} from "./handbook.shared";

describe("Handbook knowledge helpers", () => {
  it("creates stable readable slugs, including Swedish characters", () => {
    expect(makeHandbookSlug("Felsökning: Grove-kabel åäö")).toBe(
      "felsokning-grove-kabel-aao"
    );
  });

  it("extracts useful overlapping terms without generic glue words", () => {
    expect(getKnowledgeTerms("The Grove cable is loose again")).toEqual([
      "grove",
      "cable",
      "loose",
    ]);
    expect(
      getKnowledgeOverlap("Grove cable loose", "Loose Grove cable fix")
    ).toBeGreaterThan(0.5);
    expect(getKnowledgeOverlap("Grove cable", "3D printer")).toBe(0);
  });

  it("accepts only http(s) source references", () => {
    expect(normalizeSourceUrl("https://example.org/manual")).toBe(
      "https://example.org/manual"
    );
    expect(normalizeSourceUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeSourceUrl("not a URL")).toBeNull();
  });
});
