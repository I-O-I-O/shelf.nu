import type { ImportProductImageProposal } from "./product-enrichment.server";

export function importProductImagePreview(
  image?: ImportProductImageProposal | null
) {
  if (image?.status !== "IMAGE_FOUND") return undefined;
  if (image.imageId && /^ioio-import-[a-f0-9]{64}$/.test(image.imageId))
    return `/api/image/${image.imageId}`;
  return image.dataBase64
    ? `data:image/webp;base64,${image.dataBase64}`
    : undefined;
}
