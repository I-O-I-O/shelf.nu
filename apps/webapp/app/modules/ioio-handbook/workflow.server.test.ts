import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const tx = {
    handbookRevision: {
      findFirst: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
      aggregate: vi.fn(),
      create: vi.fn(),
    },
    handbookArticle: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    handbookArticleVersion: { aggregate: vi.fn(), create: vi.fn() },
    handbookArticleAssetModel: { createMany: vi.fn() },
    handbookArticleKit: { createMany: vi.fn() },
    handbookSource: { upsert: vi.fn() },
    handbookVersionSource: { createMany: vi.fn() },
    handbookFinding: { updateMany: vi.fn() },
    assetModel: { count: vi.fn() },
    kit: { count: vi.fn() },
  };
  return {
    tx,
    db: {
      $transaction: vi.fn((callback: (tx: any) => unknown) => callback(tx)),
      handbookArticle: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
      },
      handbookRevision: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
        count: vi.fn(),
        update: vi.fn(),
      },
      handbookArticleVersion: { aggregate: vi.fn() },
      handbookFinding: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
      handbookCategory: { findMany: vi.fn(), upsert: vi.fn() },
      handbookTopic: { findMany: vi.fn(), upsert: vi.fn() },
      location: { findMany: vi.fn(), count: vi.fn() },
      assetModel: { count: vi.fn() },
      kit: { count: vi.fn() },
      user: { findMany: vi.fn() },
    },
    recordEvent: vi.fn(),
  };
});

// why: isolate the database boundary so the test can prove pending submissions
// leave the current pointer untouched and staff approval changes it atomically.
vi.mock("~/database/db.server", () => ({ db: mocks.db }));
// why: the publication event is an external side effect of the DB transaction.
vi.mock("~/modules/activity-event/service.server", () => ({
  recordEvent: mocks.recordEvent,
}));
// why: fail the test module load if the core workflow ever imports Claude review.
vi.mock("./handbook-review.server", () => {
  throw new Error("Claude helper unavailable");
});

import {
  archiveHandbookArticle,
  convertHandbookProposalToRevision,
  getHandbookArticleDetail,
  getHandbookReviewDetail,
  markHandbookCandidateNotDuplicate,
  publishHandbookRevision,
  restoreHandbookArticle,
  reviewHandbookRevision,
  saveHandbookRevision,
  submitHandbookRevision,
} from "./workflow.server";

const revision = {
  id: "revision-4",
  organizationId: "org-1",
  articleId: "article-1",
  revisionNumber: 4,
  status: "DRAFT",
  title: "Soldering Basics",
  summary: "Updated procedure.",
  content: "Set the iron to 350 C.",
  section: "Electronics",
  articleType: "Guide",
  category: { name: "Electronics" },
  topic: { name: "Soldering" },
  authorUserId: "student-1",
  assetModelIds: [],
  kitIds: [],
  sourceUrls: [],
  videoUrls: [],
  categoryId: "category-1",
  topicId: "topic-1",
  locationId: null,
};

