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
    handbookSource: { upsert: vi.fn() },
    handbookVersionSource: { createMany: vi.fn() },
    handbookObservation: {
      create: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
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
  recordEvent: vi.fn(),
}));

vi.mock("~/database/db.server", () => ({
  db: {
    $transaction: (callback: (tx: typeof mocks.tx) => unknown) =>
      callback(mocks.tx),
    handbookCategory: mocks.handbookCategory,
    handbookArticle: mocks.handbookArticle,
    handbookObservation: mocks.handbookObservation,
  },
}));
vi.mock("~/modules/activity-event/service.server", () => ({
  recordEvent: mocks.recordEvent,
}));

import {
  approveHandbookArticleRevision,
  createHandbookCategory,
  createHandbookImportDrafts,
  discardHandbookArticleRevisionDraft,
  deleteHandbookDraft,
  getHandbookEditData,
  listPublishedHandbookArticles,
  listMyHandbookDrafts,
  listHandbookCategoriesForManagement,
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
    mocks.tx.handbookSource.upsert.mockResolvedValue({ id: "source-1" });
    mocks.tx.handbookObservation.create.mockResolvedValue({
      id: "observation-1",
      title: "Safety note",
    });
  });

  it("orders Handbook articles by Start here and stable position", async () => {
    mocks.handbookArticle.findMany.mockResolvedValue([]);

    await listPublishedHandbookArticles({ organizationId: "org-1" });

    expect(mocks.handbookArticle.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [
          { isStartHere: "desc" },
          { position: "asc" },
          { slug: "asc" },
        ],
      })
    );
  });

  it("moves an article inside its Start here or normal ordering group", async () => {
    mocks.tx.handbookArticle.findFirst.mockResolvedValue({
      id: "article-b",
      handbookCategoryId: "category-1",
      isStartHere: false,
      position: 2,
    });
    mocks.tx.handbookArticle.findMany.mockResolvedValue([
      { id: "article-a", position: 1 },
      { id: "article-b", position: 2 },
    ]);

    await updateHandbookArticleNavigation({
      organizationId: "org-1",
      articleId: "article-b",
      intent: "move-up",
    });

    expect(mocks.tx.handbookArticle.update).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: { id: "article-b", organizationId: "org-1" },
        data: { position: 1 },
      })
    );
    expect(mocks.tx.handbookArticle.update).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { id: "article-a", organizationId: "org-1" },
        data: { position: 2 },
      })
    );
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
  });

  it("rejects a rename that duplicates another normalized Handbook category", async () => {
    mocks.handbookCategory.findFirst
      .mockResolvedValueOnce({
        id: "category-1",
        name: "Electronics",
        normalizedName: "electronics",
      })
      .mockResolvedValueOnce({ id: "category-2" });

    await expect(
      renameHandbookCategory({
        organizationId: "org-1",
        categoryId: "category-1",
        name: " WORKSHOP   SAFETY ",
      })
    ).rejects.toThrow("An equivalent Handbook category already exists.");
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

  it("rejects a pending revision by restoring the current published draft snapshot", async () => {
    mocks.tx.handbookObservation.findFirst.mockResolvedValue({
      id: "observation-revision-1",
      articleId: "article-1",
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

  it("keeps a published article position when publishing a new version", async () => {
    mocks.tx.handbookArticle.findFirst.mockResolvedValue({
      id: "article-1",
      organizationId: "org-1",
      slug: "change-filament",
      status: "PUBLISHED",
      position: 7,
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
  });

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
