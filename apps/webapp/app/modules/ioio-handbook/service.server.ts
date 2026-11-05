import {
  HandbookArticleStatus,
  HandbookObservationStatus,
  HandbookSourceKind,
  Prisma,
} from "@prisma/client";
import type { Prisma as PrismaTypes } from "@prisma/client";
import type { ITXClientDenyList } from "@prisma/client/runtime/library";
import { db } from "~/database/db.server";
import type { ExtendedPrismaClient } from "~/database/db.server";
import { recordEvent } from "~/modules/activity-event/service.server";
import { Logger } from "~/utils/logger";
import { resolveUserDisplayName } from "~/utils/user";
import {
  getKnowledgeOverlap,
  getKnowledgeTerms,
  makeHandbookSlug,
  normalizeSourceUrl,
} from "./handbook.shared";

export class HandbookValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HandbookValidationError";
  }
}

export type HandbookImportDraftInput = {
  title: string;
  content: string;
  sourceUrls: string[];
  existingArticleSlug?: string;
  revisionBaseVersionId?: string;
};

/** Save an approved PDF proposal as drafts in one transaction. */
export async function createHandbookImportDrafts({
  organizationId,
  userId,
  handbookCategoryId,
  newCategoryName,
  articles,
}: {
  organizationId: string;
  userId: string;
  handbookCategoryId?: string;
  newCategoryName?: string;
  articles: HandbookImportDraftInput[];
}) {
  if (!articles.length || articles.length > 30) {
    throw new HandbookValidationError(
      "Choose between 1 and 30 articles before importing."
    );
  }
  for (const article of articles) {
    if (
      !article.title.trim() ||
      article.title.trim().length > 180 ||
      !article.content.trim() ||
      article.content.trim().length > 30_000
    ) {
      throw new HandbookValidationError(
        "Every imported article needs a title and content within the Handbook limits."
      );
    }
    const references = cleanSourceUrls(article.sourceUrls);
    if (
      references.length !==
        article.sourceUrls.filter((value) => value.trim()).length ||
      references.length > 20 ||
      references.some((url) => url.length > 500)
    ) {
      throw new HandbookValidationError(
        "Each imported article supports up to 20 valid http(s) references."
      );
    }
  }
  const selectedExistingSlugs = articles
    .map((article) => article.existingArticleSlug)
    .filter((slug): slug is string => Boolean(slug));
  if (new Set(selectedExistingSlugs).size !== selectedExistingSlugs.length) {
    throw new HandbookValidationError(
      "Choose an existing article only once in an import structure."
    );
  }

  return db.$transaction(async (tx) => {
    let categoryId = handbookCategoryId?.trim() || undefined;
    if (newCategoryName?.trim()) {
      if (categoryId) {
        throw new HandbookValidationError(
          "Choose an existing category or create a new one, not both."
        );
      }
      const cleanedName = cleanHandbookCategoryName(newCategoryName);
      const normalizedName = normalizeHandbookCategoryName(cleanedName);
      if (!normalizedName || cleanedName.length > 80) {
        throw new HandbookValidationError(
          "Enter a Handbook category name up to 80 characters."
        );
      }
      const existing = await tx.handbookCategory.findUnique({
        where: {
          organizationId_normalizedName: { organizationId, normalizedName },
        },
        select: { id: true, archivedAt: true },
      });
      if (existing?.archivedAt) {
        const restored = await tx.handbookCategory.update({
          where: { id: existing.id, organizationId },
          data: { name: cleanedName, archivedAt: null },
          select: { id: true },
        });
        categoryId = restored.id;
      } else if (existing) {
        categoryId = existing.id;
      } else {
        const slugBase =
          makeHandbookSlug(cleanedName).slice(0, 100) || "category";
        let slug = slugBase;
        let suffix = 2;
        while (
          await tx.handbookCategory.findUnique({
            where: { organizationId_slug: { organizationId, slug } },
            select: { id: true },
          })
        ) {
          const suffixText = `-${suffix++}`;
          slug = `${slugBase.slice(0, 100 - suffixText.length)}${suffixText}`;
        }
        const category = await tx.handbookCategory.create({
          data: { organizationId, name: cleanedName, slug, normalizedName },
          select: { id: true },
        });
        categoryId = category.id;
      }
    }

    if (categoryId) {
      const category = await tx.handbookCategory.findFirst({
        where: { id: categoryId, organizationId, archivedAt: null },
        select: { id: true },
      });
      if (!category) {
        throw new HandbookValidationError(
          "Choose a category from this Handbook workspace."
        );
      }
    }

    const created: Array<{
      slug: string;
      title: string;
      revision: boolean;
    }> = [];
    for (const proposal of articles) {
      const importedSources = cleanSourceUrls(proposal.sourceUrls);
      if (proposal.existingArticleSlug) {
        const current = await tx.handbookArticle.findFirst({
          where: {
            organizationId,
            slug: proposal.existingArticleSlug,
            status: HandbookArticleStatus.PUBLISHED,
          },
          select: {
            id: true,
            slug: true,
            updatedByUserId: true,
            publishedVersionId: true,
            handbookCategoryId: true,
            draftTitle: true,
            draftContent: true,
            draftSourceUrls: true,
            publishedVersion: {
              select: {
                title: true,
                content: true,
                sources: { select: { source: { select: { url: true } } } },
              },
            },
            observations: {
              where: {
                status: HandbookObservationStatus.PENDING_REVIEW,
                publishedVersionId: { not: null },
              },
              take: 1,
              select: { id: true },
            },
          },
        });
        if (
          !current?.publishedVersion ||
          !proposal.revisionBaseVersionId ||
          current.publishedVersionId !== proposal.revisionBaseVersionId
        ) {
          throw new HandbookValidationError(
            "The selected existing article changed. Review the import structure and choose it again."
          );
        }
        if (current.observations.length) {
          throw new HandbookValidationError(
            `“${current.publishedVersion.title}” already has an improvement awaiting review.`
          );
        }
        const existingSources = current.publishedVersion.sources
          .map(({ source }) => source.url)
          .filter((url): url is string => Boolean(url));
        const draftSources = cleanSourceUrls(current.draftSourceUrls);
        const hasExistingDraftChanges =
          current.draftTitle !== current.publishedVersion.title ||
          current.draftContent !== current.publishedVersion.content ||
          JSON.stringify(draftSources) !==
            JSON.stringify(cleanSourceUrls(existingSources));
        if (hasExistingDraftChanges && current.updatedByUserId !== userId) {
          throw new HandbookValidationError(
            `Another draft improvement is in progress for “${current.publishedVersion.title}”.`
          );
        }
        const baseTitle = hasExistingDraftChanges
          ? current.draftTitle
          : current.publishedVersion.title;
        const baseContent = hasExistingDraftChanges
          ? current.draftContent
          : current.publishedVersion.content;
        const revisedContent = `${baseContent.trim()}\n\n${proposal.content.trim()}`;
        if (revisedContent.length > 30_000) {
          throw new HandbookValidationError(
            `The proposed revision for “${current.publishedVersion.title}” exceeds the 30,000-character article limit. Shorten the imported content or create a new article.`
          );
        }
        const baseSources = hasExistingDraftChanges
          ? draftSources
          : existingSources;
        const mergedSourceCandidates = [...baseSources, ...importedSources]
          .map((url) => normalizeSourceUrl(url))
          .filter((url): url is string => Boolean(url));
        const uniqueMergedSourceCandidates = [
          ...new Set(mergedSourceCandidates),
        ];
        if (uniqueMergedSourceCandidates.length > 20) {
          throw new HandbookValidationError(
            `The proposed revision for “${current.publishedVersion.title}” exceeds the 20-reference limit.`
          );
        }
        const mergedSources = uniqueMergedSourceCandidates;
        const updated = await tx.handbookArticle.updateMany({
          where: {
            id: current.id,
            organizationId,
            status: HandbookArticleStatus.PUBLISHED,
            publishedVersionId: proposal.revisionBaseVersionId,
            updatedByUserId: current.updatedByUserId,
          },
          data: {
            draftTitle: baseTitle,
            draftContent: revisedContent,
            draftSourceUrls: mergedSources,
            handbookCategoryId: categoryId ?? current.handbookCategoryId,
            updatedByUserId: userId,
          },
        });
        if (!updated.count) {
          throw new HandbookValidationError(
            `“${current.publishedVersion.title}” changed while the import was being saved. Try again.`
          );
        }
        created.push({
          slug: current.slug,
          title: current.publishedVersion.title,
          revision: true,
        });
        continue;
      }

      const slugBase =
        makeHandbookSlug(proposal.title.trim()) || "handbook-article";
      const siblings = await tx.handbookArticle.findMany({
        where: { organizationId, slug: { startsWith: slugBase } },
        select: { slug: true },
      });
      const taken = new Set(siblings.map(({ slug }) => slug));
      let slug = slugBase;
      let suffix = 2;
      while (taken.has(slug)) slug = `${slugBase}-${suffix++}`;
      await tx.handbookArticle.create({
        data: {
          organizationId,
          slug,
          draftTitle: proposal.title.trim(),
          draftContent: proposal.content.trim(),
          handbookCategoryId: categoryId ?? null,
          draftSourceUrls: importedSources,
          createdByUserId: userId,
          updatedByUserId: userId,
        },
      });
      created.push({ slug, title: proposal.title.trim(), revision: false });
    }
    return { categoryId: categoryId ?? null, created };
  });
}

