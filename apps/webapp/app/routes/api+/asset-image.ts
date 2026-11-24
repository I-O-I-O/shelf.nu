import { data, type LoaderFunctionArgs } from "react-router";
import { db } from "~/database/db.server";
import { getSupabaseAdmin } from "~/integrations/supabase/client";
import {
  assetImageVersion,
  getAssetImagePath,
} from "~/modules/asset/image-proxy.server";
import { isIoioAssetHidden } from "~/modules/ioio-student/visibility.shared";
import { detectImageFormat } from "~/utils/image-format.server";
import { Logger } from "~/utils/logger";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

/** Same-origin, authenticated delivery: the browser never contacts private Storage. */
export async function loader({ context, request }: LoaderFunctionArgs) {
  const { userId } = context.getSession();
  const { organizationId, role } = await requirePermission({
    userId,
    request,
    entity: PermissionEntity.asset,
    action: PermissionAction.read,
  });
  const params = new URL(request.url).searchParams;
  const assetId = params.get("assetId");
  const variant = params.get("variant");
  if (
    !assetId ||
    !["main", "thumbnail", "model", "model-thumbnail"].includes(variant ?? "")
  )
    throw data({ error: "Invalid image request" }, { status: 400 });
  const asset = await db.asset.findFirst({
    where: { id: assetId, organizationId },
    select: {
      id: true,
      ioioHidden: true,
      mainImage: true,
      thumbnailImage: true,
      mainImageStoragePath: true,
      thumbnailImageStoragePath: true,
      assetModel: {
        select: {
          id: true,
          organizationId: true,
          ioioHidden: true,
          image: true,
          thumbnailImage: true,
          imageStoragePath: true,
          thumbnailImageStoragePath: true,
        },
      },
    },
  });
  const staff = role === "OWNER" || role === "ADMIN";
  if (!asset || (!staff && isIoioAssetHidden(asset, organizationId)))
    throw data({ error: "Image not found" }, { status: 404 });
  if (!staff) {
    const archived = await db.ioioArchivedItem.findFirst({
      where: {
        organizationId,
        itemType: "ASSET",
        itemId: assetId,
        restoredAt: null,
      },
      select: { id: true },
    });
    if (archived) throw data({ error: "Image not found" }, { status: 404 });
  }
  const model = variant?.startsWith("model") ? asset.assetModel : null;
  if (variant?.startsWith("model") && model?.organizationId !== organizationId)
    throw data({ error: "Image not found" }, { status: 404 });
  const thumbnail = variant?.endsWith("thumbnail");
  const bucketName = model ? "files" : "assets";
  const path = getAssetImagePath({
    bucketName,
    objectPath: model
      ? thumbnail
        ? model.thumbnailImageStoragePath
        : model.imageStoragePath
      : thumbnail
      ? asset.thumbnailImageStoragePath
      : asset.mainImageStoragePath,
    legacyUrl: model
      ? thumbnail
        ? model.thumbnailImage
        : model.image
      : thumbnail
      ? asset.thumbnailImage
      : asset.mainImage,
  });
  if (!path || (params.get("v") && params.get("v") !== assetImageVersion(path)))
    throw data({ error: "Image not found" }, { status: 404 });
  try {
    const { data: image, error } = await getSupabaseAdmin()
      .storage.from(bucketName)
      .download(path);
    if (error || !image) {
      Logger.warn("asset_image_delivery_failed", {
        assetId,
        modelId: model?.id,
        variant,
        storagePath: path,
        bucketName,
        failureClass: error?.name ?? "EmptyStorageResponse",
        status: error && "statusCode" in error ? error.statusCode : undefined,
      });
      throw data(
        { error: "Image is temporarily unavailable" },
        { status: 502 }
      );
    }
    const bytes = new Uint8Array(await image.arrayBuffer());
    const contentType = detectImageFormat(bytes);
    if (!contentType) {
      Logger.warn("asset_image_delivery_failed", {
        assetId,
        modelId: model?.id,
        variant,
        storagePath: path,
        bucketName,
        failureClass: "InvalidImageBytes",
        status: 502,
      });
      throw data({ error: "Invalid stored image" }, { status: 502 });
    }
    return new Response(bytes, {
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(bytes.byteLength),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy":
          "script-src 'none'; object-src 'none'; sandbox",
      },
    });
  } catch (cause) {
    // Data responses above already contain a safe diagnostic. Never log Storage
    // error messages or fetch URLs, which may contain authorization credentials.
    if (cause && typeof cause === "object" && "data" in cause) throw cause;
    Logger.warn("asset_image_delivery_failed", {
      assetId,
      modelId: model?.id,
      variant,
      storagePath: path,
      bucketName,
      failureClass: cause instanceof Error ? cause.name : "StorageFailure",
      status: 502,
    });
    throw data({ error: "Image is temporarily unavailable" }, { status: 502 });
  }
}
