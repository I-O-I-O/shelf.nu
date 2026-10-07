import { useZorm } from "react-zorm";
import { z } from "zod";
import {
  BulkUpdateDialogContent,
  type BulkUpdateSuccessContext,
} from "../bulk-update-dialog/bulk-update-dialog";
import { Button } from "../shared/button";

export const BulkArchiveSchema = z.object({
  assetIds: z.array(z.string()).min(1),
});

export default function BulkArchiveDialog({
  onSuccess,
}: {
  onSuccess?: (context: BulkUpdateSuccessContext) => void;
}) {
  const zo = useZorm("BulkArchive", BulkArchiveSchema);

  return (
    <BulkUpdateDialogContent
      ref={zo.ref}
      type="archive"
      title="Archive selected assets"
      description="The selected assets will be hidden from active Inventory and can be restored later."
      actionUrl="."
      intent="bulk-archive"
      arrayFieldId="assetIds"
      onSuccess={onSuccess}
    >
      {({ disabled, handleCloseDialog, fetcherError }) => (
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
              variant="primary"
              width="full"
              disabled={disabled}
              className="border-error-600 bg-error-600 hover:border-error-800 hover:!bg-error-800"
            >
              Archive
            </Button>
          </div>
        </div>
      )}
    </BulkUpdateDialogContent>
  );
}