type HandbookTransactionClient = Omit<ExtendedPrismaClient, ITXClientDenyList>;

async function getDisplayNamesByUserId(userIds: string[]) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return new Map<string, string | null>();
  const users = await db.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, displayName: true, firstName: true, lastName: true },
  });
  return new Map(users.map((user) => [user.id, resolveUserDisplayName(user)]));
}

const handbookReferences = {
  sources: {
    select: {
      source: { select: { id: true, title: true, url: true, kind: true } },
    },
  },
} satisfies PrismaTypes.HandbookArticleVersionInclude;

export async function listPublishedHandbookArticles({
  organizationId,
  query = "",
  handbookCategoryId,
}: {
  organizationId: string;
  query?: string;
  handbookCategoryId?: string;
}) {
  const search = query.trim().slice(0, 120);
  const articles = await db.handbookArticle.findMany({
    where: {
      organizationId,
      status: HandbookArticleStatus.PUBLISHED,
      ...(handbookCategoryId ? { handbookCategoryId } : {}),
      publishedVersion: {
        is: {
          ...(search
            ? {
                OR: [
                  { title: { contains: search, mode: "insensitive" } },
                  { summary: { contains: search, mode: "insensitive" } },
                  { content: { contains: search, mode: "insensitive" } },
                ],
              }
            : {}),
        },
      },
    },
    orderBy: [{ isStartHere: "desc" }, { position: "asc" }, { slug: "asc" }],
    select: {
      id: true,
      slug: true,
      updatedAt: true,
      isStartHere: true,
      position: true,
      handbookCategory: { select: { id: true, name: true } },
      publishedVersion: {
        include: {
          ...handbookReferences,
        },
      },
    },
  });
  return articles;
}

export async function updateHandbookArticleNavigation({
  organizationId,
  articleId,
  intent,
}: {
  organizationId: string;
  articleId: string;
  intent: "set-start-here" | "unset-start-here" | "move-up" | "move-down";
}) {
  return db.$transaction(async (tx) => {
    const article = await tx.handbookArticle.findFirst({
      where: {
        id: articleId,
        organizationId,
        status: HandbookArticleStatus.PUBLISHED,
        handbookCategoryId: { not: null },
      },
      select: {
        id: true,
        handbookCategoryId: true,
        isStartHere: true,
        position: true,
      },
    });
    if (!article?.handbookCategoryId) {
      throw new HandbookValidationError(
        "That published Handbook article could not be found in a category."
      );
    }

    if (intent === "set-start-here" || intent === "unset-start-here") {
      await tx.handbookArticle.update({
        where: { id: article.id, organizationId },
        data: { isStartHere: intent === "set-start-here" },
      });
      return { articleId: article.id };
    }

    const siblings = await tx.handbookArticle.findMany({
      where: {
        organizationId,
        handbookCategoryId: article.handbookCategoryId,
        status: HandbookArticleStatus.PUBLISHED,
        isStartHere: article.isStartHere,
      },
      orderBy: [{ position: "asc" }, { slug: "asc" }],
      select: { id: true, position: true },
    });
    const index = siblings.findIndex((sibling) => sibling.id === article.id);
    const targetIndex = intent === "move-up" ? index - 1 : index + 1;
    const target = siblings[targetIndex];
    if (index < 0 || !target) return { articleId: article.id };

    await tx.handbookArticle.update({
      where: { id: article.id, organizationId },
      data: { position: target.position },
    });
    await tx.handbookArticle.update({
      where: { id: target.id, organizationId },
      data: { position: article.position },
    });
    return { articleId: article.id };
  });
}

export async function listHandbookArticleTitles({
  organizationId,
  handbookCategoryId,
}: {
  organizationId: string;
  handbookCategoryId?: string;
}) {
  const articles = await db.handbookArticle.findMany({
    where: {
      organizationId,
      status: HandbookArticleStatus.PUBLISHED,
      ...(handbookCategoryId ? { handbookCategoryId } : {}),
      publishedVersion: { is: {} },
    },
    orderBy: [{ publishedVersion: { title: "asc" } }, { slug: "asc" }],
    take: 500,
    select: {
      id: true,
      slug: true,
      handbookCategoryId: true,
      publishedVersionId: true,
      handbookCategory: { select: { name: true } },
      publishedVersion: { select: { title: true } },
    },
  });
  return articles.flatMap((article) =>
    article.publishedVersion
      ? [
          {
            id: article.id,
            slug: article.slug,
            title: article.publishedVersion.title,
            handbookCategoryId: article.handbookCategoryId,
            publishedVersionId: article.publishedVersionId,
            categoryName: article.handbookCategory?.name ?? "",
          },
        ]
      : []
  );
}

export async function getPublishedHandbookArticle({
  organizationId,
  slug,
  versionId,
  compareVersionId,
}: {
  organizationId: string;
  slug: string;
  versionId?: string;
  compareVersionId?: string;
}) {
  const article = await db.handbookArticle.findFirst({
    where: {
      organizationId,
      slug,
      status: HandbookArticleStatus.PUBLISHED,
      publishedVersionId: { not: null },
    },
    select: {
      id: true,
      slug: true,
      updatedAt: true,
      handbookCategory: { select: { id: true, name: true } },
      publishedVersion: {
        include: {
          ...handbookReferences,
        },
      },
      versions: {
        orderBy: { versionNumber: "desc" },
        select: {
          id: true,
          versionNumber: true,
          title: true,
          publishedAt: true,
          publishedByUserId: true,
        },
      },
    },
  });
  if (!article?.publishedVersion) return null;
  const [selectedVersion, comparisonVersion] = await Promise.all([
    versionId
      ? db.handbookArticleVersion.findFirst({
          where: { id: versionId, articleId: article.id },
          include: { ...handbookReferences },
        })
      : Promise.resolve(article.publishedVersion),
    compareVersionId
      ? db.handbookArticleVersion.findFirst({
          where: { id: compareVersionId, articleId: article.id },
          include: { ...handbookReferences },
        })
      : Promise.resolve(null),
  ]);
  if (!selectedVersion) return null;
  if (compareVersionId && !comparisonVersion) return null;
  const authorNames = await getDisplayNamesByUserId([
    selectedVersion.publishedByUserId,
    ...(comparisonVersion ? [comparisonVersion.publishedByUserId] : []),
    ...article.versions.map((version) => version.publishedByUserId),
  ]);
  return {
    ...article,
    publishedVersion: {
      ...selectedVersion,
      publishedByName:
        authorNames.get(selectedVersion.publishedByUserId) ?? null,
    },
    comparisonVersion: comparisonVersion
      ? {
          ...comparisonVersion,
          publishedByName:
            authorNames.get(comparisonVersion.publishedByUserId) ?? null,
        }
      : null,
    versions: article.versions.map((version) => ({
      ...version,
      publishedBy: authorNames.get(version.publishedByUserId) ?? null,
    })),
  };
}

