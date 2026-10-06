import type { ActionFunctionArgs } from "react-router";
import { data, redirect } from "react-router";
import { z } from "zod";
import { db } from "~/database/db.server";
import { requireIoioStaffAccess } from "~/modules/ioio-staff/access.server";
import {
  HandbookValidationError,
  publishHandbookArticle,
  saveHandbookDraft,
} from "./service.server";

const draftSchema = z.object({
  title: z.string().trim().min(1).max(180),
  summary: z.string().max(700),
  content: z.string().trim().min(1).max(30_000),
  section: z.string().trim().max(80),
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
  const auth = await requireIoioStaffAccess({ context, request });
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
  if (intent !== "save-draft" && intent !== "publish") {
    return data(
      {
        ok: false as const,
        message: "Choose whether to save a draft or publish it.",
      },
      { status: 400 }
    );
  }
  const parsed = draftSchema.safeParse({
    title: formData.get("title") ?? "",
    summary: formData.get("summary") ?? "",
    content: formData.get("content") ?? "",
    section: formData.get("section") ?? "General",
  });
  if (!parsed.success) {
    return data(
      {
        ok: false as const,
        message: "Add a title and content, and check the field length limits.",
      },
      { status: 400 }
    );
  }

  const current = slug
    ? await db.handbookArticle.findFirst({
        where: { organizationId: auth.organizationId, slug },
        select: { id: true },
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
      ...parsed.data,
      assetModelIds: strings(formData, "assetModelIds"),
      kitIds: strings(formData, "kitIds"),
      sourceUrls: strings(formData, "sourceUrls").join("\n").split(/\r?\n/),
    });
    if (intent === "publish") {
      const published = await publishHandbookArticle({
        organizationId: auth.organizationId,
        userId: auth.userId,
        articleId: article.id,
      });
      return redirect(`/handbook/${published.slug}`);
    }
    return redirect(`/handbook/${article.slug}/edit?saved=1`);
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
