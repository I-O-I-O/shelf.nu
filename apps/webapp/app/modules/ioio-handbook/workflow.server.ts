import { HandbookArticleStatus } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { db } from "~/database/db.server";
import { recordEvent } from "~/modules/activity-event/service.server";
import { resolveUserDisplayName } from "~/utils/user";
import { makeHandbookSlug, normalizeSourceUrl } from "./handbook.shared";
import { HANDBOOK_ARTICLE_TYPES } from "./handbook.types";

// Keep Handbook queries on Shelf's shared Prisma client and its generated model types.
const handbookDb = db;

export class HandbookWorkflowError extends Error {
  constructor(
    message: string,
    public status: 400 | 403 | 404 = 400
  ) {
    super(message);
    this.name = "HandbookWorkflowError";
  }
}

export type HandbookWorkItem = {
  id: string;
  status: string;
  title: string;
  revisionNumber: number;
  submittedAt: Date | null;
  reviewNotes: string | null;
  article: {
    slug: string;
    publishedVersion: { title: string; versionNumber: number } | null;
  };
};

export type HandbookReviewQueueItem = {
  id: string;
  status: string;
  title: string;
  revisionNumber: number;
  authorUserId: string;
  articleType: string;
  submittedAt: Date | null;
  authorName: string | null;
  article: {
    slug: string;
    publishedVersion: { title: string; versionNumber: number } | null;
  };
  category: { name: string } | null;
  topic: { name: string } | null;
};

export type HandbookFindingSummary = {
  id: string;
  type: string;
  title: string;
  details: string;
  article: { slug: string; publishedVersion: { title: string } | null } | null;
  relatedArticle: {
    slug: string;
    publishedVersion: { title: string } | null;
  } | null;
};

export type HandbookHealth = {
  counts: {
    published: number;
    pending: number;
    duplicates: number;
    conflicts: number;
    missingStructure: number;
    stale: number;
  };
  findings: HandbookFindingSummary[];
};

export type ArchivedHandbookArticle = {
  id: string;
  slug: string;
  updatedAt: Date;
  publishedVersion: { title: string; versionNumber: number } | null;
  draftTitle: string;
};

type RevisionInput = {
  organizationId: string;
  userId: string;
  canEdit: boolean;
  articleId?: string;
  slug?: string;
  revisionId?: string;
  title: string;
  summary: string;
  content: string;
  category: string;
  topic: string;
  articleType: string;
  locationId?: string;
  videoUrls: string[];
  assetModelIds: string[];
  kitIds: string[];
  sourceUrls: string[];
};

function normalizeName(value: string, label: string, max: number) {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > max) {
    throw new HandbookWorkflowError(
      `Add a valid ${label} (up to ${max} characters).`
    );
  }
  return normalized;
}

function uniqueIds(values: string[]) {
  return [
    ...new Set(values.map((value) => value.trim()).filter(Boolean)),
  ].slice(0, 100);
}

function cleanHttpsUrls(values: string[], label: string, maxItems: number) {
  const submitted = values.map((value) => value.trim()).filter(Boolean);
  const clean = [
    ...new Set(
      submitted.filter((value) => {
        try {
          return new URL(value).protocol === "https:";
        } catch {
          return false;
        }
      })
    ),
  ];
  if (
    clean.length !== submitted.length ||
    clean.some((url) => url.length > 500) ||
    clean.length > maxItems
  ) {
    throw new HandbookWorkflowError(
      `${label} must be valid HTTPS URLs, up to 500 characters each.`
    );
  }
  return clean;
}

async function resolveTaxonomy(
  organizationId: string,
  categoryName: string,
  topicName: string
) {
  const categorySlug = makeHandbookSlug(categoryName) || "general";
  const category = await handbookDb.handbookCategory.upsert({
    where: { organizationId_slug: { organizationId, slug: categorySlug } },
    create: { organizationId, name: categoryName, slug: categorySlug },
    update: {},
    select: { id: true, name: true },
  });
  const topicSlug = makeHandbookSlug(topicName) || "general";
  const topic = await handbookDb.handbookTopic.upsert({
    where: { categoryId_slug: { categoryId: category.id, slug: topicSlug } },
    create: {
      organizationId,
      categoryId: category.id,
      name: topicName,
      slug: topicSlug,
    },
    update: {},
    select: { id: true, name: true },
  });
  return { category, topic };
}