describe("Handbook revision workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.db.handbookRevision.findFirst.mockResolvedValue(revision);
    mocks.db.handbookRevision.count.mockResolvedValue(0);
    mocks.db.handbookRevision.update.mockResolvedValue({
      id: revision.id,
      status: "PENDING_REVIEW",
    });
    mocks.db.handbookArticle.findMany.mockResolvedValue([
      {
        id: "article-1",
        slug: "soldering-basics",
        publishedVersion: {
          title: "Soldering Basics",
          summary: "Soldering setup.",
          content: "Set the iron to 320 C.",
          section: "Electronics",
          versionNumber: 3,
          category: { name: "Electronics" },
          topic: { name: "Soldering" },
        },
      },
    ]);
    mocks.tx.handbookRevision.findFirst.mockResolvedValue({
      ...revision,
      status: "PENDING_REVIEW",
    });
    mocks.tx.handbookRevision.count.mockResolvedValue(0);
    mocks.tx.handbookRevision.update.mockResolvedValue({});
    mocks.tx.handbookArticle.findFirst.mockResolvedValue({
      id: "article-1",
      organizationId: "org-1",
      slug: "soldering-basics",
      status: "PUBLISHED",
      publishedVersionId: "version-3",
    });
    mocks.tx.assetModel.count.mockResolvedValue(0);
    mocks.tx.kit.count.mockResolvedValue(0);
    mocks.tx.handbookArticleVersion.create.mockResolvedValue({
      id: "version-4",
      versionNumber: 4,
    });
    mocks.db.user.findMany.mockResolvedValue([]);
    mocks.db.handbookCategory.findMany.mockResolvedValue([]);
    mocks.db.handbookTopic.findMany.mockResolvedValue([]);
    mocks.db.location.findMany.mockResolvedValue([]);
    mocks.db.handbookRevision.findMany.mockResolvedValue([]);
    mocks.db.assetModel.count.mockResolvedValue(0);
    mocks.db.kit.count.mockResolvedValue(0);
    mocks.db.handbookCategory.upsert.mockResolvedValue({
      id: "category-1",
      name: "Electronics",
    });
    mocks.db.handbookTopic.upsert.mockResolvedValue({
      id: "topic-1",
      name: "Soldering",
    });
    mocks.tx.handbookArticleVersion.aggregate.mockResolvedValue({
      _max: { versionNumber: 3 },
    });
    mocks.tx.handbookRevision.aggregate.mockResolvedValue({
      _max: { revisionNumber: 0 },
    });
    mocks.tx.handbookRevision.create.mockResolvedValue({
      id: "revision-4",
      articleId: "article-1",
      revisionNumber: 4,
      status: "DRAFT",
    });
  });

  it("creates a student draft while the Claude helper is unavailable", async () => {
    mocks.tx.handbookArticle.findFirst.mockResolvedValue({
      id: "article-1",
      organizationId: "org-1",
      slug: "soldering-basics",
      status: "PUBLISHED",
      publishedVersionId: "version-3",
      createdByUserId: "staff-1",
    });

    await expect(
      saveHandbookRevision({
        organizationId: "org-1",
        userId: "student-1",
        canEdit: false,
        articleId: "article-1",
        title: "Soldering Basics",
        summary: "Updated procedure.",
        content: "Set the iron to 350 C.",
        category: "Electronics",
        topic: "Soldering",
        articleType: "Guide",
        videoUrls: ["https://www.youtube.com/watch?v=demo"],
        assetModelIds: [],
        kitIds: [],
        sourceUrls: [],
      })
    ).resolves.toMatchObject({ revisionNumber: 4, status: "DRAFT" });

    expect(mocks.tx.handbookRevision.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: "org-1",
          articleId: "article-1",
          revisionNumber: 4,
          authorUserId: "student-1",
          videoUrls: ["https://www.youtube.com/watch?v=demo"],
        }),
      })
    );
    expect(mocks.tx.handbookArticle.update).not.toHaveBeenCalled();
  });

  it("rejects a Shelf Location from another organization", async () => {
    mocks.db.assetModel.count.mockResolvedValue(0);
    mocks.db.kit.count.mockResolvedValue(0);
    mocks.db.location.count.mockResolvedValue(0);

    await expect(
      saveHandbookRevision({
        organizationId: "org-1",
        userId: "student-1",
        canEdit: false,
        articleId: "article-1",
        title: "Soldering Basics",
        summary: "Updated procedure.",
        content: "Use a clean iron.",
        category: "Electronics",
        topic: "Soldering",
        articleType: "Guide",
        locationId: "location-from-org-2",
        videoUrls: [],
        assetModelIds: [],
        kitIds: [],
        sourceUrls: [],
      })
    ).rejects.toThrow("not in this workspace");
    expect(mocks.db.handbookCategory.upsert).not.toHaveBeenCalled();
  });

  it("accepts HTTPS video links and rejects non-HTTPS links", async () => {
    await expect(
      saveHandbookRevision({
        organizationId: "org-1",
        userId: "student-1",
        canEdit: false,
        articleId: "article-1",
        title: "Soldering Basics",
        summary: "Updated procedure.",
        content: "Use a clean iron.",
        category: "Electronics",
        topic: "Soldering",
        articleType: "Guide",
        videoUrls: ["https://www.youtube.com/watch?v=demo"],
        assetModelIds: [],
        kitIds: [],
        sourceUrls: [],
      })
    ).resolves.toMatchObject({ status: "DRAFT" });

    await expect(
      saveHandbookRevision({
        organizationId: "org-1",
        userId: "student-1",
        canEdit: false,
        articleId: "article-1",
        title: "Soldering Basics",
        summary: "Updated procedure.",
        content: "Use a clean iron.",
        category: "Electronics",
        topic: "Soldering",
        articleType: "Guide",
        videoUrls: ["http://www.youtube.com/watch?v=demo"],
        assetModelIds: [],
        kitIds: [],
        sourceUrls: [],
      })
    ).rejects.toThrow("Video links must be valid HTTPS URLs");
  });

  it("submits a student revision without Claude and keeps the current version live", async () => {
    await expect(
      submitHandbookRevision({
        organizationId: "org-1",
        userId: "student-1",
        revisionId: revision.id,
      })
    ).resolves.toMatchObject({ status: "PENDING_REVIEW" });

    expect(mocks.db.handbookRevision.update).toHaveBeenCalledWith({
      where: { id: revision.id, organizationId: "org-1" },
      data: expect.objectContaining({ status: "PENDING_REVIEW" }),
      select: { id: true, articleId: true, revisionNumber: true, status: true },
    });
    expect(mocks.db.handbookArticle.update).not.toHaveBeenCalled();
    expect(mocks.tx.handbookArticle.update).not.toHaveBeenCalled();
  });

  it("staff can approve without Claude and retains older revision history", async () => {
    mocks.tx.handbookRevision.findFirst.mockResolvedValue({
      ...revision,
      status: "PENDING_REVIEW",
    });
    await expect(
      publishHandbookRevision({
        organizationId: "org-1",
        userId: "staff-1",
        revisionId: revision.id,
      })
    ).resolves.toEqual({
      articleId: "article-1",
      slug: "soldering-basics",
      versionNumber: 4,
    });

    expect(mocks.tx.handbookArticleVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        articleId: "article-1",
        versionNumber: 4,
        authorUserId: "student-1",
        publishedByUserId: "staff-1",
      }),
    });
    expect(mocks.tx.handbookArticle.update).toHaveBeenCalledWith({
      where: { id: "article-1", organizationId: "org-1" },
      data: expect.objectContaining({
        publishedVersionId: "version-4",
        status: "PUBLISHED",
      }),
    });
    expect(mocks.tx.handbookRevision.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "APPROVED",
          publishedVersionId: "version-4",
        }),
      })
    );
    expect(mocks.tx.handbookFinding.updateMany).not.toHaveBeenCalled();
  });

  it("loads staff review content and a canonical diff without AI findings", async () => {
    mocks.db.handbookRevision.findFirst.mockResolvedValue({
      ...revision,
      content: "Use eye protection.\nSet the iron to 350 C.",
      article: {
        slug: "soldering-basics",
        publishedVersion: {
          title: "Soldering Basics",
          content: "Use eye protection.\nSet the iron to 320 C.",
        },
      },
    });

    await expect(
      getHandbookReviewDetail({
        organizationId: "org-1",
        revisionId: revision.id,
      })
    ).resolves.toMatchObject({
      revision: { id: revision.id, title: revision.title },
      diff: {
        added: ["Set the iron to 350 C."],
        removed: ["Set the iron to 320 C."],
        changedPairs: 1,
      },
    });

    const query = mocks.db.handbookRevision.findFirst.mock.calls.at(-1)?.[0];
    expect(query.include).not.toHaveProperty("findings");
  });

  it("returns a student proposal for revision without changing the current version", async () => {
    await reviewHandbookRevision({
      organizationId: "org-1",
      userId: "staff-1",
      revisionId: "revision-4",
      decision: "return",
      notes: "Please clarify the temperature range.",
    });

    expect(mocks.db.handbookRevision.update).toHaveBeenCalledWith({
      where: { id: "revision-4", organizationId: "org-1" },
      data: expect.objectContaining({
        status: "DRAFT",
        reviewNotes: "Please clarify the temperature range.",
        reviewedByUserId: "staff-1",
      }),
    });
    expect(mocks.db.handbookArticle.update).not.toHaveBeenCalled();
  });

  it("keeps older approved versions readable and marks them as historical", async () => {
    const current = { id: "version-4", versionNumber: 4, content: "Current" };
    const older = { id: "version-3", versionNumber: 3, content: "Outdated" };
    mocks.db.handbookArticle.findFirst.mockResolvedValue({
      id: "article-1",
      slug: "soldering-basics",
      publishedVersion: current,
      versions: [current, older],
    });

    await expect(
      getHandbookArticleDetail({
        organizationId: "org-1",
        slug: "soldering-basics",
        versionId: "version-3",
      })
    ).resolves.toMatchObject({
      viewedVersion: { id: "version-3", content: "Outdated" },
      currentVersion: { id: "version-4" },
      isHistorical: true,
    });
  });

  it("converts a proposal into a revision without changing the target approved version", async () => {
    mocks.tx.handbookRevision.findFirst.mockResolvedValue({
      ...revision,
      articleId: "proposal-article",
      status: "PENDING_REVIEW",
    });
    mocks.tx.handbookArticle.findFirst.mockImplementation(
      ({ where }: { where: { id: string } }) =>
        where.id === "target-article"
          ? {
              id: "target-article",
              slug: "soldering-basics",
              status: "PUBLISHED",
              publishedVersionId: "version-3",
            }
          : {
              id: "proposal-article",
              status: "DRAFT",
              publishedVersionId: null,
            }
    );
    mocks.tx.handbookArticleVersion.aggregate.mockResolvedValue({
      _max: { versionNumber: 2 },
    });
    mocks.tx.handbookRevision.aggregate.mockResolvedValue({
      _max: { revisionNumber: 2 },
    });
    mocks.tx.handbookRevision.count.mockResolvedValue(0);

    await expect(
      convertHandbookProposalToRevision({
        organizationId: "org-1",
        userId: "staff-1",
        revisionId: "revision-4",
        targetArticleId: "target-article",
      })
    ).resolves.toEqual({
      articleId: "target-article",
      slug: "soldering-basics",
      revisionNumber: 3,
    });

    expect(mocks.tx.handbookRevision.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          articleId: "target-article",
          revisionNumber: 3,
        }),
      })
    );
    expect(mocks.tx.handbookArticle.update).toHaveBeenCalledWith({
      where: { id: "proposal-article", organizationId: "org-1" },
      data: expect.objectContaining({ status: "ARCHIVED" }),
    });
    expect(mocks.tx.handbookArticleVersion.create).not.toHaveBeenCalled();
  });

  it("archives and restores an article without deleting its versions", async () => {
    mocks.db.handbookArticle.updateMany.mockResolvedValue({ count: 1 });
    mocks.db.handbookArticle.findFirst.mockResolvedValue({
      id: "article-1",
      publishedVersionId: "version-3",
    });

    await archiveHandbookArticle({
      organizationId: "org-1",
      articleId: "article-1",
      userId: "staff-1",
    });
    await restoreHandbookArticle({
      organizationId: "org-1",
      articleId: "article-1",
      userId: "staff-1",
    });

    expect(mocks.db.handbookArticle.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "article-1",
          organizationId: "org-1",
        }),
        data: { status: "ARCHIVED", updatedByUserId: "staff-1" },
      })
    );
    expect(mocks.db.handbookArticle.update).toHaveBeenCalledWith({
      where: { id: "article-1", organizationId: "org-1" },
      data: { status: "PUBLISHED", updatedByUserId: "staff-1" },
    });
  });

  it("stores a staff not-a-duplicate decision for that exact article relationship", async () => {
    mocks.db.handbookRevision.findFirst.mockResolvedValue({
      id: "revision-4",
      articleId: "article-1",
    });
    mocks.db.handbookArticle.findFirst.mockResolvedValue({
      id: "article-2",
      publishedVersion: { title: "Soldering tips" },
    });
    mocks.db.handbookFinding.findFirst.mockResolvedValue(null);

    await markHandbookCandidateNotDuplicate({
      organizationId: "org-1",
      userId: "staff-1",
      revisionId: "revision-4",
      relatedArticleId: "article-2",
    });

    expect(mocks.db.handbookFinding.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: "org-1",
        articleId: "article-1",
        relatedArticleId: "article-2",
        status: "DISMISSED",
        staffDecision: "NOT_A_DUPLICATE",
        decidedByUserId: "staff-1",
      }),
    });
    expect(mocks.db.handbookArticle.update).not.toHaveBeenCalled();
  });
});
