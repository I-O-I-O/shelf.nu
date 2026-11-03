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
      create: vi.fn(),
      update: vi.fn(),
    },
    handbookArticleVersion: { aggregate: vi.fn(), create: vi.fn() },
    handbookSource: { upsert: vi.fn() },
    handbookVersionSource: { createMany: vi.fn() },
    handbookObservation: { create: vi.fn(), update: vi.fn() },
  },
  handbookCategory: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
  },
  handbookArticle: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
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
  createHandbookCategory,
  getHandbookEditData,
  normalizeHandbookCategoryName,
  publishHandbookArticle,
  resolveHandbookObservationCategoryProposal,
  saveHandbookDraft,
  submitHandbookObservation,
} from "./service.server";

describe("Handbook categories", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handbookArticle.findMany.mockResolvedValue([]);
    mocks.handbookObservation.findMany.mockResolvedValue([]);
    mocks.handbookCategory.findFirst.mockResolvedValue({
      id: "handbook-category-1",
    });
    mocks.handbookCategory.findMany.mockResolvedValue([]);
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
      proposedCategoryName: "Workshop Safety",
    });
    mocks.handbookObservation.updateMany.mockResolvedValue({ count: 1 });
    mocks.tx.handbookArticle.findFirst.mockResolvedValue({
      id: "article-1",
      organizationId: "org-1",
      slug: "soldering-basics",
      handbookCategoryId: "handbook-category-1",
      draftTitle: "Soldering Basics",
      draftContent: "Basic soldering guide.",
      draftSourceUrls: [],
    });
    mocks.tx.handbookArticleVersion.aggregate.mockResolvedValue({
      _max: { versionNumber: 0 },
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

  it("normalizes trimmed case variants to one organization-scoped identity", async () => {
    expect(normalizeHandbookCategoryName("Workshop Safety")).toBe(
      normalizeHandbookCategoryName(" WORKSHOP   SAFETY ")
    );
    mocks.tx.handbookCategory.findUnique.mockResolvedValue({
      id: "existing-category",
      name: "Workshop Safety",
      archivedAt: null,
    });

    await expect(
      createHandbookCategory({
        organizationId: "org-1",
        name: " workshop safety ",
      })
    ).resolves.toEqual({ id: "existing-category", name: "Workshop Safety" });

    expect(mocks.tx.handbookCategory.findUnique).toHaveBeenCalledWith({
      where: {
        organizationId_normalizedName: {
          organizationId: "org-1",
          normalizedName: "workshop safety",
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
    expect(mocks.handbookObservation.updateMany).toHaveBeenCalledWith({
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
