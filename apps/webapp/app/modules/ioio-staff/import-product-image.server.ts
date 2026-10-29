import { createHash } from "node:crypto";
import { db } from "~/database/db.server";
import { detectImageFormat } from "~/utils/image-format.server";
import type { ImportProductImageProposal } from "./product-enrichment.server";

const PREVIEW_PREFIX = "ioio-import-preview:";
const PREVIEW_MAX_BYTES = 128 * 1024;
// Proposals expire after 24 hours; leave a further day for in-flight retries.
const PREVIEW_RETENTION_MS = 48 * 60 * 60 * 1000;

/** Use Shelf's existing org-owned Image blob storage, never the operation JSON. */
export async function persistImportProductImage({
  image,
  operationId,
  organizationId,
  userId,
}: {
  image: ImportProductImageProposal;
  operationId: string;
  organizationId: string;
  userId: string;
}): Promise<ImportProductImageProposal> {
  if (image.status !== "IMAGE_FOUND") return image;
  if (!image.dataBase64) {
    if (!image.imageId)
      throw new Error("The processed image has no stored bytes.");
    await readImportProductImage(image.imageId, organizationId);
    return image;
  }
  const bytes = Buffer.from(image.dataBase64, "base64");
  if (
    image.mimeType !== "image/webp" ||
    !bytes.length ||
    bytes.toString("base64") !== image.dataBase64 ||
    bytes.length > PREVIEW_MAX_BYTES ||
    detectImageFormat(bytes) !== "image/webp"
  )
    throw new Error("Invalid processed import image.");
  const imageId = `ioio-import-${createHash("sha256")
    .update([organizationId, userId, operationId, image.dataBase64].join("|"))
    .digest("hex")}`;
  await db.image.upsert({
    where: { id: imageId },
    update: {},
    create: {
      id: imageId,
      contentType: "image/webp",
      blob: bytes,
      altText: `${PREVIEW_PREFIX}${operationId}`,
      ownerOrgId: organizationId,
      userId,
    },
  });
  const { dataBase64: _bytes, ...metadata } = image;
  return { ...metadata, imageId };
}

export async function readImportProductImage(
  imageId: string,
  organizationId: string
) {
  if (!/^ioio-import-[a-f0-9]{64}$/.test(imageId))
    throw new Error("Invalid import image reference.");
  const image = await db.image.findFirst({
    where: {
      id: imageId,
      ownerOrgId: organizationId,
      altText: { startsWith: PREVIEW_PREFIX },
    },
    select: { blob: true, contentType: true },
  });
  if (
    !image ||
    image.blob.length > PREVIEW_MAX_BYTES ||
    detectImageFormat(image.blob) !== "image/webp"
  )
    throw new Error("The proposed image is unavailable.");
  return Buffer.from(image.blob);
}

export async function pruneImportProductImages(
  organizationId: string,
  userId: string
) {
  await db.image.deleteMany({
    where: {
      ownerOrgId: organizationId,
      userId,
      altText: { startsWith: PREVIEW_PREFIX },
      createdAt: { lt: new Date(Date.now() - PREVIEW_RETENTION_MS) },
      location: null,
      organization: null,
    },
  });
}
