import { HandbookArticleStatus } from "@prisma/client";
import type { ActionFunctionArgs } from "react-router";
import { data, redirect } from "react-router";
import { z } from "zod";
import { db } from "~/database/db.server";
import { requireIoioHandbookRead } from "~/modules/ioio-handbook/access.server";
import {
  HandbookValidationError,
  createHandbookCategory,
  publishHandbookArticle,
  saveHandbookDraft,
  submitHandbookDraftForReview,
} from "./service.server";

const draftSchema = z.object({
  title: z.string().trim().min(1).max(180),
  handbookCategoryId: z.string().trim().max(40).optional(),
  proposedCategoryName: z.string().trim().max(80).optional(),
  content: z.string().trim().min(1).max(30_000),
});

function strings(formData: FormData, key: string) {
  return formData
    .getAll(key)
    .filter((value): value is string => typeof value === "string");
}

export async function handbookEditorAction({
  context,
  request,
  slug,
}: ActionFunctionArgs & { slug?: string }) {
  const auth = await requireIoioHandbookRead({ context, request });
  if (auth.currentOrganization.type === "PERSONAL") {
    return data(
      {
        ok: false as const,
        message: "The Handbook is available in IOIO Lab workspaces only.",
      },
      { status: 400 }
    );
  }
  const formData = await request.formData();
  const intent = formData.get("intent");
  const revisionMode = formData.get("revisionMode") === "1";
  const revisionBaseVersionId =
    String(formData.get("revisionBaseVersionId") ?? "").trim() || undefined;
  if (intent === "create-category") {
    if (!auth.canEdit) {
      return data(
        {
          ok: false as const,
          message: "Only Staff can create a Handbook category.",
        },
        { status: 403 }
      );
    }
    try {
      const category = await createHandbookCategory({
        organizationId: auth.organizationId,
        name: String(formData.get("categoryName") ?? ""),
      });
      return data({ ok: true as const, category });
    } catch (cause) {
      if (cause instanceof HandbookValidationError) {
        return data(
          { ok: false as const, message: cause.message },
          { status: 400 }
        );
      }
      throw cause;
    }
  }
  if (
    intent !== "save-draft" &&
    intent !== "publish" &&
    intent !== "submit-for-review"
  ) {
    return data(
      {
        ok: false as const,
        message: "Choose whether to save, submit for review, or publish.",
      },
      { status: 400 }
    );
  }
  if (intent === "publish" && !auth.canEdit) {
    return data(
      {
        ok: false as const,
        message: "Only Staff can publish a Handbook article.",
      },
      { status: 403 }
    );
  }
  if (intent === "submit-for-review" && !auth.isStudent) {
    return data(
      {
        ok: false as const,
        message: "Only Students can submit a draft for Staff review.",
      },
      { status: 403 }
    );
  }
  const parsed = draftSchema.safeParse({
    title: formData.get("title") ?? "",
    handbookCategoryId: formData.get("handbookCategoryId") ?? "",
    proposedCategoryName: formData.get("proposedCategoryName") ?? "",
    content: formData.get("content") ?? "",
  });
  if (!parsed.success) {
    return data(
      {
        ok: false as const,
        message:
          "Add a title, choose a category, add article content, and check the field length limits.",
      },
      { status: 400 }
    );
  }
  const handbookCategoryId = parsed.data.handbookCategoryId || undefined;
  const proposedCategoryName = parsed.data.proposedCategoryName || undefined;
  if (
    (!handbookCategoryId && !proposedCategoryName) ||
    (handbookCategoryId && proposedCategoryName)
  ) {
    return data(
      {
        ok: false as const,
        message: "Choose an existing Handbook category or propose a new one.",
      },
      { status: 400 }
    );
  }
  if (proposedCategoryName && !auth.isStudent) {
    return data(
      {
        ok: false as const,
        message: "Staff should create a canonical Handbook category inline.",
      },
      { status: 400 }
    );
  }
  if (proposedCategoryName && intent !== "submit-for-review") {
    return data(
      {
        ok: false as const,
        message:
          "Select an existing category to save a draft, or submit this proposal for Staff review.",
      },
      { status: 400 }
    );
  }

  const current = slug
    ? await db.handbookArticle.findFirst({
        where: {
          organizationId: auth.organizationId,
          slug,
          ...(revisionMode
            ? {
                status: HandbookArticleStatus.PUBLISHED,
                publishedVersionId: revisionBaseVersionId,
              }
            : !auth.canEdit
            ? {
                createdByUserId: auth.userId,
                status: HandbookArticleStatus.DRAFT,
              }
            : {}),
        },
        select: { id: true, status: true },
      })
    : null;
  if (slug && !current)
    return data(
      { ok: false as const, message: "This draft is no longer available." },
      { status: 404 }
    );

  try {
    const article = await saveHandbookDraft({
      organizationId: auth.organizationId,
      userId: auth.userId,
      articleId: current?.id,
      ownerUserId: revisionMode || auth.canEdit ? undefined : auth.userId,
      ...(revisionMode
        ? {
            revisionMode: true,
            revisionBaseVersionId,
            revisionOwnerUserId: auth.isStudent ? auth.userId : undefined,
          }
        : {}),
      title: parsed.data.title,
      handbookCategoryId,
      content: parsed.data.content,
      sourceUrls: strings(formData, "sourceUrls").join("\n").split(/\r?\n/),
    });
    if (intent === "publish") {
      const published = await publishHandbookArticle({
        organizationId: auth.organizationId,
        userId: auth.userId,
        articleId: article.id,
        ...(revisionMode ? { handbookCategoryId } : {}),
      });
      return redirect(`/handbook/${published.slug}`);
    }
    if (intent === "submit-for-review") {
      if (
        !auth.isStudent ||
        (revisionMode
          ? article.status !== "PUBLISHED"
          : article.status !== "DRAFT")
      ) {
        return data(
          {
            ok: false as const,
            message: "Only a Student draft can be submitted for Staff review.",
          },
          { status: 403 }
        );
      }
      await submitHandbookDraftForReview({
        organizationId: auth.organizationId,
        userId: auth.userId,
        articleId: article.id,
        ...(revisionMode
          ? {
              handbookCategoryId,
              revisionMode: true,
              revisionBaseVersionId,
            }
          : {}),
        ...(proposedCategoryName ? { proposedCategoryName } : {}),
      });
      return redirect("/handbook/my-work?submitted=1");
    }
    return redirect(
      `/handbook/${article.slug}/edit${
        revisionMode ? "?improve=1&saved=1" : "?saved=1"
      }`
    );
  } catch (cause) {
    if (cause instanceof HandbookValidationError) {
      return data(
        { ok: false as const, message: cause.message },
        { status: 400 }
      );
    }
    throw cause;
  }
}
