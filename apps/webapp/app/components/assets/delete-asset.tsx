import type { ReactElement } from "react";
import { cloneElement, forwardRef } from "react";
import type { Asset } from "@prisma/client";
import { ArchiveIcon } from "lucide-react";
import { useLocation, useNavigation } from "react-router";
import { Button } from "~/components/shared/button";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "~/components/shared/modal";
import { isFormProcessing } from "~/utils/form";
import { Form } from "../custom-form";
import { TrashIcon } from "../icons/library";

type DeleteAssetProps = {
  asset: {
    id: Asset["id"];
    title: Asset["title"];
    mainImage: Asset["mainImage"];
  };
  trigger: ReactElement;
  behavior?: "delete" | "archive" | "trash";
};

export const DeleteAsset = forwardRef<HTMLButtonElement, DeleteAssetProps>(
  function ({ asset, trigger, behavior = "delete" }, ref) {
    const navigation = useNavigation();
    const location = useLocation();
    const disabled = isFormProcessing(navigation.state);
    const isArchive = behavior === "archive";
    const isTrash = behavior === "trash";
    const inventoryReturnTo =
      location.state &&
      typeof location.state === "object" &&
      "inventoryReturnTo" in location.state &&
      typeof location.state.inventoryReturnTo === "string" &&
      /^\/assets(?:\?.*)?$/.test(location.state.inventoryReturnTo)
        ? location.state.inventoryReturnTo
        : undefined;

    return (
      <AlertDialog>
        <AlertDialogTrigger ref={ref} asChild>
          {cloneElement(trigger)}
        </AlertDialogTrigger>

        <AlertDialogContent>
          <AlertDialogHeader>
            <div className="mx-auto md:m-0">
              <span className="flex size-12 items-center justify-center rounded-full bg-error-50 p-2 text-error-600">
                {isArchive ? <ArchiveIcon /> : <TrashIcon />}
              </span>
            </div>
            <AlertDialogTitle>
              {isArchive ? "Archive" : "Delete"} {asset.title}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {isArchive
                ? "This item will be hidden from active Inventory and can be restored later."
                : isTrash
                ? "This item will be removed from Inventory and moved to Trash, where it can be restored later."
                : "Are you sure you want to delete this asset? This action cannot be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <div className="flex justify-center gap-2">
              <AlertDialogCancel asChild>
                <Button type="button" variant="secondary" disabled={disabled}>
                  Cancel
                </Button>
              </AlertDialogCancel>

              <Form method="delete" action={`/assets/${asset.id}`}>
                {isTrash && inventoryReturnTo ? (
                  <input
                    type="hidden"
                    name="redirectTo"
                    value={inventoryReturnTo}
                  />
                ) : null}
                {asset.mainImage && (
                  <input
                    type="hidden"
                    value={asset.mainImage}
                    name="mainImageUrl"
                  />
                )}
                <input
                  type="hidden"
                  value={isArchive ? "archive" : isTrash ? "trash" : "delete"}
                  name="intent"
                />
                <Button
                  className="border-error-600 bg-error-600 hover:border-error-800 hover:!bg-error-800"
                  type="submit"
                  data-test-id="confirmdeleteAssetButton"
                  disabled={disabled}
                >
                  {isArchive ? "Archive" : "Delete"}
                </Button>
              </Form>
            </div>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );
  }
);

DeleteAsset.displayName = "DeleteAsset";
