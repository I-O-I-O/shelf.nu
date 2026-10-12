import { OrganizationRoles } from "@prisma/client";
import type { LoaderFunctionArgs } from "react-router";
import { ShelfError } from "~/utils/error";
import { resolveIoioAccountSurface } from "~/utils/ioio-role-routing";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

/** Published IOIO Handbook content is available to staff and students who
 * already have Shelf's normal asset read permission in the selected Team. */
export async function requireIoioHandbookRead({
  context,
  request,
}: Pick<LoaderFunctionArgs, "context" | "request">) {
  const { userId } = context.getSession();
  const permission = await requirePermission({
    userId,
    request,
    entity: PermissionEntity.asset,
    action: PermissionAction.read,
  });

  if (!resolveIoioAccountSurface([permission.role])) {
    throw new ShelfError({
      cause: null,
      title: "IOIO account access required",
      message: "The IOIO Handbook is available to Staff and Student accounts.",
      status: 403,
      label: "Permission",
      shouldBeCaptured: false,
    });
  }

  return {
    ...permission,
    userId,
    canEdit:
      permission.role === OrganizationRoles.ADMIN ||
      permission.role === OrganizationRoles.OWNER,
    isStudent: permission.role === OrganizationRoles.SELF_SERVICE,
  };
}
