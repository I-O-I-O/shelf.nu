import { describe, expect, it } from "vitest";
import { orderLabInfoSections } from "./sections.shared";

describe("orderLabInfoSections", () => {
  it("keeps About first and follows the persisted order for other sections", () => {
    const ordered = orderLabInfoSections([
      { key: "rules", position: 3 },
      { key: "about", position: 8 },
      { key: "custom_safety", position: 1 },
      { key: "borrowing", position: 2 },
    ]);

    expect(ordered.map(({ key }) => key)).toEqual([
      "about",
      "custom_safety",
      "borrowing",
      "rules",
    ]);
  });
});
