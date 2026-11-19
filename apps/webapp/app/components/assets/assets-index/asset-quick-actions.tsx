import type { CSSProperties } from "react";
import {
  CopyIcon,
  MoreHorizontal,
  PencilIcon,
  QrCodeIcon,
  Trash2Icon,
} from "lucide-react";
import { Link } from "react-router";
import { Button } from "~/components/shared/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/shared/dropdown";
import When from "~/components/when/when";
import { useUserRoleHelper } from "~/hooks/user-user-role-helper";
import type { AssetsFromViewItem } from "~/modules/asset/types";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { userHasPermission } from "~/utils/permissions/permission.validator.client";
import { tw } from "~/utils/tw";
import { CodePreviewDialog } from "../../code-preview/code-preview-dialog";
import { DeleteAsset } from "../delete-asset";

type AssetQuickActionsProps = {
  className?: string;
  style?: CSSProperties;
  compact?: boolean;
  asset: Pick<AssetsFromViewItem, "id" | "title" | "mainImage"> & {
    qrId: string;
    sequentialId?: string | null;
  };
};

export default function AssetQuickActions({
  className,
  style,
  compact = false,
  asset,
}: AssetQuickActionsProps) {
  const { roles } = useUserRoleHelper();
  const canEdit = userHasPermission({
    roles,
    entity: PermissionEntity.asset,
    action: PermissionAction.update,
  });
  const canDelete = userHasPermission({
    roles,
    entity: PermissionEntity.asset,
    action: PermissionAction.delete,
  });

  if (compact) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className={tw("size-11 shrink-0 p-0", className)}
            style={style}
            aria-label="Asset actions"
          >
            <MoreHorizontal aria-hidden="true" className="size-5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-48">
          {canEdit ? (
            <DropdownMenuItem asChild className="min-h-11">
              <Link
                to={`/assets/${asset.id}/edit`}
                className="flex items-center gap-2"
              >
                <PencilIcon aria-hidden="true" className="size-4" />
                Edit asset
              </Link>
            </DropdownMenuItem>
          ) : null}
          <CodePreviewDialog
            item={{
              id: asset.id,
              title: asset.title,
              qrId: asset.qrId,
              type: "asset",
              sequentialId: asset.sequentialId,
            }}
            trigger={
              <DropdownMenuItem className="min-h-11 gap-2">
                <QrCodeIcon aria-hidden="true" className="size-4" />
                Show asset label
              </DropdownMenuItem>
            }
          />
          {canEdit ? (
            <DropdownMenuItem asChild className="min-h-11">
              <Link
                to={`/assets/${asset.id}/overview/duplicate`}
                className="flex items-center gap-2"
              >
                <CopyIcon aria-hidden="true" className="size-4" />
                Duplicate asset
              </Link>
            </DropdownMenuItem>
          ) : null}
          {canDelete ? (
            <DeleteAsset
              asset={asset}
              behavior="trash"
              trigger={
                <DropdownMenuItem className="min-h-11 gap-2 text-red-700 focus:bg-red-50 focus:text-red-800">
                  <Trash2Icon aria-hidden="true" className="size-4" />
                  Delete asset
                </DropdownMenuItem>
              }
            />
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  return (
    <div className={tw("flex items-center gap-2", className)} style={style}>
      <When
        truthy={userHasPermission({
          roles,
          entity: PermissionEntity.asset,
          action: PermissionAction.update,
        })}
      >
        <Button
          size="sm"
          variant="secondary"
          className={"p-2"}
          to={`/assets/${asset.id}/edit`}
          aria-label="Edit asset information"
          tooltip="Edit asset information"
        >
          <PencilIcon className="size-4" />
        </Button>
      </When>

      <CodePreviewDialog
        item={{
          id: asset.id,
          title: asset.title,
          qrId: asset.qrId,
          type: "asset",
          sequentialId: asset.sequentialId,
        }}
        trigger={
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className={"p-2"}
            aria-label="Show asset label"
            tooltip="Show asset label"
          >
            <QrCodeIcon className="size-4" />
          </Button>
        }
      />

      <When
        truthy={userHasPermission({
          roles,
          entity: PermissionEntity.asset,
          action: PermissionAction.update,
        })}
      >
        <Button
          size="sm"
          variant="secondary"
          className={"p-2"}
          to={`/assets/${asset.id}/overview/duplicate`}
          aria-label="Duplicate asset"
          tooltip="Duplicate asset"
        >
          <CopyIcon className="size-4" />
        </Button>
      </When>

      <When
        truthy={userHasPermission({
          roles,
          entity: PermissionEntity.asset,
          action: PermissionAction.delete,
        })}
      >
        <DeleteAsset
          asset={asset}
          behavior="trash"
          trigger={
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className={"p-2"}
              aria-label="Delete asset"
              tooltip="Delete asset"
            >
              <Trash2Icon className="size-4" />
            </Button>
          }
        />
      </When>
    </div>
  );
}