function validateRevisionInput(input: RevisionInput) {
  const title = normalizeName(input.title, "title", 180);
  const category = normalizeName(input.category, "category", 80);
  const topic = normalizeName(input.topic, "topic", 100);
  const summary = input.summary.trim();
  const content = input.content.trim();
  if (!content)
    throw new HandbookWorkflowError("Add article content before saving.");
  if (summary.length > 700 || content.length > 30_000) {
    throw new HandbookWorkflowError(
      "One or more fields are longer than the allowed limit."
    );
  }
  if (
    !(HANDBOOK_ARTICLE_TYPES as readonly string[]).includes(input.articleType)
  ) {
    throw new HandbookWorkflowError("Choose a supported article type.");
  }
  const videoUrls = cleanHttpsUrls(input.videoUrls, "Video links", 10);
  const sourceUrls = input.sourceUrls.map(normalizeSourceUrl);
  if (sourceUrls.some((url) => !url) || input.sourceUrls.length > 20) {
    throw new HandbookWorkflowError(
      "References must be valid HTTP or HTTPS URLs (up to 20 links)."
    );
  }
  return {
    title,
    category,
    topic,
    summary,
    content,
    articleType: input.articleType,
    videoUrls,
    sourceUrls: [...new Set(sourceUrls as string[])],
    assetModelIds: uniqueIds(input.assetModelIds),
    kitIds: uniqueIds(input.kitIds),
    locationId: input.locationId?.trim() || null,
  };
}

export async function getHandbookFormOptions({
  organizationId,
  userId,
  canEdit,
  slug,
  revisionId,
}: {
  organizationId: string;
  userId: string;
  canEdit: boolean;
  slug?: string;
  revisionId?: string;
}) {
  const [categories, topics, locations, assetModels, kits, article] =
    await Promise.all([
      handbookDb.handbookCategory.findMany({
        where: { organizationId },
        orderBy: { name: "asc" },
        select: { id: true, name: true },
      }),
      handbookDb.handbookTopic.findMany({
        where: { organizationId },
        orderBy: [{ category: { name: "asc" } }, { name: "asc" }],
        include: { category: { select: { id: true, name: true } } },
      }),
      handbookDb.location.findMany({
        where: { organizationId },
        orderBy: { name: "asc" },
        select: { id: true, name: true, parentId: true },
      }),
      db.assetModel.findMany({
        where: { organizationId },
        orderBy: { name: "asc" },
        take: 300,
        select: { id: true, name: true },
      }),
      db.kit.findMany({
        where: { organizationId },
        orderBy: { name: "asc" },
        take: 300,
        select: { id: true, name: true },
      }),
      slug
        ? handbookDb.handbookArticle.findFirst({
            where: { organizationId, slug },
            include: {
              publishedVersion: {
                include: {
                  category: true,
                  topic: true,
                  assetModels: { select: { assetModelId: true } },
                  kits: { select: { kitId: true } },
                  sources: { include: { source: { select: { url: true } } } },
                },
              },
              revisions: {
                where: {
                  authorUserId: userId,
                  status: { in: ["DRAFT", "PENDING_REVIEW"] },
                  ...(revisionId ? { id: revisionId } : {}),
                },
                orderBy: { updatedAt: "desc" },
                take: 1,
                include: {
                  category: { select: { id: true, name: true } },
                  topic: { select: { id: true, name: true } },
                },
              },
            },
          })
        : null,
    ]);
  if (slug && !article)
    throw new HandbookWorkflowError(
      "This Handbook article is not available.",
      404
    );
  const draft =
    article?.revisions?.find((item) => item.status === "DRAFT") ?? null;
  const pendingRevision =
    article?.revisions?.find((item) => item.status === "PENDING_REVIEW") ??
    null;
  if (revisionId && (!draft || draft.id !== revisionId)) {
    throw new HandbookWorkflowError(
      "That draft is not available to your account.",
      404
    );
  }
  if (
    article &&
    !article.publishedVersionId &&
    article.createdByUserId !== userId &&
    !canEdit
  ) {
    throw new HandbookWorkflowError(
      "Only the proposal author or staff can work on this unpublished article.",
      403
    );
  }
  const canonical = article?.publishedVersion ?? null;
  const initial = draft ?? canonical;
  return {
    categories,
    topics,
    locations,
    assetModels,
    kits,
    article: article
      ? { id: article.id, slug: article.slug, status: article.status }
      : null,
    revision: draft,
    pendingRevision: pendingRevision ? { id: pendingRevision.id } : null,
    initial: initial
      ? {
          title: initial.title,
          summary: initial.summary,
          content: initial.content,
          category: initial.category?.name ?? initial.section ?? "General",
          topic: initial.topic?.name ?? "General",
          articleType: initial.articleType ?? "Guide",
          locationId: initial.locationId ?? "",
          videoUrls: initial.videoUrls ?? [],
          assetModelIds:
            draft?.assetModelIds ??
            canonical?.assetModels?.map((entry) => entry.assetModelId) ??
            [],
          kitIds:
            draft?.kitIds ?? canonical?.kits?.map((entry) => entry.kitId) ?? [],
          sourceUrls:
            draft?.sourceUrls ??
            canonical?.sources?.flatMap((entry) =>
              entry.source.url ? [entry.source.url] : []
            ) ??
            [],
        }
      : null,
  };
}

