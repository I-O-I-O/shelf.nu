import {
  HandbookArticleStatus,
  HandbookObservationStatus,
  HandbookSourceKind,
  OrganizationRoles,
  Prisma,
} from "@prisma/client";
import type { Prisma as PrismaTypes } from "@prisma/client";
import type { ITXClientDenyList } from "@prisma/client/runtime/library";
import { db } from "~/database/db.server";
import type { ExtendedPrismaClient } from "~/database/db.server";
import { recordEvent } from "~/modules/activity-event/service.server";
import { Logger } from "~/utils/logger";
import { removeStorageImageObject } from "~/utils/storage.server";
import { resolveUserDisplayName } from "~/utils/user";
import { HANDBOOK_ARTICLE_MAX_CONTENT_LENGTH } from "./article-limits";
import {
  uploadHandbookAttachmentObject,
  validateHandbookAttachment,
  HANDBOOK_ATTACHMENT_MAX_FILES,
} from "./attachment.server";
import { handbookAttachmentFilenameFromPath } from "./attachment.shared";
import {
  getKnowledgeOverlap,
  getKnowledgeTerms,
  makeHandbookSlug,
  normalizeSourceUrl,
} from "./handbook.shared";

import {
  appendHandbookReviewFeedback,
  getHandbookReviewFeedback,
  HANDBOOK_REVIEW_FEEDBACK_MAX_LENGTH,
} from "./review-feedback.shared";

export class HandbookValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HandbookValidationError";
  }
}

function reviewFeedbackUpdate(content: string | undefined, feedback?: string) {
  const note = feedback?.trim();
  if (!note) return {};
  const updatedContent = appendHandbookReviewFeedback(content ?? "", note);
  if (
    note.length > HANDBOOK_REVIEW_FEEDBACK_MAX_LENGTH ||
    updatedContent.length > 4000
  ) {
    throw new HandbookValidationError(
      "Keep review feedback to 1000 characters or fewer."
    );
  }
  return { content: updatedContent };
}

