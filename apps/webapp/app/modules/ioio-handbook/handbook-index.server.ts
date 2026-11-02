import { HandbookArticleStatus } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { db } from "~/database/db.server";
import { Logger } from "~/utils/logger";

type HandbookCategorySummary = { id: string; name: string };
type HandbookTopicSummary = {
  id: string;
  name: string;
  categoryId: string;
  category: { name: string };
};

/** Load only current published knowledge for the normal Handbook page. */
export async function getHandbookIndex({
  organizationId,
  query = "",
  categoryId,
  topicId,
  articleType,
}: {
  organizationId: string;
  query?: string;
  categoryId?: string;
  topicId?: string;
  articleType?: string;
}) {
  const search = query.trim().slice(0, 120);
  const publishedVersionWhere: Prisma.HandbookArticleVersionWhereInput = {
    ...(categoryId ? { categoryId } : {}),
    ...(topicId ? { topicId } : {}),
    ...(articleType ? { articleType } : {}),
    ...(search
      ? {
          OR: [
            { title: { contains: search, mode: "insensitive" } },
            { summary: { contains: search, mode: "insensitive" } },
            { content: { contains: search, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const articles = await db.handbookArticle.findMany({
    where: {
      organizationId,
      status: HandbookArticleStatus.PUBLISHED,
      ...(Object.keys(publishedVersionWhere).length
        ? { publishedVersion: { is: publishedVersionWhere } }
        : {}),
    },
    orderBy: [{ updatedAt: "desc" }, { slug: "asc" }],
    take: 100,
    select: {
      id: true,
      slug: true,
      updatedAt: true,
      publishedVersion: {
        select: {
          id: true,
          title: true,
          summary: true,
          content: true,
          versionNumber: true,
          publishedAt: true,
          category: { select: { id: true, name: true } },
          topic: { select: { id: true, name: true } },
          articleType: true,
          location: { select: { id: true, name: true } },
        },
      },
    },
  });

  let categories: HandbookCategorySummary[] = [];
  let topics: HandbookTopicSummary[] = [];
  try {
    [categories, topics] = await Promise.all([
      db.handbookCategory.findMany({
        where: { organizationId },
        orderBy: { name: "asc" },
        select: { id: true, name: true },
      }),
      db.handbookTopic.findMany({
        where: { organizationId },
        orderBy: [{ category: { name: "asc" } }, { name: "asc" }],
        select: {
          id: true,
          name: true,
          categoryId: true,
          category: { select: { name: true } },
        },
      }),
    ]);
  } catch (cause) {
    Logger.error(cause);
  }

  return { articles, categories, topics };
}
