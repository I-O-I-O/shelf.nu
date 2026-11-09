import { HandbookArticleStatus } from "@prisma/client";
import {
  FormDataParseError,
  MaxFileSizeExceededError,
  parseFormData,
} from "@remix-run/form-data-parser";
import type { ActionFunctionArgs } from "react-router";
import { data, redirect } from "react-router";
import { z } from "zod";
import { HANDBOOK_ARTICLE_MAX_CONTENT_LENGTH } from "./article-limits";
import { db } from "~/database/db.server";
import { requireIoioHandbookRead } from "~/modules/ioio-handbook/access.server";
import {
  HANDBOOK_ATTACHMENT_MAX_BYTES,
  HANDBOOK_ATTACHMENT_MAX_FILES,
  HANDBOOK_ATTACHMENT_MAX_TOTAL_BYTES,
  validateHandbookAttachment,
} from "./attachment.server";
import {
  HandbookValidationError,
  createHandbookAttachmentSource,
  createHandbookCategory,
  publishHandbookArticle,
  removeUnattachedHandbookAttachmentSources,
  saveHandbookDraft,
  setHandbookDraftAttachments,
  submitHandbookDraftForReview,
} from "./service.server";

const draftSchema = z.object({
  title: z.string().trim().min(1).max(180),
  handbookCategoryId: z.string().trim().max(40).optional(),
  proposedCategoryName: z.string().trim().max(80).optional(),
  content: z.string().trim().min(1).max(HANDBOOK_ARTICLE_MAX_CONTENT_LENGTH),
});

function strings(formData: FormData, key: string) {
  return formData
    .getAll(key)
    .filter((value): value is string => typeof value === "string");
}

function isUploadedFile(value: FormDataEntryValue | null): value is File {
  return (
    typeof File !== "undefined" &&
    value instanceof File &&
    typeof value.arrayBuffer === "function"
  );
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
  let formData: FormData;
  if (request.headers.get("content-type")?.includes("multipart/form-data")) {
    const declaredLength = Number(request.headers.get("content-length") ?? 0);
    if (declaredLength > HANDBOOK_ATTACHMENT_MAX_TOTAL_BYTES + 1024 * 1024) {
      return data(
        {
          ok: false as const,
          message: "Attachments must total 50 MB or less.",
        },
        { status: 413 }
      );
    }
    try {
      formData = await parseFormData(request.clone(), {
        maxFileSize: HANDBOOK_ATTACHMENT_MAX_BYTES,
        maxFiles: HANDBOOK_ATTACHMENT_MAX_FILES,
      });
    } catch (cause) {
      if (
        cause instanceof MaxFileSizeExceededError ||
        (cause instanceof FormDataParseError &&
          cause.cause instanceof MaxFileSizeExceededError)
      ) {
        return data(
          {
            ok: false as const,
            message: "Each attachment must be 10 MB or smaller.",
          },
          { status: 413 }
        );
      }
      return data(
        { ok: false as const, message: "Choose supported Handbook files." },
        { status: 400 }
      );
    }
  } else {
    formData = await request.formData();
  }
  const intent = formData.get("intent");
  const revisionMode = formData.get("revisionMode") === "1";
  const staffOnly = auth.canEdit
    ? formData.get("visibility") === "staff-only"
    : undefined;
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
  const attachmentValues = formData.getAll("attachments");
  const uploadedFiles: Array<{
    filename: string;
    contentType: string;
    bytes: Buffer;
  }> = [];
  let totalAttachmentBytes = 0;
  for (const value of attachmentValues) {
    if (!isUploadedFile(value)) {
      return data(
        { ok: false as const, message: "Choose supported Handbook files." },
        { status: 400 }
      );
    }
    if (!value.name && value.size === 0) continue;
    if (!value.name || value.size === 0) {
      return data(
        { ok: false as const, message: "Attachments cannot be empty." },
        { status: 400 }
      );
    }
    const bytes = Buffer.from(await value.arrayBuffer());
    totalAttachmentBytes += bytes.byteLength;
    if (totalAttachmentBytes > HANDBOOK_ATTACHMENT_MAX_TOTAL_BYTES) {
      return data(
        {
          ok: false as const,
          message: "Attachments must total 50 MB or less.",
        },
        { status: 413 }
      );
    }
    try {
      const validated = validateHandbookAttachment({
        filename: value.name,
        contentType: value.type,
        bytes,
      });
      uploadedFiles.push({
        filename: validated.filename,
        contentType: value.type,
        bytes,
      });
    } catch (cause) {
      return data(
        {
          ok: false as const,
          message:
            cause instanceof Error
              ? cause.message
              : "This file cannot be attached.",
        },
        { status: 400 }
      );
    }
  }
  const retainedAttachmentIds = strings(formData, "attachmentSourceId");
  if (
    retainedAttachmentIds.length + uploadedFiles.length >
    HANDBOOK_ATTACHMENT_MAX_FILES
  ) {
    return data(
      {
        ok: false as const,
        message: `An article can have up to ${HANDBOOK_ATTACHMENT_MAX_FILES} files.`,
      },
      { status: 400 }
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
                ...(auth.canEdit ? {} : { staffOnly: false }),
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

  const uploadedSourceIds: string[] = [];
  let attachmentsSaved = false;
  try {
    for (const file of uploadedFiles) {
      uploadedSourceIds.push(
        await createHandbookAttachmentSource({
          organizationId: auth.organizationId,
          userId: auth.userId,
          filename: file.filename,
          contentType: file.contentType,
          bytes: file.bytes,
        })
      );
    }
  } catch {
    await removeUnattachedHandbookAttachmentSources({
      organizationId: auth.organizationId,
      userId: auth.userId,
      sourceIds: uploadedSourceIds,
    });
    return data(
      {
        ok: false as const,
        message:
          "A file could not be uploaded. Your article was not saved; try again.",
      },
      { status: 500 }
    );
  }

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
      ...(staffOnly === undefined ? {} : { staffOnly }),
    });
    await setHandbookDraftAttachments({
      organizationId: auth.organizationId,
      userId: auth.userId,
      articleId: article.id,
      sourceIds: [...retainedAttachmentIds, ...uploadedSourceIds],
      newlyUploadedSourceIds: uploadedSourceIds,
    });
    attachmentsSaved = true;
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
    if (!attachmentsSaved) {
      await removeUnattachedHandbookAttachmentSources({
        organizationId: auth.organizationId,
        userId: auth.userId,
        sourceIds: uploadedSourceIds,
      });
    }
    if (cause instanceof HandbookValidationError) {
      return data(
        { ok: false as const, message: cause.message },
        { status: 400 }
      );
    }
    if (!attachmentsSaved) {
      return data(
        {
          ok: false as const,
          message:
            "The article draft could not be saved with its files. Try saving again.",
        },
        { status: 500 }
      );
    }
    throw cause;
  }
}
