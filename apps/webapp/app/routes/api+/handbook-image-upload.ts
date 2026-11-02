import { data, type ActionFunctionArgs } from "react-router";
import { db } from "~/database/db.server";
import { requireIoioHandbookRead } from "~/modules/ioio-handbook/access.server";
import { payload } from "~/utils/http.server";
import { assertUploadedImageContentType } from "~/utils/image-upload.server";

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

export async function action({ context, request }: ActionFunctionArgs) {
  const auth = await requireIoioHandbookRead({ context, request });
  const form = await request.formData();
  const image = form.get("image");
  if (
    !image ||
    typeof image === "string" ||
    typeof image.arrayBuffer !== "function"
  ) {
    return data(
      payload({
        success: false as const,
        message: "Choose an image to upload.",
      }),
      { status: 400 }
    );
  }
  if (image.size > MAX_IMAGE_BYTES) {
    return data(
      payload({
        success: false as const,
        message: "Images must be 2 MB or smaller.",
      }),
      { status: 400 }
    );
  }
  const bytes = new Uint8Array(await image.arrayBuffer());
  let contentType: string;
  try {
    contentType = assertUploadedImageContentType(bytes);
  } catch {
    return data(
      payload({
        success: false as const,
        message: "Upload a PNG, JPEG, or WebP image.",
      }),
      { status: 400 }
    );
  }
  const stored = await db.image.create({
    data: {
      contentType,
      altText:
        String(form.get("alt") ?? "")
          .trim()
          .slice(0, 240) || null,
      blob: Buffer.from(bytes),
      ownerOrgId: auth.organizationId,
      userId: auth.userId,
    },
    select: { id: true },
  });
  return payload({ success: true as const, src: `/api/image/${stored.id}` });
}