export async function saveHandbookRevision(input: RevisionInput) {
  const fields = validateRevisionInput(input);
  const {
    category: categoryName,
    topic: topicName,
    ...revisionFields
  } = fields;
  const relatedCounts = await Promise.all([
    fields.assetModelIds.length
      ? db.assetModel.count({
          where: {
            organizationId: input.organizationId,
            id: { in: fields.assetModelIds },
          },
        })
      : 0,
    fields.kitIds.length
      ? db.kit.count({
          where: {
            organizationId: input.organizationId,
            id: { in: fields.kitIds },
          },
        })
      : 0,
    fields.locationId
      ? handbookDb.location.count({
          where: {
            id: fields.locationId,
            organizationId: input.organizationId,
          },
        })
      : 1,
  ]);
  if (
    relatedCounts[0] !== fields.assetModelIds.length ||
    relatedCounts[1] !== fields.kitIds.length ||
    relatedCounts[2] !== 1
  ) {
    throw new HandbookWorkflowError(
      "A selected Shelf product or Location is not in this workspace."
    );
  }
  const { category, topic } = await resolveTaxonomy(
    input.organizationId,
    categoryName,
    topicName
  );

  return db.$transaction(async (tx) => {
    const txHandbook = tx;
    let article = input.articleId
      ? await txHandbook.handbookArticle.findFirst({
          where: { id: input.articleId, organizationId: input.organizationId },
        })
      : input.slug
      ? await txHandbook.handbookArticle.findFirst({
          where: { slug: input.slug, organizationId: input.organizationId },
        })
      : null;
    if ((input.articleId || input.slug) && !article)
      throw new HandbookWorkflowError(
        "This Handbook article is not available.",
        404
      );
    if (article?.status === "ARCHIVED")
      throw new HandbookWorkflowError(
        "Archived articles cannot receive revisions."
      );
    if (
      article &&
      !article.publishedVersionId &&
      article.createdByUserId !== input.userId &&
      !input.canEdit
    ) {
      throw new HandbookWorkflowError(
        "Only the proposal author or staff can work on this unpublished article.",
        403
      );
    }

    if (!article) {
      const base = makeHandbookSlug(fields.title) || "handbook-article";
      const existing = await txHandbook.handbookArticle.findMany({
        where: {
          organizationId: input.organizationId,
          slug: { startsWith: base },
        },
        select: { slug: true },
      });
      const taken = new Set(existing.map((row: { slug: string }) => row.slug));
      let slug = base;
      let suffix = 2;
      while (taken.has(slug)) slug = `${base}-${suffix++}`;
      article = await txHandbook.handbookArticle.create({
        data: {
          organizationId: input.organizationId,
          slug,
          draftTitle: fields.title,
          draftSummary: fields.summary,
          draftContent: fields.content,
          draftSection: categoryName,
          draftAssetModelIds: fields.assetModelIds,
          draftKitIds: fields.kitIds,
          draftSourceUrls: fields.sourceUrls,
          createdByUserId: input.userId,
          updatedByUserId: input.userId,
        },
      });
    }

    if (input.revisionId) {
      const ownDraft = await txHandbook.handbookRevision.findFirst({
        where: {
          id: input.revisionId,
          organizationId: input.organizationId,
          articleId: article.id,
          authorUserId: input.userId,
          status: "DRAFT",
        },
      });
      if (!ownDraft)
        throw new HandbookWorkflowError(
          "Only your own saved draft can be edited.",
          403
        );
      return txHandbook.handbookRevision
        .update({
          where: { id: ownDraft.id, organizationId: input.organizationId },
          data: {
            ...revisionFields,
            categoryId: category.id,
            topicId: topic.id,
          },
          select: {
            id: true,
            articleId: true,
            revisionNumber: true,
            status: true,
          },
        })
        .then((revision) => ({ ...revision, slug: article.slug }));
    }

    const [versionMax, revisionMax] = await Promise.all([
      txHandbook.handbookArticleVersion.aggregate({
        where: { articleId: article.id },
        _max: { versionNumber: true },
      }),
      txHandbook.handbookRevision.aggregate({
        where: { articleId: article.id },
        _max: { revisionNumber: true },
      }),
    ]);
    const revisionNumber =
      Math.max(
        versionMax._max.versionNumber ?? 0,
        revisionMax._max.revisionNumber ?? 0
      ) + 1;
    const revision = await txHandbook.handbookRevision.create({
      data: {
        organizationId: input.organizationId,
        articleId: article.id,
        revisionNumber,
        authorUserId: input.userId,
        ...revisionFields,
        categoryId: category.id,
        topicId: topic.id,
      },
      select: { id: true, articleId: true, revisionNumber: true, status: true },
    });
    return { ...revision, slug: article.slug };
  });
}

