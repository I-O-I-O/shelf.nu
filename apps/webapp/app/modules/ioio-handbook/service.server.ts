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
import { resolveStorageImageUrl } from "~/utils/storage.server";
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

const assetRelations = {
  assetModels: {
    select: {
      assetModel: {
        select: {
          id: true,
          name: true,
          image: true,
          imageStoragePath: true,
          thumbnailImage: true,
          thumbnailImageStoragePath: true,
        },
      },
    },
  },
  kits: {
    select: {
      kit: {
        select: { id: true, name: true, image: true, imageStoragePath: true },
      },
    },
  },
  sources: {
    select: {
      source: { select: { id: true, title: true, url: true, kind: true } },
    },
  },
} satisfies PrismaTypes.HandbookArticleVersionInclude;

type CanonicalHandbookAsset = {
  kind: "asset-model";
  id: string;
  name: string;
  image: string | null;
  imageStoragePath: string | null;
  thumbnailImage: string | null;
  thumbnailImageStoragePath: string | null;
  imageUrl: string | null;
  thumbnailUrl: string | null;
};

type CanonicalHandbookKit = {
  kind: "kit";
  id: string;
  name: string;
  image: string | null;
  imageStoragePath: string | null;
  imageUrl: string | null;
};

type CanonicalHandbookVersion<T> = Omit<T, "assetModels" | "kits"> & {
  assetModels: CanonicalHandbookAsset[];
  kits: CanonicalHandbookKit[];
};

async function withCanonicalImages<
  T extends {
    assetModels: Array<{
      assetModel: {
        image?: string | null;
        imageStoragePath?: string | null;
        thumbnailImage?: string | null;
        thumbnailImageStoragePath?: string | null;
      };
    }>;
    kits: Array<{
      kit: { image?: string | null; imageStoragePath?: string | null };
    }>;
  },
>(version: T): Promise<CanonicalHandbookVersion<T>> {
  const canonical = {
    ...version,
    assetModels: await Promise.all(
      version.assetModels.map(async ({ assetModel }) => ({
        kind: "asset-model" as const,
        ...assetModel,
        imageUrl: await resolveStorageImageUrl({
          bucketName: "files",
          objectPath: assetModel.imageStoragePath,
          legacyUrl: assetModel.image,
          isPublic: true,
        }),
        thumbnailUrl: await resolveStorageImageUrl({
          bucketName: "files",
          objectPath: assetModel.thumbnailImageStoragePath,
          legacyUrl: assetModel.thumbnailImage,
          isPublic: true,
        }),
      }))
    ),
    kits: await Promise.all(
      version.kits.map(async ({ kit }) => ({
        kind: "kit" as const,
        ...kit,
        imageUrl: await resolveStorageImageUrl({
          bucketName: "kits",
          objectPath: kit.imageStoragePath,
          legacyUrl: kit.image,
          isPublic: false,
        }),
      }))
    ),
  };
  return canonical as unknown as CanonicalHandbookVersion<T>;
}

