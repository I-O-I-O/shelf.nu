import type { CSSProperties } from "react";
import type { Location } from "@prisma/client";
import {
  MoreHorizontal,
  MoveRightIcon,
  PencilIcon,
  PrinterIcon,
  Trash2Icon,
} from "lucide-react";
import { Link } from "react-router";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/shared/dropdown";
import { useUserRoleHelper } from "~/hooks/user-user-role-helper";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { userHasPermission } from "~/utils/permissions/permission.validator.client";
import { tw } from "~/utils/tw";
import { DeleteLocation } from "./delete-location";
import When from "../when/when";

type LocationQuickActionsProps = {
  className?: string;
  style?: CSSProperties;
  location: Pick<Location, "id" | "name"> & { childCount?: number };
  onMove?: () => void;
};

export default function LocationQuickActions({
  className,
  style,
  location,
  onMove,
}: LocationQuickActionsProps) {
  const { roles } = useUserRoleHelper();

  const canUpdate = userHasPermission({
    roles,
    entity: PermissionEntity.location,
    action: PermissionAction.update,
  });

  const canDelete = userHasPermission({
    roles,
    entity: PermissionEntity.location,
    action: PermissionAction.delete,
  });

  if (!canUpdate && !canDelete) return null;

  return (
    <div className={tw("flex items-center", className)} style={style}>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`Actions for ${location.name}`}
            className="flex size-8 items-center justify-center rounded text-gray-400 hover:bg-gray-100 hover:text-gray-700 focus:outline-none focus:ring-2 focus:ring-red-600"
          >
            <MoreHorizontal className="size-4" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-40 bg-white p-1">
          <When truthy={canUpdate}>
            <DropdownMenuItem asChild>
              <Link
                to={`/locations/${location.id}/edit`}
                className="flex w-full items-center gap-2"
              >
                <PencilIcon className="size-4" aria-hidden="true" />
                Edit
              </Link>
            </DropdownMenuItem>
            {onMove ? (
              <DropdownMenuItem
                className="flex w-full items-center gap-2"
                onSelect={onMove}
              >
                <MoveRightIcon className="size-4" aria-hidden="true" />
                Move...
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem asChild>
              <Link
                to={`/labels?locationId=${encodeURIComponent(location.id)}`}
                className="flex w-full items-center gap-2"
              >
                <PrinterIcon className="size-4" aria-hidden="true" />
                Print label
              </Link>
            </DropdownMenuItem>
          </When>
          <When truthy={canUpdate && canDelete}>
            <DropdownMenuSeparator />
          </When>
          <When truthy={canDelete}>
            <DeleteLocation
              location={{
                ...location,
                childCount: location.childCount,
              }}
              trigger={
                <DropdownMenuItem
                  className="gap-2 text-red-700 focus:text-red-700"
                  onSelect={(event) => event.preventDefault()}
                >
                  <Trash2Icon className="size-4" aria-hidden="true" />
                  Delete
                </DropdownMenuItem>
              }
            />
          </When>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