export async function submitHandbookRevision({
  organizationId,
  userId,
  revisionId,
}: {
  organizationId: string;
  userId: string;
  revisionId: string;
}) {
  const revision = await handbookDb.handbookRevision.findFirst({
    where: {
      id: revisionId,
      organizationId,
      authorUserId: userId,
      status: "DRAFT",
    },
    select: { id: true, articleId: true },
  });
  if (!revision)
    throw new HandbookWorkflowError(
      "Only your own saved draft can be submitted.",
      403
    );
  const pending = await handbookDb.handbookRevision.count({
    where: {
      organizationId,
      articleId: revision.articleId,
      status: "PENDING_REVIEW",
    },
  });
  if (pending)
    throw new HandbookWorkflowError(
      "This article already has a revision awaiting staff review."
    );
  const submitted = await handbookDb.handbookRevision.update({
    where: { id: revision.id, organizationId },
    data: { status: "PENDING_REVIEW", submittedAt: new Date() },
    select: { id: true, articleId: true, revisionNumber: true, status: true },
  });
  return submitted;
}

export async function publishHandbookRevision({
  organizationId,
  userId,
  revisionId,
}: {
  organizationId: string;
  userId: string;
  revisionId: string;
}) {
  return db.$transaction(async (tx) => {
    const h = tx;
    const revision = await h.handbookRevision.findFirst({
      where: {
        id: revisionId,
        organizationId,
        status: { in: ["DRAFT", "PENDING_REVIEW"] },
      },
    });
    if (!revision)
      throw new HandbookWorkflowError(
        "This proposal is no longer available for publication."
      );
    const otherPending = await h.handbookRevision.count({
      where: {
        organizationId,
        articleId: revision.articleId,
        status: "PENDING_REVIEW",
        id: { not: revision.id },
      },
    });
    if (otherPending)
      throw new HandbookWorkflowError(
        "Review the other pending proposal before publishing this one."
      );
    const article = await h.handbookArticle.findFirst({
      where: { id: revision.articleId, organizationId },
    });
    if (!article || article.status === "ARCHIVED")
      throw new HandbookWorkflowError(
        "This Handbook article cannot be published."
      );
    const [assetModelCount, kitCount, locationCount] = await Promise.all([
      revision.assetModelIds.length
        ? tx.assetModel.count({
            where: { organizationId, id: { in: revision.assetModelIds } },
          })
        : 0,
      revision.kitIds.length
        ? tx.kit.count({
            where: { organizationId, id: { in: revision.kitIds } },
          })
        : 0,
      revision.locationId
        ? h.location.count({
            where: { id: revision.locationId, organizationId },
          })
        : 1,
    ]);
    if (
      assetModelCount !== revision.assetModelIds.length ||
      kitCount !== revision.kitIds.length ||
      locationCount !== 1
    )
      throw new HandbookWorkflowError(
        "A linked Shelf record changed. Reopen the proposal and review its links."
      );
    const version = await h.handbookArticleVersion.create({
      data: {
        articleId: article.id,
        versionNumber: revision.revisionNumber,
        title: revision.title,
        summary: revision.summary,
        content: revision.content,
        section: revision.section,
        publishedByUserId: userId,
        authorUserId: revision.authorUserId,
        categoryId: revision.categoryId,
        topicId: revision.topicId,
        articleType: revision.articleType,
        locationId: revision.locationId,
        videoUrls: revision.videoUrls,
      },
    });
    if (revision.assetModelIds.length)
      await h.handbookArticleAssetModel.createMany({
        data: revision.assetModelIds.map((assetModelId: string) => ({
          versionId: version.id,
          assetModelId,
        })),
        skipDuplicates: true,
      });
    if (revision.kitIds.length)
      await h.handbookArticleKit.createMany({
        data: revision.kitIds.map((kitId: string) => ({
          versionId: version.id,
          kitId,
        })),
        skipDuplicates: true,
      });
    const sourceIds: string[] = [];
    for (const url of revision.sourceUrls as string[]) {
      const normalized = normalizeSourceUrl(url);
      if (!normalized) continue;
      const source = await h.handbookSource.upsert({
        where: { organizationId_url: { organizationId, url: normalized } },
        create: {
          organizationId,
          kind: "EXTERNAL_REFERENCE",
          title: new URL(normalized).hostname.replace(/^www\./, ""),
          url: normalized,
          createdByUserId: revision.authorUserId,
        },
        update: {},
        select: { id: true },
      });
      sourceIds.push(source.id);
    }
    if (sourceIds.length)
      await h.handbookVersionSource.createMany({
        data: sourceIds.map((sourceId) => ({
          versionId: version.id,
          sourceId,
        })),
        skipDuplicates: true,
      });
    await h.handbookArticle.update({
      where: { id: article.id, organizationId },
      data: {
        status: "PUBLISHED",
        publishedVersionId: version.id,
        draftTitle: revision.title,
        draftSummary: revision.summary,
        draftContent: revision.content,
        draftSection: revision.section,
        draftAssetModelIds: revision.assetModelIds,
        draftKitIds: revision.kitIds,
        draftSourceUrls: revision.sourceUrls,
        updatedByUserId: userId,
      },
    });
    await h.handbookRevision.update({
      where: { id: revision.id, organizationId },
      data: {
        status: "APPROVED",
        reviewedAt: new Date(),
        reviewedByUserId: userId,
        publishedVersionId: version.id,
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
        } as Prisma.InputJsonValue,
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

export async function reviewHandbookRevision({
  organizationId,
  userId,
  revisionId,
  decision,
  notes,
}: {
  organizationId: string;
  userId: string;
  revisionId: string;
  decision: "approve" | "return" | "reject";
  notes: string;
}) {
  const revision = await handbookDb.handbookRevision.findFirst({
    where: { id: revisionId, organizationId, status: "PENDING_REVIEW" },
    select: { id: true, articleId: true },
  });
  if (!revision)
    throw new HandbookWorkflowError(
      "This proposal is no longer awaiting review."
    );
  if (decision === "approve")
    return publishHandbookRevision({ organizationId, userId, revisionId });
  await handbookDb.handbookRevision.update({
    where: { id: revisionId, organizationId },
    data: {
      status: decision === "reject" ? "REJECTED" : "DRAFT",
      reviewedAt: new Date(),
      reviewedByUserId: userId,
      reviewNotes: notes.trim().slice(0, 4000),
    },
  });
  if (decision === "reject")
    await handbookDb.handbookArticle.updateMany({
      where: {
        id: revision.articleId,
        organizationId,
        status: "DRAFT",
        publishedVersionId: null,
      },
      data: { status: "ARCHIVED", updatedByUserId: userId },
    });
  return { returned: decision === "return" };
}

export async function convertHandbookProposalToRevision({
  organizationId,
  userId,
  revisionId,
  targetArticleId,
}: {
  organizationId: string;
  userId: string;
  revisionId: string;
  targetArticleId: string;
}) {
  return db.$transaction(async (tx) => {
    const h = tx;
    const proposal = await h.handbookRevision.findFirst({
      where: { id: revisionId, organizationId, status: "PENDING_REVIEW" },
    });
    const target = await h.handbookArticle.findFirst({
      where: { id: targetArticleId, organizationId, status: "PUBLISHED" },
    });
    if (!proposal || !target || proposal.articleId === targetArticleId)
      throw new HandbookWorkflowError(
        "Choose an existing published article for this proposal."
      );
    const [versionMax, revisionMax] = await Promise.all([
      h.handbookArticleVersion.aggregate({
        where: { articleId: targetArticleId },
        _max: { versionNumber: true },
      }),
      h.handbookRevision.aggregate({
        where: { articleId: targetArticleId },
        _max: { revisionNumber: true },
      }),
    ]);
    const revisionNumber =
      Math.max(
        versionMax._max.versionNumber ?? 0,
        revisionMax._max.revisionNumber ?? 0
      ) + 1;
    await h.handbookRevision.update({
      where: { id: proposal.id, organizationId },
      data: {
        articleId: targetArticleId,
        revisionNumber,
        reviewNotes: "Converted to a revision of an existing article.",
        reviewedByUserId: userId,
        reviewedAt: new Date(),
      },
    });
    await h.handbookFinding.updateMany({
      where: { revisionId: proposal.id, organizationId },
      data: { articleId: targetArticleId },
    });
    await h.handbookFinding.updateMany({
      where: {
        revisionId: proposal.id,
        organizationId,
        type: "DUPLICATE",
        relatedArticleId: targetArticleId,
        status: "OPEN",
      },
      data: {
        status: "RESOLVED",
        staffDecision: "CONVERTED_TO_REVISION",
        decidedByUserId: userId,
        decidedAt: new Date(),
      },
    });
    const source = await h.handbookArticle.findFirst({
      where: {
        id: proposal.articleId,
        organizationId,
        publishedVersionId: null,
      },
    });
    if (source) {
      const remaining = await h.handbookRevision.count({
        where: { articleId: source.id },
      });
      if (remaining === 0) {
        await h.handbookArticle.update({
          where: { id: source.id, organizationId },
          data: { status: "ARCHIVED", updatedByUserId: userId },
        });
      }
    }
    return { articleId: target.id, slug: target.slug, revisionNumber };
  });
}

export async function markHandbookCandidateNotDuplicate({
  organizationId,
  userId,
  revisionId,
  relatedArticleId,
}: {
  organizationId: string;
  userId: string;
  revisionId: string;
  relatedArticleId: string;
}) {
  const revision = await handbookDb.handbookRevision.findFirst({
    where: { id: revisionId, organizationId, status: "PENDING_REVIEW" },
    select: { id: true, articleId: true },
  });
  const related = await handbookDb.handbookArticle.findFirst({
    where: { id: relatedArticleId, organizationId, status: "PUBLISHED" },
    select: { id: true, publishedVersion: { select: { title: true } } },
  });
  if (!revision || !related || revision.articleId === relatedArticleId)
    throw new HandbookWorkflowError(
      "That duplicate relationship is not available."
    );
  const existing = await handbookDb.handbookFinding.findFirst({
    where: {
      organizationId,
      type: "DUPLICATE",
      articleId: revision.articleId,
      relatedArticleId,
    },
    select: { id: true },
  });
  if (existing) {
    await handbookDb.handbookFinding.update({
      where: { id: existing.id, organizationId },
      data: {
        status: "DISMISSED",
        staffDecision: "NOT_A_DUPLICATE",
        decidedByUserId: userId,
        decidedAt: new Date(),
      },
    });
  } else {
    await handbookDb.handbookFinding.create({
      data: {
        organizationId,
        type: "DUPLICATE",
        status: "DISMISSED",
        articleId: revision.articleId,
        relatedArticleId,
        revisionId,
        title: `Staff marked not a duplicate: ${
          related.publishedVersion?.title ?? "Handbook article"
        }`,
        details:
          "A staff reviewer marked this proposed relationship as not a duplicate.",
        staffDecision: "NOT_A_DUPLICATE",
        decidedByUserId: userId,
        decidedAt: new Date(),
        createdByUserId: userId,
      },
    });
  }
}

export async function resolveHandbookFinding({
  organizationId,
  userId,
  findingId,
  status,
}: {
  organizationId: string;
  userId: string;
  findingId: string;
  status: "DISMISSED" | "RESOLVED";
}) {
  const result = await handbookDb.handbookFinding.updateMany({
    where: { id: findingId, organizationId, status: "OPEN" },
    data: {
      status,
      staffDecision: status,
      decidedByUserId: userId,
      decidedAt: new Date(),
    },
  });
  if (!result.count)
    throw new HandbookWorkflowError("This finding is no longer open.");
}

export async function archiveHandbookArticle({
  organizationId,
  articleId,
  userId,
}: {
  organizationId: string;
  articleId: string;
  userId: string;
}) {
  const result = await handbookDb.handbookArticle.updateMany({
    where: { id: articleId, organizationId, status: { not: "ARCHIVED" } },
    data: { status: "ARCHIVED", updatedByUserId: userId },
  });
  if (!result.count)
    throw new HandbookWorkflowError("This article is not available.", 404);
}

export function listArchivedHandbookArticles(
  organizationId: string
): Promise<ArchivedHandbookArticle[]> {
  return handbookDb.handbookArticle.findMany({
    where: { organizationId, status: "ARCHIVED" },
    orderBy: { updatedAt: "desc" },
    take: 100,
    select: {
      id: true,
      slug: true,
      updatedAt: true,
      publishedVersion: { select: { title: true, versionNumber: true } },
      draftTitle: true,
    },
  });
}

export async function restoreHandbookArticle({
  organizationId,
  articleId,
  userId,
}: {
  organizationId: string;
  articleId: string;
  userId: string;
}) {
  const article = await handbookDb.handbookArticle.findFirst({
    where: { id: articleId, organizationId, status: "ARCHIVED" },
    select: { id: true, publishedVersionId: true },
  });
  if (!article)
    throw new HandbookWorkflowError(
      "This archived article is not available.",
      404
    );
  await handbookDb.handbookArticle.update({
    where: { id: article.id, organizationId },
    data: {
      status: article.publishedVersionId ? "PUBLISHED" : "DRAFT",
      updatedByUserId: userId,
    },
  });
}

export async function getHandbookArticleDetail({
  organizationId,
  slug,
  versionId,
}: {
  organizationId: string;
  slug: string;
  versionId?: string;
}) {
  const article = await handbookDb.handbookArticle.findFirst({
    where: {
      organizationId,
      slug,
      status: HandbookArticleStatus.PUBLISHED,
      publishedVersionId: { not: null },
    },
    include: {
      publishedVersion: {
        include: {
          category: true,
          topic: true,
          location: true,
          assetModels: {
            include: {
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
            include: {
              kit: {
                select: {
                  id: true,
                  name: true,
                  image: true,
                  imageStoragePath: true,
                },
              },
            },
          },
          sources: {
            include: {
              source: { select: { id: true, title: true, url: true } },
            },
          },
        },
      },
      versions: {
        orderBy: { versionNumber: "desc" },
        include: {
          category: true,
          topic: true,
          location: true,
          assetModels: {
            include: { assetModel: { select: { id: true, name: true } } },
          },
          kits: { include: { kit: { select: { id: true, name: true } } } },
          sources: {
            include: {
              source: { select: { id: true, title: true, url: true } },
            },
          },
        },
      },
    },
  });
  if (!article?.publishedVersion) return null;
  const selected = versionId
    ? article.versions.find((version: any) => version.id === versionId)
    : article.publishedVersion;
  if (!selected) return null;
  const locationParts: string[] = selected.location?.name
    ? [selected.location.name]
    : [];
  let locationParentId: string | null = selected.location?.parentId ?? null;
  while (locationParentId && locationParts.length < 8) {
    const parent = await handbookDb.location.findFirst({
      where: { id: locationParentId, organizationId },
      select: { id: true, name: true, parentId: true },
    });
    if (!parent) break;
    locationParts.unshift(parent.name);
    locationParentId = parent.parentId;
  }
  const locationPath = locationParts.length ? locationParts.join(" · ") : null;
  const contributorIds: string[] = [
    ...new Set<string>(
      article.versions
        .flatMap((version: any) => [
          version.authorUserId,
          version.publishedByUserId,
        ])
        .filter((id: unknown): id is string => typeof id === "string")
    ),
  ];
  const users = contributorIds.length
    ? await db.user.findMany({
        where: { id: { in: contributorIds } },
        select: {
          id: true,
          displayName: true,
          firstName: true,
          lastName: true,
        },
      })
    : [];
  const authorNames = new Map(
    users.map((user) => [user.id, resolveUserDisplayName(user)])
  );
  return {
    id: article.id,
    slug: article.slug,
    currentVersion: {
      ...article.publishedVersion,
      authorName:
        authorNames.get(
          article.publishedVersion.authorUserId ??
            article.publishedVersion.publishedByUserId
        ) ?? null,
    },
    viewedVersion: {
      ...selected,
      locationPath,
      authorName:
        authorNames.get(selected.authorUserId ?? selected.publishedByUserId) ??
        null,
    },
    history: article.versions.map((version: any) => ({
      ...version,
      authorName:
        authorNames.get(version.authorUserId ?? version.publishedByUserId) ??
        null,
    })),
    isHistorical: selected.id !== article.publishedVersion.id,
  };
}

export function getMyHandbookWork({
  organizationId,
  userId,
}: {
  organizationId: string;
  userId: string;
}): Promise<HandbookWorkItem[]> {
  return handbookDb.handbookRevision.findMany({
    where: { organizationId, authorUserId: userId },
    orderBy: { updatedAt: "desc" },
    take: 100,
    include: {
      article: {
        select: {
          slug: true,
          publishedVersion: { select: { title: true, versionNumber: true } },
        },
      },
    },
  });
}

export async function getHandbookReviewQueue(
  organizationId: string
): Promise<HandbookReviewQueueItem[]> {
  const revisions = await handbookDb.handbookRevision.findMany({
    where: { organizationId, status: "PENDING_REVIEW" },
    orderBy: { submittedAt: "asc" },
    take: 100,
    include: {
      article: {
        select: {
          slug: true,
          publishedVersion: { select: { title: true, versionNumber: true } },
        },
      },
      category: { select: { name: true } },
      topic: { select: { name: true } },
    },
  });
  const ids: string[] = [
    ...new Set<string>(
      revisions.map((revision: any) => revision.authorUserId as string)
    ),
  ];
  const users = ids.length
    ? await db.user.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          displayName: true,
          firstName: true,
          lastName: true,
        },
      })
    : [];
  const names = new Map(
    users.map((user) => [user.id, resolveUserDisplayName(user)])
  );
  return revisions.map((revision: any) => ({
    ...revision,
    authorName: names.get(revision.authorUserId) ?? null,
  })) as HandbookReviewQueueItem[];
}

function deterministicDiff(before: string, after: string) {
  const oldLines = before
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const newLines = after
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);
  const removed = oldLines.filter((line) => !newSet.has(line)).slice(0, 40);
  const added = newLines.filter((line) => !oldSet.has(line)).slice(0, 40);
  return {
    added,
    removed,
    changedPairs: Math.min(added.length, removed.length),
  };
}

export async function getHandbookReviewDetail({
  organizationId,
  revisionId,
}: {
  organizationId: string;
  revisionId: string;
}) {
  const revision = await handbookDb.handbookRevision.findFirst({
    where: { id: revisionId, organizationId },
    include: {
      article: {
        include: {
          publishedVersion: { include: { category: true, topic: true } },
        },
      },
      category: true,
      topic: true,
      location: true,
    },
  });
  if (!revision) return null;
  const [author] = await db.user.findMany({
    where: { id: revision.authorUserId },
    select: { id: true, displayName: true, firstName: true, lastName: true },
    take: 1,
  });
  return {
    revision: {
      ...revision,
      authorName: author ? resolveUserDisplayName(author) : null,
    },
    diff: revision.article.publishedVersion
      ? deterministicDiff(
          revision.article.publishedVersion.content,
          revision.content
        )
      : {
          added: revision.content.split(/\n+/).slice(0, 40),
          removed: [],
          changedPairs: 0,
        },
  };
}

export async function getHandbookHealth(
  organizationId: string
): Promise<HandbookHealth> {
  const [published, pending, duplicates, conflicts, missingStructure, stale] =
    await Promise.all([
      handbookDb.handbookArticle.count({
        where: { organizationId, status: "PUBLISHED" },
      }),
      handbookDb.handbookRevision.count({
        where: { organizationId, status: "PENDING_REVIEW" },
      }),
      handbookDb.handbookFinding.count({
        where: { organizationId, status: "OPEN", type: "DUPLICATE" },
      }),
      handbookDb.handbookFinding.count({
        where: { organizationId, status: "OPEN", type: "CONFLICT" },
      }),
      handbookDb.handbookArticle.count({
        where: {
          organizationId,
          status: "PUBLISHED",
          publishedVersion: {
            is: { OR: [{ categoryId: null }, { topicId: null }] },
          },
        },
      }),
      handbookDb.handbookArticle.count({
        where: {
          organizationId,
          status: "PUBLISHED",
          updatedAt: { lt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000) },
        },
      }),
    ]);
  const findings = await handbookDb.handbookFinding.findMany({
    where: { organizationId, status: "OPEN" },
    orderBy: { createdAt: "desc" },
    take: 50,
    include: {
      article: {
        select: { slug: true, publishedVersion: { select: { title: true } } },
      },
      relatedArticle: {
        select: { slug: true, publishedVersion: { select: { title: true } } },
      },
    },
  });
  return {
    counts: {
      published: Number(published),
      pending: Number(pending),
      duplicates: Number(duplicates),
      conflicts: Number(conflicts),
      missingStructure: Number(missingStructure),
      stale: Number(stale),
    },
    findings: findings as HandbookFindingSummary[],
  };
}
