import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";
import { HandbookImportReview } from "./handbook-import-review";

const draft = {
  title: "Soldering Basics",
  content: "## Safety\n\nWear eye protection.",
  sourceUrls: ["https://example.com/manual"],
  sourceName: "soldering.pdf",
  categorySuggestion: "Workshop Safety",
  referencesByHeading: {},
  sourceOutline: [
    {
      id: "source-section-1",
      sourceOrder: 0,
      title: "Safety",
      level: 2 as const,
      sourcePage: 1,
    },
  ],
  sections: [
    {
      id: "section-safety",
      sourceOrder: 0,
      title: "Safety",
      level: 2 as const,
      markdown: "## Safety\n\nWear eye protection.",
      sourceUrls: ["https://example.com/manual"],
    },
  ],
  articles: [
    {
      id: "article-1",
      title: "Soldering Basics",
      sections: [
        {
          id: "section-safety",
          sourceOrder: 0,
          title: "Safety",
          level: 2 as const,
          markdown: "## Safety\n\nWear eye protection.",
          sourceUrls: ["https://example.com/manual"],
        },
      ],
    },
  ],
  hierarchyDetected: true,
  fallback: false,
};

function renderReview(
  isStudent: boolean,
  reviewDraft = draft,
  existingArticles: Array<{
    id: string;
    slug: string;
    title: string;
    handbookCategoryId: string | null;
    publishedVersionId: string | null;
    categoryName: string;
  }> = [],
  claudeAvailable = false
) {
  const router = createMemoryRouter(
    [
      {
        path: "/handbook/import",
        action: () => ({
          kind: "structure-suggestion",
          categorySuggestion: "AI Workshop",
          articles: [
            {
              id: "claude-article-1",
              title: "AI suggested article",
              sections: draft.articles[0]!.sections,
              rationale: "These headings describe one coherent task.",
            },
          ],
        }),
        Component: () => (
          <HandbookImportReview
            draft={reviewDraft}
            categories={[{ id: "category-1", name: "Workshop Safety" }]}
            existingArticles={existingArticles}
            isStudent={isStudent}
            claudeAvailable={claudeAvailable}
            onImportAnother={() => {}}
          />
        ),
      },
    ],
    { initialEntries: ["/handbook/import"] }
  );

  return render(<RouterProvider router={router} />);
}

