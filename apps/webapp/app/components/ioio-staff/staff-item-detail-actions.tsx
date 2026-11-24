import {
  ArchiveIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PrinterIcon,
  Trash2Icon,
} from "lucide-react";
import { Link } from "react-router";
import { DeleteAsset } from "~/components/assets/delete-asset";
import { Button } from "~/components/shared/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/shared/dropdown";

export function StaffItemDetailActions({
  asset,
  editAction,
  labelAssetIds,
  canManageLifecycle,
}: {
  asset: { id: string; title: string; mainImage: string | null };
  editAction?: { to: string; label: string };
  labelAssetIds: string[];
  canManageLifecycle: boolean;
}) {
  return (
    <>
      {editAction ? (
        <Button
          to={editAction.to}
          className="max-md:hidden"
          size="sm"
          variant="secondary"
        >
          {editAction.label}
        </Button>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="max-md:ml-auto max-md:size-11 max-md:p-0"
            aria-label="More item actions"
            tooltip="More item actions"
          >
            <MoreHorizontalIcon className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-52 max-w-[calc(100vw-2rem)] p-1"
        >
          {editAction ? (
            <DropdownMenuItem asChild className="min-h-11 md:hidden">
              <Link to={editAction.to} className="gap-3">
                <PencilIcon aria-hidden="true" className="size-4 shrink-0" />
                {editAction.label}
              </Link>
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem className="p-0">
            <Button
              to={`/labels?assetIds=${encodeURIComponent(
                labelAssetIds.join(",")
              )}`}
              variant="link"
              className="flex w-full items-center justify-start gap-3 rounded p-2 text-left text-gray-700 hover:bg-gray-50 max-md:min-h-11"
            >
              <PrinterIcon className="size-4 shrink-0" />
              <span>Print label / QR</span>
            </Button>
          </DropdownMenuItem>
          {canManageLifecycle ? (
            <DropdownMenuItem
              className="p-0"
              onSelect={(event) => event.preventDefault()}
            >
              <DeleteAsset
                asset={asset}
                behavior="archive"
                trigger={
                  <Button
                    type="button"
                    variant="link"
                    className="flex w-full items-center justify-start gap-3 rounded p-2 text-left text-gray-700 hover:bg-gray-50 max-md:min-h-11"
                  >
                    <ArchiveIcon className="size-4 shrink-0" />
                    <span>Archive</span>
                  </Button>
                }
              />
            </DropdownMenuItem>
          ) : null}
          {canManageLifecycle ? (
            <DropdownMenuItem
              className="p-0"
              onSelect={(event) => event.preventDefault()}
            >
              <DeleteAsset
                asset={asset}
                behavior="trash"
                trigger={
                  <Button
                    type="button"
                    variant="link"
                    className="flex w-full items-center justify-start gap-3 rounded p-2 text-left text-red-700 hover:bg-red-50 max-md:min-h-11"
                  >
                    <Trash2Icon className="size-4 shrink-0" />
                    <span>Delete</span>
                  </Button>
                }
              />
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
