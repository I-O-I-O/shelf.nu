import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tx: {
    handbookArticle: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    handbookArticleVersion: {
      aggregate: vi.fn(),
      create: vi.fn(),
    },
    handbookArticleAssetModel: { createMany: vi.fn() },
    handbookArticleKit: { createMany: vi.fn() },
    handbookSource: { upsert: vi.fn() },
    handbookVersionSource: { createMany: vi.fn() },
    assetModel: { count: vi.fn() },
    kit: { count: vi.fn() },
    handbookObservation: { create: vi.fn() },
  },
  handbookArticle: { findMany: vi.fn() },
  handbookObservation: { findMany: vi.fn() },
  assetModel: { findFirst: vi.fn() },
  kit: { findFirst: vi.fn() },
  recordEvent: vi.fn(),
}));

vi.mock("~/database/db.server", () => ({
  db: {
    $transaction: (callback: (tx: typeof mocks.tx) => unknown) =>
      callback(mocks.tx),
    handbookArticle: mocks.handbookArticle,
    handbookObservation: mocks.handbookObservation,
    assetModel: mocks.assetModel,
    kit: mocks.kit,
  },
}));
vi.mock("~/modules/activity-event/service.server", () => ({
  recordEvent: mocks.recordEvent,
}));

import {
  getHandbookContextForAssistant,
  publishHandbookArticle,
  submitHandbookObservation,
} from "./service.server";

describe("Handbook publication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handbookArticle.findMany.mockResolvedValue([]);
    mocks.handbookObservation.findMany.mockResolvedValue([]);
    mocks.tx.handbookArticle.findFirst.mockResolvedValue({
      id: "article-1",
      organizationId: "org-1",
      slug: "grove-kit",
      draftTitle: "Grove Kit",
      draftSummary: "A practical guide.",
      draftContent: "Check the cable first.",
      draftSection: "Equipment & Kits",
      draftAssetModelIds: [],
      draftKitIds: [],
      draftSourceUrls: [],
    });
    mocks.tx.handbookArticleVersion.aggregate.mockResolvedValue({
      _max: { versionNumber: 3 },
    });
    mocks.tx.handbookArticleVersion.create.mockResolvedValue({
      id: "version-4",
      versionNumber: 4,
    });
    mocks.tx.assetModel.count.mockResolvedValue(0);
    mocks.tx.kit.count.mockResolvedValue(0);
  });

  it("publishes an immutable next snapshot and points readers at it", async () => {
    await expect(
      publishHandbookArticle({
        organizationId: "org-1",
        userId: "staff-1",
        articleId: "article-1",
      })
    ).resolves.toEqual({
      articleId: "article-1",
      slug: "grove-kit",
      versionNumber: 4,
    });

    expect(mocks.tx.handbookArticleVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        articleId: "article-1",
        versionNumber: 4,
        title: "Grove Kit",
        content: "Check the cable first.",
        publishedByUserId: "staff-1",
      }),
    });
    expect(mocks.tx.handbookArticle.update).toHaveBeenCalledWith({
      where: { id: "article-1", organizationId: "org-1" },
      data: expect.objectContaining({
        status: "PUBLISHED",
        publishedVersionId: "version-4",
        updatedByUserId: "staff-1",
      }),
    });
    expect(mocks.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "IOIO_HANDBOOK_ARTICLE_PUBLISHED",
        organizationId: "org-1",
        entityId: "article-1",
      }),
      mocks.tx
    );
  });

  it("revalidates linked Shelf products within the active organization", async () => {
    mocks.tx.handbookArticle.findFirst.mockResolvedValue({
      id: "article-1",
      organizationId: "org-1",
      slug: "grove-kit",
      draftTitle: "Grove Kit",
      draftSummary: "",
      draftContent: "Content",
      draftSection: "Equipment",
      draftAssetModelIds: ["asset-model-elsewhere"],
      draftKitIds: [],
      draftSourceUrls: [],
    });
    mocks.tx.assetModel.count.mockResolvedValue(0);

    await expect(
      publishHandbookArticle({
        organizationId: "org-1",
        userId: "staff-1",
        articleId: "article-1",
      })
    ).rejects.toThrow("A linked Shelf product has changed");
    expect(mocks.tx.handbookArticleVersion.create).not.toHaveBeenCalled();
  });

  it("keeps Ask IOIO usable when the optional Handbook migration is absent", async () => {
    mocks.handbookArticle.findMany.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Handbook table is missing", {
        code: "P2021",
        clientVersion: "test",
      })
    );

    await expect(
      getHandbookContextForAssistant({
        organizationId: "org-1",
        question: "How do I prepare the Grove kit?",
        audience: "student",
      })
    ).resolves.toBe("");
  });

  it("does not create a second exact pending contribution", async () => {
    const content =
      "The Grove Kit contains a carrier board and a vibration motor.";
    mocks.handbookObservation.findMany.mockResolvedValue([
      {
        id: "observation-existing",
        title: "The Grove Kit knowledge",
        content,
        status: "PENDING_REVIEW",
      },
    ]);

    await expect(
      submitHandbookObservation({
        organizationId: "org-1",
        userId: "student-1",
        title: "Grove Kit components",
        content,
      })
    ).resolves.toMatchObject({
      duplicate: true,
      duplicateKind: "observation",
      duplicateTitle: "The Grove Kit knowledge",
    });

    expect(mocks.tx.handbookObservation.create).not.toHaveBeenCalled();
    expect(mocks.recordEvent).not.toHaveBeenCalled();
  });
});
