import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tx: {
    handbookCategory: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    handbookArticle: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      aggregate: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    handbookArticleVersion: { aggregate: vi.fn(), create: vi.fn() },
    handbookSource: { upsert: vi.fn(), deleteMany: vi.fn() },
    handbookVersionSource: { createMany: vi.fn() },
    handbookObservation: {
      create: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    userOrganization: { findFirst: vi.fn() },
  },
  handbookCategory: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  handbookArticle: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  handbookObservation: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    updateMany: vi.fn(),
  },
  userOrganization: { findFirst: vi.fn(), findMany: vi.fn() },
  recordEvent: vi.fn(),
}));

vi.mock("~/database/db.server", () => ({
  db: {
    $transaction: (callback: (tx: typeof mocks.tx) => unknown) =>
      callback(mocks.tx),
    handbookCategory: mocks.handbookCategory,
    handbookArticle: mocks.handbookArticle,
    handbookObservation: mocks.handbookObservation,
    userOrganization: mocks.userOrganization,
  },
}));
vi.mock("~/modules/activity-event/service.server", () => ({
  recordEvent: mocks.recordEvent,
}));

import {
  approveHandbookNewArticleSubmission,
  approveHandbookArticleRevision,
  archiveHandbookArticle,
  deleteHandbookArticlePermanently,
  withdrawHandbookSubmission,
  createHandbookCategory,
  createHandbookImportDrafts,
  discardHandbookArticleRevisionDraft,
  deleteHandbookDraft,
  getHandbookEditData,
  listPublishedHandbookArticles,
  listRelatedHandbookArticles,
  listMyHandbookDrafts,
  listHandbookCategoriesForManagement,
  listHandbookArticleTitles,
  normalizeHandbookCategoryName,
  publishHandbookArticle,
  rejectHandbookArticleRevision,
  renameHandbookCategory,
  resolveHandbookObservationCategoryProposal,
  saveHandbookDraft,
  submitHandbookDraftForReview,
  submitHandbookObservation,
  updateHandbookArticleNavigation,
} from "./service.server";

describe("Handbook PDF import drafts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tx.handbookCategory.findFirst.mockResolvedValue({
      id: "category-1",
    });
    mocks.tx.handbookCategory.findUnique.mockResolvedValue(null);
    mocks.tx.handbookCategory.create.mockResolvedValue({ id: "category-1" });
    mocks.tx.handbookArticle.findMany.mockResolvedValue([]);
    mocks.tx.handbookArticle.create.mockResolvedValue({
      id: "article-1",
      slug: "laser-cutting-basics",
    });
    mocks.tx.handbookArticle.updateMany.mockResolvedValue({ count: 1 });
  });

  it("creates a selected category and all imported articles as drafts in one transaction", async () => {
    const result = await createHandbookImportDrafts({
      organizationId: "org-1",
      userId: "staff-1",
      newCategoryName: "Laser Cutting",
      articles: [
        {
          title: "Laser Cutting Basics",
          content: "## Vector graphics\n\nUse paths.",
          sourceUrls: ["https://example.com/guide"],
        },
        {
          title: "Inkscape for Laser Cutting",
          content: "## Document setup\n\nSet units.",
          sourceUrls: [],
        },
      ],
    });

    expect(result.created).toEqual([
      {
        slug: "laser-cutting-basics",
        title: "Laser Cutting Basics",
        revision: false,
      },
      {
        slug: "inkscape-for-laser-cutting",
        title: "Inkscape for Laser Cutting",
        revision: false,
      },
    ]);
    expect(mocks.tx.handbookCategory.create).toHaveBeenCalledWith({
      data: {
        organizationId: "org-1",
        name: "Laser Cutting",
        slug: "laser-cutting",
        normalizedName: "laser cutting",
      },
      select: { id: true },
    });
    expect(mocks.tx.handbookArticle.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({
          draftTitle: "Laser Cutting Basics",
          handbookCategoryId: "category-1",
          draftContent: "## Vector graphics\n\nUse paths.",
          draftSourceUrls: ["https://example.com/guide"],
          createdByUserId: "staff-1",
        }),
      })
    );
    expect(mocks.tx.handbookArticleVersion.create).not.toHaveBeenCalled();
  });

  it("appends imported material to an existing article revision draft", async () => {
    mocks.tx.handbookArticle.findFirst.mockResolvedValue({
      id: "existing-article",
      slug: "inkscape-basics",
      updatedByUserId: "staff-1",
      publishedVersionId: "version-4",
      handbookCategoryId: "category-1",
      draftTitle: "Inkscape Basics for Laser Cutting",
      draftContent: "## Overview\n\nExisting workflow.",
      draftSourceUrls: ["https://example.com/old"],
      publishedVersion: {
        title: "Inkscape Basics for Laser Cutting",
        content: "## Overview\n\nExisting workflow.",
        sources: [{ source: { url: "https://example.com/old" } }],
      },
      observations: [],
    });

    const result = await createHandbookImportDrafts({
      organizationId: "org-1",
      userId: "student-1",
      handbookCategoryId: "category-1",
      articles: [
        {
          title: "Inkscape for Laser Cutting",
          content: "## Keyboard shortcuts\n\nUse Ctrl+D.",
          sourceUrls: ["https://example.com/shortcuts"],
          existingArticleSlug: "inkscape-basics",
          revisionBaseVersionId: "version-4",
        },
      ],
    });

    expect(result.created).toEqual([
      {
        slug: "inkscape-basics",
        title: "Inkscape Basics for Laser Cutting",
        revision: true,
      },
    ]);
    expect(mocks.tx.handbookArticle.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          publishedVersionId: "version-4",
        }),
        data: expect.objectContaining({
          draftTitle: "Inkscape Basics for Laser Cutting",
          draftContent:
            "## Overview\n\nExisting workflow.\n\n## Keyboard shortcuts\n\nUse Ctrl+D.",
          draftSourceUrls: [
            "https://example.com/old",
            "https://example.com/shortcuts",
          ],
        }),
      })
    );
    expect(mocks.tx.handbookArticle.create).not.toHaveBeenCalled();
    expect(mocks.tx.handbookArticleVersion.create).not.toHaveBeenCalled();
  });

  it("preserves the same Student's existing revision draft when adding an import", async () => {
    mocks.tx.handbookArticle.findFirst.mockResolvedValue({
      id: "existing-article",
      slug: "inkscape-basics",
      updatedByUserId: "student-1",
      publishedVersionId: "version-4",
      handbookCategoryId: "category-1",
      draftTitle: "Inkscape Basics for Laser Cutting",
      draftContent:
        "## Overview\n\nPublished workflow.\n\n## My notes\n\nKeep these notes.",
      draftSourceUrls: [
        "https://example.com/old",
        "https://example.com/student-note",
      ],
      publishedVersion: {
        title: "Inkscape Basics for Laser Cutting",
        content: "## Overview\n\nPublished workflow.",
        sources: [{ source: { url: "https://example.com/old" } }],
      },
      observations: [],
    });

    await createHandbookImportDrafts({
      organizationId: "org-1",
      userId: "student-1",
      handbookCategoryId: "category-1",
      articles: [
        {
          title: "Inkscape for Laser Cutting",
          content: "## Keyboard shortcuts\n\nUse Ctrl+D.",
          sourceUrls: ["https://example.com/shortcuts"],
          existingArticleSlug: "inkscape-basics",
          revisionBaseVersionId: "version-4",
        },
      ],
    });

    expect(mocks.tx.handbookArticle.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          draftContent:
            "## Overview\n\nPublished workflow.\n\n## My notes\n\nKeep these notes.\n\n## Keyboard shortcuts\n\nUse Ctrl+D.",
          draftSourceUrls: [
            "https://example.com/old",
            "https://example.com/student-note",
            "https://example.com/shortcuts",
          ],
        }),
      })
    );
  });

  it("rejects an imported revision that would exceed the article content limit", async () => {
    const publishedContent = `## Existing\n\n${"x".repeat(29_990)}`;
    mocks.tx.handbookArticle.findFirst.mockResolvedValue({
      id: "existing-article",
      slug: "inkscape-basics",
      updatedByUserId: "staff-1",
      publishedVersionId: "version-4",
      handbookCategoryId: "category-1",
      draftTitle: "Inkscape Basics",
      draftContent: publishedContent,
      draftSourceUrls: [],
      publishedVersion: {
        title: "Inkscape Basics",
        content: publishedContent,
        sources: [],
      },
      observations: [],
    });

    await expect(
      createHandbookImportDrafts({
        organizationId: "org-1",
        userId: "staff-1",
        articles: [
          {
            title: "Inkscape shortcuts",
            content: "## Shortcuts\n\nUse Ctrl+D.",
            sourceUrls: [],
            existingArticleSlug: "inkscape-basics",
            revisionBaseVersionId: "version-4",
          },
        ],
      })
    ).rejects.toThrow("exceeds the 30,000-character article limit");
    expect(mocks.tx.handbookArticle.updateMany).not.toHaveBeenCalled();
  });
});

