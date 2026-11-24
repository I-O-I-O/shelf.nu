import { createHash } from "node:crypto";
import { extractLegacySupabaseObjectPath } from "~/utils/storage.server";
import type { StorageImageBucket } from "~/utils/storage.server";

export type AssetImageVariant =
  | "main"
  | "thumbnail"
  | "model"
  | "model-thumbnail";

/** Only canonical storage references are proxied; external legacy URLs stay external. */
export function getAssetImagePath({
  objectPath,
  legacyUrl,
  bucketName,
}: {
  objectPath?: string | null;
  legacyUrl?: string | null;
  bucketName: StorageImageBucket;
}) {
  return (
    (objectPath
      ? extractLegacySupabaseObjectPath(objectPath.trim(), bucketName)
      : null) ??
    (legacyUrl &&
    !legacyUrl.startsWith("/api/") &&
    !legacyUrl.startsWith("/static/")
      ? extractLegacySupabaseObjectPath(legacyUrl, bucketName)
      : null)
  );
}

export function assetImageVersion(path: string) {
  return createHash("sha256").update(path).digest("hex").slice(0, 20);
}

/** The object identity changes on replacement, without embedding storage hosts or tokens. */
export function getAssetImageProxyUrl(
  assetId: string,
  variant: AssetImageVariant,
  path: string
) {
  return `/api/asset-image?${new URLSearchParams({
    assetId,
    variant,
    v: assetImageVersion(path),
  })}`;
}
