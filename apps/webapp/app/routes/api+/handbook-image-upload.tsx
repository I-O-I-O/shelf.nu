import {
  FormDataParseError,
  MaxFileSizeExceededError,
  parseFormData,
} from "@remix-run/form-data-parser";
import type { ActionFunctionArgs } from "react-router";
import { data } from "react-router";
import sharp from "sharp";
import { requireIoioHandbookRead } from "~/modules/ioio-handbook/access.server";
import {
  detectHandbookImageFormat,
  HANDBOOK_IMAGE_MAX_BYTES,
  uploadHandbookArticleImage,
} from "~/modules/ioio-handbook/image.server";

function isUploadedFile(value: FormDataEntryValue | null): value is File {
  return (
    typeof File !== "undefined" &&
    value instanceof File &&
    typeof value.arrayBuffer === "function"
  );
}

async function imageDecodesAsFormat(
  bytes: Buffer,
  contentType: string
): Promise<boolean> {
  const expectedFormat = {
    "image/jpeg": "jpeg",
    "image/png": "png",
    "image/webp": "webp",
  }[contentType];
  if (!expectedFormat) return false;

  try {
    const options = { failOn: "error" as const, limitInputPixels: 40_000_000 };
    const metadata = await sharp(bytes, options).metadata();
    if (metadata.format !== expectedFormat) return false;
    await sharp(bytes, options).stats();
    return true;
  } catch {
    return false;
  }
}

export async function action({ context, request }: ActionFunctionArgs) {
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

  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > HANDBOOK_IMAGE_MAX_BYTES + 64 * 1024) {
    return data(
      { ok: false as const, message: "Images must be 2 MB or smaller." },
      { status: 413 }
    );
  }

  let form: FormData;
  try {
    form = await parseFormData(request.clone(), {
      maxFileSize: HANDBOOK_IMAGE_MAX_BYTES,
      maxFiles: 1,
    });
  } catch (cause) {
    if (
      cause instanceof MaxFileSizeExceededError ||
      (cause instanceof FormDataParseError &&
        cause.cause instanceof MaxFileSizeExceededError)
    ) {
      return data(
        { ok: false as const, message: "Images must be 2 MB or smaller." },
        { status: 413 }
      );
    }
    return data(
      { ok: false as const, message: "Choose a PNG, JPEG, or WebP image." },
      { status: 400 }
    );
  }

  const file = form.get("image");
  if (!isUploadedFile(file) || !file.name || file.size === 0) {
    return data(
      { ok: false as const, message: "Choose a PNG, JPEG, or WebP image." },
      { status: 400 }
    );
  }
  if (file.size > HANDBOOK_IMAGE_MAX_BYTES) {
    return data(
      { ok: false as const, message: "Images must be 2 MB or smaller." },
      { status: 413 }
    );
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const format = detectHandbookImageFormat(bytes);
  if (
    !format ||
    (file.type && file.type.toLowerCase() !== format.contentType) ||
    !(await imageDecodesAsFormat(bytes, format.contentType))
  ) {
    return data(
      {
        ok: false as const,
        message: "Upload a valid PNG, JPEG, or WebP image.",
      },
      { status: 400 }
    );
  }

  try {
    const image = await uploadHandbookArticleImage({
      organizationId: auth.organizationId,
      bytes,
      contentType: format.contentType,
    });
    return data({ ok: true as const, src: image.src });
  } catch {
    return data(
      {
        ok: false as const,
        message: "The image could not be uploaded. Try again.",
      },
      { status: 500 }
    );
  }
}
