import { HandbookArticleStatus, HandbookSourceKind } from "@prisma/client";
import type { LoaderFunctionArgs } from "react-router";
import { data, redirect } from "react-router";
import { db } from "~/database/db.server";
import { getSupabaseAdmin } from "~/integrations/supabase/client";
import { requireIoioHandbookRead } from "~/modules/ioio-handbook/access.server";
import { handbookAttachmentFilenameFromPath } from "~/modules/ioio-handbook/attachment.shared";

function notFound() {
  return data(
    { message: "This Handbook file is not available." },
    { status: 404 }
  );
}

export async function loader({ context, request }: LoaderFunctionArgs) {
  const auth = await requireIoioHandbookRead({ context, request });
  const params = new URL(request.url).searchParams;
  const sourceId = params.get("sourceId")?.trim() ?? "";
  const versionId = params.get("versionId")?.trim();
  if (
    !sourceId ||
    sourceId.length > 40 ||
    (versionId && versionId.length > 40)
  ) {
    return notFound();
  }

  const source = await db.handbookSource.findFirst({
    where: {
      id: sourceId,
      organizationId: auth.organizationId,
      kind: HandbookSourceKind.UPLOADED_DOCUMENT,
      storageObjectPath: { not: null },
    },
    select: {
      storageObjectPath: true,
      draftArticle: {
        select: {
          id: true,
          organizationId: true,
          status: true,
          staffOnly: true,
          createdByUserId: true,
          updatedByUserId: true,
        },
      },
      versions: {
        select: {
          version: {
            select: {
              id: true,
              article: {
                select: { organizationId: true, status: true, staffOnly: true },
              },
            },
          },
        },
      },
    },
  });
  const objectPath = source?.storageObjectPath;
  if (!source || !objectPath) return notFound();

  if (versionId) {
    const publishedVersion = source.versions.some(
      ({ version }) =>
        version.id === versionId &&
        version.article.organizationId === auth.organizationId &&
        version.article.status === HandbookArticleStatus.PUBLISHED &&
        (auth.canEdit || !version.article.staffOnly)
    );
    if (!publishedVersion) return notFound();
  } else {
    const draftArticle = source.draftArticle;
    const canReadDraft = Boolean(
      draftArticle &&
        draftArticle.organizationId === auth.organizationId &&
        draftArticle.status !== HandbookArticleStatus.ARCHIVED &&
        (auth.canEdit || !draftArticle.staffOnly) &&
        (auth.canEdit ||
          (auth.isStudent &&
            (draftArticle.createdByUserId === auth.userId ||
              draftArticle.updatedByUserId === auth.userId)))
    );
    if (!canReadDraft) return notFound();
  }

  const fileName = handbookAttachmentFilenameFromPath(objectPath);
  if (!/^handbook-attachments\/[0-9a-f-]{36}\/[^/]+$/iu.test(objectPath)) {
    return notFound();
  }
  const { data: signed, error: signingError } = await getSupabaseAdmin()
    .storage.from("assets")
    .createSignedUrl(objectPath, 5 * 60, { download: fileName });
  if (signingError || !signed?.signedUrl) return notFound();
  return redirect(signed.signedUrl, {
    headers: { "Cache-Control": "private, no-store" },
  });
}
