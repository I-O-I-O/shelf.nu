import { useAtomValue, useSetAtom } from "jotai";
import { useLoaderData } from "react-router";
import { openBulkDialogAtom } from "~/atoms/bulk-update-dialog";
import {
  clearSelectedBulkItemsAtom,
  selectedBulkItemsAtom,
  selectedBulkItemsCountAtom,
  setSelectedBulkItemsAtom,
} from "~/atoms/list";
import type { loader } from "~/routes/_layout+/categories";
import { ALL_SELECTED_KEY, isSelectingAllItems } from "~/utils/list";
import BulkDeleteDialog from "./bulk-delete-dialog";
import { Button } from "../shared/button";

export function CategorySelectionToolbar() {
  const { items, totalItems } = useLoaderData<typeof loader>();
  const selectedItems = useAtomValue(selectedBulkItemsAtom);
  const selectedCount = useAtomValue(selectedBulkItemsCountAtom);
  const setSelectedItems = useSetAtom(setSelectedBulkItemsAtom);
  const clearSelectedItems = useSetAtom(clearSelectedBulkItemsAtom);
  const openBulkDialog = useSetAtom(openBulkDialogAtom);
  const isSelectingAll = isSelectingAllItems(selectedItems);

  const handleSelectAll = () => {
    setSelectedItems([...items, { id: ALL_SELECTED_KEY }]);
  };

  const handleDeleteSelected = () => {
    // The existing confirmation dialog and bulk-delete action handle the
    // same "trash" dialog intent used by the former dropdown.
    openBulkDialog("trash");
  };

  return (
    <>
      <BulkDeleteDialog />
      <div className="flex w-full flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm font-semibold text-gray-900">
            {isSelectingAll ? totalItems : selectedCount} selected
          </span>
          {!isSelectingAll && selectedCount < totalItems ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={handleSelectAll}
            >
              Select all
            </Button>
          ) : null}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={clearSelectedItems}
          >
            Cancel
          </Button>
        </div>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          <Button
            type="button"
            size="sm"
            className="border-error-600 bg-error-600 hover:border-error-800 hover:bg-error-800"
            onClick={handleDeleteSelected}
          >
            Delete selected
          </Button>
        </div>
      </div>
    </>
  );
}
