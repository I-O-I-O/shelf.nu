import { describe, expect, it } from "vitest";
import {
  assignHandbookHeadingIds,
  compareHandbookVersions,
  findHandbookSearchMatch,
  getHandbookDocument,
  getHandbookOutline,
} from "./document";

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

  it("keeps H2 sections and H3 subsections as nested canonical Markdown blocks", () => {
    const document = getHandbookDocument(
      [
        "Opening paragraph.",
        "",
        "## Introduction",
        "",
        "Overview text.",
        "",
        "## Terminology",
        "",
        "### Additive manufacturing",
        "",
        "Layered process.",
        "",
        "### Subtractive manufacturing",
        "",
        "Material removal.",
        "",
        "## References",
        "- [Guide](https://example.test)",
      ].join("\n")
    );

    expect(document.introduction).toBe("");
    expect(document.sections.map(({ title }) => title)).toEqual([
      "Introduction",
      "Terminology",
      "References",
    ]);
    expect(document.sections[1]).toMatchObject({
      id: "terminology",
      content: "",
      subsections: [
        {
          id: "additive-manufacturing",
          title: "Additive manufacturing",
          content: "Layered process.",
        },
        {
          id: "subtractive-manufacturing",
          title: "Subtractive manufacturing",
          content: "Material removal.",
        },
      ],
    });
    expect(document.sections[0]?.content).toContain("Opening paragraph.");
    expect(document.sections[2]?.content).toContain("https://example.test");
  });

  it("shows unheaded opening content as a navigable Introduction when sections follow", () => {
    const document = getHandbookDocument(
      "Opening paragraph.\n\n## Terminology\nDefinitions."
    );
    const match = findHandbookSearchMatch(
      "Opening paragraph.\n\n## Terminology\nDefinitions.",
      "opening paragraph"
    );

    expect(document.introduction).toBe("Opening paragraph.");
    expect(document.introductionId).toBe("introduction");
    expect(match).toEqual({ id: "introduction", title: "Introduction" });
  });

  it("reports deterministic section changes and resolves structured search hits", () => {
    const before = [
      "## Terminology",
      "Old definition.",
      "### Additive manufacturing",
      "Layers are added.",
      "## References",
      "Old link.",
    ].join("\n");
    const after = [
      "## Terminology",
      "Expanded definition.",
      "### Additive manufacturing",
      "Layers are added.",
      "## FDM",
      "Filament is deposited.",
      "## References",
      "Updated link.",
    ].join("\n");
    const differences = compareHandbookVersions(before, after);

    expect(differences.map(({ title, status }) => [title, status])).toEqual([
      ["Terminology", "Modified"],
      ["Additive manufacturing", "Unchanged"],
      ["FDM", "Added"],
      ["References", "Modified"],
    ]);
    expect(findHandbookSearchMatch(after, "filament")).toEqual({
      id: "fdm",
      title: "FDM",
    });
    expect(findHandbookSearchMatch(after, "terminology")).toEqual({
      id: "terminology",
      title: "Terminology",
    });
  });

  it("marks stable sections as modified when their order changes", () => {
    const differences = compareHandbookVersions(
      "## Introduction\nStart here.\n## References\nUseful links.",
      "## References\nUseful links.\n## Introduction\nStart here."
    );

    expect(differences.map(({ title, status }) => [title, status])).toEqual([
      ["References", "Modified"],
      ["Introduction", "Modified"],
    ]);
  });
});