describe("Handbook categories", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handbookArticle.findMany.mockResolvedValue([]);
    mocks.handbookObservation.findMany.mockResolvedValue([]);
    mocks.handbookCategory.findFirst.mockResolvedValue({
      id: "handbook-category-1",
    });
    mocks.handbookCategory.findMany.mockResolvedValue([]);
    mocks.handbookCategory.update.mockResolvedValue({
      id: "handbook-category-1",
      name: "Updated Safety",
    });
    mocks.tx.handbookCategory.findFirst.mockResolvedValue({
      id: "handbook-category-1",
    });
    mocks.tx.handbookCategory.findUnique.mockResolvedValue(null);
    mocks.tx.handbookCategory.create.mockResolvedValue({
      id: "handbook-category-1",
      name: "Workshop Safety",
    });
    mocks.handbookObservation.findFirst.mockResolvedValue({
      id: "observation-1",
      articleId: "article-1",
      proposedCategoryName: "Workshop Safety",
    });
    mocks.handbookObservation.updateMany.mockResolvedValue({ count: 1 });
    mocks.tx.handbookObservation.updateMany.mockResolvedValue({ count: 1 });
    mocks.tx.handbookArticle.update.mockResolvedValue({ id: "article-1" });
    mocks.tx.handbookArticle.updateMany.mockResolvedValue({ count: 1 });
    mocks.tx.handbookArticle.findFirst.mockResolvedValue({
      id: "article-1",
      organizationId: "org-1",
      slug: "soldering-basics",
      position: 0,
      isStartHere: false,
      handbookCategoryId: "handbook-category-1",
      draftTitle: "Soldering Basics",
      draftContent: "Basic soldering guide.",
      draftSourceUrls: [],
    });
    mocks.tx.handbookArticle.findMany.mockResolvedValue([]);
    mocks.tx.handbookArticleVersion.aggregate.mockResolvedValue({
      _max: { versionNumber: 0 },
    });
    mocks.tx.handbookArticle.aggregate.mockResolvedValue({
      _max: { position: 0 },
    });
    mocks.tx.handbookArticleVersion.create.mockResolvedValue({
      id: "version-1",
      versionNumber: 1,
    });
    mocks.tx.userOrganization.findFirst.mockResolvedValue({
      roles: ["SELF_SERVICE"],
    });
    mocks.userOrganization.findFirst.mockResolvedValue({
      roles: ["SELF_SERVICE"],
    });
    mocks.tx.handbookSource.upsert.mockResolvedValue({ id: "source-1" });
    mocks.tx.handbookObservation.create.mockResolvedValue({
      id: "observation-1",
      title: "Safety note",
    });
  });

  it("orders Handbook articles by manual position independently of publication dates", async () => {
    mocks.handbookArticle.findMany.mockResolvedValue([]);

    await listPublishedHandbookArticles({ organizationId: "org-1" });

    expect(mocks.handbookArticle.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ position: "asc" }, { slug: "asc" }],
      })
    );
  });

  it("does not change a one-article category when the article is dropped on itself", async () => {
    mocks.tx.handbookArticle.findFirst.mockResolvedValue({
      id: "article-only",
      handbookCategoryId: "category-1",
      position: 1,
    });
    mocks.tx.handbookArticle.findMany.mockResolvedValue([
      { id: "article-only", position: 1 },
    ]);

    await expect(
      updateHandbookArticleNavigation({
        organizationId: "org-1",
        articleId: "article-only",
        intent: "move-before",
        targetArticleId: "article-only",
      })
    ).resolves.toEqual({ articleId: "article-only" });
    expect(mocks.tx.handbookArticle.update).not.toHaveBeenCalled();
  });

  it("normalizes tied legacy positions when dragging an article before a sibling", async () => {
    mocks.tx.handbookArticle.findFirst.mockResolvedValue({
      id: "article-c",
      handbookCategoryId: "category-1",
    });
    mocks.tx.handbookArticle.findMany.mockResolvedValue([
      { id: "article-a", position: 0 },
      { id: "article-b", position: 0 },
      { id: "article-c", position: 0 },
    ]);
    await updateHandbookArticleNavigation({
      organizationId: "org-1",
      articleId: "article-c",
      intent: "move-before",
      targetArticleId: "article-b",
    });
    expect(
      mocks.tx.handbookArticle.update.mock.calls.map(([args]) => [
        args.where.id,
        args.data.position,
      ])
    ).toEqual([
      ["article-a", 1],
      ["article-c", 2],
      ["article-b", 3],
    ]);
    expect(mocks.tx.handbookArticle.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: "org-1",
          handbookCategoryId: "category-1",
          status: "PUBLISHED",
          publishedVersion: { isNot: null },
        },
      })
    );
  });

  it("can drag an article after the last sibling", async () => {
    mocks.tx.handbookArticle.findFirst.mockResolvedValue({
      id: "article-a",
      handbookCategoryId: "category-1",
    });
    mocks.tx.handbookArticle.findMany.mockResolvedValue([
      { id: "article-a", position: 1 },
      { id: "article-b", position: 2 },
      { id: "article-c", position: 3 },
    ]);
    await updateHandbookArticleNavigation({
      organizationId: "org-1",
      articleId: "article-a",
      intent: "move-after",
      targetArticleId: "article-c",
    });
    expect(
      mocks.tx.handbookArticle.update.mock.calls.map(([args]) => [
        args.where.id,
        args.data.position,
      ])
    ).toEqual([
      ["article-b", 1],
      ["article-c", 2],
      ["article-a", 3],
    ]);
  });

  it("rejects a drag target outside the source category without writing", async () => {
    mocks.tx.handbookArticle.findMany.mockResolvedValue([
      { id: "article-1", position: 1 },
    ]);
    await expect(
      updateHandbookArticleNavigation({
        organizationId: "org-1",
        articleId: "article-1",
        intent: "move-before",
        targetArticleId: "other-category-article",
      })
    ).rejects.toThrow("same category");
    expect(mocks.tx.handbookArticle.update).not.toHaveBeenCalled();
  });

  it("normalizes capitalization and repeated whitespace to one category identity", async () => {
    expect(normalizeHandbookCategoryName("3D Printing")).toBe(
      normalizeHandbookCategoryName(" 3d   printing ")
    );
    mocks.tx.handbookCategory.findUnique.mockResolvedValue({
      id: "existing-category",
      name: "3D Printing",
      archivedAt: null,
    });

    await expect(
      createHandbookCategory({
        organizationId: "org-1",
        name: " 3d   printing ",
      })
    ).resolves.toEqual({
      id: "existing-category",
      name: "3D Printing",
      alreadyExists: true,
    });

    expect(mocks.tx.handbookCategory.findUnique).toHaveBeenCalledWith({
      where: {
        organizationId_normalizedName: {
          organizationId: "org-1",
          normalizedName: "3d printing",
        },
      },
      select: { id: true, name: true, archivedAt: true },
    });
    expect(mocks.tx.handbookCategory.create).not.toHaveBeenCalled();
  });

  it("loads an empty category list scoped to the current organization", async () => {
    await expect(
      getHandbookEditData({ organizationId: "org-1" })
    ).resolves.toMatchObject({ article: null, categories: [] });

    expect(mocks.handbookCategory.findMany).toHaveBeenCalledWith({
      where: { organizationId: "org-1", archivedAt: null },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      select: { id: true, name: true },
    });
  });

  it("lists Handbook categories and article counts for the active organization", async () => {
    await listHandbookCategoriesForManagement("org-1");

    expect(mocks.handbookCategory.findMany).toHaveBeenCalledWith({
      where: { organizationId: "org-1", archivedAt: null },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      select: {
        id: true,
        name: true,
        _count: { select: { articles: true } },
      },
    });
  });

  it("renames a Handbook category without crossing organization scope", async () => {
    mocks.handbookCategory.findFirst.mockResolvedValue({
      id: "category-1",
      name: "Workshop Safety",
      normalizedName: "workshop safety",
    });
    mocks.handbookCategory.update.mockResolvedValue({
      id: "category-1",
      name: "Lab Safety",
    });

    await expect(
      renameHandbookCategory({
        organizationId: "org-1",
        categoryId: "category-1",
        name: "  Lab   Safety ",
      })
    ).resolves.toMatchObject({ id: "category-1", name: "Lab Safety" });

    expect(mocks.handbookCategory.findFirst).toHaveBeenNthCalledWith(1, {
      where: { id: "category-1", organizationId: "org-1", archivedAt: null },
      select: { id: true, name: true, normalizedName: true },
    });
    expect(mocks.handbookCategory.update).toHaveBeenCalledWith({
      where: { id: "category-1", organizationId: "org-1" },
      data: { name: "Lab Safety", normalizedName: "lab safety" },
      select: { id: true, name: true },
    });
    expect(mocks.handbookArticle.update).not.toHaveBeenCalled();
    expect(mocks.handbookArticle.updateMany).not.toHaveBeenCalled();
  });

  it("updates display capitalization when the normalized category name is unchanged", async () => {
    mocks.handbookCategory.findFirst.mockResolvedValue({
      id: "category-1",
      name: "3d printing",
      normalizedName: "3d printing",
    });
    mocks.handbookCategory.update.mockResolvedValue({
      id: "category-1",
      name: "3D Printing",
    });

    await expect(
      renameHandbookCategory({
        organizationId: "org-1",
        categoryId: "category-1",
        name: "  3D   Printing ",
      })
    ).resolves.toMatchObject({
      id: "category-1",
      name: "3D Printing",
      unchanged: false,
    });
    expect(mocks.handbookCategory.update).toHaveBeenCalledWith({
      where: { id: "category-1", organizationId: "org-1" },
      data: { name: "3D Printing" },
      select: { id: true, name: true },
    });
    expect(mocks.handbookArticle.update).not.toHaveBeenCalled();
  });

  it("rejects a rename that duplicates another normalized Handbook category", async () => {
    mocks.handbookCategory.findFirst
      .mockResolvedValueOnce({
        id: "category-1",
        name: "Electronics",
        normalizedName: "electronics",
      })
      .mockResolvedValueOnce({ id: "category-2", name: "Workshop Safety" });

    await expect(
      renameHandbookCategory({
        organizationId: "org-1",
        categoryId: "category-1",
        name: " WORKSHOP   SAFETY ",
      })
    ).rejects.toThrow('A category named "Workshop Safety" already exists.');
    expect(mocks.handbookCategory.update).not.toHaveBeenCalled();
  });

  it("scopes My Work drafts to the current user and organization", async () => {
    mocks.handbookArticle.findMany.mockResolvedValue([]);

    await listMyHandbookDrafts({
      organizationId: "org-1",
      userId: "student-1",
    });

    expect(mocks.handbookArticle.findMany).toHaveBeenNthCalledWith(1, {
      where: {
        organizationId: "org-1",
        createdByUserId: "student-1",
        status: "DRAFT",
      },
      orderBy: [{ updatedAt: "desc" }, { slug: "asc" }],
      take: 200,
      select: {
        id: true,
        slug: true,
        draftTitle: true,
        updatedAt: true,
        handbookCategory: { select: { id: true, name: true } },
        observations: {
          where: { status: "PENDING_REVIEW", publishedVersionId: null },
          take: 1,
          select: { id: true },
        },
      },
    });
    expect(mocks.handbookArticle.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: "org-1",
          updatedByUserId: "student-1",
          status: "PUBLISHED",
        }),
      })
    );
    expect(mocks.handbookObservation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: "org-1",
          contributorUserId: "student-1",
          publishedVersionId: { not: null },
        }),
      })
    );
  });

  it("deletes only an unpublished, unsubmitted draft owned by the requesting user", async () => {
    mocks.tx.handbookArticle.findFirst.mockResolvedValue({
      id: "article-1",
      status: "DRAFT",
      publishedVersionId: null,
      _count: { versions: 0 },
      observations: [],
    });
    mocks.tx.handbookArticle.deleteMany.mockResolvedValue({ count: 1 });

    await expect(
      deleteHandbookDraft({
        organizationId: "org-1",
        articleId: "article-1",
        userId: "student-1",
      })
    ).resolves.toEqual({ id: "article-1" });

    expect(mocks.tx.handbookArticle.findFirst).toHaveBeenCalledWith({
      where: {
        id: "article-1",
        organizationId: "org-1",
        createdByUserId: "student-1",
      },
      select: {
        id: true,
        status: true,
        publishedVersionId: true,
        _count: { select: { versions: true } },
        observations: {
          where: { status: "PENDING_REVIEW" },
          take: 1,
          select: { id: true },
        },
      },
    });
    expect(mocks.tx.handbookArticle.deleteMany).toHaveBeenCalledWith({
      where: {
        id: "article-1",
        organizationId: "org-1",
        createdByUserId: "student-1",
        status: "DRAFT",
        publishedVersionId: null,
        versions: { none: {} },
        observations: { none: { status: "PENDING_REVIEW" } },
      },
    });
  });

  it("discards a saved revision by restoring current content without deleting history", async () => {
    mocks.tx.handbookArticle.findFirst.mockResolvedValue({
      id: "article-1",
      updatedByUserId: "student-1",
      publishedVersionId: "version-2",
      draftTitle: "Improved title",
      draftContent: "Improved steps.",
      publishedVersion: {
        id: "version-2",
        title: "Current title",
        content: "Current steps.",
        publishedByUserId: "staff-1",
        sources: [{ source: { url: "https://example.com/current" } }],
      },
      observations: [],
    });
    mocks.tx.handbookArticle.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      discardHandbookArticleRevisionDraft({
        organizationId: "org-1",
        articleId: "article-1",
        userId: "student-1",
      })
    ).resolves.toEqual({ id: "article-1" });

    expect(mocks.tx.handbookArticle.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          draftTitle: "Current title",
          draftContent: "Current steps.",
          draftSourceUrls: ["https://example.com/current"],
          updatedByUserId: "staff-1",
        }),
      })
    );
    expect(mocks.tx.handbookArticle.deleteMany).not.toHaveBeenCalled();
  });

  it("does not allow a user to delete another user's draft", async () => {
    mocks.tx.handbookArticle.findFirst.mockResolvedValue(null);

    await expect(
      deleteHandbookDraft({
        organizationId: "org-1",
        articleId: "article-2",
        userId: "student-1",
      })
    ).rejects.toThrow("could not be found or you do not have permission");

    expect(mocks.tx.handbookArticle.deleteMany).not.toHaveBeenCalled();
  });

  it("leaves drafts already submitted for review unchanged", async () => {
    mocks.tx.handbookArticle.findFirst.mockResolvedValue({
      id: "article-1",
      status: "DRAFT",
      publishedVersionId: null,
      _count: { versions: 0 },
      observations: [{ id: "observation-1" }],
    });

    await expect(
      deleteHandbookDraft({
        organizationId: "org-1",
        articleId: "article-1",
        userId: "student-1",
      })
    ).rejects.toThrow("submitted for Staff review and cannot be deleted");

    expect(mocks.tx.handbookArticle.deleteMany).not.toHaveBeenCalled();
  });

  it("does not hard-delete published articles or their version history", async () => {
    mocks.tx.handbookArticle.findFirst.mockResolvedValue({
      id: "article-1",
      status: "PUBLISHED",
      publishedVersionId: "version-1",
      _count: { versions: 1 },
      observations: [],
    });

    await expect(
      deleteHandbookDraft({
        organizationId: "org-1",
        articleId: "article-1",
        userId: "staff-1",
        canManageAnyDraft: true,
      })
    ).rejects.toThrow("Only unpublished Handbook drafts");

    expect(mocks.tx.handbookArticle.deleteMany).not.toHaveBeenCalled();
  });

  it("allows a Staff manager to delete another user's true draft", async () => {
    mocks.tx.handbookArticle.findFirst.mockResolvedValue({
      id: "article-2",
      status: "DRAFT",
      publishedVersionId: null,
      _count: { versions: 0 },
      observations: [],
    });
    mocks.tx.handbookArticle.deleteMany.mockResolvedValue({ count: 1 });

    await expect(
      deleteHandbookDraft({
        organizationId: "org-1",
        articleId: "article-2",
        userId: "staff-1",
        canManageAnyDraft: true,
      })
    ).resolves.toEqual({ id: "article-2" });

    expect(mocks.tx.handbookArticle.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "article-2", organizationId: "org-1" },
      })
    );
  });

  it("submits an owned draft for review without publishing it", async () => {
    mocks.handbookArticle.findFirst.mockResolvedValue({
      id: "article-1",
      draftTitle: "Test Handbook Draft",
      handbookCategoryId: "handbook-category-1",
    });
    mocks.handbookObservation.findFirst.mockResolvedValue(null);
    mocks.tx.handbookObservation.create.mockResolvedValue({
      id: "observation-1",
    });

    await expect(
      submitHandbookDraftForReview({
        organizationId: "org-1",
        userId: "student-1",
        articleId: "article-1",
      })
    ).resolves.toEqual({ id: "observation-1", alreadyPending: false });

    expect(mocks.handbookArticle.findFirst).toHaveBeenCalledWith({
      where: {
        id: "article-1",
        organizationId: "org-1",
        createdByUserId: "student-1",
        status: "DRAFT",
      },
      select: {
        id: true,
        draftTitle: true,
        handbookCategoryId: true,
      },
    });
    expect(mocks.tx.handbookObservation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        articleId: "article-1",
        handbookCategoryId: "handbook-category-1",
      }),
      select: { id: true },
    });
    expect(mocks.tx.handbookArticleVersion.create).not.toHaveBeenCalled();
  });

  it("stores a Student's proposed category with the linked pending draft", async () => {
    mocks.handbookArticle.findFirst.mockResolvedValue({
      id: "article-1",
      draftTitle: "Student Draft",
      handbookCategoryId: null,
    });
    mocks.handbookCategory.findFirst.mockResolvedValue(null);
    mocks.handbookObservation.findFirst.mockResolvedValue(null);
    mocks.tx.handbookObservation.create.mockResolvedValue({
      id: "observation-1",
    });

    await submitHandbookDraftForReview({
      organizationId: "org-1",
      userId: "student-1",
      articleId: "article-1",
      proposedCategoryName: "  Workshop   Safety ",
    });

    expect(mocks.tx.handbookObservation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        articleId: "article-1",
        handbookCategoryId: null,
        proposedCategoryName: "Workshop Safety",
      }),
      select: { id: true },
    });
    expect(mocks.tx.handbookCategory.create).not.toHaveBeenCalled();
  });

  it("saves an article with a canonical Handbook category and no Asset category lookup", async () => {
    mocks.handbookArticle.findMany.mockResolvedValue([]);
    mocks.handbookArticle.create.mockResolvedValue({
      id: "article-1",
      slug: "soldering-basics",
      status: "DRAFT",
    });

    await expect(
      saveHandbookDraft({
        organizationId: "org-1",
        userId: "staff-1",
        title: "Soldering Basics",
        handbookCategoryId: "handbook-category-1",
        content: "Basic soldering guide.",
        sourceUrls: [],
      })
    ).resolves.toMatchObject({ slug: "soldering-basics" });

    expect(mocks.handbookCategory.findFirst).toHaveBeenCalledWith({
      where: {
        id: "handbook-category-1",
        organizationId: "org-1",
        archivedAt: null,
      },
      select: { id: true },
    });
    expect(mocks.handbookArticle.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        handbookCategoryId: "handbook-category-1",
        draftTitle: "Soldering Basics",
        draftContent: "Basic soldering guide.",
      }),
      select: { id: true, slug: true, status: true },
    });
  });

  it("updates the same Student-owned draft when saving an edit", async () => {
    mocks.handbookArticle.findFirst.mockResolvedValue({
      id: "article-1",
      slug: "test-handbook-draft",
    });
    mocks.handbookArticle.update.mockResolvedValue({
      id: "article-1",
      slug: "test-handbook-draft",
      status: "DRAFT",
    });

    await expect(
      saveHandbookDraft({
        organizationId: "org-1",
        userId: "student-1",
        articleId: "article-1",
        ownerUserId: "student-1",
        title: "Test Handbook Draft Updated",
        handbookCategoryId: "handbook-category-1",
        content: "This is a draft editing test.",
        sourceUrls: ["https://example.com"],
      })
    ).resolves.toMatchObject({ slug: "test-handbook-draft" });

    expect(mocks.handbookArticle.findFirst).toHaveBeenCalledWith({
      where: {
        id: "article-1",
        organizationId: "org-1",
        createdByUserId: "student-1",
        status: "DRAFT",
      },
      select: { id: true, slug: true },
    });
    expect(mocks.handbookArticle.update).toHaveBeenCalledWith({
      where: {
        id: "article-1",
        organizationId: "org-1",
        createdByUserId: "student-1",
        status: "DRAFT",
      },
      data: expect.objectContaining({
        draftTitle: "Test Handbook Draft Updated",
        draftContent: "This is a draft editing test.",
        draftSourceUrls: ["https://example.com/"],
      }),
      select: { id: true, slug: true, status: true },
    });
  });

  it("saves a revision on the same published article without changing its live category", async () => {
    mocks.handbookArticle.findFirst.mockResolvedValue({
      id: "article-1",
      slug: "change-filament",
      draftTitle: "How to change filament",
      draftContent: "Current approved steps.",
      draftSourceUrls: [],
      updatedByUserId: "staff-1",
      publishedVersion: {
        title: "How to change filament",
        content: "Current approved steps.",
        sources: [],
      },
      observations: [],
    });
    mocks.handbookArticle.updateMany.mockResolvedValue({ count: 1 });

    await saveHandbookDraft({
      organizationId: "org-1",
      userId: "student-1",
      articleId: "article-1",
      revisionMode: true,
      revisionBaseVersionId: "version-2",
      revisionOwnerUserId: "student-1",
      title: "How to change filament",
      handbookCategoryId: "handbook-category-1",
      content: "Improved steps.",
      sourceUrls: ["https://example.com/guide"],
    });

    expect(mocks.handbookArticle.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "article-1",
          organizationId: "org-1",
          status: "PUBLISHED",
          publishedVersionId: "version-2",
          updatedByUserId: "staff-1",
        },
        data: expect.objectContaining({
          draftTitle: "How to change filament",
          draftContent: "Improved steps.",
          updatedByUserId: "student-1",
        }),
      })
    );
    expect(
      mocks.handbookArticle.updateMany.mock.calls[0]?.[0].data
    ).not.toHaveProperty("handbookCategoryId");
  });

  it("submits a proposed improvement against its base version and leaves the current version live", async () => {
    mocks.handbookArticle.findFirst.mockResolvedValue({
      id: "article-1",
      draftTitle: "How to change filament",
      handbookCategoryId: "handbook-category-1",
      publishedVersionId: "version-2",
      draftContent: "Improved steps.",
      draftSourceUrls: [],
      publishedVersion: {
        versionNumber: 2,
        title: "How to change filament",
        content: "Current steps.",
        sources: [],
      },
    });
    mocks.handbookObservation.findFirst.mockResolvedValue(null);
    mocks.tx.handbookObservation.create.mockResolvedValue({
      id: "observation-revision-1",
    });

    await submitHandbookDraftForReview({
      organizationId: "org-1",
      userId: "student-1",
      articleId: "article-1",
      revisionMode: true,
      revisionBaseVersionId: "version-2",
      handbookCategoryId: "handbook-category-1",
    });

    expect(mocks.tx.handbookObservation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        articleId: "article-1",
        handbookCategoryId: "handbook-category-1",
        publishedVersionId: "version-2",
      }),
      select: { id: true },
    });
    expect(mocks.tx.handbookArticle.update).not.toHaveBeenCalled();
    expect(mocks.tx.handbookArticleVersion.create).not.toHaveBeenCalled();
  });

  it("approves a pending improvement by publishing the next version transactionally", async () => {
    mocks.tx.handbookObservation.findFirst.mockResolvedValue({
      id: "observation-revision-1",
      articleId: "article-1",
      contributorUserId: "student-1",
      publishedVersionId: "version-2",
      handbookCategoryId: "handbook-category-1",
      proposedCategoryName: null,
    });
    mocks.tx.handbookArticle.findFirst.mockResolvedValue({
      id: "article-1",
      slug: "change-filament",
      status: "PUBLISHED",
      publishedVersionId: "version-2",
      handbookCategoryId: "handbook-category-1",
      draftTitle: "How to change filament",
      draftContent: "Improved steps.",
      draftSourceUrls: [],
    });
    mocks.tx.handbookArticleVersion.aggregate.mockResolvedValue({
      _max: { versionNumber: 2 },
    });
    mocks.tx.handbookArticle.aggregate.mockResolvedValue({
      _max: { position: 1 },
    });
    mocks.tx.handbookArticleVersion.create.mockResolvedValue({
      id: "version-3",
      versionNumber: 3,
    });

    await expect(
      approveHandbookArticleRevision({
        organizationId: "org-1",
        userId: "staff-1",
        observationId: "observation-revision-1",
      })
    ).resolves.toMatchObject({ versionNumber: 3, slug: "change-filament" });

    expect(mocks.tx.handbookArticleVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        articleId: "article-1",
        versionNumber: 3,
        content: "Improved steps.",
      }),
    });
    expect(mocks.tx.handbookObservation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "observation-revision-1",
          publishedVersionId: "version-2",
        }),
        data: expect.objectContaining({ status: "REVIEWED" }),
      })
    );
  });

  it("publishes a student's existing pending new-article draft and closes its review record", async () => {
    mocks.tx.handbookObservation.findFirst.mockResolvedValue({
      id: "submission-1",
      articleId: "article-1",
      contributorUserId: "student-1",
      proposedCategoryName: null,
    });
    mocks.tx.handbookArticle.findFirst
      .mockResolvedValueOnce({ id: "article-1" })
      .mockResolvedValueOnce({
        id: "article-1",
        organizationId: "org-1",
        slug: "change-filament",
        status: "DRAFT",
        position: 0,
        handbookCategoryId: "handbook-category-1",
        draftTitle: "How to change filament",
        draftContent: "Turn off the printer first.",
        draftSourceUrls: [],
      });
    mocks.tx.handbookArticle.aggregate.mockResolvedValue({
      _max: { position: 0 },
    });
    mocks.tx.handbookArticleVersion.aggregate.mockResolvedValue({
      _max: { versionNumber: 0 },
    });
    mocks.tx.handbookArticleVersion.create.mockResolvedValue({
      id: "version-1",
      versionNumber: 1,
    });
    mocks.tx.handbookObservation.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      approveHandbookNewArticleSubmission({
        organizationId: "org-1",
        userId: "staff-1",
        observationId: "submission-1",
      })
    ).resolves.toMatchObject({ slug: "change-filament", versionNumber: 1 });

    expect(mocks.tx.handbookArticleVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        articleId: "article-1",
        title: "How to change filament",
        content: "Turn off the printer first.",
      }),
    });
    expect(mocks.tx.handbookObservation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "submission-1" }),
        data: expect.objectContaining({ status: "REVIEWED" }),
      })
    );
  });

  it("does not place a staff-authored draft in the student approval flow", async () => {
    mocks.tx.handbookObservation.findFirst.mockResolvedValue({
      id: "submission-1",
      articleId: "article-1",
      contributorUserId: "staff-1",
      proposedCategoryName: null,
    });
    mocks.tx.userOrganization.findFirst.mockResolvedValue({ roles: ["ADMIN"] });

    await expect(
      approveHandbookNewArticleSubmission({
        organizationId: "org-1",
        userId: "staff-1",
        observationId: "submission-1",
      })
    ).rejects.toThrow("Only student article submissions require staff review.");
    expect(mocks.tx.handbookArticleVersion.create).not.toHaveBeenCalled();
  });

  it("rejects a pending revision by restoring the current published draft snapshot", async () => {
    mocks.tx.handbookObservation.findFirst.mockResolvedValue({
      id: "observation-revision-1",
      articleId: "article-1",
      contributorUserId: "student-1",
      publishedVersionId: "version-2",
    });
    mocks.tx.handbookArticle.findFirst.mockResolvedValue({
      id: "article-1",
      publishedVersionId: "version-2",
      publishedVersion: {
        title: "How to change filament",
        content: "Current steps.",
        publishedByUserId: "staff-1",
        sources: [],
      },
    });

    await expect(
      rejectHandbookArticleRevision({
        organizationId: "org-1",
        userId: "staff-1",
        observationId: "observation-revision-1",
      })
    ).resolves.toEqual({ articleId: "article-1" });

    expect(mocks.tx.handbookArticle.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          draftTitle: "How to change filament",
          draftContent: "Current steps.",
          updatedByUserId: "staff-1",
        }),
      })
    );
    expect(mocks.tx.handbookObservation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "DISMISSED" }),
      })
    );
    expect(mocks.tx.handbookArticleVersion.create).not.toHaveBeenCalled();
  });

  it("rejects a category outside the active organization", async () => {
    mocks.handbookCategory.findFirst.mockResolvedValue(null);

    await expect(
      saveHandbookDraft({
        organizationId: "org-1",
        userId: "staff-1",
        title: "Soldering Basics",
        handbookCategoryId: "category-other-org",
        content: "Basic soldering guide.",
        sourceUrls: [],
      })
    ).rejects.toThrow("Choose a category from this Handbook workspace.");
    expect(mocks.handbookArticle.create).not.toHaveBeenCalled();
  });

  it("lets a student submit a pending contribution with a proposed category", async () => {
    mocks.handbookCategory.findFirst.mockResolvedValue(null);

    await expect(
      submitHandbookObservation({
        organizationId: "org-1",
        userId: "student-1",
        title: "Safety note",
        content: "Always wear eye protection while soldering.",
        proposedCategoryName: "  Workshop   Safety ",
      })
    ).resolves.toMatchObject({ duplicate: false });

    expect(mocks.handbookCategory.findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: "org-1",
        archivedAt: null,
        normalizedName: "workshop safety",
      },
      select: { id: true },
    });
    expect(mocks.tx.handbookObservation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        handbookCategoryId: null,
        proposedCategoryName: "Workshop Safety",
      }),
      select: { id: true, title: true },
    });
    expect(mocks.tx.handbookCategory.create).not.toHaveBeenCalled();
  });

  it("keeps the existing category-free Ask IOIO observation path available", async () => {
    await submitHandbookObservation({
      organizationId: "org-1",
      userId: "student-1",
      title: "Observation from Ask IOIO",
      content: "This contribution came from the existing assistant flow.",
    });

    expect(mocks.tx.handbookObservation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        handbookCategoryId: null,
        proposedCategoryName: null,
      }),
      select: { id: true, title: true },
    });
  });

  it("resolves a student proposal to an existing category with normalized matching", async () => {
    mocks.handbookCategory.findFirst.mockResolvedValue({
      id: "existing-category",
    });

    await submitHandbookObservation({
      organizationId: "org-1",
      userId: "student-1",
      title: "Safety note",
      content: "Use eye protection for soldering work.",
      proposedCategoryName: " WORKSHOP safety ",
    });

    expect(mocks.tx.handbookObservation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        handbookCategoryId: "existing-category",
        proposedCategoryName: null,
      }),
      select: { id: true, title: true },
    });
    expect(mocks.tx.handbookCategory.create).not.toHaveBeenCalled();
  });

  it("publishes using the Handbook category relation", async () => {
    await expect(
      publishHandbookArticle({
        organizationId: "org-1",
        userId: "staff-1",
        articleId: "article-1",
      })
    ).resolves.toMatchObject({ articleId: "article-1", versionNumber: 1 });

    expect(mocks.tx.handbookCategory.findFirst).toHaveBeenCalledWith({
      where: {
        id: "handbook-category-1",
        organizationId: "org-1",
        archivedAt: null,
      },
      select: { id: true },
    });
    expect(mocks.tx.handbookArticleVersion.create).toHaveBeenCalled();
  });

  it.each([0, 7])(
    "keeps published position %s when publishing a new version",
    async (position) => {
      mocks.tx.handbookArticle.findFirst.mockResolvedValue({
        id: "article-1",
        organizationId: "org-1",
        slug: "change-filament",
        status: "PUBLISHED",
        position,
        isStartHere: false,
        handbookCategoryId: "handbook-category-1",
        draftTitle: "How to change filament",
        draftContent: "Updated steps.",
        draftSourceUrls: [],
      });

      await publishHandbookArticle({
        organizationId: "org-1",
        userId: "staff-1",
        articleId: "article-1",
      });

      expect(mocks.tx.handbookArticle.aggregate).not.toHaveBeenCalled();
      expect(mocks.tx.handbookArticle.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.not.objectContaining({ position: expect.anything() }),
        })
      );
    }
  );

  it("lets Staff approve and rename a proposal as a canonical Handbook category", async () => {
    await expect(
      resolveHandbookObservationCategoryProposal({
        organizationId: "org-1",
        observationId: "observation-1",
        resolution: "approve",
        categoryName: "Electronics Knowledge",
      })
    ).resolves.toMatchObject({
      resolution: "approve",
      handbookCategoryId: "handbook-category-1",
    });

    expect(mocks.tx.handbookCategory.create).toHaveBeenCalledWith({
      data: {
        organizationId: "org-1",
        name: "Electronics Knowledge",
        slug: "electronics-knowledge",
        normalizedName: "electronics knowledge",
      },
      select: { id: true, name: true },
    });
    expect(mocks.tx.handbookObservation.updateMany).toHaveBeenCalledWith({
      where: {
        id: "observation-1",
        organizationId: "org-1",
        status: "PENDING_REVIEW",
      },
      data: {
        handbookCategoryId: "handbook-category-1",
        proposedCategoryName: null,
      },
    });
    expect(mocks.tx.handbookArticle.updateMany).toHaveBeenCalledWith({
      where: { id: "article-1", organizationId: "org-1" },
      data: { handbookCategoryId: "handbook-category-1" },
    });
  });

  it("lets Staff replace or reject a proposal without creating an Asset category", async () => {
    await resolveHandbookObservationCategoryProposal({
      organizationId: "org-1",
      observationId: "observation-1",
      resolution: "replace",
      handbookCategoryId: "handbook-category-1",
    });
    expect(mocks.handbookCategory.findFirst).toHaveBeenCalledWith({
      where: {
        id: "handbook-category-1",
        organizationId: "org-1",
        archivedAt: null,
      },
      select: { id: true },
    });

    mocks.handbookObservation.updateMany.mockClear();
    await resolveHandbookObservationCategoryProposal({
      organizationId: "org-1",
      observationId: "observation-1",
      resolution: "reject",
    });
    expect(mocks.handbookObservation.updateMany).toHaveBeenCalledWith({
      where: {
        id: "observation-1",
        organizationId: "org-1",
        status: "PENDING_REVIEW",
      },
      data: { proposedCategoryName: null, handbookCategoryId: null },
    });
    expect(mocks.tx.handbookCategory.create).not.toHaveBeenCalled();
  });
});

