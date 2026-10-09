import type { CSSProperties } from "react";
import type { Location } from "@prisma/client";
import { PencilIcon, PrinterIcon, Trash2Icon } from "lucide-react";
import { useUserRoleHelper } from "~/hooks/user-user-role-helper";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { userHasPermission } from "~/utils/permissions/permission.validator.client";
import { tw } from "~/utils/tw";
import { DeleteLocation } from "./delete-location";
import { Button } from "../shared/button";
import When from "../when/when";

type LocationQuickActionsProps = {
  className?: string;
  style?: CSSProperties;
  location: Pick<Location, "id" | "name"> & { childCount?: number };
};

export default function LocationQuickActions({
  className,
  style,
  location,
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

  const canPrintLabel = userHasPermission({
    roles,
    entity: PermissionEntity.location,
    action: PermissionAction.update,
  });

  return (
    <div className={tw("flex items-center gap-2", className)} style={style}>
      <When truthy={canUpdate}>
        <Button
          size="sm"
          variant="secondary"
          className="p-2"
          to={`/locations/${location.id}/edit`}
          aria-label="Edit location"
          tooltip="Edit location"
        >
          <PencilIcon className="size-4" />
        </Button>
      </When>

      <When truthy={canPrintLabel}>
        <Button
          size="sm"
          variant="secondary"
          className="size-8 shrink-0 rounded-lg p-1.5"
          to={`/labels?locationId=${encodeURIComponent(location.id)}`}
          aria-label="Print location label"
          tooltip="Print label"
        >
          <PrinterIcon className="size-4" />
        </Button>
      </When>

      <When truthy={canDelete}>
        <DeleteLocation
          location={{
            ...location,
            childCount: location.childCount,
          }}
          trigger={
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="p-2"
              aria-label="Delete location"
              tooltip="Delete location"
            >
              <Trash2Icon className="size-4" />
            </Button>
          }
        />
      </When>
    </div>
  );
}
