import type { LoaderFunctionArgs } from "react-router";
import { ShelfError } from "~/utils/error";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

/**
 * Staff IOIO routes have a second, explicit role gate in addition to the
 * normal Shelf permission check. This prevents a SELF_SERVICE member who
 * happens to receive a broad permission override from reaching staff AI or
 * import actions.
 */
export async function requireIoioStaffAccess({
  context,
  request,
}: Pick<LoaderFunctionArgs, "context" | "request">) {
  const { userId } = context.getSession();
  const permission = await requirePermission({
    userId,
    request,
    entity: PermissionEntity.dashboard,
    action: PermissionAction.read,
  });

  if (permission.role !== "ADMIN" && permission.role !== "OWNER") {
    throw new ShelfError({
      cause: null,
      message: "This IOIO staff feature is available to staff only.",
      label: "Permission",
      status: 403,
      shouldBeCaptured: false,
    });
  }

  return { ...permission, userId };
}