export async function getHandbookEditData({
  organizationId,
  articleId,
  slug,
  ownerUserId,
  userId,
  revisionMode = false,
}: {
  organizationId: string;
  articleId?: string;
  slug?: string;
  ownerUserId?: string;
  userId?: string;
  revisionMode?: boolean;
}) {
  const [article, categories] = await Promise.all([
    articleId || slug
      ? db.handbookArticle.findFirst({
          where: articleId
            ? {
                id: articleId,
                organizationId,
                ...(ownerUserId ? { createdByUserId: ownerUserId } : {}),
              }
            : {
                slug,
                organizationId,
                ...(revisionMode
                  ? { status: HandbookArticleStatus.PUBLISHED }
                  : ownerUserId
                  ? {
                      OR: [
                        {
                          createdByUserId: ownerUserId,
                          status: HandbookArticleStatus.DRAFT,
                        },
                        ...(revisionMode
                          ? [{ status: HandbookArticleStatus.PUBLISHED }]
                          : []),
                      ],
                    }
                  : {}),
              },
          select: {
            id: true,
            status: true,
            draftTitle: true,
            draftContent: true,
            draftSourceUrls: true,
            handbookCategoryId: true,
            updatedByUserId: true,
            publishedVersionId: true,
            publishedVersion: {
              include: { ...handbookReferences },
            },
            observations: {
              where: { status: HandbookObservationStatus.PENDING_REVIEW },
              orderBy: { createdAt: "desc" },
              take: 10,
              select: {
                proposedCategoryName: true,
                handbookCategoryId: true,
                publishedVersionId: true,
                contributorUserId: true,
              },
            },
            versions: {
              orderBy: { versionNumber: "desc" },
              take: 10,
              select: {
                versionNumber: true,
                title: true,
                publishedAt: true,
                publishedByUserId: true,
              },
            },
          },
        })
      : null,
    db.handbookCategory.findMany({
      where: { organizationId, archivedAt: null },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      select: { id: true, name: true },
    }),
  ]);
  const authorNames = await getDisplayNamesByUserId(
    article?.versions.map((version) => version.publishedByUserId) ?? []
  );
  return {
    article: article
      ? {
          ...article,
          proposedCategoryName:
            article.observations.find((item) => item.proposedCategoryName)
              ?.proposedCategoryName ?? null,
          revisionCategoryId:
            article.observations.find((item) => item.publishedVersionId)
              ?.handbookCategoryId ?? article.handbookCategoryId,
          revisionBaseVersionId:
            article.observations.find((item) => item.publishedVersionId)
              ?.publishedVersionId ?? article.publishedVersionId,
          revisionContributorUserId:
            article.observations.find((item) => item.publishedVersionId)
              ?.contributorUserId ?? null,
          revisionSubmitted: article.observations.some((item) =>
            Boolean(item.publishedVersionId)
          ),
          ...(revisionMode && article.status === HandbookArticleStatus.PUBLISHED
            ? (() => {
                const ownSavedRevision =
                  userId && article.updatedByUserId === userId;
                const published = article.publishedVersion;
                const pendingRevision = Boolean(
                  article.observations.some((item) => item.publishedVersionId)
                );
                return {
                  draftTitle:
                    ownSavedRevision || pendingRevision
                      ? article.draftTitle
                      : published?.title ?? article.draftTitle,
                  draftContent:
                    ownSavedRevision || pendingRevision
                      ? article.draftContent
                      : published?.content ?? article.draftContent,
                  draftSourceUrls:
                    ownSavedRevision || pendingRevision
                      ? article.draftSourceUrls
                      : published?.sources
                          .map(({ source }) => source.url)
                          .filter((url): url is string => Boolean(url)) ??
                        article.draftSourceUrls,
                  handbookCategoryId:
                    article.observations.find((item) => item.publishedVersionId)
                      ?.handbookCategoryId ?? article.handbookCategoryId,
                };
              })()
            : {}),
          versions: article.versions.map((version) => ({
            ...version,
            publishedBy: authorNames.get(version.publishedByUserId) ?? null,
          })),
        }
      : null,
    categories,
  };
}

export async function listHandbookCategories(organizationId: string) {
  return db.handbookCategory.findMany({
    where: { organizationId, archivedAt: null },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    select: { id: true, name: true },
  });
}

export async function listHandbookCategoriesForManagement(
  organizationId: string
) {
  return db.handbookCategory.findMany({
    where: { organizationId, archivedAt: null },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    select: {
      id: true,
      name: true,
      _count: { select: { articles: true } },
    },
  });
}

