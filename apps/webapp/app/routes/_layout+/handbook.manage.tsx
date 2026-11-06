import type { ActionFunctionArgs } from "react-router";
import { data, redirect } from "react-router";
import { requireIoioHandbookRead } from "~/modules/ioio-handbook/access.server";
import {
  archiveHandbookArticle,
  deleteHandbookArticlePermanently,
  HandbookValidationError,
} from "~/modules/ioio-handbook/service.server";

export async function action({ context, request }: ActionFunctionArgs) {
  const auth = await requireIoioHandbookRead({ context, request });
  if (!auth.canEdit)
    return data(
      {
        ok: false,
        message: "Only Staff can manage published Handbook articles.",
      },
      { status: 403 }
    );
  const form = await request.formData();
  const intent = form.get("intent");
  const articleId = String(form.get("articleId") ?? "").trim();
  const confirmationTitle = String(form.get("confirmationTitle") ?? "");
  if (
    !["archive-article", "restore-article", "delete-permanently"].includes(
      String(intent)
    ) ||
    !articleId ||
    articleId.length > 40 ||
    (intent === "delete-permanently" && !confirmationTitle.trim())
  ) {
    return data(
      { ok: false, message: "Choose a valid article action." },
      { status: 400 }
    );
  }
  try {
    if (intent === "delete-permanently") {
      await deleteHandbookArticlePermanently({
        organizationId: auth.organizationId,
        articleId,
        userId: auth.userId,
        canManageArticles: auth.canEdit,
        confirmationTitle,
      });
    } else {
      await archiveHandbookArticle({
        organizationId: auth.organizationId,
        articleId,
        userId: auth.userId,
        canManageArticles: auth.canEdit,
        restore: intent === "restore-article",
      });
    }
    return redirect(
      intent === "restore-article"
        ? "/settings/ai/knowledge"
        : intent === "delete-permanently"
        ? "/handbook"
        : "/handbook?archived=1"
    );
  } catch (cause) {
    if (cause instanceof HandbookValidationError)
      return data({ ok: false, message: cause.message }, { status: 400 });
    throw cause;
  }
}
