import { describe, expect, it } from "vitest";
import { assignHandbookHeadingIds, getHandbookOutline } from "./document";

describe("Handbook article documents", () => {
  it("derives a stable outline from H2 and H3 Markdown headings only", () => {
    const outline = getHandbookOutline(
      [
        "## Before you start",
        "",
        "### What to check",
        "",
        "## Changing the filament",
        "",
        "### Changing the filament",
        "",
        "#### Details stay out of the V1 outline",
        "",
        "```md",
        "## Example inside code",
        "```",
      ].join("\n")
    );

    expect(outline).toEqual([
      { level: 2, title: "Before you start", id: "before-you-start" },
      { level: 3, title: "What to check", id: "what-to-check" },
      {
        level: 2,
        title: "Changing the filament",
        id: "changing-the-filament",
      },
      {
        level: 3,
        title: "Changing the filament",
        id: "changing-the-filament-2",
      },
    ]);
  });

  it("adds heading anchors and styles supported callouts", () => {
    const container = document.createElement("div");
    container.innerHTML =
      "<h2>Safety</h2><blockquote><p>[!WARNING] Stop the printer first.</p></blockquote>";
    const outline = getHandbookOutline("## Safety\n");

    assignHandbookHeadingIds(container, outline);

    expect(container.querySelector("h2")?.id).toBe("safety");
    expect(container.querySelector("blockquote")?.dataset.handbookCallout).toBe(
      "warning"
    );
    expect(
      container.querySelector(".handbook-callout-label")?.textContent
    ).toBe("WARNING:");
    expect(container.querySelector("blockquote p")?.textContent).toBe(
      "WARNING: Stop the printer first."
    );
  });
});
