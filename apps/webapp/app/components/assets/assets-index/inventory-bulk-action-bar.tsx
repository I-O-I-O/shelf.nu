import { Button } from "~/components/shared/button";

export function InventoryBulkActionBar({
  selectedCount,
  canUpdate,
  canDelete,
  canPrintLabels,
  onChangeCategory,
  onChangeLocation,
  onArchive,
  onTrash,
  onPrintLabels,
}: {
  selectedCount: number;
  canUpdate: boolean;
  canDelete: boolean;
  canPrintLabels: boolean;
  onChangeCategory: () => void;
  onChangeLocation: () => void;
  onArchive: () => void;
  onTrash: () => void;
  onPrintLabels: () => void;
}) {
  return (
    <div
      role="region"
      aria-label="Inventory bulk actions"
      className="flex flex-wrap items-center gap-2 border-b border-gray-200 bg-red-50/60 px-4 py-3"
    >
      <span className="mr-1 text-sm font-semibold text-gray-900">
        {selectedCount} selected
      </span>
      {canUpdate ? (
        <>
          <Button type="button" variant="secondary" onClick={onChangeCategory}>
            Change category
          </Button>
          <Button type="button" variant="secondary" onClick={onChangeLocation}>
            Change location
          </Button>
        </>
      ) : null}
      {canDelete ? (
        <>
          <Button type="button" variant="secondary" onClick={onArchive}>
            Archive
          </Button>
          <Button type="button" variant="danger" onClick={onTrash}>
            Move to trash
          </Button>
        </>
      ) : null}
      {canPrintLabels ? (
        <Button type="button" variant="secondary" onClick={onPrintLabels}>
          Print labels / QR
        </Button>
      ) : null}
    </div>
  );
}