// why: database calls use the suite's shared mock to verify the readable query boundary without a live database.
describe("related Handbook navigation", () => {
  it("bounds category navigation, excludes the current article, and selects only the canonical publication", async () => {
    mocks.handbookArticle.findMany.mockResolvedValue(
      Array.from({ length: 8 }, (_, index) => ({
        id: `article-${index}`,
        slug: `article-${index}`,
        publishedVersion: { title: `Article ${index}` },
      }))
    );
    const result = await listRelatedHandbookArticles({
      organizationId: "org-1",
      handbookCategoryId: "printing",
      articleId: "current",
    });
    expect(mocks.handbookArticle.findMany).toHaveBeenLastCalledWith({
      where: {
        organizationId: "org-1",
        handbookCategoryId: "printing",
        id: { not: "current" },
        status: "PUBLISHED",
        publishedVersion: { isNot: null },
      },
      orderBy: [{ position: "asc" }, { slug: "asc" }],
      take: 8,
      select: {
        id: true,
        slug: true,
        publishedVersion: { select: { title: true } },
      },
    });
    expect(result.articles.map(({ id }) => id)).toEqual(
      Array.from({ length: 7 }, (_, index) => `article-${index}`)
    );
    expect(result.hasMore).toBe(true);
  });
  it("returns no related navigation for an empty category", async () => {
    mocks.handbookArticle.findMany.mockResolvedValue([]);
    expect(
      await listRelatedHandbookArticles({
        organizationId: "org-1",
        handbookCategoryId: "printing",
        articleId: "current",
      })
    ).toEqual({ articles: [], hasMore: false });
  });
});

