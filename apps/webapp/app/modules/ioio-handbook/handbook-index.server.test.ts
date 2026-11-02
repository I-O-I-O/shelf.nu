import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  articleFindMany: vi.fn(),
  categoryFindMany: vi.fn(),
  topicFindMany: vi.fn(),
  loggerError: vi.fn(),
}));

// why: exercise the index service boundary without requiring a local database.
vi.mock("~/database/db.server", () => ({
  db: {
    handbookArticle: { findMany: mocks.articleFindMany },
    handbookCategory: { findMany: mocks.categoryFindMany },
    handbookTopic: { findMany: mocks.topicFindMany },
  },
}));
// why: verify optional taxonomy failures are logged without initializing app telemetry.
vi.mock("~/utils/logger", () => ({ Logger: { error: mocks.loggerError } }));
// why: prove normal index reads do not load the optional Claude reviewer.
vi.mock("~/modules/ioio-handbook/handbook-review.server", () => {
  throw new Error("Claude helper unavailable");
});

import { getHandbookIndex } from "./handbook-index.server";

describe("Handbook index service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.articleFindMany.mockResolvedValue([]);
    mocks.categoryFindMany.mockResolvedValue([]);
    mocks.topicFindMany.mockResolvedValue([]);
  });

  it("loads an empty published index without querying revisions or findings", async () => {
    await expect(
      getHandbookIndex({ organizationId: "org-1" })
    ).resolves.toEqual({
      articles: [],
      categories: [],
      topics: [],
    });

    expect(mocks.articleFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: "org-1", status: "PUBLISHED" },
      })
    );
  });

  it("keeps published articles available if optional taxonomy queries fail", async () => {
    const failure = new Error("Taxonomy unavailable");
    const articles = [{ id: "article-1", slug: "soldering-basics" }];
    mocks.articleFindMany.mockResolvedValue(articles);
    mocks.categoryFindMany.mockRejectedValue(failure);

    await expect(
      getHandbookIndex({ organizationId: "org-1" })
    ).resolves.toEqual({
      articles,
      categories: [],
      topics: [],
    });
    expect(mocks.loggerError).toHaveBeenCalledWith(failure);
  });

  it("searches only current articles and applies category, topic, and type filters", async () => {
    await getHandbookIndex({
      organizationId: "org-1",
      query: "  soldering  ",
      categoryId: "category-1",
      topicId: "topic-1",
      articleType: "Guide",
    });

    expect(mocks.articleFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: "org-1",
          status: "PUBLISHED",
          publishedVersion: {
            is: {
              categoryId: "category-1",
              topicId: "topic-1",
              articleType: "Guide",
              OR: [
                { title: { contains: "soldering", mode: "insensitive" } },
                { summary: { contains: "soldering", mode: "insensitive" } },
                { content: { contains: "soldering", mode: "insensitive" } },
              ],
            },
          },
        },
      })
    );
  });
});
