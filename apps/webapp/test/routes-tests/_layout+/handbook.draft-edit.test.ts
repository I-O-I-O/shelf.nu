import { beforeEach, describe, expect, it, vi } from "vitest";
import { createActionArgs, createLoaderArgs } from "@mocks/remix";

const mocks = vi.hoisted(() => ({
  requireRead: vi.fn(),
  getEditData: vi.fn(),
  listArticleTitles: vi.fn(),
  editorAction: vi.fn(),
}));

// why: route tests exercise the edit URL and ownership parameters without
// requiring a live Shelf session or database connection.
vi.mock("~/modules/ioio-handbook/access.server", () => ({
  requireIoioHandbookRead: mocks.requireRead,
}));
vi.mock("~/modules/ioio-handbook/service.server", () => ({
  getHandbookEditData: mocks.getEditData,
  listHandbookArticleTitles: mocks.listArticleTitles,
}));
vi.mock("~/modules/ioio-handbook/editor.server", () => ({
  handbookEditorAction: mocks.editorAction,
}));

import { action, loader } from "~/routes/_layout+/handbook.$slug_.edit";

const context = { getSession: () => ({ userId: "student-1" }) } as never;
const draft = {
  id: "article-1",
  slug: "test-handbook-draft",
  status: "DRAFT",
  draftTitle: "Test Handbook Draft",
  draftContent: "This is a draft editing test.",
  handbookCategoryId: "category-1",
  draftSourceUrls: ["https://example.com"],
  versions: [],
};

describe("Handbook draft edit route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireRead.mockResolvedValue({
      userId: "student-1",
      organizationId: "org-1",
      currentOrganization: { type: "TEAM" },
      canEdit: false,
      isStudent: true,
    });
    mocks.getEditData.mockResolvedValue({
      article: draft,
      categories: [{ id: "category-1", name: "Workshop Safety" }],
    });
    mocks.listArticleTitles.mockResolvedValue([
      {
        slug: "how-to-change-filament",
        title: "How to change filament",
        handbookCategoryId: "category-1",
        categoryName: "Workshop Safety",
      },
    ]);
    mocks.editorAction.mockResolvedValue({ ok: true });
  });

  it("loads the existing draft values for its slug and owner", async () => {
    const result = await loader(
      createLoaderArgs({
        context,
        request: new Request(
          "http://localhost/handbook/test-handbook-draft/edit"
        ),
        params: { slug: "test-handbook-draft" },
      })
    );

    expect(result).toMatchObject({
      article: draft,
      categories: [{ id: "category-1", name: "Workshop Safety" }],
      titleMatches: [
        {
          slug: "how-to-change-filament",
          title: "How to change filament",
          handbookCategoryId: "category-1",
          categoryName: "Workshop Safety",
        },
      ],
      isStudent: true,
    });
    expect(mocks.listArticleTitles).toHaveBeenCalledWith({
      organizationId: "org-1",
    });
    expect(mocks.getEditData).toHaveBeenCalledWith({
      organizationId: "org-1",
      slug: "test-handbook-draft",
      ownerUserId: "student-1",
      userId: "student-1",
      revisionMode: false,
    });
  });

  it("passes the article slug to the save action instead of a version id", async () => {
    const args = createActionArgs({
      context,
      request: new Request(
        "http://localhost/handbook/test-handbook-draft/edit",
        { method: "POST" }
      ),
      params: { slug: "test-handbook-draft" },
    });

    await action(args);

    expect(mocks.editorAction).toHaveBeenCalledWith({
      ...args,
      slug: "test-handbook-draft",
    });
  });

  it("opens a published article in revision mode without restricting it to its original author", async () => {
    mocks.getEditData.mockResolvedValue({
      article: {
        ...draft,
        status: "PUBLISHED",
        revisionBaseVersionId: "version-2",
        revisionSubmitted: false,
      },
      categories: [{ id: "category-1", name: "Workshop Safety" }],
    });

    const result = await loader(
      createLoaderArgs({
        context,
        request: new Request(
          "http://localhost/handbook/test-handbook-draft/edit?improve=1"
        ),
        params: { slug: "test-handbook-draft" },
      })
    );

    expect(result).toMatchObject({ revisionMode: true, isStudent: true });
    expect(mocks.getEditData).toHaveBeenCalledWith({
      organizationId: "org-1",
      slug: "test-handbook-draft",
      ownerUserId: undefined,
      userId: "student-1",
      revisionMode: true,
    });
  });
});