export async function listPublishedHandbookArticles({
  organizationId,
  query = "",
  section,
}: {
  organizationId: string;
  query?: string;
  section?: string;
}) {
  const search = query.trim().slice(0, 120);
  const articles = await db.handbookArticle.findMany({
    where: {
      organizationId,
      status: HandbookArticleStatus.PUBLISHED,
      publishedVersion: {
        is: {
          ...(section ? { section } : {}),
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
      publishedVersion: {
        include: {
          ...assetRelations,
        },
      },
    },
  });

  const versions = await Promise.all(
    articles.flatMap((article) =>
      article.publishedVersion
        ? [withCanonicalImages(article.publishedVersion)]
        : []
    )
  );
  const byId = new Map(versions.map((version) => [version.id, version]));
  return articles.flatMap((article) => {
    const version = article.publishedVersion
      ? byId.get(article.publishedVersion.id)
      : null;
    return version ? [{ ...article, publishedVersion: version }] : [];
  });
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
      publishedVersion: {
        include: {
          ...assetRelations,
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
          ...assetRelations,
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
      ...(await withCanonicalImages(selectedVersion)),
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
  const [article, assetModels, kits] = await Promise.all([
    articleId || slug
      ? db.handbookArticle.findFirst({
          where: articleId
            ? { id: articleId, organizationId }
            : { slug, organizationId },
          include: {
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
    db.assetModel.findMany({
      where: { organizationId },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
      take: 500,
    }),
    db.kit.findMany({
      where: { organizationId },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
      take: 500,
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
    assetModels,
    kits,
  };
}

function uniqueIds(values: string[]) {
  return [
    ...new Set(values.map((value) => value.trim()).filter(Boolean)),
  ].slice(0, 100);
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
  summary,
  content,
  section,
  assetModelIds,
  kitIds,
  sourceUrls,
}: {
  organizationId: string;
  userId: string;
  articleId?: string;
  title: string;
  summary: string;
  content: string;
  section: string;
  assetModelIds: string[];
  kitIds: string[];
  sourceUrls: string[];
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
    summary.length > 700 ||
    section.length > 80 ||
    normalizedContent.length > 30_000
  ) {
    throw new HandbookValidationError(
      "One or more fields are longer than the allowed limit."
    );
  }
  const validAssetModels = uniqueIds(assetModelIds);
  const validKits = uniqueIds(kitIds);
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
  const [assetModelCount, kitCount] = await Promise.all([
    validAssetModels.length
      ? db.assetModel.count({
          where: { organizationId, id: { in: validAssetModels } },
        })
      : 0,
    validKits.length
      ? db.kit.count({ where: { organizationId, id: { in: validKits } } })
      : 0,
  ]);
  if (
    assetModelCount !== validAssetModels.length ||
    kitCount !== validKits.length
  ) {
    throw new HandbookValidationError(
      "One or more linked inventory products are not in this workspace."
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
        draftSummary: summary.trim(),
        draftContent: normalizedContent,
        draftSection: section.trim() || "General",
        draftAssetModelIds: validAssetModels,
        draftKitIds: validKits,
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
      draftSummary: summary.trim(),
      draftContent: normalizedContent,
      draftSection: section.trim() || "General",
      draftAssetModelIds: validAssetModels,
      draftKitIds: validKits,
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
    const [assetModelCount, kitCount] = await Promise.all([
      article.draftAssetModelIds.length
        ? tx.assetModel.count({
            where: { organizationId, id: { in: article.draftAssetModelIds } },
          })
        : 0,
      article.draftKitIds.length
        ? tx.kit.count({
            where: { organizationId, id: { in: article.draftKitIds } },
          })
        : 0,
    ]);
    if (
      assetModelCount !== article.draftAssetModelIds.length ||
      kitCount !== article.draftKitIds.length
    ) {
      throw new HandbookValidationError(
        "A linked Shelf product has changed. Reopen the draft and review its links before publishing."
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
        summary: article.draftSummary,
        content: article.draftContent,
        section: article.draftSection,
        publishedByUserId: userId,
      },
    });
    if (article.draftAssetModelIds.length) {
      await tx.handbookArticleAssetModel.createMany({
        data: article.draftAssetModelIds.map((assetModelId) => ({
          versionId: version.id,
          assetModelId,
        })),
        skipDuplicates: true,
      });
    }
    if (article.draftKitIds.length) {
      await tx.handbookArticleKit.createMany({
        data: article.draftKitIds.map((kitId) => ({
          versionId: version.id,
          kitId,
        })),
        skipDuplicates: true,
      });
    }
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
  assetModelId,
  kitId,
}: {
  organizationId: string;
  userId: string;
  title: string;
  content: string;
  articleId?: string;
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
      draftSection: true,
      updatedAt: true,
      publishedVersion: {
        select: { title: true, versionNumber: true, publishedAt: true },
      },
    },
  });
}

export async function getHandbookContributionOptions(organizationId: string) {
  const [articles, assetModels, kits] = await Promise.all([
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
  ]);
  return {
    articles: articles.flatMap(({ id, slug, publishedVersion }) =>
      publishedVersion ? [{ id, slug, title: publishedVersion.title }] : []
    ),
    assetModels,
    kits,
  };
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
  section?: string;
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
        publishedVersion: {
          select: {
            title: true,
            summary: true,
            section: true,
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
    ...articles.flatMap(({ publishedVersion }) =>
      publishedVersion
        ? [
            {
              kind: "article" as const,
              title: publishedVersion.title,
              section: publishedVersion.section,
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
            section: true,
            content: true,
            versionNumber: true,
            publishedAt: true,
          },
        },
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
    .flatMap(({ slug, publishedVersion }) =>
      publishedVersion
        ? [
            {
              slug,
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
  const sections = [
    ...rankedArticles.map(
      ({ slug, version }) =>
        `Published Handbook · ${version.section} · ${version.title} · version ${
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
  return sections.length ? sections.join("\n\n").slice(0, 6500) : "";
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
