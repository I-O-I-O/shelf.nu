import type { LoaderFunctionArgs } from "react-router";
import { data, redirect } from "react-router";
import { db } from "~/database/db.server";
import { getSupabaseAdmin } from "~/integrations/supabase/client";
import { requireIoioHandbookRead } from "~/modules/ioio-handbook/access.server";
import { isHandbookImagePathForOrganization } from "~/modules/ioio-handbook/image.server";
import { PUBLIC_BUCKET } from "~/utils/constants";

export async function loader({ context, request }: LoaderFunctionArgs) {
  const auth = await requireIoioHandbookRead({ context, request });
  const path = new URL(request.url).searchParams.get("path") ?? "";
  if (!isHandbookImagePathForOrganization(path, auth.organizationId)) {
    throw data(
      { message: "This Handbook image is not available." },
      { status: 404 }
    );
  }

  if (!auth.canEdit) {
    const fileName = path.split("/").at(-1) ?? "";
    const staffOnlyReference = await db.handbookArticle.findFirst({
      where: {
        organizationId: auth.organizationId,
        staffOnly: true,
        OR: [
          { draftContent: { contains: fileName } },
          { versions: { some: { content: { contains: fileName } } } },
        ],
      },
      select: { id: true },
    });
    if (staffOnlyReference) {
      throw data(
        { message: "This Handbook image is not available." },
        { status: 404 }
      );
    }
  }

  const { data: image } = getSupabaseAdmin()
    .storage.from(PUBLIC_BUCKET)
    .getPublicUrl(path);
  return redirect(image.publicUrl, {
    status: 302,
    headers: { "Cache-Control": "private, no-store" },
  });
}
