import { Button } from "~/components/shared/button";

export function InventoryBulkActionBar({
  selectedCount,
  canUpdate,
  canDelete,
  canPrintLabels,
  canHide,
  canUnhide,
  onChangeCategory,
  onChangeLocation,
  onArchive,
  onTrash,
  onHide,
  onUnhide,
  onPrintLabels,
  canOrganizeSelected,
  onOrganizeSelected,
}: {
  selectedCount: number;
  canUpdate: boolean;
  canDelete: boolean;
  canPrintLabels: boolean;
  canHide: boolean;
  canUnhide: boolean;
  onChangeCategory: () => void;
  onChangeLocation: () => void;
  onArchive: () => void;
  onTrash: () => void;
  onHide: () => void;
  onUnhide: () => void;
  onPrintLabels: () => void;
  canOrganizeSelected?: boolean;
  onOrganizeSelected?: () => void;
}) {
  return (
    <div
      role="region"
      aria-label="Inventory bulk actions"
      className="flex min-w-0 flex-col gap-3 border-b border-gray-200 bg-red-50/60 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
    >
      <span className="min-w-0 text-sm font-semibold text-gray-900">
        {selectedCount} selected
      </span>
      <div
        role="group"
        aria-label="Selected inventory actions"
        className="flex min-w-0 flex-wrap items-center gap-2 sm:ml-auto sm:justify-end"
      >
        {canHide ? (
          <Button type="button" variant="secondary" onClick={onHide}>
            Hide
          </Button>
        ) : null}
        {canUnhide ? (
          <Button type="button" variant="secondary" onClick={onUnhide}>
            Unhide
          </Button>
        ) : null}
        {canUpdate ? (
          <>
            <Button
              type="button"
              variant="secondary"
              onClick={onChangeCategory}
            >
              Change category
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={onChangeLocation}
            >
              Change location
            </Button>
          </>
        ) : null}
        {onOrganizeSelected ? (
          <Button
            type="button"
            variant="secondary"
            disabled={!canOrganizeSelected}
            onClick={onOrganizeSelected}
            title={
              canOrganizeSelected
                ? "Analyze the selected products in Organize"
                : "Select only inventory rows linked to an AssetModel"
            }
          >
            Organize selected
          </Button>
        ) : null}
        {canDelete ? (
          <>
            <Button type="button" variant="secondary" onClick={onArchive}>
              Archive
            </Button>
            <Button type="button" variant="danger" onClick={onTrash}>
              Delete
            </Button>
          </>
        ) : null}
        {canPrintLabels ? (
          <Button type="button" variant="secondary" onClick={onPrintLabels}>
            Print labels / QR
          </Button>
        ) : null}
      </div>
    </div>
  );
}
