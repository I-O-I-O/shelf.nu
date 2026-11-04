import { randomUUID } from "node:crypto";
import { getSupabaseAdmin } from "~/integrations/supabase/client";
import { PUBLIC_BUCKET } from "~/utils/constants";

export const HANDBOOK_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

const IMAGE_FORMATS = [
  {
    contentType: "image/png",
    extension: "png",
    matches: (bytes: Buffer) =>
      bytes
        .subarray(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  {
    contentType: "image/jpeg",
    extension: "jpg",
    matches: (bytes: Buffer) =>
      bytes.length >= 3 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff,
  },
  {
    contentType: "image/webp",
    extension: "webp",
    matches: (bytes: Buffer) =>
      bytes.length >= 12 &&
      bytes.toString("ascii", 0, 4) === "RIFF" &&
      bytes.toString("ascii", 8, 12) === "WEBP",
  },
] as const;

export function detectHandbookImageFormat(bytes: Buffer) {
  return IMAGE_FORMATS.find((format) => format.matches(bytes)) ?? null;
}

export async function uploadHandbookArticleImage({
  organizationId,
  bytes,
  contentType,
}: {
  organizationId: string;
  bytes: Buffer;
  contentType: string;
}) {
  if (bytes.byteLength === 0 || bytes.byteLength > HANDBOOK_IMAGE_MAX_BYTES) {
    throw new Error("Images must be larger than 0 bytes and 2 MB or smaller.");
  }
  const format = detectHandbookImageFormat(bytes);
  if (!format || format.contentType !== contentType) {
    throw new Error("Upload a valid PNG, JPEG, or WebP image.");
  }

  const path = `handbook/${organizationId}/${randomUUID()}.${format.extension}`;
  const { error } = await getSupabaseAdmin()
    .storage.from(PUBLIC_BUCKET)
    .upload(path, bytes, { contentType: format.contentType, upsert: false });
  if (error) throw error;

  return {
    path,
    src: `/api/handbook-image?path=${encodeURIComponent(path)}`,
  };
}

export function isHandbookImagePathForOrganization(
  path: string,
  organizationId: string
) {
  return (
    path.startsWith(`handbook/${organizationId}/`) &&
    /^handbook\/[^/]+\/[0-9a-f-]{36}\.(?:png|jpg|webp)$/iu.test(path)
  );
}
