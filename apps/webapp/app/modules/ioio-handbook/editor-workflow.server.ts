import type { ActionFunctionArgs } from "react-router";
import { data, redirect } from "react-router";
import { requireIoioHandbookRead } from "./access.server";
import {
  HandbookWorkflowError,
  publishHandbookRevision,
  saveHandbookRevision,
  submitHandbookRevision,
} from "./workflow.server";

function text(form: FormData, key: string) {
  const value = form.get(key);
  return typeof value === "string" ? value : "";
}

function lines(form: FormData, key: string) {
  return text(form, key)
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function ids(form: FormData, key: string) {
  return form
    .getAll(key)
    .filter((value): value is string => typeof value === "string");
}

export async function handbookRevisionAction({
  context,
  request,
  slug,
}: ActionFunctionArgs & { slug?: string }) {
  const auth = await requireIoioHandbookRead({ context, request });
  const form = await request.formData();
  const intent = text(form, "intent");
  if (!auth.canEdit && intent === "publish") {
    return data(
      {
        ok: false as const,
        message: "Only staff can publish Handbook articles.",
      },
      { status: 403 }
    );
  }
  if (intent !== "save" && intent !== "submit" && intent !== "publish") {
    return data(
      { ok: false as const, message: "Choose a valid Handbook action." },
      { status: 400 }
    );
  }
  try {
    const revision = await saveHandbookRevision({
      organizationId: auth.organizationId,
      userId: auth.userId,
      canEdit: auth.canEdit,
      articleId: text(form, "articleId") || undefined,
      slug,
      revisionId: text(form, "revisionId") || undefined,
      title: text(form, "title"),
      summary: text(form, "summary"),
      content: text(form, "content"),
      category: text(form, "category"),
      topic: text(form, "topic"),
      articleType: text(form, "articleType"),
      locationId: text(form, "locationId") || undefined,
      videoUrls: lines(form, "videoUrls"),
      sourceUrls: lines(form, "sourceUrls"),
      assetModelIds: ids(form, "assetModelIds"),
      kitIds: ids(form, "kitIds"),
    });
    if (intent === "save") {
      return redirect(
        `/handbook/${revision.slug ?? slug ?? ""}/edit?revision=${
          revision.id
        }&saved=1`
      );
    }
    if (intent === "submit") {
      await submitHandbookRevision({
        organizationId: auth.organizationId,
        userId: auth.userId,
        revisionId: revision.id,
      });
      return redirect("/handbook/my-work?submitted=1");
    }
    const published = await publishHandbookRevision({
      organizationId: auth.organizationId,
      userId: auth.userId,
      revisionId: revision.id,
    });
    return redirect(`/handbook/${published.slug}`);
  } catch (cause) {
    if (cause instanceof HandbookWorkflowError) {
      return data(
        { ok: false as const, message: cause.message },
        { status: cause.status }
      );
    }
    throw cause;
  }
}