async function isStudentHandbookContributor(
  client: HandbookTransactionClient,
  organizationId: string,
  userId: string
) {
  const membership = await client.userOrganization.findFirst({
    where: {
      organizationId,
      userId,
      roles: { has: OrganizationRoles.SELF_SERVICE },
    },
    select: { roles: true },
  });
  return Boolean(
    membership &&
      !membership.roles.includes(OrganizationRoles.ADMIN) &&
      !membership.roles.includes(OrganizationRoles.OWNER)
  );
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
      article.content.trim().length > HANDBOOK_ARTICLE_MAX_CONTENT_LENGTH
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
        if (revisedContent.length > HANDBOOK_ARTICLE_MAX_CONTENT_LENGTH) {
          throw new HandbookValidationError(
            `The proposed revision for “${
              current.publishedVersion.title
            }” exceeds the ${HANDBOOK_ARTICLE_MAX_CONTENT_LENGTH.toLocaleString()}-character safety limit. Shorten the imported content or create a new article.`
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

const handbookAttachmentReferences = {
  sources: {
    select: {
      source: {
        select: {
          id: true,
          title: true,
          url: true,
          kind: true,
          storageObjectPath: true,
          fileSizeBytes: true,
        },
      },
    },
  },
} satisfies PrismaTypes.HandbookArticleVersionInclude;

const handbookArticleNavigationOrder = [
  { position: "asc" },
  { slug: "asc" },
] satisfies Prisma.HandbookArticleOrderByWithRelationInput[];

export async function listPublishedHandbookArticles({
  organizationId,
  query = "",
  handbookCategoryId,
  canReadStaffOnly = false,
}: {
  organizationId: string;
  query?: string;
  handbookCategoryId?: string;
  canReadStaffOnly?: boolean;
}) {
  const search = query.trim().slice(0, 120);
  const articles = await db.handbookArticle.findMany({
    where: {
      organizationId,
      status: HandbookArticleStatus.PUBLISHED,
      ...(canReadStaffOnly ? {} : { staffOnly: false }),
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
    orderBy: handbookArticleNavigationOrder,
    select: {
      id: true,
      slug: true,
      staffOnly: true,
      updatedAt: true,
      position: true,
      handbookCategory: { select: { id: true, name: true } },
      publishedVersion: {
        include: {
          ...handbookAttachmentReferences,
        },
      },
    },
  });
  return articles;
}

/** Same navigation order as the Handbook category list; fetch one extra for overflow. */
export async function listRelatedHandbookArticles({
  organizationId,
  handbookCategoryId,
  articleId,
  canReadStaffOnly = false,
}: {
  organizationId: string;
  handbookCategoryId: string;
  articleId: string;
  canReadStaffOnly?: boolean;
}) {
  const articles = await db.handbookArticle.findMany({
    where: {
      organizationId,
      handbookCategoryId,
      id: { not: articleId },
      status: HandbookArticleStatus.PUBLISHED,
      ...(canReadStaffOnly ? {} : { staffOnly: false }),
      publishedVersion: { isNot: null },
    },
    orderBy: handbookArticleNavigationOrder,
    take: 8,
    select: {
      id: true,
      slug: true,
      publishedVersion: { select: { title: true } },
    },
  });
  return {
    articles: articles.slice(0, 7).flatMap((article) =>
      article.publishedVersion
        ? [
            {
              id: article.id,
              slug: article.slug,
              title: article.publishedVersion.title,
            },
          ]
        : []
    ),
    hasMore: articles.length > 7,
  };
}

/** Persist one category's reading order, including legacy rows with tied positions. */
export async function updateHandbookArticleNavigation({
  organizationId,
  articleId,
  intent,
  targetArticleId,
}: {
  organizationId: string;
  articleId: string;
  intent: "move-before" | "move-after";
  targetArticleId?: string;
}) {
  return db.$transaction(
    async (tx) => {
      const article = await tx.handbookArticle.findFirst({
        where: {
          id: articleId,
          organizationId,
          status: HandbookArticleStatus.PUBLISHED,
          publishedVersion: { isNot: null },
          handbookCategoryId: { not: null },
        },
        select: { id: true, handbookCategoryId: true },
      });
      if (!article?.handbookCategoryId) {
        throw new HandbookValidationError(
          "That published Handbook article could not be found in a category."
        );
      }
      const siblings = await tx.handbookArticle.findMany({
        where: {
          organizationId,
          handbookCategoryId: article.handbookCategoryId,
          status: HandbookArticleStatus.PUBLISHED,
          publishedVersion: { isNot: null },
        },
        orderBy: handbookArticleNavigationOrder,
        select: { id: true, position: true },
      });
      const index = siblings.findIndex((sibling) => sibling.id === article.id);
      if (index < 0)
        throw new HandbookValidationError(
          "That article is no longer available."
        );
      const targetIndex = siblings.findIndex(
        (sibling) => sibling.id === targetArticleId
      );
      if (targetIndex < 0) {
        throw new HandbookValidationError(
          "Choose an article in the same category."
        );
      }
      if (targetIndex === index) return { articleId: article.id };
      let destination = targetIndex + (intent === "move-after" ? 1 : 0);
      if (index < destination) destination -= 1;
      const [moved] = siblings.splice(index, 1);
      siblings.splice(destination, 0, moved!);
      for (const [position, sibling] of siblings.entries()) {
        if (sibling.position === position + 1) continue;
        await tx.handbookArticle.update({
          where: { id: sibling.id, organizationId },
          data: { position: position + 1 },
        });
      }
      return { articleId: article.id };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );
}

export async function listHandbookArticleTitles({
  organizationId,
  handbookCategoryId,
  canReadStaffOnly = false,
}: {
  organizationId: string;
  handbookCategoryId?: string;
  canReadStaffOnly?: boolean;
}) {
  const articles = await db.handbookArticle.findMany({
    where: {
      organizationId,
      status: HandbookArticleStatus.PUBLISHED,
      ...(canReadStaffOnly ? {} : { staffOnly: false }),
      ...(handbookCategoryId ? { handbookCategoryId } : {}),
      publishedVersion: { is: {} },
    },
    orderBy: [{ publishedVersion: { title: "asc" } }, { slug: "asc" }],
    select: {
      id: true,
      slug: true,
      staffOnly: true,
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
            staffOnly: article.staffOnly,
            title: article.publishedVersion.title,
            handbookCategoryId: article.handbookCategoryId,
            publishedVersionId: article.publishedVersionId,
            categoryName: article.handbookCategory?.name ?? "",
          },
        ]
      : []
  );
}

export async function setHandbookArticleVisibility({
  organizationId,
  articleId,
  staffOnly,
  canManageArticles,
}: {
  organizationId: string;
  articleId: string;
  staffOnly: boolean;
  canManageArticles: boolean;
}) {
  if (!canManageArticles) {
    throw new HandbookValidationError(
      "Only Staff can change Handbook article visibility."
    );
  }
  const article = await db.handbookArticle.findFirst({
    where: {
      id: articleId,
      organizationId,
      status: HandbookArticleStatus.PUBLISHED,
      publishedVersionId: { not: null },
    },
    select: { id: true, staffOnly: true },
  });
  if (!article) {
    throw new HandbookValidationError(
      "That published Handbook article could not be found."
    );
  }
  if (article.staffOnly === staffOnly) return { id: article.id, staffOnly };
  const updated = await db.handbookArticle.updateMany({
    where: {
      id: article.id,
      organizationId,
      status: HandbookArticleStatus.PUBLISHED,
    },
    data: { staffOnly },
  });
  if (!updated.count) {
    throw new HandbookValidationError(
      "The article changed before its visibility could be updated."
    );
  }
  return { id: article.id, staffOnly };
}

export async function getPublishedHandbookArticle({
  organizationId,
  slug,
  versionId,
  compareVersionId,
  canReadStaffOnly = false,
}: {
  organizationId: string;
  slug: string;
  versionId?: string;
  compareVersionId?: string;
  canReadStaffOnly?: boolean;
}) {
  const article = await db.handbookArticle.findFirst({
    where: {
      organizationId,
      slug,
      status: HandbookArticleStatus.PUBLISHED,
      ...(canReadStaffOnly ? {} : { staffOnly: false }),
      publishedVersionId: { not: null },
    },
    select: {
      id: true,
      slug: true,
      staffOnly: true,
      updatedAt: true,
      handbookCategory: { select: { id: true, name: true } },
      publishedVersion: {
        include: {
          ...handbookAttachmentReferences,
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
          include: { ...handbookAttachmentReferences },
        })
      : Promise.resolve(article.publishedVersion),
    compareVersionId
      ? db.handbookArticleVersion.findFirst({
          where: { id: compareVersionId, articleId: article.id },
          include: { ...handbookAttachmentReferences },
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
  canReadStaffOnly = false,
}: {
  organizationId: string;
  articleId?: string;
  slug?: string;
  ownerUserId?: string;
  userId?: string;
  revisionMode?: boolean;
  canReadStaffOnly?: boolean;
}) {
  const [article, categories] = await Promise.all([
    articleId || slug
      ? db.handbookArticle.findFirst({
          where: articleId
            ? {
                id: articleId,
                organizationId,
                status: { not: HandbookArticleStatus.ARCHIVED },
                ...(canReadStaffOnly ? {} : { staffOnly: false }),
                ...(ownerUserId ? { createdByUserId: ownerUserId } : {}),
              }
            : {
                slug,
                organizationId,
                ...(canReadStaffOnly ? {} : { staffOnly: false }),
                ...(revisionMode
                  ? { status: HandbookArticleStatus.PUBLISHED }
                  : {
                      status: { not: HandbookArticleStatus.ARCHIVED },
                      ...(ownerUserId
                        ? {
                            OR: [
                              {
                                createdByUserId: ownerUserId,
                                status: HandbookArticleStatus.DRAFT,
                              },
                            ],
                          }
                        : {}),
                    }),
              },
          select: {
            id: true,
            status: true,
            staffOnly: true,
            draftTitle: true,
            draftContent: true,
            draftSourceUrls: true,
            draftAttachmentsInitialized: true,
            draftSources: {
              where: { kind: HandbookSourceKind.UPLOADED_DOCUMENT },
              select: {
                id: true,
                title: true,
                storageObjectPath: true,
                fileSizeBytes: true,
              },
            },
            handbookCategoryId: true,
            updatedByUserId: true,
            publishedVersionId: true,
            publishedVersion: {
              include: { ...handbookAttachmentReferences },
            },
            observations: {
              where: {
                OR: [
                  { status: HandbookObservationStatus.PENDING_REVIEW },
                  ...(userId ? [{ contributorUserId: userId }] : []),
                ],
              },
              orderBy: { createdAt: "desc" },
              take: 10,
              select: {
                id: true,
                status: true,
                content: true,
                reviewedByUserId: true,
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
  const pendingObservations =
    article?.observations.filter(
      (item) => item.status === HandbookObservationStatus.PENDING_REVIEW
    ) ?? [];
  const latestOwnReview = article?.observations.find(
    (item) => item.contributorUserId === userId
  );
  const rejectedReview =
    latestOwnReview?.status === HandbookObservationStatus.DISMISSED &&
    latestOwnReview.reviewedByUserId !== latestOwnReview.contributorUserId
      ? latestOwnReview
      : null;
  const revisionReview =
    pendingObservations.find((item) => item.publishedVersionId) ??
    (rejectedReview?.publishedVersionId === article?.publishedVersionId &&
    article?.updatedByUserId === userId
      ? rejectedReview
      : null);
  const authorNames = await getDisplayNamesByUserId(
    article?.versions.map((version) => version.publishedByUserId) ?? []
  );
  const publishedAttachments =
    article?.publishedVersion?.sources.flatMap(({ source }) =>
      source.kind === HandbookSourceKind.UPLOADED_DOCUMENT &&
      source.storageObjectPath
        ? [
            {
              id: source.id,
              title: source.title,
              fileName: handbookAttachmentFilenameFromPath(
                source.storageObjectPath
              ),
              fileSizeBytes: source.fileSizeBytes ?? 0,
              downloadVersionId: article.publishedVersion!.id,
            },
          ]
        : []
    ) ?? [];
  const draftAttachments =
    article?.draftSources.flatMap((source) =>
      source.storageObjectPath
        ? [
            {
              id: source.id,
              title: source.title,
              fileName: handbookAttachmentFilenameFromPath(
                source.storageObjectPath
              ),
              fileSizeBytes: source.fileSizeBytes ?? 0,
              ...(article.publishedVersion?.sources.some(
                ({ source: versionSource }) => versionSource.id === source.id
              )
                ? { downloadVersionId: article.publishedVersion.id }
                : {}),
            },
          ]
        : []
    ) ?? [];
  const hasSavedRevision = Boolean(
    revisionMode &&
      article?.status === HandbookArticleStatus.PUBLISHED &&
      ((userId && article.updatedByUserId === userId) ||
        pendingObservations.some((item) => Boolean(item.publishedVersionId)))
  );
  const attachments =
    article?.draftAttachmentsInitialized && (!revisionMode || hasSavedRevision)
      ? draftAttachments
      : publishedAttachments;
  return {
    article: article
      ? {
          ...article,
          draftSources: undefined,
          publishedVersion: undefined,
          attachments,
          pendingSubmissionId: pendingObservations[0]?.id ?? null,
          reviewFeedback: getHandbookReviewFeedback(rejectedReview?.content),
          proposedCategoryName:
            (
              pendingObservations.find((item) => item.proposedCategoryName) ??
              rejectedReview
            )?.proposedCategoryName ?? null,
          revisionCategoryId:
            revisionReview?.handbookCategoryId ?? article.handbookCategoryId,
          revisionBaseVersionId:
            revisionReview?.publishedVersionId ?? article.publishedVersionId,
          revisionContributorUserId: revisionReview?.contributorUserId ?? null,
          revisionSubmitted: pendingObservations.some((item) =>
            Boolean(item.publishedVersionId)
          ),
          ...(revisionMode && article.status === HandbookArticleStatus.PUBLISHED
            ? (() => {
                const ownSavedRevision =
                  userId && article.updatedByUserId === userId;
                const published = article.publishedVersion;
                const pendingRevision = Boolean(
                  pendingObservations.some((item) => item.publishedVersionId)
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
                    revisionReview?.handbookCategoryId ??
                    article.handbookCategoryId,
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

export async function listHandbookCategoriesWithPublishedArticles({
  organizationId,
  canReadStaffOnly = false,
}: {
  organizationId: string;
  canReadStaffOnly?: boolean;
}) {
  return db.handbookCategory.findMany({
    where: {
      organizationId,
      archivedAt: null,
      articles: {
        some: {
          status: HandbookArticleStatus.PUBLISHED,
          publishedVersionId: { not: null },
          ...(canReadStaffOnly ? {} : { staffOnly: false }),
        },
      },
    },
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
    if (current.name === cleanedName) {
      return { id: current.id, name: current.name, unchanged: true };
    }
    const category = await db.handbookCategory.update({
      where: { id: current.id, organizationId },
      data: { name: cleanedName },
      select: { id: true, name: true },
    });
    return { ...category, unchanged: false };
  }
  const duplicate = await db.handbookCategory.findFirst({
    where: { organizationId, normalizedName },
    select: { id: true, name: true },
  });
  if (duplicate && duplicate.id !== current.id) {
    throw new HandbookValidationError(
      `A category named "${duplicate.name}" already exists.`
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
  staffOnly,
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
  staffOnly?: boolean;
}) {
  const normalizedTitle = title.trim();
  const normalizedContent = content.trim();
  if (!normalizedTitle || !normalizedContent) {
    throw new HandbookValidationError(
      "Add a title and article content before saving."
    );
  }
  if (
    normalizedTitle.length > 180 ||
    normalizedContent.length > HANDBOOK_ARTICLE_MAX_CONTENT_LENGTH
  ) {
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
        draftAttachmentsInitialized: true,
        draftSources: {
          where: { kind: HandbookSourceKind.UPLOADED_DOCUMENT },
          select: { id: true },
        },
        updatedByUserId: true,
        publishedVersion: {
          select: {
            title: true,
            content: true,
            sources: {
              select: {
                source: { select: { id: true, url: true, kind: true } },
              },
            },
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
    const rejectedOwnedRevision =
      revisionOwnerUserId && current.updatedByUserId !== revisionOwnerUserId
        ? await db.handbookObservation.findFirst({
            where: {
              organizationId,
              articleId: current.id,
              publishedVersionId: revisionBaseVersionId,
              status: HandbookObservationStatus.DISMISSED,
              contributorUserId: current.updatedByUserId,
              reviewedByUserId: { not: current.updatedByUserId },
            },
            select: { id: true },
          })
        : null;
    if (
      revisionOwnerUserId &&
      current.updatedByUserId !== revisionOwnerUserId &&
      (Boolean(rejectedOwnedRevision) ||
        current.draftTitle !== current.publishedVersion.title ||
        current.draftContent !== current.publishedVersion.content ||
        (current.draftAttachmentsInitialized &&
          JSON.stringify(current.draftSources.map(({ id }) => id).sort()) !==
            JSON.stringify(
              current.publishedVersion.sources
                .filter(
                  ({ source }) =>
                    source.kind === HandbookSourceKind.UPLOADED_DOCUMENT
                )
                .map(({ source }) => source.id)
                .sort()
            )) ||
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
        ...(staffOnly === undefined ? {} : { staffOnly }),
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
        status: { not: HandbookArticleStatus.ARCHIVED },
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
        status: { not: HandbookArticleStatus.ARCHIVED },
        ...(ownerUserId ? { createdByUserId: ownerUserId } : {}),
        ...(ownerUserId ? { status: HandbookArticleStatus.DRAFT } : {}),
      },
      data: {
        draftTitle: normalizedTitle,
        draftContent: normalizedContent,
        handbookCategoryId: category?.id ?? null,
        draftSourceUrls: validSources,
        updatedByUserId: userId,
        ...(staffOnly === undefined ? {} : { staffOnly }),
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
      ...(staffOnly === undefined ? {} : { staffOnly }),
      createdByUserId: userId,
      updatedByUserId: userId,
    },
    select: { id: true, slug: true, status: true },
  });
}

export async function createHandbookAttachmentSource({
  organizationId,
  userId,
  filename,
  contentType,
  bytes,
}: {
  organizationId: string;
  userId: string;
  filename: string;
  contentType: string;
  bytes: Buffer;
}) {
  let validated: ReturnType<typeof validateHandbookAttachment>;
  try {
    validated = validateHandbookAttachment({ filename, contentType, bytes });
  } catch (cause) {
    throw new HandbookValidationError(
      cause instanceof Error ? cause.message : "This file cannot be attached."
    );
  }

  const storageObjectPath = await uploadHandbookAttachmentObject({
    filename: validated.filename,
    bytes,
  });
  try {
    const source = await db.handbookSource.create({
      data: {
        organizationId,
        kind: HandbookSourceKind.UPLOADED_DOCUMENT,
        title: validated.filename,
        storageObjectPath,
        contentType: "application/octet-stream",
        fileSizeBytes: bytes.byteLength,
        createdByUserId: userId,
      },
      select: { id: true },
    });
    return source.id;
  } catch (cause) {
    await removeStorageImageObject({
      bucketName: "assets",
      objectPath: storageObjectPath,
    }).catch(() => undefined);
    throw cause;
  }
}

/** Replace the article's editable attachment set while keeping published version links intact. */
export async function setHandbookDraftAttachments({
  organizationId,
  userId,
  articleId,
  sourceIds,
  newlyUploadedSourceIds = [],
}: {
  organizationId: string;
  userId: string;
  articleId: string;
  sourceIds: string[];
  newlyUploadedSourceIds?: string[];
}) {
  const selectedIds = [...new Set(sourceIds)];
  const newIds = [...new Set(newlyUploadedSourceIds)];
  if (
    selectedIds.length > HANDBOOK_ATTACHMENT_MAX_FILES ||
    newIds.some((id) => !selectedIds.includes(id))
  ) {
    throw new HandbookValidationError(
      `An article can have up to ${HANDBOOK_ATTACHMENT_MAX_FILES} files.`
    );
  }

  const detachedSourceIds = await db.$transaction(async (tx) => {
    const article = await tx.handbookArticle.findFirst({
      where: {
        id: articleId,
        organizationId,
        status: { not: HandbookArticleStatus.ARCHIVED },
        updatedByUserId: userId,
      },
      select: { id: true },
    });
    if (!article) {
      throw new HandbookValidationError(
        "This Handbook draft is no longer available to edit."
      );
    }

    const sources = selectedIds.length
      ? await tx.handbookSource.findMany({
          where: {
            id: { in: selectedIds },
            organizationId,
            kind: HandbookSourceKind.UPLOADED_DOCUMENT,
            OR: [
              { draftArticleId: articleId },
              { versions: { some: { version: { articleId } } } },
              {
                id: { in: newIds },
                draftArticleId: null,
                createdByUserId: userId,
              },
            ],
          },
          select: {
            id: true,
            title: true,
            storageObjectPath: true,
          },
        })
      : [];
    if (sources.length !== selectedIds.length) {
      throw new HandbookValidationError(
        "One or more selected files are no longer available for this article."
      );
    }
    const detachedSources = await tx.handbookSource.findMany({
      where: {
        organizationId,
        draftArticleId: articleId,
        ...(selectedIds.length ? { id: { notIn: selectedIds } } : {}),
      },
      select: { id: true },
    });

    await tx.handbookSource.updateMany({
      where: {
        organizationId,
        draftArticleId: articleId,
        ...(selectedIds.length ? { id: { notIn: selectedIds } } : {}),
      },
      data: { draftArticleId: null },
    });
    for (const source of sources) {
      await tx.handbookSource.update({
        where: { id: source.id, organizationId },
        data: { draftArticleId: articleId },
      });
    }
    await tx.handbookArticle.update({
      where: { id: articleId, organizationId },
      data: { draftAttachmentsInitialized: true },
    });
    return detachedSources.map(({ id }) => id);
  });
  await removeUnusedHandbookAttachmentSources({
    organizationId,
    sourceIds: detachedSourceIds,
  });
}

async function removeUnusedHandbookAttachmentSources({
  organizationId,
  sourceIds,
}: {
  organizationId: string;
  sourceIds: string[];
}) {
  if (!sourceIds.length) return;
  const sources = await db.handbookSource.findMany({
    where: {
      id: { in: sourceIds },
      organizationId,
      kind: HandbookSourceKind.UPLOADED_DOCUMENT,
      draftArticleId: null,
      versions: { none: {} },
    },
    select: { id: true, storageObjectPath: true },
  });
  for (const source of sources) {
    const deleted = await db.handbookSource.deleteMany({
      where: {
        id: source.id,
        organizationId,
        draftArticleId: null,
        versions: { none: {} },
      },
    });
    if (deleted.count && source.storageObjectPath) {
      await removeStorageImageObject({
        bucketName: "assets",
        objectPath: source.storageObjectPath,
      }).catch(() => undefined);
    }
  }
}

export async function removeUnattachedHandbookAttachmentSources({
  organizationId,
  userId,
  sourceIds,
}: {
  organizationId: string;
  userId: string;
  sourceIds: string[];
}) {
  if (!sourceIds.length) return;
  const sources = await db.handbookSource.findMany({
    where: {
      id: { in: sourceIds },
      organizationId,
      createdByUserId: userId,
      kind: HandbookSourceKind.UPLOADED_DOCUMENT,
      draftArticleId: null,
      versions: { none: {} },
    },
    select: { id: true, storageObjectPath: true },
  });
  for (const source of sources) {
    if (source.storageObjectPath) {
      await removeStorageImageObject({
        bucketName: "assets",
        objectPath: source.storageObjectPath,
      }).catch(() => undefined);
    }
  }
  await db.handbookSource.deleteMany({
    where: {
      id: { in: sources.map(({ id }) => id) },
      organizationId,
      createdByUserId: userId,
      draftArticleId: null,
      versions: { none: {} },
    },
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
    where: {
      id: articleId,
      organizationId,
      status: { not: HandbookArticleStatus.ARCHIVED },
    },
    include: {
      draftSources: {
        where: { kind: HandbookSourceKind.UPLOADED_DOCUMENT },
        select: { id: true },
      },
    },
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
  const needsPosition =
    categoryChanged ||
    (article.position <= 0 &&
      article.status !== HandbookArticleStatus.PUBLISHED);
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
      where: {
        id: article.id,
        organizationId,
        status: { not: HandbookArticleStatus.ARCHIVED },
      },
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
  const sourceIds: string[] = article.draftSources?.map(({ id }) => id) ?? [];
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
    where: {
      id: article.id,
      organizationId,
      status: { not: HandbookArticleStatus.ARCHIVED },
    },
    data: {
      status: HandbookArticleStatus.PUBLISHED,
      publishedVersionId: version.id,
      updatedByUserId: userId,
      draftAttachmentsInitialized: true,
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
        contributorUserId: true,
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
    if (
      !(await isStudentHandbookContributor(
        tx,
        organizationId,
        observation.contributorUserId
      ))
    ) {
      throw new HandbookValidationError(
        "Only student article improvements require staff review."
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

/** Publish a student's new article submission and close its existing review record atomically. */
export async function approveHandbookNewArticleSubmission({
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
        articleId: { not: null },
        publishedVersionId: null,
      },
      select: {
        id: true,
        articleId: true,
        contributorUserId: true,
        proposedCategoryName: true,
      },
    });
    if (!observation?.articleId) {
      throw new HandbookValidationError(
        "This new article is no longer awaiting review."
      );
    }
    if (
      !(await isStudentHandbookContributor(
        tx,
        organizationId,
        observation.contributorUserId
      ))
    ) {
      throw new HandbookValidationError(
        "Only student article submissions require staff review."
      );
    }
    if (observation.proposedCategoryName) {
      throw new HandbookValidationError(
        "Resolve the proposed category before publishing this article."
      );
    }
    const article = await tx.handbookArticle.findFirst({
      where: {
        id: observation.articleId,
        organizationId,
        status: HandbookArticleStatus.DRAFT,
        createdByUserId: observation.contributorUserId,
      },
      select: { id: true },
    });
    if (!article) {
      throw new HandbookValidationError(
        "The submitted article draft is no longer available."
      );
    }
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
        articleId: article.id,
        publishedVersionId: null,
      },
      data: {
        status: HandbookObservationStatus.REVIEWED,
        reviewedByUserId: userId,
        reviewedAt: new Date(),
      },
    });
    if (!reviewed.count) {
      throw new HandbookValidationError(
        "This new article is no longer awaiting review."
      );
    }
    return published;
  });
}

export async function resolveHandbookArticleSubmission({
  organizationId,
  userId,
  observationId,
  resolution,
  feedback,
}: {
  organizationId: string;
  userId: string;
  observationId: string;
  resolution: "return-for-changes" | "reject";
  feedback?: string;
}) {
  return db.$transaction(async (tx) => {
    const observation = await tx.handbookObservation.findFirst({
      where: {
        id: observationId,
        organizationId,
        status: HandbookObservationStatus.PENDING_REVIEW,
        articleId: { not: null },
      },
      select: { id: true, contributorUserId: true, content: true },
    });
    if (!observation) {
      throw new HandbookValidationError(
        "This contribution is no longer awaiting review."
      );
    }
    if (
      !(await isStudentHandbookContributor(
        tx,
        organizationId,
        observation.contributorUserId
      ))
    ) {
      throw new HandbookValidationError(
        "Only student contributions require staff review."
      );
    }
    const update = await tx.handbookObservation.updateMany({
      where: {
        id: observation.id,
        organizationId,
        status: HandbookObservationStatus.PENDING_REVIEW,
      },
      data: {
        status:
          resolution === "return-for-changes"
            ? HandbookObservationStatus.REVIEWED
            : HandbookObservationStatus.DISMISSED,
        reviewedByUserId: userId,
        reviewedAt: new Date(),
        ...reviewFeedbackUpdate(observation.content, feedback),
      },
    });
    if (!update.count) {
      throw new HandbookValidationError(
        "This contribution is no longer awaiting review."
      );
    }
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
        draftAttachmentsInitialized: true,
        draftSources: {
          where: { kind: HandbookSourceKind.UPLOADED_DOCUMENT },
          select: { id: true },
        },
        handbookCategoryId: true,
        publishedVersionId: true,
        publishedVersion: {
          select: {
            versionNumber: true,
            title: true,
            content: true,
            sources: {
              select: {
                source: { select: { id: true, url: true, kind: true } },
              },
            },
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
    const currentAttachmentIds = article.publishedVersion.sources
      .filter(
        ({ source }) => source.kind === HandbookSourceKind.UPLOADED_DOCUMENT
      )
      .map(({ source }) => source.id)
      .sort();
    const proposedAttachmentIds = article.draftAttachmentsInitialized
      ? article.draftSources.map(({ id }) => id).sort()
      : currentAttachmentIds;
    const revisionHasChanges =
      article.draftTitle !== article.publishedVersion.title ||
      article.draftContent !== article.publishedVersion.content ||
      JSON.stringify(proposedAttachmentIds) !==
        JSON.stringify(currentAttachmentIds) ||
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

function pendingHandbookReviewsWhere(
  organizationId: string
): Prisma.HandbookObservationWhereInput {
  return {
    organizationId,
    status: HandbookObservationStatus.PENDING_REVIEW,
    article: { status: { not: HandbookArticleStatus.ARCHIVED } },
    AND: [
      {
        OR: [
          { title: { startsWith: "Draft submitted for review:" } },
          { title: { startsWith: "Proposed improvement:" } },
        ],
      },
      {
        OR: [
          { publishedVersionId: { not: null } },
          { article: { status: HandbookArticleStatus.DRAFT } },
        ],
      },
    ],
  };
}

async function studentHandbookContributorIds(
  organizationId: string,
  contributorIds?: string[]
) {
  const memberships = await db.userOrganization.findMany({
    where: {
      organizationId,
      ...(contributorIds ? { userId: { in: contributorIds } } : {}),
      roles: { has: OrganizationRoles.SELF_SERVICE },
    },
    select: { userId: true, roles: true },
  });
  return memberships
    .filter(
      ({ roles }) =>
        !roles.includes(OrganizationRoles.ADMIN) &&
        !roles.includes(OrganizationRoles.OWNER)
    )
    .map(({ userId }) => userId);
}

/** Count the canonical review queue without fetching article content or applying pagination. */
export async function countPendingHandbookReviews(organizationId: string) {
  const studentIds = await studentHandbookContributorIds(organizationId);
  if (!studentIds.length) return 0;
  return db.handbookObservation.count({
    where: {
      ...pendingHandbookReviewsWhere(organizationId),
      contributorUserId: { in: studentIds },
    },
  });
}

export async function listHandbookObservations(organizationId: string) {
  const observations = await db.handbookObservation.findMany({
    where: pendingHandbookReviewsWhere(organizationId),
    orderBy: { createdAt: "desc" },
    take: 100,
    include: {
      article: {
        select: {
          id: true,
          slug: true,
          status: true,
          createdByUserId: true,
          draftTitle: true,
          draftContent: true,
          draftSourceUrls: true,
          draftSources: {
            where: { kind: HandbookSourceKind.UPLOADED_DOCUMENT },
            select: {
              id: true,
              title: true,
              storageObjectPath: true,
              fileSizeBytes: true,
            },
          },
          publishedVersion: {
            select: {
              id: true,
              title: true,
              content: true,
              versionNumber: true,
              sources: {
                select: {
                  source: {
                    select: {
                      id: true,
                      title: true,
                      url: true,
                      kind: true,
                      storageObjectPath: true,
                      fileSizeBytes: true,
                    },
                  },
                },
              },
            },
          },
        },
      },
      handbookCategory: { select: { id: true, name: true } },
      assetModel: { select: { name: true } },
      kit: { select: { name: true } },
    },
  });
  const contributorIds = [
    ...new Set(
      observations.map((observation) => observation.contributorUserId)
    ),
  ];
  const studentIds = new Set(
    contributorIds.length
      ? await studentHandbookContributorIds(organizationId, contributorIds)
      : []
  );
  const studentObservations = observations.filter((observation) =>
    studentIds.has(observation.contributorUserId)
  );
  const contributorNames = await getDisplayNamesByUserId(
    studentObservations.map((observation) => observation.contributorUserId)
  );
  return studentObservations.map((observation) => ({
    ...observation,
    contributorName:
      contributorNames.get(observation.contributorUserId) ?? null,
    article: observation.article
      ? {
          ...observation.article,
          draftSources: undefined,
          draftAttachments: observation.article.draftSources.flatMap(
            (source) =>
              source.storageObjectPath
                ? [
                    {
                      id: source.id,
                      title: source.title,
                      fileName: handbookAttachmentFilenameFromPath(
                        source.storageObjectPath
                      ),
                      fileSizeBytes: source.fileSizeBytes ?? 0,
                    },
                  ]
                : []
          ),
          publishedVersion: observation.article.publishedVersion
            ? observation.article.publishedVersion
            : null,
        }
      : null,
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
  canReadStaffOnly = false,
}: {
  organizationId: string;
  userId: string;
  canReadStaffOnly?: boolean;
}) {
  const [drafts, revisedArticles, pendingRevisions, contributionRecords] =
    await Promise.all([
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
          ...(canReadStaffOnly ? {} : { staffOnly: false }),
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
          draftAttachmentsInitialized: true,
          draftSources: {
            where: { kind: HandbookSourceKind.UPLOADED_DOCUMENT },
            select: { id: true },
          },
          updatedAt: true,
          handbookCategory: { select: { id: true, name: true } },
          publishedVersion: {
            select: {
              id: true,
              title: true,
              content: true,
              versionNumber: true,
              sources: {
                select: {
                  source: { select: { id: true, kind: true } },
                },
              },
            },
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
          ...(canReadStaffOnly
            ? {}
            : { article: { is: { staffOnly: false } } }),
        },
        orderBy: { createdAt: "desc" },
        take: 200,
        select: {
          id: true,
          createdAt: true,
          status: true,
          reviewedByUserId: true,
          contributorUserId: true,
          publishedVersionId: true,
          publishedVersion: { select: { versionNumber: true } },
          handbookCategory: { select: { id: true, name: true } },
          article: {
            select: {
              id: true,
              slug: true,
              status: true,
              publishedVersionId: true,
              draftTitle: true,
              handbookCategory: { select: { id: true, name: true } },
              publishedVersion: { select: { title: true } },
            },
          },
        },
      }),
      db.handbookObservation.findMany({
        where: {
          organizationId,
          contributorUserId: userId,
          articleId: { not: null },
          ...(canReadStaffOnly
            ? {}
            : { article: { is: { staffOnly: false } } }),
          OR: [
            { title: { startsWith: "Draft submitted for review:" } },
            { title: { startsWith: "Proposed improvement:" } },
          ],
          status: {
            in: [
              HandbookObservationStatus.PENDING_REVIEW,
              HandbookObservationStatus.REVIEWED,
              HandbookObservationStatus.DISMISSED,
            ],
          },
        },
        orderBy: { createdAt: "desc" },
        take: 400,
        select: {
          id: true,
          articleId: true,
          title: true,
          content: true,
          createdAt: true,
          status: true,
          reviewedByUserId: true,
          contributorUserId: true,
          publishedVersionId: true,
          publishedVersion: { select: { versionNumber: true } },
          handbookCategory: { select: { id: true, name: true } },
          article: {
            select: {
              id: true,
              slug: true,
              status: true,
              draftTitle: true,
              publishedVersionId: true,
              handbookCategory: { select: { id: true, name: true } },
              publishedVersion: { select: { title: true } },
            },
          },
        },
      }),
    ]);
  const latestContributionByArticle = new Map<
    string,
    (typeof contributionRecords)[number]
  >();
  for (const observation of contributionRecords) {
    if (
      observation.articleId &&
      !latestContributionByArticle.has(observation.articleId)
    ) {
      latestContributionByArticle.set(observation.articleId, observation);
    }
  }
  const newArticleWork = drafts.map(({ observations, ...draft }) => {
    const latest = latestContributionByArticle.get(draft.id);
    const withdrawn =
      latest?.status === HandbookObservationStatus.DISMISSED &&
      latest.reviewedByUserId === latest.contributorUserId;
    const contributionStatus = observations.length
      ? "PENDING_REVIEW"
      : !withdrawn && latest?.status === HandbookObservationStatus.DISMISSED
      ? "REJECTED"
      : !withdrawn && latest?.status === HandbookObservationStatus.REVIEWED
      ? "RETURNED_FOR_CHANGES"
      : "DRAFT";
    return {
      ...draft,
      articleId: draft.id,
      submissionId: observations[0]?.id ?? null,
      workType: "NEW_ARTICLE" as const,
      submittedForReview: observations.length > 0,
      baseVersionNumber: null,
      contributionStatus,
      reviewFeedback:
        contributionStatus === "REJECTED"
          ? getHandbookReviewFeedback(latest?.content)
          : null,
      submittedAt: withdrawn ? null : latest?.createdAt ?? null,
    };
  });
  const improvementDrafts = revisedArticles
    .filter(
      (article) =>
        article.publishedVersion &&
        (article.draftTitle !== article.publishedVersion.title ||
          article.draftContent !== article.publishedVersion.content ||
          (() => {
            const latest = latestContributionByArticle.get(article.id);
            return (
              latest?.status === HandbookObservationStatus.DISMISSED &&
              latest.reviewedByUserId !== latest.contributorUserId &&
              latest.publishedVersionId === article.publishedVersion.id
            );
          })() ||
          (article.draftAttachmentsInitialized &&
            JSON.stringify(article.draftSources.map(({ id }) => id).sort()) !==
              JSON.stringify(
                article.publishedVersion.sources
                  .filter(
                    ({ source }) =>
                      source.kind === HandbookSourceKind.UPLOADED_DOCUMENT
                  )
                  .map(({ source }) => source.id)
                  .sort()
              )))
    )
    .map((article) => ({
      id: article.id,
      articleId: article.id,
      slug: article.slug,
      draftTitle: article.draftTitle,
      updatedAt: article.updatedAt,
      handbookCategory: article.handbookCategory,
      submissionId: null,
      workType: "IMPROVEMENT_DRAFT" as const,
      submittedForReview: false,
      baseVersionNumber: article.publishedVersion!.versionNumber,
      contributionStatus: (() => {
        const latest = latestContributionByArticle.get(article.id);
        const withdrawn =
          latest?.status === HandbookObservationStatus.DISMISSED &&
          latest.reviewedByUserId === latest.contributorUserId;
        if (
          !withdrawn &&
          latest?.status === HandbookObservationStatus.DISMISSED
        )
          return "REJECTED" as const;
        if (
          !withdrawn &&
          latest?.status === HandbookObservationStatus.REVIEWED &&
          latest.publishedVersionId === article.publishedVersion!.id
        )
          return "RETURNED_FOR_CHANGES" as const;
        return "DRAFT" as const;
      })(),
      reviewFeedback: getHandbookReviewFeedback(
        latestContributionByArticle.get(article.id)?.content
      ),
      submittedAt:
        latestContributionByArticle.get(article.id)?.createdAt ?? null,
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
            submissionId: observation.id,
            workType: "IMPROVEMENT_PENDING" as const,
            submittedForReview: true,
            baseVersionNumber: observation.publishedVersion.versionNumber,
            reviewFeedback: null,
            contributionStatus: "PENDING_REVIEW" as const,
            submittedAt: observation.createdAt,
          },
        ]
      : []
  );
  const completedWork = [...latestContributionByArticle.values()].flatMap(
    (observation) => {
      const article = observation.article;
      if (!article) return [];
      const wasWithdrawn =
        observation.status === HandbookObservationStatus.DISMISSED &&
        observation.reviewedByUserId === observation.contributorUserId;
      if (
        wasWithdrawn ||
        observation.status === HandbookObservationStatus.PENDING_REVIEW
      )
        return [];
      const isRejected =
        observation.status === HandbookObservationStatus.DISMISSED;
      const isApproved =
        observation.status === HandbookObservationStatus.REVIEWED &&
        article.status === HandbookArticleStatus.PUBLISHED &&
        (observation.publishedVersionId
          ? observation.publishedVersionId !== article.publishedVersionId
          : Boolean(article.publishedVersionId));
      if (!isRejected && !isApproved) return [];
      // A rejected new article remains editable and is represented by its draft row.
      if (
        isRejected &&
        (article.status === HandbookArticleStatus.DRAFT ||
          improvementDrafts.some((draft) => draft.articleId === article.id))
      )
        return [];
      const proposedTitle = observation.title.replace(
        /^(?:Proposed improvement: |Draft submitted for review: )/u,
        ""
      );
      return [
        {
          id: `outcome:${observation.id}`,
          articleId: article.id,
          slug: article.slug,
          draftTitle:
            observation.publishedVersionId === null
              ? article.publishedVersion?.title ?? article.draftTitle
              : proposedTitle,
          updatedAt: observation.createdAt,
          handbookCategory:
            observation.handbookCategory ?? article.handbookCategory,
          submissionId: observation.id,
          workType: "OUTCOME" as const,
          submittedForReview: false,
          baseVersionNumber:
            observation.publishedVersion?.versionNumber ?? null,
          contributionStatus: isApproved
            ? ("APPROVED" as const)
            : ("REJECTED" as const),
          reviewFeedback: isRejected
            ? getHandbookReviewFeedback(observation.content)
            : null,
          submittedAt: observation.createdAt,
        },
      ];
    }
  );
  return [
    ...newArticleWork,
    ...improvementDrafts,
    ...pendingImprovementWork,
    ...completedWork,
  ].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

/** Archive/restore only changes visibility; immutable published versions stay intact. */
export async function archiveHandbookArticle({
  organizationId,
  articleId,
  userId,
  canManageArticles = false,
  restore = false,
}: {
  organizationId: string;
  articleId: string;
  userId: string;
  canManageArticles?: boolean;
  restore?: boolean;
}) {
  if (!userId || !canManageArticles)
    throw new HandbookValidationError(
      "Only Staff can archive or restore Handbook articles."
    );
  const result = await db.handbookArticle.updateMany({
    where: {
      id: articleId,
      organizationId,
      status: restore
        ? HandbookArticleStatus.ARCHIVED
        : HandbookArticleStatus.PUBLISHED,
      publishedVersionId: { not: null },
    },
    data: {
      status: restore
        ? HandbookArticleStatus.PUBLISHED
        : HandbookArticleStatus.ARCHIVED,
    },
  });
  if (!result.count)
    throw new HandbookValidationError(
      "That article is no longer available for this action."
    );
  return { id: articleId };
}

/**
 * Permanently delete a published or archived article and only the records owned by it.
 * Shared Handbook sources and submissions linked to another resource survive.
 */
export async function deleteHandbookArticlePermanently({
  organizationId,
  articleId,
  userId,
  canManageArticles = false,
  confirmationTitle,
}: {
  organizationId: string;
  articleId: string;
  userId: string;
  canManageArticles?: boolean;
  confirmationTitle: string;
}) {
  if (!userId || !canManageArticles)
    throw new HandbookValidationError(
      "Only Staff can permanently delete Handbook articles."
    );

  return db.$transaction(
    async (tx) => {
      const article = await tx.handbookArticle.findFirst({
        where: {
          id: articleId,
          organizationId,
          status: {
            in: [
              HandbookArticleStatus.PUBLISHED,
              HandbookArticleStatus.ARCHIVED,
            ],
          },
          publishedVersionId: { not: null },
        },
        select: {
          id: true,
          slug: true,
          status: true,
          handbookCategoryId: true,
          publishedVersionId: true,
          publishedVersion: { select: { title: true } },
          versions: {
            select: {
              sources: { select: { sourceId: true } },
            },
          },
          observations: {
            select: {
              id: true,
              assetModelId: true,
              kitId: true,
              conversationId: true,
              messageId: true,
            },
          },
        },
      });
      const articleTitle = article?.publishedVersion?.title;
      if (!article || !articleTitle)
        throw new HandbookValidationError(
          "Only published or archived articles can be permanently deleted."
        );
      if (confirmationTitle.trim() !== articleTitle)
        throw new HandbookValidationError(
          "Type the article title exactly to confirm permanent deletion."
        );

      const independentObservations = article.observations.filter(
        (observation) =>
          observation.assetModelId ||
          observation.kitId ||
          observation.conversationId ||
          observation.messageId
      );
      const articleOnlyObservationIds = article.observations
        .filter(
          (observation) =>
            !observation.assetModelId &&
            !observation.kitId &&
            !observation.conversationId &&
            !observation.messageId
        )
        .map(({ id }) => id);

      if (articleOnlyObservationIds.length) {
        await tx.handbookObservation.deleteMany({
          where: {
            organizationId,
            articleId: article.id,
            id: { in: articleOnlyObservationIds },
          },
        });
      }
      if (independentObservations.length) {
        await tx.handbookObservation.updateMany({
          where: {
            organizationId,
            articleId: article.id,
            id: { in: independentObservations.map(({ id }) => id) },
          },
          data: { articleId: null },
        });
      }

      const deleted = await tx.handbookArticle.deleteMany({
        where: {
          id: article.id,
          organizationId,
          status: article.status,
          publishedVersionId: article.publishedVersionId,
        },
      });
      if (!deleted.count)
        throw new HandbookValidationError(
          "That article is no longer available for deletion."
        );

      const sourceIds = [
        ...new Set(
          article.versions.flatMap((version) =>
            version.sources.map(({ sourceId }) => sourceId)
          )
        ),
      ];
      if (sourceIds.length) {
        // A source may be deduplicated across articles. Remove only unreferenced
        // database records without storage objects; uploaded files are retained.
        await tx.handbookSource.deleteMany({
          where: {
            organizationId,
            id: { in: sourceIds },
            storageObjectPath: null,
            versions: { none: {} },
          },
        });
      }

      if (article.handbookCategoryId) {
        const remainingArticles = await tx.handbookArticle.findMany({
          where: {
            organizationId,
            handbookCategoryId: article.handbookCategoryId,
            status: HandbookArticleStatus.PUBLISHED,
            publishedVersion: { isNot: null },
          },
          orderBy: handbookArticleNavigationOrder,
          select: { id: true, position: true },
        });
        for (const [index, remaining] of remainingArticles.entries()) {
          const position = index + 1;
          if (remaining.position === position) continue;
          await tx.handbookArticle.updateMany({
            where: {
              id: remaining.id,
              organizationId,
              status: HandbookArticleStatus.PUBLISHED,
            },
            data: { position },
          });
        }
      }

      await recordEvent(
        {
          action: "IOIO_HANDBOOK_ARTICLE_DELETED",
          organizationId,
          actorUserId: userId,
          entityType: "HANDBOOK_ARTICLE",
          entityId: article.id,
          meta: {
            slug: article.slug,
            title: articleTitle,
          } as PrismaTypes.InputJsonValue,
        },
        tx
      );

      return { id: article.id, slug: article.slug, title: articleTitle };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );
}

/** Withdraw from review while retaining both the request and editable draft. */
export async function withdrawHandbookSubmission({
  organizationId,
  observationId,
  userId,
  canManageAnySubmission = false,
}: {
  organizationId: string;
  observationId: string;
  userId: string;
  canManageAnySubmission?: boolean;
}) {
  const result = await db.handbookObservation.updateMany({
    where: {
      id: observationId,
      organizationId,
      status: HandbookObservationStatus.PENDING_REVIEW,
      ...(!canManageAnySubmission ? { contributorUserId: userId } : {}),
    },
    data: {
      status: HandbookObservationStatus.DISMISSED,
      reviewedByUserId: userId,
      reviewedAt: new Date(),
    },
  });
  if (!result.count)
    throw new HandbookValidationError(
      "That submission is no longer pending or you do not have permission to withdraw it."
    );
  return { id: observationId };
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
      where: {
        organizationId,
        status: HandbookArticleStatus.PUBLISHED,
        staffOnly: false,
      },
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
      contributorUserId: true,
      proposedCategoryName: true,
      publishedVersionId: true,
    },
  });
  if (!observation || !observation.proposedCategoryName) {
    throw new HandbookValidationError(
      "This category proposal is no longer awaiting review."
    );
  }
  if (
    !(await isStudentHandbookContributor(
      db,
      organizationId,
      observation.contributorUserId
    ))
  ) {
    throw new HandbookValidationError(
      "Only student contributions require staff review."
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
  feedback,
}: {
  organizationId: string;
  userId: string;
  observationId: string;
  feedback?: string;
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
        content: true,
        articleId: true,
        contributorUserId: true,
        publishedVersionId: true,
      },
    });
    if (!observation?.articleId || !observation.publishedVersionId) {
      throw new HandbookValidationError(
        "This article improvement is no longer awaiting review."
      );
    }
    if (
      !(await isStudentHandbookContributor(
        tx,
        organizationId,
        observation.contributorUserId
      ))
    ) {
      throw new HandbookValidationError(
        "Only student article improvements require staff review."
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
        ...reviewFeedbackUpdate(observation.content, feedback),
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
        staffOnly: false,
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
        ...(audience === "staff" ? {} : { staffOnly: false }),
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
