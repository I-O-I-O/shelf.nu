import { OrganizationRoles } from "@prisma/client";
import type { LoaderFunctionArgs } from "react-router";
import { ensureIoioTeamOrganizationForRequest } from "~/modules/ioio/organization-access.server";
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
  return requireIoioBorrowerAccess({ context, request }).then((auth) => {
    if (auth.role !== OrganizationRoles.SELF_SERVICE) {
      throw new ShelfError({
        cause: null,
        title: "Student access required",
        message: "This page is only available to Student accounts.",
        status: 403,
        label: "Permission",
        shouldBeCaptured: false,
      });
    }
    return auth;
  });
}

/** Resolve a workspace-scoped borrowing identity for Student and Staff routes. */
export async function requireIoioBorrowerAccess({
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
  await ensureIoioTeamOrganizationForRequest({
    request,
    organizationId: permission.organizationId,
    currentOrganizationType: permission.currentOrganization.type,
    userOrganizations: permission.userOrganizations,
  });

  if (
    permission.role !== OrganizationRoles.SELF_SERVICE &&
    permission.role !== OrganizationRoles.ADMIN &&
    permission.role !== OrganizationRoles.OWNER
  ) {
    throw new ShelfError({
      cause: null,
      title: "Borrowing access required",
      message: "Your workspace role is not allowed to borrow IOIO items.",
      status: 403,
      label: "Permission",
      shouldBeCaptured: false,
    });
  }

  return { ...permission, userId };
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
