import { OrganizationRoles } from "@prisma/client";
import type { LoaderFunctionArgs } from "react-router";
import { ShelfError } from "~/utils/error";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

/**
 * IOIO student routes deliberately use Shelf's existing asset read permission.
 * Location records are projected here without granting access to Shelf's
 * administrative `/locations` surface.
 */
export function requireStudentRead({
  context,
  request,
}: Pick<LoaderFunctionArgs, "context" | "request">) {
  const { userId } = context.getSession();
  return requirePermission({
    userId,
    request,
    entity: PermissionEntity.asset,
    action: PermissionAction.read,
  }).then((permission) => ({ ...permission, userId }));
}

export type IoioAuth = Awaited<ReturnType<typeof requireStudentRead>>;
export type IoioAuthSnapshot = Pick<
  IoioAuth,
  "userId" | "organizationId" | "role"
>;

/** Settings that change a student's own account must never be available from
 * the Staff shell or through an ambiguous role fallback. */
export async function requireStudentAccountSettings({
  context,
  request,
}: Pick<LoaderFunctionArgs, "context" | "request">) {
  const auth = await requireStudentRead({ context, request });
  if (auth.role !== OrganizationRoles.SELF_SERVICE) {
    throw new ShelfError({
      cause: null,
      title: "Student settings required",
      message: "These settings are only available to Student accounts.",
      status: 403,
      label: "Permission",
      shouldBeCaptured: false,
    });
  }
  return auth;
}
