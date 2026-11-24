import { data, type ActionFunctionArgs } from "react-router";
import { db } from "~/database/db.server";
import { updateAssetMainImage } from "~/modules/asset/service.server";
import { updateAssetModelImage } from "~/modules/asset-model/service.server";
import { requireIoioStaffAccess } from "~/modules/ioio-staff/access.server";
import { makeShelfError } from "~/utils/error";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

/** Clipboard uploads use the same processing, storage, and replacement as Save. */
export async function action({ context, request }: ActionFunctionArgs) {
  try {
    const { userId, organizationId } = await requireIoioStaffAccess({
      context,
      request,
    });
    const params = new URL(request.url).searchParams;
    const kind = params.get("kind");
    const id = params.get("id");
    if (!id || (kind !== "asset" && kind !== "model"))
      return data({ error: "Invalid image target" }, { status: 400 });
    await requirePermission({
      userId,
      request,
      entity:
        kind === "asset" ? PermissionEntity.asset : PermissionEntity.assetModel,
      action: PermissionAction.update,
    });
    const target =
      kind === "asset"
        ? await db.asset.findFirst({
            where: { id, organizationId },
            select: { id: true },
          })
        : await db.assetModel.findFirst({
            where: { id, organizationId },
            select: { id: true },
          });
    if (!target)
      return data({ error: "Image target not found" }, { status: 404 });
    const uploaded =
      kind === "asset"
        ? await updateAssetMainImage({
            request,
            assetId: id,
            userId,
            organizationId,
          })
        : await updateAssetModelImage({
            request,
            assetModelId: id,
            organizationId,
          });
    if (!uploaded)
      return data({ error: "No image was uploaded" }, { status: 400 });
    return data({ success: true });
  } catch (cause) {
    const error = makeShelfError(cause);
    return data({ error: error.message }, { status: error.status });
  }
}
