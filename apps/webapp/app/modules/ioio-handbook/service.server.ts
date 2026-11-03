import {
  HandbookArticleStatus,
  HandbookObservationStatus,
  HandbookSourceKind,
  Prisma,
} from "@prisma/client";
import type { Prisma as PrismaTypes } from "@prisma/client";
import { db } from "~/database/db.server";
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
    orderBy: [{ updatedAt: "desc" }, { slug: "asc" }],
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
    },
  });
  return articles;
}

export async function getPublishedHandbookArticle({
  organizationId,
  slug,
  versionId,
}: {
  organizationId: string;
  slug: string;
  versionId?: string;
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
        take: 20,
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
  const selectedVersion = versionId
    ? await db.handbookArticleVersion.findFirst({
        where: { id: versionId, articleId: article.id },
        include: {
          ...handbookReferences,
        },
      })
    : article.publishedVersion;
  if (!selectedVersion) return null;
  const authorNames = await getDisplayNamesByUserId([
    selectedVersion.publishedByUserId,
    ...article.versions.map((version) => version.publishedByUserId),
  ]);
  return {
    ...article,
    publishedVersion: {
      ...selectedVersion,
      publishedByName:
        authorNames.get(selectedVersion.publishedByUserId) ?? null,
    },
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
}: {
  organizationId: string;
  articleId?: string;
  slug?: string;
}) {
  const [article, categories] = await Promise.all([
    articleId || slug
      ? db.handbookArticle.findFirst({
          where: articleId
            ? { id: articleId, organizationId }
            : { slug, organizationId },
          select: {
            id: true,
            status: true,
            draftTitle: true,
            draftContent: true,
            handbookCategoryId: true,
            draftSourceUrls: true,
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
          return tx.handbookCategory.update({
            where: { id: existing.id, organizationId },
            data: { name: cleanedName, archivedAt: null },
            select: { id: true, name: true },
          });
        }
        return { id: existing.id, name: existing.name };
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

      return tx.handbookCategory.create({
        data: { organizationId, name: cleanedName, slug, normalizedName },
        select: { id: true, name: true },
      });
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
        return { id: existing.id, name: existing.name };
      }
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
  title,
  handbookCategoryId,
  content,
  sourceUrls,
}: {
  organizationId: string;
  userId: string;
  articleId?: string;
  title: string;
  handbookCategoryId: string;
  content: string;
  sourceUrls: string[];
}) {
  const normalizedTitle = title.trim();
  const normalizedContent = content.trim();
  if (!normalizedTitle || !handbookCategoryId.trim() || !normalizedContent) {
    throw new HandbookValidationError(
      "Add a title, choose a category, and add article content before saving."
    );
  }
  if (normalizedTitle.length > 180 || normalizedContent.length > 30_000) {
    throw new HandbookValidationError(
      "One or more fields are longer than the allowed limit."
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
  if (articleId) {
    const current = await db.handbookArticle.findFirst({
      where: { id: articleId, organizationId },
      select: { id: true, slug: true },
    });
    if (!current)
      throw new HandbookValidationError(
        "That Handbook draft could not be found."
      );
    return db.handbookArticle.update({
      where: { id: current.id, organizationId },
      data: {
        draftTitle: normalizedTitle,
        draftContent: normalizedContent,
        handbookCategoryId: category.id,
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
      handbookCategoryId: category.id,
      draftSourceUrls: validSources,
      createdByUserId: userId,
      updatedByUserId: userId,
    },
    select: { id: true, slug: true, status: true },
  });
}

export async function publishHandbookArticle({
  organizationId,
  userId,
  articleId,
}: {
  organizationId: string;
  userId: string;
  articleId: string;
}) {
  return db.$transaction(async (tx) => {
    const article = await tx.handbookArticle.findFirst({
      where: { id: articleId, organizationId },
    });
    if (!article)
      throw new HandbookValidationError(
        "That Handbook article could not be found."
      );
    const category = article.handbookCategoryId
      ? await tx.handbookCategory.findFirst({
          where: {
            id: article.handbookCategoryId,
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

export async function listHandbookObservations(organizationId: string) {
  const observations = await db.handbookObservation.findMany({
    where: { organizationId, status: HandbookObservationStatus.PENDING_REVIEW },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: {
      article: {
        select: { slug: true, publishedVersion: { select: { title: true } } },
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
    select: { id: true, proposedCategoryName: true },
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

  const update = await db.handbookObservation.updateMany({
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