describe("Handbook article link targets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists only current published articles with their category labels", async () => {
    mocks.handbookArticle.findMany.mockResolvedValue([
      {
        id: "article-1",
        slug: "how-to-change-filament",
        handbookCategoryId: "category-3d",
        publishedVersionId: "version-1",
        handbookCategory: { name: "3D Printing" },
        publishedVersion: { title: "How to change filament" },
      },
    ]);

    await expect(
      listHandbookArticleTitles({ organizationId: "org-1" })
    ).resolves.toEqual([
      {
        id: "article-1",
        slug: "how-to-change-filament",
        title: "How to change filament",
        handbookCategoryId: "category-3d",
        publishedVersionId: "version-1",
        categoryName: "3D Printing",
      },
    ]);
    expect(mocks.handbookArticle.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: "org-1",
          status: "PUBLISHED",
          publishedVersion: { is: {} },
        },
      })
    );
    expect(
      mocks.handbookArticle.findMany.mock.calls.at(-1)?.[0]
    ).not.toHaveProperty("take");
  });
});

// why: the shared database mock verifies guarded mutations without deleting real knowledge.
describe("Handbook removal safety", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handbookArticle.updateMany.mockResolvedValue({ count: 1 });
    mocks.handbookObservation.updateMany.mockResolvedValue({ count: 1 });
  });

  it("requires staff capability before archiving", async () => {
    await expect(
      archiveHandbookArticle({
        organizationId: "org-1",
        articleId: "article-1",
        userId: "student-1",
      })
    ).rejects.toThrow("Only Staff");
    expect(mocks.handbookArticle.updateMany).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "changes only article visibility on archive/restore (restore=%s)",
    async (restore) => {
      await archiveHandbookArticle({
        organizationId: "org-1",
        articleId: "article-1",
        userId: "staff-1",
        canManageArticles: true,
        restore,
      });
      expect(mocks.handbookArticle.updateMany).toHaveBeenCalledWith({
        where: {
          id: "article-1",
          organizationId: "org-1",
          status: restore ? "ARCHIVED" : "PUBLISHED",
          publishedVersionId: { not: null },
        },
        data: {
          status: restore ? "PUBLISHED" : "ARCHIVED",
        },
      });
      expect(mocks.tx.handbookArticle.deleteMany).not.toHaveBeenCalled();
      expect(mocks.tx.handbookArticleVersion.create).not.toHaveBeenCalled();
    }
  );

  it("rejects wrong-state or outside-workspace archive requests", async () => {
    mocks.handbookArticle.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      archiveHandbookArticle({
        organizationId: "org-1",
        articleId: "other-article",
        userId: "staff-1",
        canManageArticles: true,
      })
    ).rejects.toThrow("no longer available");
  });

  it.each(["ARCHIVED", "PUBLISHED"] as const)(
    "permanently deletes %s history and article-only records atomically",
    async (status) => {
      mocks.tx.handbookArticle.findFirst.mockResolvedValue({
        id: "article-1",
        slug: "old-test-article",
        status,
        handbookCategoryId: "category-1",
        publishedVersionId: "version-2",
        publishedVersion: { title: "Old test article" },
        versions: [
          {
            sources: [
              { sourceId: "exclusive-source" },
              { sourceId: "shared-source" },
            ],
          },
          { sources: [] },
        ],
        observations: [
          {
            id: "article-review",
            assetModelId: null,
            kitId: null,
            conversationId: null,
            messageId: null,
          },
          {
            id: "asset-linked-review",
            assetModelId: "asset-1",
            kitId: null,
            conversationId: null,
            messageId: null,
          },
        ],
      });
      mocks.tx.handbookArticle.deleteMany.mockResolvedValue({ count: 1 });
      mocks.tx.handbookArticle.findMany.mockResolvedValue([
        { id: "article-2", position: 1 },
        { id: "article-3", position: 4 },
      ]);

      await expect(
        deleteHandbookArticlePermanently({
          organizationId: "org-1",
          articleId: "article-1",
          userId: "staff-1",
          canManageArticles: true,
          confirmationTitle: "Old test article",
        })
      ).resolves.toEqual({
        id: "article-1",
        slug: "old-test-article",
        title: "Old test article",
      });

      expect(mocks.tx.handbookArticle.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: "article-1",
            organizationId: "org-1",
            status: { in: ["PUBLISHED", "ARCHIVED"] },
            publishedVersionId: { not: null },
          },
        })
      );
      expect(mocks.tx.handbookObservation.deleteMany).toHaveBeenCalledWith({
        where: {
          organizationId: "org-1",
          articleId: "article-1",
          id: { in: ["article-review"] },
        },
      });
      expect(mocks.tx.handbookObservation.updateMany).toHaveBeenCalledWith({
        where: {
          organizationId: "org-1",
          articleId: "article-1",
          id: { in: ["asset-linked-review"] },
        },
        data: { articleId: null },
      });
      expect(mocks.tx.handbookArticle.deleteMany).toHaveBeenCalledWith({
        where: {
          id: "article-1",
          organizationId: "org-1",
          status,
          publishedVersionId: "version-2",
        },
      });
      expect(mocks.tx.handbookSource.deleteMany).toHaveBeenCalledWith({
        where: {
          organizationId: "org-1",
          id: { in: ["exclusive-source", "shared-source"] },
          storageObjectPath: null,
          versions: { none: {} },
        },
      });
      expect(mocks.tx.handbookArticle.updateMany).toHaveBeenCalledWith({
        where: {
          id: "article-3",
          organizationId: "org-1",
          status: "PUBLISHED",
        },
        data: { position: 2 },
      });
      expect(mocks.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "IOIO_HANDBOOK_ARTICLE_DELETED",
          organizationId: "org-1",
          actorUserId: "staff-1",
          entityType: "HANDBOOK_ARTICLE",
          entityId: "article-1",
          meta: { slug: "old-test-article", title: "Old test article" },
        }),
        mocks.tx
      );
    }
  );

  it("requires staff permission, published or archived state, and the exact article title", async () => {
    await expect(
      deleteHandbookArticlePermanently({
        organizationId: "org-1",
        articleId: "article-1",
        userId: "student-1",
        confirmationTitle: "Old test article",
      })
    ).rejects.toThrow("Only Staff");
    expect(mocks.tx.handbookArticle.findFirst).not.toHaveBeenCalled();

    mocks.tx.handbookArticle.findFirst.mockResolvedValue({
      id: "article-1",
      slug: "old-test-article",
      status: "PUBLISHED",
      handbookCategoryId: "category-1",
      publishedVersion: { title: "Old test article" },
      versions: [],
      observations: [],
    });
    await expect(
      deleteHandbookArticlePermanently({
        organizationId: "org-1",
        articleId: "article-1",
        userId: "staff-1",
        canManageArticles: true,
        confirmationTitle: "Wrong title",
      })
    ).rejects.toThrow("exactly");
    expect(mocks.tx.handbookArticle.deleteMany).not.toHaveBeenCalled();

    mocks.tx.handbookArticle.findFirst.mockResolvedValue(null);
    await expect(
      deleteHandbookArticlePermanently({
        organizationId: "org-1",
        articleId: "published-article",
        userId: "staff-1",
        canManageArticles: true,
        confirmationTitle: "Some title",
      })
    ).rejects.toThrow("published or archived articles");
    expect(mocks.tx.handbookArticle.deleteMany).not.toHaveBeenCalled();
  });

  it("withdraws an owned pending submission without altering its draft or versions", async () => {
    await withdrawHandbookSubmission({
      organizationId: "org-1",
      observationId: "submission-1",
      userId: "student-1",
    });
    expect(mocks.handbookObservation.updateMany).toHaveBeenCalledWith({
      where: {
        id: "submission-1",
        organizationId: "org-1",
        status: "PENDING_REVIEW",
        contributorUserId: "student-1",
      },
      data: {
        status: "DISMISSED",
        reviewedByUserId: "student-1",
        reviewedAt: expect.any(Date),
      },
    });
    expect(mocks.handbookArticle.updateMany).not.toHaveBeenCalled();
    expect(mocks.tx.handbookArticle.deleteMany).not.toHaveBeenCalled();
    expect(mocks.tx.handbookArticleVersion.create).not.toHaveBeenCalled();
  });

  it("rejects another contributor's or already-reviewed submission", async () => {
    mocks.handbookObservation.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      withdrawHandbookSubmission({
        organizationId: "org-1",
        observationId: "other-submission",
        userId: "student-1",
      })
    ).rejects.toThrow("permission");
  });

  it.each([
    {
      status: "PUBLISHED",
      publishedVersionId: "v1",
      _count: { versions: 1 },
      observations: [],
    },
    {
      status: "ARCHIVED",
      publishedVersionId: "v1",
      _count: { versions: 1 },
      observations: [],
    },
    {
      status: "DRAFT",
      publishedVersionId: null,
      _count: { versions: 1 },
      observations: [],
    },
    {
      status: "DRAFT",
      publishedVersionId: null,
      _count: { versions: 0 },
      observations: [{ id: "pending" }],
    },
  ])(
    "refuses draft deletion when state/history is protected: %j",
    async (article) => {
      mocks.tx.handbookArticle.findFirst.mockResolvedValue({
        id: "article-1",
        ...article,
      });
      await expect(
        deleteHandbookDraft({
          organizationId: "org-1",
          articleId: "article-1",
          userId: "student-1",
        })
      ).rejects.toThrow();
      expect(mocks.tx.handbookArticle.deleteMany).not.toHaveBeenCalled();
    }
  );

  it("refuses deletion when ownership or organization does not match", async () => {
    mocks.tx.handbookArticle.findFirst.mockResolvedValue(null);
    await expect(
      deleteHandbookDraft({
        organizationId: "org-1",
        articleId: "other-draft",
        userId: "student-1",
      })
    ).rejects.toThrow("permission");
    expect(mocks.tx.handbookArticle.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "other-draft",
          organizationId: "org-1",
          createdByUserId: "student-1",
        },
      })
    );
    expect(mocks.tx.handbookArticle.deleteMany).not.toHaveBeenCalled();
  });
});
