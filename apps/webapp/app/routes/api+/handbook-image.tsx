import type { LoaderFunctionArgs } from "react-router";
import { data } from "react-router";
import { db } from "~/database/db.server";
import { getSupabaseAdmin } from "~/integrations/supabase/client";
import { requireIoioHandbookRead } from "~/modules/ioio-handbook/access.server";
import { isHandbookImagePathForOrganization } from "~/modules/ioio-handbook/image.server";
import { PUBLIC_BUCKET } from "~/utils/constants";

export async function loader({ context, request }: LoaderFunctionArgs) {
  const auth = await requireIoioHandbookRead({ context, request });
  const path = new URL(request.url).searchParams.get("path") ?? "";
  const pathOrganizationId = path.split("/")[1] ?? "";
  if (!isHandbookImagePathForOrganization(path, pathOrganizationId)) {
    throw data({ message: "Invalid Handbook image path." }, { status: 400 });
  }
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

  const { data: image, error } = await getSupabaseAdmin()
    .storage.from(PUBLIC_BUCKET)
    .download(path);
  if (error || !image) {
    throw data(
      { message: "This Handbook image is not available." },
      { status: 404 }
    );
  }

  return new Response(await image.arrayBuffer(), {
    headers: {
      "Content-Type": image.type,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
