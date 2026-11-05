import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireRead: vi.fn(),
  listCategories: vi.fn(),
  listArticleTitles: vi.fn(),
  importPdf: vi.fn(),
  createImportDrafts: vi.fn(),
  improveStructure: vi.fn(),
  claudeAvailable: vi.fn(),
}));

// why: this route test focuses on upload/review gates; authentication and the
// organization-scoped Handbook service have focused tests of their own.
vi.mock("~/modules/ioio-handbook/access.server", () => ({
  requireIoioHandbookRead: mocks.requireRead,
}));
// why: PDF extraction and Claude response validation are tested at their
// module boundaries, while this test verifies that neither writes articles.
vi.mock("~/modules/ioio-handbook/pdf-import.server", () => ({
  HANDBOOK_PDF_MAX_BYTES: 5 * 1024 * 1024,
  HandbookPdfImportError: class HandbookPdfImportError extends Error {},
  importHandbookPdf: mocks.importPdf,
}));
// why: the category/article database queries and transactional draft writes
// belong to the Handbook service, not this route action test.
vi.mock("~/modules/ioio-handbook/service.server", () => ({
  HandbookValidationError: class HandbookValidationError extends Error {},
  createHandbookImportDrafts: mocks.createImportDrafts,
  listHandbookArticleTitles: mocks.listArticleTitles,
  listHandbookCategories: mocks.listCategories,
}));
// why: the route passes extracted sections to this optional provider boundary;
// its prompt validation and HTTP behavior are covered separately.
vi.mock("~/modules/ioio-handbook/structure-analysis.server", () => ({
  HandbookStructureAnalysisError: class HandbookStructureAnalysisError extends Error {},
  improveHandbookStructureWithClaude: mocks.improveStructure,
  isHandbookStructureAnalysisAvailable: mocks.claudeAvailable,
}));

import { action, loader } from "~/routes/_layout+/handbook.import";

const importedDraft = {
  title: "Laser Cutting Guide",
  content: "## Basics\n\nVector graphics.",
  sourceUrls: ["https://example.com/manual"],
  sourceName: "Laser cutting.pdf",
  categorySuggestion: "Laser Cutting",
  referencesByHeading: { Basics: ["https://example.com/manual"] },
  sourceOutline: [
    {
      id: "source-section-1",
      sourceOrder: 0,
      title: "Basics",
      level: 2 as const,
      sourcePage: 1,
    },
  ],
  sections: [
    {
      id: "source-section-1",
      sourceOrder: 0,
      title: "Basics",
      level: 2 as const,
      markdown: "## Basics\n\nVector graphics.",
      sourceUrls: ["https://example.com/manual"],
    },
  ],
  articles: [
    {
      id: "article-1",
      title: "Laser Cutting Basics",
      sections: [
        {
          id: "source-section-1",
          sourceOrder: 0,
          title: "Basics",
          level: 2 as const,
          markdown: "## Basics\n\nVector graphics.",
          sourceUrls: ["https://example.com/manual"],
        },
      ],
    },
  ],
  hierarchyDetected: true,
  fallback: false,
};

function requestArgs(form: FormData) {
  return {
    context: {
      getSession: () => ({ userId: "user-1" }),
    } as ActionFunctionArgs["context"],
    request: new Request("http://localhost/handbook/import", {
      method: "POST",
      body: form,
    }),
    params: {},
  } as ActionFunctionArgs;
}

