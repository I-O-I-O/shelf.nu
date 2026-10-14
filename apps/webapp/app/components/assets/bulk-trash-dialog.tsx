import { useAtomValue } from "jotai";
import { useLoaderData } from "react-router";
import { useZorm } from "react-zorm";
import { z } from "zod";
import { selectedBulkItemsAtom } from "~/atoms/list";
import { ASSET_LIFECYCLE_INTENT } from "~/modules/asset/lifecycle-intent";
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
      title={`Delete ${totalSelected} item${totalSelected === 1 ? "" : "s"}?`}
      description="These items will be removed from Inventory and moved to Trash, where they can be restored later."
      actionUrl="."
      intent={ASSET_LIFECYCLE_INTENT.TRASH}
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
              Delete
            </Button>
          </div>
        </div>
      )}
    </BulkUpdateDialogContent>
  );
}