describe("HandbookImportReview", () => {
  it("shows the detected source outline and proposed article structure", () => {
    renderReview(false);

    expect(screen.getByText("soldering.pdf")).toBeTruthy();
    expect(screen.getByLabelText("Rename article")).toHaveValue(
      "Soldering Basics"
    );
    expect(
      screen.getByRole("heading", { name: "Detected PDF structure" })
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Proposed Handbook structure" })
    ).toBeTruthy();
    expect(screen.getByText("Page 1")).toBeTruthy();
    expect(screen.getByLabelText("Rename heading Safety")).toHaveValue(
      "Safety"
    );
    const contentEditor = screen.getByRole("textbox", {
      name: "Article content",
      hidden: true,
    });
    expect(contentEditor).toHaveValue("## Safety\n\nWear eye protection.");
    expect(
      screen.getByRole("combobox", { name: "Select an existing category" })
    ).toBeTruthy();
    expect(screen.getByLabelText("Category to create on approval")).toHaveValue(
      ""
    );
    expect(screen.getByRole("button", { name: "Create 1 draft" })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Publish article" })
    ).toBeNull();
  });

  it("lets Students save drafts without creating a category or publishing", () => {
    renderReview(true);

    expect(screen.getByText(/save drafts without a category/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create 1 draft" })).toBeTruthy();
    expect(
      screen.queryByLabelText("Category to create on approval")
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Publish article" })
    ).toBeNull();
  });

  it("lets Staff rename a proposal and remove it from the import", () => {
    const resourceSection = {
      id: "section-resources",
      sourceOrder: 1,
      title: "References",
      level: 2 as const,
      markdown: "## References\n\nUseful links.",
      sourceUrls: [],
    };
    const twoArticleDraft = {
      ...draft,
      articles: [
        draft.articles[0]!,
        {
          id: "article-2",
          title: "Laser Cutting Resources",
          sections: [resourceSection],
        },
      ],
      sections: [...draft.sections, resourceSection],
    };
    renderReview(false, twoArticleDraft);

    fireEvent.change(screen.getAllByLabelText("Rename article")[0]!, {
      target: { value: "Renamed proposal" },
    });
    expect(screen.getAllByLabelText("Rename article")[0]).toHaveValue(
      "Renamed proposal"
    );
    fireEvent.click(screen.getByLabelText("Include Laser Cutting Resources"));
    expect(
      screen.getByLabelText("Include Laser Cutting Resources")
    ).not.toBeChecked();
  });

  it("lets a user edit canonical Markdown before approving the draft", () => {
    renderReview(false);

    fireEvent.click(screen.getByText("Edit article content (Markdown)"));
    fireEvent.change(screen.getByRole("textbox", { name: "Article content" }), {
      target: { value: "## Safety\n\nWear goggles and gloves." },
    });

    expect(
      screen.getByRole("textbox", { name: "Article content" })
    ).toHaveValue("## Safety\n\nWear goggles and gloves.");
  });

  it("keeps excluded sections visible and out of the proposal", () => {
    renderReview(false);

    fireEvent.click(screen.getByLabelText("Include section Safety"));

    expect(
      screen.getByText("Excluded from import · still detected")
    ).toBeTruthy();
    expect(screen.getByLabelText("Rename heading Safety")).toHaveValue(
      "Safety"
    );
    expect(screen.queryByRole("button", { name: "Create 1 draft" })).toBeNull();
  });

  it("moves selected sections into a newly titled article", () => {
    const resourceSection = {
      id: "section-resources",
      sourceOrder: 1,
      title: "References",
      level: 2 as const,
      markdown: "## References\n\nUseful links.",
      sourceUrls: [],
    };
    const twoSectionDraft = {
      ...draft,
      articles: [
        {
          ...draft.articles[0]!,
          sections: [...draft.articles[0]!.sections, resourceSection],
        },
      ],
    };
    renderReview(false, twoSectionDraft);

    fireEvent.click(
      screen.getByLabelText("Select References to move into a new article")
    );
    fireEvent.change(
      screen.getByLabelText("New article title from Soldering Basics"),
      {
        target: { value: "Reference Links" },
      }
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Move selected to new article" })
    );

    expect(screen.getAllByLabelText("Rename article")).toHaveLength(2);
    expect(screen.getAllByLabelText("Rename article")[1]).toHaveValue(
      "Reference Links"
    );
    expect(screen.getAllByText("References").length).toBeGreaterThan(0);
  });

  it("lets the user change a heading level and preview the final article", () => {
    const resourceSection = {
      id: "section-resources",
      sourceOrder: 1,
      title: "References",
      level: 2 as const,
      markdown: "## References\n\nUseful links.",
      sourceUrls: ["https://example.com/resources"],
    };
    const twoSectionDraft = {
      ...draft,
      articles: [
        {
          ...draft.articles[0]!,
          sections: [...draft.articles[0]!.sections, resourceSection],
        },
      ],
    };
    renderReview(false, twoSectionDraft);

    fireEvent.click(
      screen.getAllByRole("button", { name: "Make subsection" })[1]!
    );
    expect(screen.getByRole("button", { name: "Make section" })).toBeTruthy();
    fireEvent.click(screen.getByText("Preview article"));

    expect(
      screen.getByRole("navigation", {
        name: "Table of contents for Soldering Basics",
      })
    ).toBeTruthy();
    expect(screen.getByText("Article references")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "https://example.com/resources" })
    ).toBeTruthy();
    expect(screen.getByText(/Imported from: soldering\.pdf/)).toBeTruthy();
  });

  it("labels Claude suggestions and lets the user apply or restore the original", async () => {
    renderReview(false, draft, [], true);

    fireEvent.click(
      screen.getByRole("button", { name: "Improve structure with Claude" })
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Use suggestion" })
      ).toBeTruthy()
    );
    expect(
      screen.getByRole("heading", {
        name: "Claude suggested structure · AI suggested",
      })
    ).toBeTruthy();
    expect(screen.getByLabelText("Rename article")).toHaveValue(
      "Soldering Basics"
    );

    fireEvent.click(screen.getByRole("button", { name: "Use suggestion" }));
    expect(screen.getByLabelText("Rename article")).toHaveValue(
      "AI suggested article"
    );
    expect(screen.getAllByText("AI suggested").length).toBeGreaterThan(0);
    fireEvent.click(
      screen.getByRole("button", { name: "Keep original structure" })
    );
    expect(screen.getByLabelText("Rename article")).toHaveValue(
      "Soldering Basics"
    );
  });

  it("lets a user move a section and merge article proposals", () => {
    const resourceSection = {
      id: "section-resources",
      sourceOrder: 1,
      title: "References",
      level: 2 as const,
      markdown: "## References\n\nUseful links.",
      sourceUrls: [],
    };
    const twoArticleDraft = {
      ...draft,
      articles: [
        draft.articles[0]!,
        {
          id: "article-2",
          title: "Laser Cutting Resources",
          sections: [resourceSection],
        },
      ],
      sections: [...draft.sections, resourceSection],
    };
    const { unmount } = renderReview(false, twoArticleDraft);
    fireEvent.change(screen.getByLabelText("Move References to article"), {
      target: { value: "article-1" },
    });
    expect(screen.getAllByLabelText("Rename article")).toHaveLength(1);
    expect(screen.getAllByText("References").length).toBeGreaterThan(0);
    unmount();

    renderReview(false, twoArticleDraft);
    fireEvent.change(screen.getByLabelText("Merge Soldering Basics with"), {
      target: { value: "article-2" },
    });
    expect(screen.getAllByLabelText("Rename article")).toHaveLength(1);
    expect(screen.getByLabelText("Rename article")).toHaveValue(
      "Laser Cutting Resources"
    );
    expect(screen.getAllByText("Safety").length).toBeGreaterThan(0);
    expect(screen.getAllByText("References").length).toBeGreaterThan(0);
  });

  it("surfaces a title-overlapping existing article and its revision path", () => {
    const inkscapeDraft = {
      ...draft,
      articles: [
        {
          ...draft.articles[0]!,
          id: "article-inkscape",
          title: "Inkscape for Laser Cutting",
        },
      ],
    };
    renderReview(false, inkscapeDraft, [
      {
        id: "existing-1",
        slug: "inkscape-basics",
        title: "Inkscape Basics for Laser Cutting",
        handbookCategoryId: "category-1",
        publishedVersionId: "version-2",
        categoryName: "Workshop Safety",
      },
    ]);

    expect(screen.getByText("Potential existing article")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Import action"), {
      target: { value: "inkscape-basics" },
    });
    expect(
      screen.getByText(
        /creates a proposed revision.*keeps its current published version live/i
      )
    ).toBeTruthy();
  });
});