describe("Handbook PDF import route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireRead.mockResolvedValue({
      organizationId: "org-1",
      userId: "user-1",
      canEdit: true,
      isStudent: false,
      currentOrganization: { type: "TEAM" },
    });
    mocks.listCategories.mockResolvedValue([]);
    mocks.listArticleTitles.mockResolvedValue([]);
    mocks.importPdf.mockResolvedValue(importedDraft);
    mocks.createImportDrafts.mockResolvedValue({
      categoryId: "category-1",
      created: [{ slug: "laser-cutting-basics", revision: false }],
    });
    mocks.improveStructure.mockResolvedValue({
      categorySuggestion: "Laser Cutting",
      articles: importedDraft.articles,
    });
    mocks.claudeAvailable.mockReturnValue(true);
  });

  it("loads organization-scoped categories and existing articles for overlap review", async () => {
    const result = await loader({
      context: {
        getSession: () => ({ userId: "user-1" }),
      } as LoaderFunctionArgs["context"],
      request: new Request("http://localhost/handbook/import"),
      params: {},
    } as LoaderFunctionArgs);

    expect(result).toMatchObject({
      categories: [],
      existingArticles: [],
      isStudent: false,
      claudeAvailable: true,
    });
    expect(mocks.listCategories).toHaveBeenCalledWith("org-1");
    expect(mocks.listArticleTitles).toHaveBeenCalledWith({
      organizationId: "org-1",
    });
  });

  it("extracts and previews a PDF without creating drafts", async () => {
    const form = new FormData();
    form.set("intent", "upload-pdf");
    form.set(
      "file",
      new File(
        ["%PDF-1.4 content"],
        "Challenge 6 Laser cutting done right.pdf",
        {
          type: "application/pdf",
        }
      )
    );

    const result = await action(requestArgs(form));

    expect(mocks.importPdf).toHaveBeenCalledWith(
      expect.any(Buffer),
      "Challenge 6 Laser cutting done right.pdf"
    );
    expect(result).toMatchObject({
      data: {
        kind: "preview",
        draft: { articles: importedDraft.articles },
      },
    });
    expect(mocks.createImportDrafts).not.toHaveBeenCalled();
  });

  it("keeps upload validation failures local to the import screen", async () => {
    const form = new FormData();
    form.set("intent", "upload-pdf");
    form.set(
      "file",
      new File(["not pdf"], "notes.txt", { type: "text/plain" })
    );

    const result = await action(requestArgs(form));

    expect(result).toMatchObject({
      init: { status: 400 },
      data: { kind: "error", message: "Only PDF files are supported." },
    });
    expect(mocks.importPdf).not.toHaveBeenCalled();
  });

  it("sends extracted sections to optional Claude and still creates no drafts", async () => {
    const form = new FormData();
    form.set("intent", "improve-structure");
    form.set("draft", JSON.stringify(importedDraft));

    const result = await action(requestArgs(form));

    expect(mocks.improveStructure).toHaveBeenCalledWith(importedDraft);
    expect(result).toMatchObject({
      data: { kind: "structure-suggestion", articles: importedDraft.articles },
    });
    expect(mocks.createImportDrafts).not.toHaveBeenCalled();
  });

  it("creates drafts only on approval and keeps source provenance", async () => {
    const form = new FormData();
    form.set("intent", "approve-structure");
    form.set("sourceName", "Laser cutting.pdf");
    form.set("handbookCategoryId", "category-1");
    form.set(
      "articles",
      JSON.stringify([
        {
          title: "Laser Cutting Basics",
          content: "## Basics\n\nVector graphics.",
          sourceUrls: ["https://example.com/manual"],
        },
      ])
    );

    const result = await action(requestArgs(form));

    expect(result).toMatchObject({ status: 302 });
    expect(mocks.createImportDrafts).toHaveBeenCalledWith({
      organizationId: "org-1",
      userId: "user-1",
      handbookCategoryId: "category-1",
      newCategoryName: undefined,
      articles: [
        {
          title: "Laser Cutting Basics",
          content:
            "## Basics\n\nVector graphics.\n\n> [!NOTE] Imported from: Laser cutting.pdf",
          sourceUrls: ["https://example.com/manual"],
        },
      ],
    });
  });

  it("lets Students save imported structures as drafts through the same approval path", async () => {
    mocks.requireRead.mockResolvedValue({
      organizationId: "org-1",
      userId: "student-1",
      canEdit: false,
      isStudent: true,
      currentOrganization: { type: "TEAM" },
    });
    const form = new FormData();
    form.set("intent", "approve-structure");
    form.set("sourceName", "Laser cutting.pdf");
    form.set(
      "articles",
      JSON.stringify([
        {
          title: "Laser Cutting Basics",
          content: "## Basics\n\nVector graphics.",
          sourceUrls: [],
        },
      ])
    );

    await action(requestArgs(form));

    expect(mocks.createImportDrafts).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-1",
        userId: "student-1",
        handbookCategoryId: undefined,
        newCategoryName: undefined,
      })
    );
  });
});