export function normalizeHandbookCategoryName(value: string) {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

function cleanHandbookCategoryName(value: string) {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

export async function createHandbookCategory({
  organizationId,
  name,
}: {
  organizationId: string;
  name: string;
}) {
  const cleanedName = cleanHandbookCategoryName(name);
  const normalizedName = normalizeHandbookCategoryName(cleanedName);
  if (!normalizedName || cleanedName.length > 80) {
    throw new HandbookValidationError(
      "Enter a Handbook category name up to 80 characters."
    );
  }

  try {
    return await db.$transaction(async (tx) => {
      const existing = await tx.handbookCategory.findUnique({
        where: {
          organizationId_normalizedName: { organizationId, normalizedName },
        },
        select: { id: true, name: true, archivedAt: true },
      });
      if (existing) {
        if (existing.archivedAt) {
          const category = await tx.handbookCategory.update({
            where: { id: existing.id, organizationId },
            data: { name: cleanedName, archivedAt: null },
            select: { id: true, name: true },
          });
          return { ...category, alreadyExists: false };
        }
        return { id: existing.id, name: existing.name, alreadyExists: true };
      }

      const slugBase =
        makeHandbookSlug(cleanedName).slice(0, 100) || "category";
      let slug = slugBase;
      let suffix = 2;
      while (
        await tx.handbookCategory.findUnique({
          where: { organizationId_slug: { organizationId, slug } },
          select: { id: true },
        })
      ) {
        const suffixText = `-${suffix++}`;
        slug = `${slugBase.slice(0, 100 - suffixText.length)}${suffixText}`;
      }

      const category = await tx.handbookCategory.create({
        data: { organizationId, name: cleanedName, slug, normalizedName },
        select: { id: true, name: true },
      });
      return { ...category, alreadyExists: false };
    });
  } catch (cause) {
    if (
      cause instanceof Prisma.PrismaClientKnownRequestError &&
      cause.code === "P2002"
    ) {
      const existing = await db.handbookCategory.findUnique({
        where: {
          organizationId_normalizedName: { organizationId, normalizedName },
        },
        select: { id: true, name: true, archivedAt: true },
      });
      if (existing && !existing.archivedAt) {
        return {
          id: existing.id,
          name: existing.name,
          alreadyExists: true,
        };
      }
    }
    throw cause;
  }
}

export async function renameHandbookCategory({
  organizationId,
  categoryId,
  name,
}: {
  organizationId: string;
  categoryId: string;
  name: string;
}) {
  const cleanedName = cleanHandbookCategoryName(name);
  const normalizedName = normalizeHandbookCategoryName(cleanedName);
  if (!normalizedName || cleanedName.length > 80) {
    throw new HandbookValidationError(
      "Enter a Handbook category name up to 80 characters."
    );
  }
  const current = await db.handbookCategory.findFirst({
    where: { id: categoryId, organizationId, archivedAt: null },
    select: { id: true, name: true, normalizedName: true },
  });
  if (!current) {
    throw new HandbookValidationError(
      "That Handbook category is not available in this workspace."
    );
  }
  if (current.normalizedName === normalizedName) {
    return { id: current.id, name: current.name, unchanged: true };
  }
  const duplicate = await db.handbookCategory.findFirst({
    where: { organizationId, normalizedName },
    select: { id: true },
  });
  if (duplicate && duplicate.id !== current.id) {
    throw new HandbookValidationError(
      "An equivalent Handbook category already exists."
    );
  }
  try {
    const category = await db.handbookCategory.update({
      where: { id: current.id, organizationId },
      data: { name: cleanedName, normalizedName },
      select: { id: true, name: true },
    });
    return { ...category, unchanged: false };
  } catch (cause) {
    if (
      cause instanceof Prisma.PrismaClientKnownRequestError &&
      cause.code === "P2002"
    ) {
      throw new HandbookValidationError(
        "An equivalent Handbook category already exists."
      );
    }
    throw cause;
  }
}

function cleanSourceUrls(values: string[]) {
  return [
    ...new Set(
      values
        .map(normalizeSourceUrl)
        .filter((url): url is string => Boolean(url))
    ),
  ].slice(0, 20);
}

export async function saveHandbookDraft({
  organizationId,
  userId,
  articleId,
  ownerUserId,
  revisionMode = false,
  revisionBaseVersionId,
  revisionOwnerUserId,
  title,
  handbookCategoryId,
  content,
  sourceUrls,
}: {
  organizationId: string;
  userId: string;
  articleId?: string;
  ownerUserId?: string;
  revisionMode?: boolean;
  revisionBaseVersionId?: string;
  revisionOwnerUserId?: string;
  title: string;
  handbookCategoryId?: string;
  content: string;
  sourceUrls: string[];
}) {
  const normalizedTitle = title.trim();
  const normalizedContent = content.trim();
  if (!normalizedTitle || !normalizedContent) {
    throw new HandbookValidationError(
      "Add a title and article content before saving."
    );
  }
  if (normalizedTitle.length > 180 || normalizedContent.length > 30_000) {
    throw new HandbookValidationError(
      "One or more fields are longer than the allowed limit."
    );
  }
  const category = handbookCategoryId
    ? await db.handbookCategory.findFirst({
        where: { id: handbookCategoryId, organizationId, archivedAt: null },
        select: { id: true },
      })
    : null;
  if (handbookCategoryId && !category) {
    throw new HandbookValidationError(
      "Choose a category from this Handbook workspace."
    );
  }
  const submittedSources = sourceUrls.map((url) => url.trim()).filter(Boolean);
  const validSources = cleanSourceUrls(sourceUrls);
  if (
    submittedSources.length !== validSources.length ||
    submittedSources.length > 20 ||
    validSources.some((url) => url.length > 500)
  ) {
    throw new HandbookValidationError(
      "References must be valid http(s) URLs up to 500 characters, with no more than 20 links."
    );
  }

  const slugBase = makeHandbookSlug(normalizedTitle) || "handbook-article";
  if (articleId && revisionMode) {
    if (!revisionBaseVersionId) {
      throw new HandbookValidationError(
        "Reopen the current published article before proposing an improvement."
      );
    }
    const current = await db.handbookArticle.findFirst({
      where: {
        id: articleId,
        organizationId,
        status: HandbookArticleStatus.PUBLISHED,
        publishedVersionId: revisionBaseVersionId,
      },
      select: {
        id: true,
        slug: true,
        draftTitle: true,
        draftContent: true,
        draftSourceUrls: true,
        updatedByUserId: true,
        publishedVersion: {
          select: {
            title: true,
            content: true,
            sources: { select: { source: { select: { url: true } } } },
          },
        },
        observations: {
          where: {
            status: HandbookObservationStatus.PENDING_REVIEW,
            publishedVersionId: { not: null },
          },
          take: 1,
          select: { id: true },
        },
      },
    });
    if (!current?.publishedVersion) {
      throw new HandbookValidationError(
        "The published article changed. Reopen it before proposing an improvement."
      );
    }
    if (current.observations.length) {
      throw new HandbookValidationError(
        "A revision of this article is already awaiting Staff review."
      );
    }
    if (
      revisionOwnerUserId &&
      current.updatedByUserId !== revisionOwnerUserId &&
      (current.draftTitle !== current.publishedVersion.title ||
        current.draftContent !== current.publishedVersion.content ||
        JSON.stringify(cleanSourceUrls(current.draftSourceUrls)) !==
          JSON.stringify(
            cleanSourceUrls(
              current.publishedVersion.sources
                .map(({ source }) => source.url)
                .filter((url): url is string => Boolean(url))
            )
          ))
    ) {
      throw new HandbookValidationError(
        "Another draft improvement is in progress for this article."
      );
    }
    const updated = await db.handbookArticle.updateMany({
      where: {
        id: current.id,
        organizationId,
        status: HandbookArticleStatus.PUBLISHED,
        publishedVersionId: revisionBaseVersionId,
        updatedByUserId: current.updatedByUserId,
      },
      data: {
        draftTitle: normalizedTitle,
        draftContent: normalizedContent,
        draftSourceUrls: validSources,
        updatedByUserId: userId,
      },
    });
    if (!updated.count) {
      throw new HandbookValidationError(
        "Another contribution changed this article. Reopen it before saving your improvement."
      );
    }
    return { id: current.id, slug: current.slug, status: "PUBLISHED" as const };
  }

  if (articleId) {
    const current = await db.handbookArticle.findFirst({
      where: {
        id: articleId,
        organizationId,
        ...(ownerUserId ? { createdByUserId: ownerUserId } : {}),
        ...(ownerUserId ? { status: HandbookArticleStatus.DRAFT } : {}),
      },
      select: { id: true, slug: true },
    });
    if (!current)
      throw new HandbookValidationError(
        "That Handbook draft could not be found."
      );
    return db.handbookArticle.update({
      where: {
        id: current.id,
        organizationId,
        ...(ownerUserId ? { createdByUserId: ownerUserId } : {}),
        ...(ownerUserId ? { status: HandbookArticleStatus.DRAFT } : {}),
      },
      data: {
        draftTitle: normalizedTitle,
        draftContent: normalizedContent,
        handbookCategoryId: category?.id ?? null,
        draftSourceUrls: validSources,
        updatedByUserId: userId,
      },
      select: { id: true, slug: true, status: true },
    });
  }

  const siblingSlugs = await db.handbookArticle.findMany({
    where: { organizationId, slug: { startsWith: slugBase } },
    select: { slug: true },
  });
  const taken = new Set(siblingSlugs.map(({ slug }) => slug));
  let slug = slugBase;
  let suffix = 2;
  while (taken.has(slug)) slug = `${slugBase}-${suffix++}`;
  return db.handbookArticle.create({
    data: {
      organizationId,
      slug,
      draftTitle: normalizedTitle,
      draftContent: normalizedContent,
      handbookCategoryId: category?.id ?? null,
      draftSourceUrls: validSources,
      createdByUserId: userId,
      updatedByUserId: userId,
    },
    select: { id: true, slug: true, status: true },
  });
}

async function publishHandbookArticleInTransaction(
  tx: HandbookTransactionClient,
  {
    organizationId,
    userId,
    articleId,
    handbookCategoryId,
  }: {
    organizationId: string;
    userId: string;
    articleId: string;
    handbookCategoryId?: string;
  }
) {
  const article = await tx.handbookArticle.findFirst({
    where: { id: articleId, organizationId },
  });
  if (!article)
    throw new HandbookValidationError(
      "That Handbook article could not be found."
    );
  const targetCategoryId = handbookCategoryId ?? article.handbookCategoryId;
  const category = targetCategoryId
    ? await tx.handbookCategory.findFirst({
        where: {
          id: targetCategoryId,
          organizationId,
          archivedAt: null,
        },
        select: { id: true },
      })
    : null;
  if (!category) {
    throw new HandbookValidationError(
      "Choose a category from this Shelf workspace before publishing."
    );
  }
  const categoryChanged = article.handbookCategoryId !== category.id;
  const needsPosition = categoryChanged || article.position <= 0;
  if (needsPosition) {
    const maxPosition = await tx.handbookArticle.aggregate({
      where: {
        organizationId,
        handbookCategoryId: category.id,
        id: { not: article.id },
      },
      _max: { position: true },
    });
    await tx.handbookArticle.update({
      where: { id: article.id, organizationId },
      data: {
        ...(categoryChanged ? { handbookCategoryId: category.id } : {}),
        position: (maxPosition._max.position ?? 0) + 1,
      },
    });
  }
  const max = await tx.handbookArticleVersion.aggregate({
    where: { articleId },
    _max: { versionNumber: true },
  });
  const version = await tx.handbookArticleVersion.create({
    data: {
      articleId,
      versionNumber: (max._max.versionNumber ?? 0) + 1,
      title: article.draftTitle,
      content: article.draftContent,
      publishedByUserId: userId,
    },
  });
  const sourceIds: string[] = [];
  for (const sourceUrl of cleanSourceUrls(article.draftSourceUrls)) {
    const title = new URL(sourceUrl).hostname.replace(/^www\./, "");
    const source = await tx.handbookSource.upsert({
      where: { organizationId_url: { organizationId, url: sourceUrl } },
      create: {
        organizationId,
        kind: HandbookSourceKind.EXTERNAL_REFERENCE,
        title,
        url: sourceUrl,
        createdByUserId: userId,
      },
      update: { title },
      select: { id: true },
    });
    sourceIds.push(source.id);
  }
  if (sourceIds.length) {
    await tx.handbookVersionSource.createMany({
      data: sourceIds.map((sourceId) => ({
        versionId: version.id,
        sourceId,
      })),
      skipDuplicates: true,
    });
  }
  await tx.handbookArticle.update({
    where: { id: article.id, organizationId },
    data: {
      status: HandbookArticleStatus.PUBLISHED,
      publishedVersionId: version.id,
      updatedByUserId: userId,
    },
  });
  await recordEvent(
    {
      action: "IOIO_HANDBOOK_ARTICLE_PUBLISHED",
      organizationId,
      actorUserId: userId,
      entityType: "HANDBOOK_ARTICLE",
      entityId: article.id,
      meta: {
        versionId: version.id,
        versionNumber: version.versionNumber,
      } as PrismaTypes.InputJsonValue,
    },
    tx
  );
  return {
    articleId: article.id,
    slug: article.slug,
    versionNumber: version.versionNumber,
  };
}

export async function publishHandbookArticle({
  organizationId,
  userId,
  articleId,
  handbookCategoryId,
}: {
  organizationId: string;
  userId: string;
  articleId: string;
  handbookCategoryId?: string;
}) {
  return db.$transaction((tx) =>
    publishHandbookArticleInTransaction(tx, {
      organizationId,
      userId,
      articleId,
      handbookCategoryId,
    })
  );
}

export async function approveHandbookArticleRevision({
  organizationId,
  userId,
  observationId,
}: {
  organizationId: string;
  userId: string;
  observationId: string;
}) {
  return db.$transaction(async (tx) => {
    const observation = await tx.handbookObservation.findFirst({
      where: {
        id: observationId,
        organizationId,
        status: HandbookObservationStatus.PENDING_REVIEW,
        publishedVersionId: { not: null },
        articleId: { not: null },
      },
      select: {
        id: true,
        articleId: true,
        publishedVersionId: true,
        handbookCategoryId: true,
        proposedCategoryName: true,
      },
    });
    if (
      !observation?.articleId ||
      !observation.publishedVersionId ||
      observation.proposedCategoryName
    ) {
      throw new HandbookValidationError(
        "Resolve the proposed category before approving this article improvement."
      );
    }
    const article = await tx.handbookArticle.findFirst({
      where: {
        id: observation.articleId,
        organizationId,
        status: HandbookArticleStatus.PUBLISHED,
        publishedVersionId: observation.publishedVersionId,
      },
      select: { id: true, handbookCategoryId: true },
    });
    if (!article) {
      throw new HandbookValidationError(
        "The current published article changed. This proposed revision needs review against the latest version."
      );
    }
    const categoryId =
      observation.handbookCategoryId ?? article.handbookCategoryId;
    if (!categoryId) {
      throw new HandbookValidationError(
        "Choose a Handbook category before approving this revision."
      );
    }
    const category = await tx.handbookCategory.findFirst({
      where: { id: categoryId, organizationId, archivedAt: null },
      select: { id: true },
    });
    if (!category) {
      throw new HandbookValidationError(
        "Choose a category from this Handbook workspace."
      );
    }
    await tx.handbookArticle.update({
      where: {
        id: article.id,
        organizationId,
        status: HandbookArticleStatus.PUBLISHED,
        publishedVersionId: observation.publishedVersionId,
      },
      data: { handbookCategoryId: category.id },
    });
    const published = await publishHandbookArticleInTransaction(tx, {
      organizationId,
      userId,
      articleId: article.id,
    });
    const reviewed = await tx.handbookObservation.updateMany({
      where: {
        id: observation.id,
        organizationId,
        status: HandbookObservationStatus.PENDING_REVIEW,
        publishedVersionId: observation.publishedVersionId,
      },
      data: {
        status: HandbookObservationStatus.REVIEWED,
        reviewedByUserId: userId,
        reviewedAt: new Date(),
      },
    });
    if (!reviewed.count) {
      throw new HandbookValidationError(
        "This article improvement is no longer awaiting review."
      );
    }
    return published;
  });
}

export async function submitHandbookObservation({
  organizationId,
  userId,
  title,
  content,
  articleId,
  handbookCategoryId,
  proposedCategoryName,
  assetModelId,
  kitId,
}: {
  organizationId: string;
  userId: string;
  title: string;
  content: string;
  articleId?: string;
  handbookCategoryId?: string;
  proposedCategoryName?: string;
  assetModelId?: string;
  kitId?: string;
}) {
  const normalizedTitle = title.trim();
  const normalizedContent = content.trim();
  if (!normalizedTitle || !normalizedContent)
    throw new HandbookValidationError("Add a short title and useful details.");
  if (normalizedTitle.length > 180 || normalizedContent.length > 4000)
    throw new HandbookValidationError(
      "The contribution is longer than the allowed limit."
    );
  const cleanedProposal = proposedCategoryName
    ? cleanHandbookCategoryName(proposedCategoryName)
    : "";
  if (cleanedProposal.length > 80) {
    throw new HandbookValidationError(
      "Handbook category names can be up to 80 characters."
    );
  }
  if (handbookCategoryId && cleanedProposal) {
    throw new HandbookValidationError(
      "Choose an existing Handbook category or propose a new one."
    );
  }
  let selectedHandbookCategoryId = handbookCategoryId || null;
  let pendingCategoryProposal: string | null = cleanedProposal || null;
  if (handbookCategoryId) {
    const category = await db.handbookCategory.findFirst({
      where: { id: handbookCategoryId, organizationId, archivedAt: null },
      select: { id: true },
    });
    if (!category) {
      throw new HandbookValidationError(
        "Choose a category from this Handbook workspace."
      );
    }
  } else if (cleanedProposal) {
    const existingCategory = await db.handbookCategory.findFirst({
      where: {
        organizationId,
        archivedAt: null,
        normalizedName: normalizeHandbookCategoryName(cleanedProposal),
      },
      select: { id: true },
    });
    if (existingCategory) {
      selectedHandbookCategoryId = existingCategory.id;
      pendingCategoryProposal = null;
    }
  }
  if (articleId) {
    const matchingArticle = await db.handbookArticle.findFirst({
      where: {
        id: articleId,
        organizationId,
        status: HandbookArticleStatus.PUBLISHED,
      },
      select: { id: true },
    });
    if (!matchingArticle)
      throw new HandbookValidationError(
        "The selected published Handbook page is not available."
      );
  }
  if (
    assetModelId &&
    !(await db.assetModel.findFirst({
      where: { id: assetModelId, organizationId },
      select: { id: true },
    }))
  ) {
    throw new HandbookValidationError(
      "The selected inventory product is not in this workspace."
    );
  }
  if (
    kitId &&
    !(await db.kit.findFirst({
      where: { id: kitId, organizationId },
      select: { id: true },
    }))
  ) {
    throw new HandbookValidationError(
      "The selected Kit is not in this workspace."
    );
  }
  const related = await findRelatedHandbookKnowledge({
    organizationId,
    text: normalizedContent,
  });
  const duplicate = related.find((item) => item.duplicate);
  if (duplicate) {
    return {
      duplicate: true as const,
      duplicateKind: duplicate.kind,
      duplicateTitle: duplicate.title,
      related,
    };
  }

  const observation = await db.$transaction(async (tx) => {
    const created = await tx.handbookObservation.create({
      data: {
        organizationId,
        contributorUserId: userId,
        title: normalizedTitle,
        content: normalizedContent,
        articleId: articleId || null,
        handbookCategoryId: selectedHandbookCategoryId,
        proposedCategoryName: pendingCategoryProposal,
        assetModelId: assetModelId || null,
        kitId: kitId || null,
      },
      select: { id: true, title: true },
    });
    await recordEvent(
      {
        action: "IOIO_HANDBOOK_OBSERVATION_SUBMITTED",
        organizationId,
        actorUserId: userId,
        entityType: "HANDBOOK_ARTICLE",
        entityId: articleId ?? created.id,
        meta: {
          observationId: created.id,
          linkedArticleId: articleId ?? null,
        } as PrismaTypes.InputJsonValue,
      },
      tx
    );
    return created;
  });
  return { ...observation, duplicate: false as const, related };
}

export async function submitHandbookDraftForReview({
  organizationId,
  userId,
  articleId,
  proposedCategoryName,
  handbookCategoryId: proposedHandbookCategoryId,
  revisionMode = false,
  revisionBaseVersionId,
}: {
  organizationId: string;
  userId: string;
  articleId: string;
  proposedCategoryName?: string;
  handbookCategoryId?: string;
  revisionMode?: boolean;
  revisionBaseVersionId?: string;
}) {
  if (revisionMode) {
    if (!revisionBaseVersionId) {
      throw new HandbookValidationError(
        "Reopen the current published article before submitting an improvement."
      );
    }
    const article = await db.handbookArticle.findFirst({
      where: {
        id: articleId,
        organizationId,
        status: HandbookArticleStatus.PUBLISHED,
        publishedVersionId: revisionBaseVersionId,
        updatedByUserId: userId,
      },
      select: {
        id: true,
        draftTitle: true,
        draftContent: true,
        draftSourceUrls: true,
        handbookCategoryId: true,
        publishedVersionId: true,
        publishedVersion: {
          select: {
            versionNumber: true,
            title: true,
            content: true,
            sources: { select: { source: { select: { url: true } } } },
          },
        },
      },
    });
    if (!article?.publishedVersionId || !article.publishedVersion) {
      throw new HandbookValidationError(
        "That article improvement could not be found or the current version changed."
      );
    }
    const pendingRevision = await db.handbookObservation.findFirst({
      where: {
        organizationId,
        articleId: article.id,
        status: HandbookObservationStatus.PENDING_REVIEW,
        publishedVersionId: { not: null },
      },
      select: { id: true },
    });
    if (pendingRevision) {
      throw new HandbookValidationError(
        "A revision of this article is already awaiting Staff review."
      );
    }

    const cleanedProposal = proposedCategoryName
      ? cleanHandbookCategoryName(proposedCategoryName)
      : "";
    if (cleanedProposal.length > 80) {
      throw new HandbookValidationError(
        "Handbook category names can be up to 80 characters."
      );
    }
    let selectedCategoryId: string | null =
      proposedHandbookCategoryId ?? article.handbookCategoryId;
    let pendingCategoryProposal = cleanedProposal || null;
    if (cleanedProposal) {
      const existingCategory = await db.handbookCategory.findFirst({
        where: {
          organizationId,
          archivedAt: null,
          normalizedName: normalizeHandbookCategoryName(cleanedProposal),
        },
        select: { id: true },
      });
      if (existingCategory) {
        selectedCategoryId = existingCategory.id;
        pendingCategoryProposal = null;
      } else {
        selectedCategoryId = null;
      }
    }
    if (selectedCategoryId) {
      const category = await db.handbookCategory.findFirst({
        where: {
          id: selectedCategoryId,
          organizationId,
          archivedAt: null,
        },
        select: { id: true },
      });
      if (!category) {
        throw new HandbookValidationError(
          "Choose a category from this Handbook workspace."
        );
      }
      selectedCategoryId = category.id;
    }
    if (!selectedCategoryId && !pendingCategoryProposal) {
      throw new HandbookValidationError(
        "Choose an existing Handbook category or propose a new one."
      );
    }
    const currentSourceUrls = cleanSourceUrls(
      article.publishedVersion.sources
        .map(({ source }) => source.url)
        .filter((url): url is string => Boolean(url))
    );
    const proposedSourceUrls = cleanSourceUrls(article.draftSourceUrls);
    const revisionHasChanges =
      article.draftTitle !== article.publishedVersion.title ||
      article.draftContent !== article.publishedVersion.content ||
      JSON.stringify(proposedSourceUrls) !==
        JSON.stringify(currentSourceUrls) ||
      Boolean(pendingCategoryProposal) ||
      selectedCategoryId !== article.handbookCategoryId;
    if (!revisionHasChanges) {
      throw new HandbookValidationError(
        "Make an improvement before submitting this revision."
      );
    }
    const baseVersionNumber = article.publishedVersion.versionNumber;
    const observation = await db.$transaction(async (tx) => {
      const created = await tx.handbookObservation.create({
        data: {
          organizationId,
          contributorUserId: userId,
          title: `Proposed improvement: ${article.draftTitle}`.slice(0, 180),
          content: `Proposed changes to Version ${baseVersionNumber}. The current published version remains live until Staff approval.`,
          articleId: article.id,
          handbookCategoryId: selectedCategoryId ?? null,
          proposedCategoryName: pendingCategoryProposal,
          publishedVersionId: article.publishedVersionId,
        },
        select: { id: true },
      });
      await recordEvent(
        {
          action: "IOIO_HANDBOOK_OBSERVATION_SUBMITTED",
          organizationId,
          actorUserId: userId,
          entityType: "HANDBOOK_ARTICLE",
          entityId: article.id,
          meta: {
            observationId: created.id,
            linkedArticleId: article.id,
            revisionOfVersionId: article.publishedVersionId,
          } as PrismaTypes.InputJsonValue,
        },
        tx
      );
      return created;
    });
    return { ...observation, alreadyPending: false as const };
  }

  const article = await db.handbookArticle.findFirst({
    where: {
      id: articleId,
      organizationId,
      createdByUserId: userId,
      status: HandbookArticleStatus.DRAFT,
    },
    select: {
      id: true,
      draftTitle: true,
      handbookCategoryId: true,
    },
  });
  if (!article) {
    throw new HandbookValidationError(
      "That Handbook draft could not be found."
    );
  }

  const cleanedProposal = proposedCategoryName
    ? cleanHandbookCategoryName(proposedCategoryName)
    : "";
  if (cleanedProposal.length > 80) {
    throw new HandbookValidationError(
      "Handbook category names can be up to 80 characters."
    );
  }
  if (article.handbookCategoryId && cleanedProposal) {
    throw new HandbookValidationError(
      "Choose an existing Handbook category or propose a new one."
    );
  }

  let handbookCategoryId = article.handbookCategoryId;
  let pendingCategoryProposal = cleanedProposal || null;
  if (cleanedProposal) {
    const existingCategory = await db.handbookCategory.findFirst({
      where: {
        organizationId,
        archivedAt: null,
        normalizedName: normalizeHandbookCategoryName(cleanedProposal),
      },
      select: { id: true },
    });
    if (existingCategory) {
      handbookCategoryId = existingCategory.id;
      pendingCategoryProposal = null;
    }
  }
  if (!handbookCategoryId && !pendingCategoryProposal) {
    throw new HandbookValidationError(
      "Choose an existing Handbook category or propose a new one."
    );
  }

  const pending = await db.handbookObservation.findFirst({
    where: {
      organizationId,
      contributorUserId: userId,
      articleId: article.id,
      status: HandbookObservationStatus.PENDING_REVIEW,
    },
    select: { id: true },
  });
  if (pending) {
    await db.$transaction(async (tx) => {
      if (handbookCategoryId !== article.handbookCategoryId) {
        await tx.handbookArticle.update({
          where: { id: article.id, organizationId },
          data: { handbookCategoryId },
          select: { id: true },
        });
      }
      await tx.handbookObservation.updateMany({
        where: {
          id: pending.id,
          organizationId,
          contributorUserId: userId,
          status: HandbookObservationStatus.PENDING_REVIEW,
        },
        data: {
          title: `Draft submitted for review: ${article.draftTitle}`.slice(
            0,
            180
          ),
          handbookCategoryId,
          proposedCategoryName: pendingCategoryProposal,
        },
      });
    });
    return { id: pending.id, alreadyPending: true as const };
  }

  const observation = await db.$transaction(async (tx) => {
    if (handbookCategoryId !== article.handbookCategoryId) {
      await tx.handbookArticle.update({
        where: { id: article.id, organizationId },
        data: { handbookCategoryId },
        select: { id: true },
      });
    }
    const created = await tx.handbookObservation.create({
      data: {
        organizationId,
        contributorUserId: userId,
        title: `Draft submitted for review: ${article.draftTitle}`.slice(
          0,
          180
        ),
        content:
          "A student Handbook draft is ready for staff review. Open the linked draft to review its title, category, content, and external references.",
        articleId: article.id,
        handbookCategoryId,
        proposedCategoryName: pendingCategoryProposal,
      },
      select: { id: true },
    });
    await recordEvent(
      {
        action: "IOIO_HANDBOOK_OBSERVATION_SUBMITTED",
        organizationId,
        actorUserId: userId,
        entityType: "HANDBOOK_ARTICLE",
        entityId: article.id,
        meta: {
          observationId: created.id,
          linkedArticleId: article.id,
        } as PrismaTypes.InputJsonValue,
      },
      tx
    );
    return created;
  });
  return { ...observation, alreadyPending: false as const };
}

export async function listHandbookObservations(organizationId: string) {
  const observations = await db.handbookObservation.findMany({
    where: { organizationId, status: HandbookObservationStatus.PENDING_REVIEW },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: {
      article: {
        select: {
          id: true,
          slug: true,
          status: true,
          draftTitle: true,
          draftContent: true,
          draftSourceUrls: true,
          publishedVersion: {
            select: { id: true, title: true, versionNumber: true },
          },
        },
      },
      handbookCategory: { select: { id: true, name: true } },
      assetModel: { select: { name: true } },
      kit: { select: { name: true } },
    },
  });
  const contributorNames = await getDisplayNamesByUserId(
    observations.map((observation) => observation.contributorUserId)
  );
  return observations.map((observation) => ({
    ...observation,
    contributorName:
      contributorNames.get(observation.contributorUserId) ?? null,
  }));
}

export async function listHandbookArticlesForStaff(organizationId: string) {
  return db.handbookArticle.findMany({
    where: { organizationId },
    orderBy: [{ updatedAt: "desc" }, { slug: "asc" }],
    take: 200,
    select: {
      id: true,
      slug: true,
      status: true,
      draftTitle: true,
      handbookCategory: { select: { id: true, name: true } },
      updatedAt: true,
      publishedVersion: {
        select: { title: true, versionNumber: true, publishedAt: true },
      },
    },
  });
}

export async function listMyHandbookDrafts({
  organizationId,
  userId,
}: {
  organizationId: string;
  userId: string;
}) {
  const [drafts, revisedArticles, pendingRevisions] = await Promise.all([
    db.handbookArticle.findMany({
      where: {
        organizationId,
        createdByUserId: userId,
        status: HandbookArticleStatus.DRAFT,
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
          where: {
            status: HandbookObservationStatus.PENDING_REVIEW,
            publishedVersionId: null,
          },
          take: 1,
          select: { id: true },
        },
      },
    }),
    db.handbookArticle.findMany({
      where: {
        organizationId,
        updatedByUserId: userId,
        status: HandbookArticleStatus.PUBLISHED,
        observations: {
          none: {
            status: HandbookObservationStatus.PENDING_REVIEW,
            publishedVersionId: { not: null },
          },
        },
      },
      orderBy: [{ updatedAt: "desc" }, { slug: "asc" }],
      take: 200,
      select: {
        id: true,
        slug: true,
        draftTitle: true,
        draftContent: true,
        updatedAt: true,
        handbookCategory: { select: { id: true, name: true } },
        publishedVersion: {
          select: { title: true, content: true, versionNumber: true },
        },
      },
    }),
    db.handbookObservation.findMany({
      where: {
        organizationId,
        contributorUserId: userId,
        status: HandbookObservationStatus.PENDING_REVIEW,
        publishedVersionId: { not: null },
        articleId: { not: null },
      },
      orderBy: { createdAt: "desc" },
      take: 200,
      select: {
        id: true,
        createdAt: true,
        handbookCategory: { select: { id: true, name: true } },
        publishedVersion: { select: { versionNumber: true } },
        article: {
          select: {
            id: true,
            slug: true,
            draftTitle: true,
            handbookCategory: { select: { id: true, name: true } },
          },
        },
      },
    }),
  ]);
  const newArticleWork = drafts.map(({ observations, ...draft }) => ({
    ...draft,
    articleId: draft.id,
    workType: "NEW_ARTICLE" as const,
    submittedForReview: observations.length > 0,
    baseVersionNumber: null,
  }));
  const improvementDrafts = revisedArticles
    .filter(
      (article) =>
        article.publishedVersion &&
        (article.draftTitle !== article.publishedVersion.title ||
          article.draftContent !== article.publishedVersion.content)
    )
    .map((article) => ({
      id: article.id,
      articleId: article.id,
      slug: article.slug,
      draftTitle: article.draftTitle,
      updatedAt: article.updatedAt,
      handbookCategory: article.handbookCategory,
      workType: "IMPROVEMENT_DRAFT" as const,
      submittedForReview: false,
      baseVersionNumber: article.publishedVersion!.versionNumber,
    }));
  const pendingImprovementWork = pendingRevisions.flatMap((observation) =>
    observation.article && observation.publishedVersion
      ? [
          {
            id: `revision:${observation.id}`,
            articleId: observation.article.id,
            slug: observation.article.slug,
            draftTitle: observation.article.draftTitle,
            updatedAt: observation.createdAt,
            handbookCategory:
              observation.handbookCategory ??
              observation.article.handbookCategory,
            workType: "IMPROVEMENT_PENDING" as const,
            submittedForReview: true,
            baseVersionNumber: observation.publishedVersion.versionNumber,
          },
        ]
      : []
  );
  return [
    ...newArticleWork,
    ...improvementDrafts,
    ...pendingImprovementWork,
  ].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

export async function deleteHandbookDraft({
  organizationId,
  articleId,
  userId,
  canManageAnyDraft = false,
}: {
  organizationId: string;
  articleId: string;
  userId: string;
  canManageAnyDraft?: boolean;
}) {
  return db.$transaction(async (tx) => {
    const scope = {
      id: articleId,
      organizationId,
      ...(!canManageAnyDraft ? { createdByUserId: userId } : {}),
    };
    const article = await tx.handbookArticle.findFirst({
      where: scope,
      select: {
        id: true,
        status: true,
        publishedVersionId: true,
        _count: { select: { versions: true } },
        observations: {
          where: { status: HandbookObservationStatus.PENDING_REVIEW },
          take: 1,
          select: { id: true },
        },
      },
    });
    if (!article) {
      throw new HandbookValidationError(
        "That Handbook draft could not be found or you do not have permission to delete it."
      );
    }
    if (
      article.status !== HandbookArticleStatus.DRAFT ||
      article.publishedVersionId ||
      article._count.versions > 0
    ) {
      throw new HandbookValidationError(
        "Only unpublished Handbook drafts without published history can be deleted."
      );
    }
    if (article.observations.length > 0) {
      throw new HandbookValidationError(
        "This draft has been submitted for Staff review and cannot be deleted."
      );
    }

    const deleted = await tx.handbookArticle.deleteMany({
      where: {
        ...scope,
        status: HandbookArticleStatus.DRAFT,
        publishedVersionId: null,
        versions: { none: {} },
        observations: {
          none: { status: HandbookObservationStatus.PENDING_REVIEW },
        },
      },
    });
    if (!deleted.count) {
      throw new HandbookValidationError(
        "This draft changed or was submitted for review before it could be deleted."
      );
    }
    return { id: article.id };
  });
}

export async function discardHandbookArticleRevisionDraft({
  organizationId,
  articleId,
  userId,
  canManageAnyDraft = false,
}: {
  organizationId: string;
  articleId: string;
  userId: string;
  canManageAnyDraft?: boolean;
}) {
  return db.$transaction(async (tx) => {
    const article = await tx.handbookArticle.findFirst({
      where: {
        id: articleId,
        organizationId,
        status: HandbookArticleStatus.PUBLISHED,
        ...(!canManageAnyDraft ? { updatedByUserId: userId } : {}),
      },
      select: {
        id: true,
        updatedByUserId: true,
        publishedVersionId: true,
        draftTitle: true,
        draftContent: true,
        publishedVersion: {
          select: {
            id: true,
            title: true,
            content: true,
            publishedByUserId: true,
            sources: { select: { source: { select: { url: true } } } },
          },
        },
        observations: {
          where: {
            status: HandbookObservationStatus.PENDING_REVIEW,
            publishedVersionId: { not: null },
          },
          take: 1,
          select: { id: true },
        },
      },
    });
    if (!article?.publishedVersion || !article.publishedVersionId) {
      throw new HandbookValidationError(
        "That draft improvement could not be found or you do not have permission to discard it."
      );
    }
    if (article.observations.length) {
      throw new HandbookValidationError(
        "This improvement is awaiting Staff review and cannot be discarded."
      );
    }
    if (
      article.draftTitle === article.publishedVersion.title &&
      article.draftContent === article.publishedVersion.content
    ) {
      throw new HandbookValidationError(
        "There is no draft improvement to discard."
      );
    }
    const updated = await tx.handbookArticle.updateMany({
      where: {
        id: article.id,
        organizationId,
        status: HandbookArticleStatus.PUBLISHED,
        publishedVersionId: article.publishedVersionId,
        ...(!canManageAnyDraft ? { updatedByUserId: userId } : {}),
        observations: {
          none: {
            status: HandbookObservationStatus.PENDING_REVIEW,
            publishedVersionId: { not: null },
          },
        },
      },
      data: {
        draftTitle: article.publishedVersion.title,
        draftContent: article.publishedVersion.content,
        draftSourceUrls: cleanSourceUrls(
          article.publishedVersion.sources
            .map(({ source }) => source.url)
            .filter((url): url is string => Boolean(url))
        ),
        updatedByUserId: article.publishedVersion.publishedByUserId,
      },
    });
    if (!updated.count) {
      throw new HandbookValidationError(
        "This draft improvement changed before it could be discarded."
      );
    }
    return { id: article.id };
  });
}

export async function getHandbookContributionOptions(organizationId: string) {
  const [articles, assetModels, kits, categories] = await Promise.all([
    db.handbookArticle.findMany({
      where: { organizationId, status: HandbookArticleStatus.PUBLISHED },
      orderBy: { slug: "asc" },
      select: {
        id: true,
        slug: true,
        publishedVersion: { select: { title: true } },
      },
      take: 200,
    }),
    db.assetModel.findMany({
      where: { organizationId },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
      take: 300,
    }),
    db.kit.findMany({
      where: { organizationId },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
      take: 300,
    }),
    listHandbookCategories(organizationId),
  ]);
  return {
    articles: articles.flatMap(({ id, slug, publishedVersion }) =>
      publishedVersion ? [{ id, slug, title: publishedVersion.title }] : []
    ),
    assetModels,
    kits,
    categories,
  };
}

export async function resolveHandbookObservationCategoryProposal({
  organizationId,
  observationId,
  resolution,
  handbookCategoryId,
  categoryName,
}: {
  organizationId: string;
  observationId: string;
  resolution: "approve" | "replace" | "reject";
  handbookCategoryId?: string;
  categoryName?: string;
}) {
  const observation = await db.handbookObservation.findFirst({
    where: {
      id: observationId,
      organizationId,
      status: HandbookObservationStatus.PENDING_REVIEW,
    },
    select: {
      id: true,
      articleId: true,
      proposedCategoryName: true,
      publishedVersionId: true,
    },
  });
  if (!observation || !observation.proposedCategoryName) {
    throw new HandbookValidationError(
      "This category proposal is no longer awaiting review."
    );
  }

  if (resolution === "reject") {
    const update = await db.handbookObservation.updateMany({
      where: {
        id: observation.id,
        organizationId,
        status: HandbookObservationStatus.PENDING_REVIEW,
      },
      data: { proposedCategoryName: null, handbookCategoryId: null },
    });
    if (!update.count) {
      throw new HandbookValidationError(
        "This category proposal is no longer awaiting review."
      );
    }
    return { resolution };
  }

  let selectedHandbookCategoryId: string;
  if (resolution === "replace") {
    if (!handbookCategoryId) {
      throw new HandbookValidationError(
        "Choose an existing Handbook category."
      );
    }
    const category = await db.handbookCategory.findFirst({
      where: { id: handbookCategoryId, organizationId, archivedAt: null },
      select: { id: true },
    });
    if (!category) {
      throw new HandbookValidationError(
        "Choose a category from this Handbook workspace."
      );
    }
    selectedHandbookCategoryId = category.id;
  } else {
    const category = await createHandbookCategory({
      organizationId,
      name: categoryName?.trim() || observation.proposedCategoryName,
    });
    selectedHandbookCategoryId = category.id;
  }

  await db.$transaction(async (tx) => {
    const update = await tx.handbookObservation.updateMany({
      where: {
        id: observation.id,
        organizationId,
        status: HandbookObservationStatus.PENDING_REVIEW,
      },
      data: {
        handbookCategoryId: selectedHandbookCategoryId,
        proposedCategoryName: null,
      },
    });
    if (!update.count) {
      throw new HandbookValidationError(
        "This category proposal is no longer awaiting review."
      );
    }
    if (observation.articleId && !observation.publishedVersionId) {
      await tx.handbookArticle.updateMany({
        where: { id: observation.articleId, organizationId },
        data: { handbookCategoryId: selectedHandbookCategoryId },
      });
    }
  });
  return { resolution, handbookCategoryId: selectedHandbookCategoryId };
}

export async function reviewHandbookObservation({
  organizationId,
  userId,
  observationId,
  status,
}: {
  organizationId: string;
  userId: string;
  observationId: string;
  status: "REVIEWED" | "DISMISSED";
}) {
  const result = await db.handbookObservation.updateMany({
    where: {
      id: observationId,
      organizationId,
      status: HandbookObservationStatus.PENDING_REVIEW,
    },
    data: {
      status,
      reviewedByUserId: userId,
      reviewedAt: new Date(),
    },
  });
  if (!result.count)
    throw new HandbookValidationError(
      "This contribution is no longer awaiting review."
    );
}

export async function rejectHandbookArticleRevision({
  organizationId,
  userId,
  observationId,
}: {
  organizationId: string;
  userId: string;
  observationId: string;
}) {
  return db.$transaction(async (tx) => {
    const observation = await tx.handbookObservation.findFirst({
      where: {
        id: observationId,
        organizationId,
        status: HandbookObservationStatus.PENDING_REVIEW,
        publishedVersionId: { not: null },
        articleId: { not: null },
      },
      select: {
        id: true,
        articleId: true,
        publishedVersionId: true,
      },
    });
    if (!observation?.articleId || !observation.publishedVersionId) {
      throw new HandbookValidationError(
        "This article improvement is no longer awaiting review."
      );
    }
    const article = await tx.handbookArticle.findFirst({
      where: {
        id: observation.articleId,
        organizationId,
        status: HandbookArticleStatus.PUBLISHED,
        publishedVersionId: observation.publishedVersionId,
      },
      select: {
        id: true,
        publishedVersionId: true,
        publishedVersion: {
          select: {
            title: true,
            content: true,
            publishedByUserId: true,
            sources: { select: { source: { select: { url: true } } } },
          },
        },
      },
    });
    if (!article?.publishedVersion) {
      throw new HandbookValidationError(
        "The current article version changed. Reopen the article before rejecting this revision."
      );
    }
    await tx.handbookArticle.update({
      where: {
        id: article.id,
        organizationId,
        status: HandbookArticleStatus.PUBLISHED,
        publishedVersionId: observation.publishedVersionId,
      },
      data: {
        draftTitle: article.publishedVersion.title,
        draftContent: article.publishedVersion.content,
        draftSourceUrls: cleanSourceUrls(
          article.publishedVersion.sources
            .map(({ source }) => source.url)
            .filter((url): url is string => Boolean(url))
        ),
        updatedByUserId: article.publishedVersion.publishedByUserId,
      },
    });
    const dismissed = await tx.handbookObservation.updateMany({
      where: {
        id: observation.id,
        organizationId,
        status: HandbookObservationStatus.PENDING_REVIEW,
        publishedVersionId: observation.publishedVersionId,
      },
      data: {
        status: HandbookObservationStatus.DISMISSED,
        reviewedByUserId: userId,
        reviewedAt: new Date(),
      },
    });
    if (!dismissed.count) {
      throw new HandbookValidationError(
        "This article improvement is no longer awaiting review."
      );
    }
    return { articleId: article.id };
  });
}

type RelatedKnowledge = {
  kind: "article" | "observation";
  title: string;
  category?: string;
  version?: number;
  status?: string;
  score: number;
  duplicate: boolean;
};

function normalizeHandbookComparisonText(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export async function findRelatedHandbookKnowledge({
  organizationId,
  text,
  excludeObservationId,
}: {
  organizationId: string;
  text: string;
  excludeObservationId?: string;
}) {
  const terms = getKnowledgeTerms(text).slice(0, 5);
  if (!terms.length) return [] as RelatedKnowledge[];
  const normalizedText = normalizeHandbookComparisonText(text);
  const matching = (field: "title" | "content") =>
    terms.map((term) => ({
      [field]: { contains: term, mode: "insensitive" as const },
    }));
  const [articles, observations] = await Promise.all([
    db.handbookArticle.findMany({
      where: {
        organizationId,
        status: HandbookArticleStatus.PUBLISHED,
        publishedVersion: {
          is: { OR: [...matching("title"), ...matching("content")] },
        },
      },
      take: 40,
      select: {
        handbookCategory: { select: { name: true } },
        publishedVersion: {
          select: {
            title: true,
            summary: true,
            content: true,
            versionNumber: true,
          },
        },
      },
    }),
    db.handbookObservation.findMany({
      where: {
        organizationId,
        status: {
          in: [
            HandbookObservationStatus.PENDING_REVIEW,
            HandbookObservationStatus.REVIEWED,
          ],
        },
        ...(excludeObservationId ? { id: { not: excludeObservationId } } : {}),
        OR: [...matching("title"), ...matching("content")],
      },
      orderBy: { createdAt: "desc" },
      take: 80,
      select: { title: true, content: true, status: true },
    }),
  ]);
  const candidates: RelatedKnowledge[] = [
    ...articles.flatMap(({ handbookCategory, publishedVersion }) =>
      publishedVersion
        ? [
            {
              kind: "article" as const,
              title: publishedVersion.title,
              category: handbookCategory?.name,
              version: publishedVersion.versionNumber,
              duplicate:
                normalizeHandbookComparisonText(publishedVersion.content) ===
                normalizedText,
              score: getKnowledgeOverlap(
                text,
                `${publishedVersion.title} ${publishedVersion.content}`
              ),
            },
          ]
        : []
    ),
    ...observations.map((observation) => ({
      kind: "observation" as const,
      title: observation.title,
      status: observation.status,
      duplicate:
        normalizeHandbookComparisonText(observation.content) === normalizedText,
      score: getKnowledgeOverlap(
        text,
        `${observation.title} ${observation.content}`
      ),
    })),
  ];
  return candidates
    .filter(({ score }) => score >= 0.2)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);
}

/** Compact org-scoped retrieval. Published pages are authoritative procedures;
 * observations are labeled as unverified evidence and never promoted to rules. */
async function queryHandbookContextForAssistant({
  organizationId,
  question,
  audience,
}: {
  organizationId: string;
  question: string;
  audience: "student" | "staff";
}) {
  const terms = getKnowledgeTerms(question).slice(0, 6);
  if (!terms.length) return "";
  const matching = (field: "title" | "summary" | "content") =>
    terms.map((term) => ({
      [field]: { contains: term, mode: "insensitive" as const },
    }));
  const [articles, observations] = await Promise.all([
    db.handbookArticle.findMany({
      where: {
        organizationId,
        status: HandbookArticleStatus.PUBLISHED,
        publishedVersion: {
          is: {
            OR: [
              ...matching("title"),
              ...matching("summary"),
              ...matching("content"),
            ],
          },
        },
      },
      orderBy: { updatedAt: "desc" },
      take: 30,
      select: {
        slug: true,
        publishedVersion: {
          select: {
            title: true,
            summary: true,
            content: true,
            versionNumber: true,
            publishedAt: true,
          },
        },
        handbookCategory: { select: { name: true } },
      },
    }),
    db.handbookObservation.findMany({
      where: {
        organizationId,
        status:
          audience === "staff"
            ? {
                in: [
                  HandbookObservationStatus.PENDING_REVIEW,
                  HandbookObservationStatus.REVIEWED,
                ],
              }
            : HandbookObservationStatus.REVIEWED,
        OR: [...matching("title"), ...matching("content")],
      },
      orderBy: { createdAt: "desc" },
      take: 30,
      select: { title: true, content: true, status: true, createdAt: true },
    }),
  ]);
  const rankedArticles = articles
    .flatMap(({ slug, handbookCategory, publishedVersion }) =>
      publishedVersion
        ? [
            {
              slug,
              handbookCategory,
              version: publishedVersion,
              score: getKnowledgeOverlap(
                question,
                `${publishedVersion.title} ${publishedVersion.summary} ${publishedVersion.content}`
              ),
            },
          ]
        : []
    )
    .filter(({ score }) => score >= 0.15)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  const rankedObservations = observations
    .map((observation) => ({
      ...observation,
      score: getKnowledgeOverlap(
        question,
        `${observation.title} ${observation.content}`
      ),
    }))
    .filter(({ score }) => score >= 0.2)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);
  const entries = [
    ...rankedArticles.map(
      ({ slug, version, handbookCategory }) =>
        `Published Handbook · ${
          handbookCategory?.name ? `${handbookCategory.name} · ` : ""
        }${version.title} · version ${
          version.versionNumber
        } · /handbook/${slug}\n${version.content.slice(0, 1800)}`
    ),
    ...rankedObservations.map(
      (observation) =>
        `Unverified knowledge observation (${observation.status.toLowerCase()}) · ${
          observation.title
        } · ${observation.createdAt.toISOString()}\n${observation.content.slice(
          0,
          700
        )}`
    ),
  ];
  return entries.length ? entries.join("\n\n").slice(0, 6500) : "";
}

let missingHandbookSchemaLogged = false;

/** The Handbook migration is deliberately installed separately from code. Until
 * it is manually applied, Ask IOIO remains usable without supplemental memory. */
export async function getHandbookContextForAssistant(input: {
  organizationId: string;
  question: string;
  audience: "student" | "staff";
}) {
  try {
    return await queryHandbookContextForAssistant(input);
  } catch (cause) {
    if (
      cause instanceof Prisma.PrismaClientKnownRequestError &&
      cause.code === "P2021"
    ) {
      if (!missingHandbookSchemaLogged) {
        missingHandbookSchemaLogged = true;
        Logger.warn({
          event: "ioio_handbook_context_unavailable",
          reason: "Handbook migration is not applied",
        });
      }
      return "";
    }
    throw cause;
  }
}
