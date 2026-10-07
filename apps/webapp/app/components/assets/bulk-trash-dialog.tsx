import { useAtomValue } from "jotai";
import { useLoaderData } from "react-router";
import { useZorm } from "react-zorm";
import { z } from "zod";
import { selectedBulkItemsAtom } from "~/atoms/list";
import type { AssetIndexLoaderData } from "~/routes/_layout+/assets._index";
import { isSelectingAllItems } from "~/utils/list";
import {
  BulkUpdateDialogContent,
  type BulkUpdateSuccessContext,
} from "../bulk-update-dialog/bulk-update-dialog";
import { Button } from "../shared/button";

export const BulkTrashSchema = z.object({
  assetIds: z.array(z.string()).min(1),
});

export default function BulkTrashDialog({
  onSuccess,
}: {
  onSuccess?: (context: BulkUpdateSuccessContext) => void;
}) {
  const { totalItems } = useLoaderData<AssetIndexLoaderData>();
  const selectedAssets = useAtomValue(selectedBulkItemsAtom);
  const totalSelected = isSelectingAllItems(selectedAssets)
    ? totalItems
    : selectedAssets.length;
  const zo = useZorm("BulkTrash", BulkTrashSchema);

  return (
    <BulkUpdateDialogContent
      ref={zo.ref}
      type="trash"
      title={`Move ${totalSelected} items to trash`}
      description="The selected items will be hidden from active Inventory and can be restored from Trash."
      actionUrl="."
      intent="bulk-trash"
      arrayFieldId="assetIds"
      onSuccess={onSuccess}
    >
      {({ fetcherError, disabled, handleCloseDialog }) => (
        <div>
          {fetcherError ? (
            <p className="mb-4 text-sm text-error-500">{fetcherError}</p>
          ) : null}
          <div className="flex gap-3">
            <Button
              type="button"
              variant="secondary"
              width="full"
              disabled={disabled}
              onClick={handleCloseDialog}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="danger"
              width="full"
              disabled={disabled}
            >
              Move to trash
            </Button>
          </div>
        </div>
      )}
    </BulkUpdateDialogContent>
  );
}
