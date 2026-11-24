import type { ReactNode } from "react";
import type { Location } from "@prisma/client";
import { useFetcher } from "react-router";
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
import { TrashIcon } from "../icons/library";

type DeleteLocationProps = {
  location: {
    name: Location["name"];
    id: Location["id"];
    childCount?: number;
  };
  trigger?: ReactNode;
};

export const DeleteLocation = ({ location, trigger }: DeleteLocationProps) => {
  const fetcher = useFetcher<{
    error?: { message?: string };
  }>();
  const disabled = fetcher.state !== "idle";
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        {trigger ?? (
          <Button
            type="button"
            variant="link"
            data-test-id="deleteAssetButton"
            icon="trash"
            className="justify-start rounded-sm px-2 py-1.5 text-sm font-medium text-gray-700 outline-none hover:bg-slate-100 hover:text-gray-700"
            width="full"
          >
            Delete
          </Button>
        )}
      </AlertDialogTrigger>

      <AlertDialogContent>
        <AlertDialogHeader>
          <div className="mx-auto md:m-0">
            <span className="flex size-12 items-center justify-center rounded-full bg-error-50 p-2 text-error-600">
              <TrashIcon />
            </span>
          </div>
          <AlertDialogTitle>Delete {location.name}</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to delete this Location? This action cannot be
            undone.
          </AlertDialogDescription>
          {fetcher.data?.error?.message ? (
            <p role="alert" className="text-sm text-red-700">
              {fetcher.data.error.message}
            </p>
          ) : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <div className="flex justify-center gap-2">
            <AlertDialogCancel asChild>
              <Button type="button" variant="secondary">
                Cancel
              </Button>
            </AlertDialogCancel>

            <fetcher.Form method="delete" action={`/locations/${location.id}`}>
              <Button
                className="border-error-600 bg-error-600 hover:border-error-800 hover:bg-error-800"
                type="submit"
                data-test-id="confirmdeleteLocationButton"
                disabled={disabled}
              >
                Delete
              </Button>
            </fetcher.Form>
          </div>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
