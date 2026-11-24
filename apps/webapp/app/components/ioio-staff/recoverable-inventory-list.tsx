import { useState } from "react";
import { Form, Link } from "react-router";
import { AssetImage } from "~/components/assets/asset-image";
import {
  recoverablePermanentDeleteActionClassName,
  recoverableRestoreActionClassName,
  recoverableTrashActionClassName,
} from "~/components/ioio-staff/recoverable-action-styles";
import { SelectableRow } from "~/components/ioio-staff/selectable-row";
import KitImage from "~/components/kits/kit-image";
import { Button } from "~/components/shared/button";
import { DateS } from "~/components/shared/date";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/shared/modal";

export type RecoverableInventoryItem = {
  id: string;
  itemId: string;
  itemType: "ASSET" | "KIT";
  name: string;
  category: string | null;
  location: string | null;
  archivedAt: string | Date;
  archivedBy: string;
  quantity: number | null;
  duplicateRecordCount: number;
  lifecycleItems: Array<{
    itemId: string;
    itemType: "ASSET" | "KIT";
  }>;
  needsReview: boolean;
  assetImage: {
    id: string;
    mainImage: string | null;
    thumbnailImage: string | null;
    assetModel: { image: string | null; thumbnailImage: string | null } | null;
  } | null;
  kitImage: {
    kitId: string;
    image: string | null;
    imageExpiration: string | Date | null;
  } | null;
};

type RecoverableInventoryListProps = {
  items: RecoverableInventoryItem[];
  mode: "archive" | "trash";
};

export function RecoverableInventoryList({
  items,
  mode,
}: RecoverableInventoryListProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [isPermanentDeleteDialogOpen, setIsPermanentDeleteDialogOpen] =
    useState(false);
  const [itemToDelete, setItemToDelete] =
    useState<RecoverableInventoryItem | null>(null);
  const formId = `recoverable-bulk-${mode}`;
  const allSelected = items.length > 0 && selected.size === items.length;
  const selectedItems = items.filter((item) => selected.has(item.id));

  function toggleItem(item: RecoverableInventoryItem, checked: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(item.id);
      else next.delete(item.id);
      return next;
    });
  }

  function toggleAll(checked: boolean) {
    setSelected(checked ? new Set(items.map((item) => item.id)) : new Set());
  }

  return (
    <section className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
      {items.length > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-gray-200 bg-gray-50 px-3 py-2.5">
          <div className="flex min-w-0 items-center gap-3">
            <label className="flex items-center gap-2 text-sm font-semibold text-gray-700">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={(event) => toggleAll(event.target.checked)}
                className="size-4 rounded border-gray-300 text-red-700 focus:ring-red-700"
                aria-label="Select all items"
              />
              Select all
            </label>
            {selected.size > 0 ? (
              <span className="text-sm text-gray-500">
                {selected.size} selected
              </span>
            ) : null}
          </div>
          {selected.size > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              <Form method="post" id={formId} className="flex flex-wrap gap-2">
                <button
                  type="submit"
                  name="intent"
                  value="restore"
                  className={recoverableRestoreActionClassName}
                >
                  Restore selected
                </button>
                {mode === "archive" ? (
                  <button
                    type="submit"
                    name="intent"
                    value="trash"
                    className={recoverableTrashActionClassName}
                  >
                    Move selected to Trash
                  </button>
                ) : null}
              </Form>
              {mode === "trash" ? (
                <button
                  type="button"
                  onClick={() => setIsPermanentDeleteDialogOpen(true)}
                  className={recoverablePermanentDeleteActionClassName}
                >
                  Delete permanently
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {items.length === 0 ? (
        <p className="p-6 text-sm text-gray-600">
          {mode === "archive" ? "No archived items." : "Trash is empty."}
        </p>
      ) : (
        <div className="divide-y divide-gray-200">
          {items.map((item) => (
            <SelectableRow
              key={item.id}
              selected={selected.has(item.id)}
              onToggle={() => toggleItem(item, !selected.has(item.id))}
              variant="list"
              className="grid grid-cols-[20px_56px_minmax(0,1fr)] items-center gap-x-3 gap-y-2.5 p-3 xl:grid-cols-[20px_56px_minmax(220px,1.1fr)_minmax(190px,0.9fr)_auto] xl:gap-x-4 xl:py-2.5"
            >
              <input
                type="checkbox"
                checked={selected.has(item.id)}
                onChange={(event) => toggleItem(item, event.target.checked)}
                className="size-4 justify-self-center rounded border-gray-300 text-red-700 focus:ring-red-700"
                aria-label={`Select ${item.name}`}
              />
              {selected.has(item.id)
                ? item.lifecycleItems.map((lifecycleItem) => (
                    <div
                      key={`${item.id}:${lifecycleItem.itemType}:${lifecycleItem.itemId}`}
                      className="hidden"
                    >
                      <input
                        type="hidden"
                        name="itemType"
                        value={lifecycleItem.itemType}
                        form={formId}
                      />
                      <input
                        type="hidden"
                        name="itemId"
                        value={lifecycleItem.itemId}
                        form={formId}
                      />
                    </div>
                  ))
                : null}

              <div className="contents">
                <div className="size-14 shrink-0 overflow-hidden rounded-lg border border-gray-200 bg-gray-50 p-1">
                  {item.assetImage ? (
                    <AssetImage
                      asset={item.assetImage}
                      alt={item.name}
                      className="size-full"
                      imageFit="contain"
                    />
                  ) : item.kitImage ? (
                    <KitImage
                      kit={{ ...item.kitImage, alt: item.name }}
                      className="size-full [&_img]:!object-contain"
                    />
                  ) : (
                    <img
                      src="/static/images/asset-placeholder.jpg"
                      alt=""
                      className="size-full object-contain"
                    />
                  )}
                </div>
                <div className="col-start-3 min-w-0 xl:col-start-auto">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      to={
                        item.itemType === "ASSET"
                          ? `/assets/${item.itemId}/overview`
                          : `/kits/${item.itemId}/overview`
                      }
                      className="break-words font-semibold text-gray-950 hover:text-red-700"
                    >
                      {item.name}
                    </Link>
                    <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-600">
                      {item.itemType === "ASSET" ? "Asset" : "Kit"}
                    </span>
                  </div>
                  <dl className="mt-1.5 space-y-0.5 text-sm leading-5 text-gray-600">
                    <div className="flex min-w-0 gap-1.5">
                      <dt className="shrink-0 text-gray-500">Category</dt>
                      <dd className="min-w-0 break-words font-medium text-gray-700">
                        {item.category ?? "Uncategorized"}
                      </dd>
                    </div>
                    <div className="flex min-w-0 gap-1.5">
                      <dt className="shrink-0 text-gray-500">
                        {mode === "archive" ? "Archived" : "Deleted"}
                      </dt>
                      <dd className="min-w-0 font-medium text-gray-700">
                        <DateS
                          date={item.archivedAt}
                          options={{
                            year: "numeric",
                            month: "short",
                            day: "numeric",
                          }}
                        />
                      </dd>
                    </div>
                  </dl>
                </div>
              </div>

              <dl className="col-span-2 col-start-2 grid min-w-0 grid-cols-1 gap-x-4 gap-y-1 text-sm leading-5 sm:grid-cols-2 xl:col-span-1 xl:col-start-auto xl:grid-cols-2">
                <div className="min-w-0">
                  <dt className="text-xs font-medium text-gray-500">
                    Previous location
                  </dt>
                  <dd className="break-words font-medium text-gray-700">
                    {item.location ?? "Not recorded"}
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-xs font-medium text-gray-500">
                    {mode === "archive" ? "Archived by" : "Deleted by"}
                  </dt>
                  <dd className="break-words font-medium text-gray-700">
                    {item.archivedBy}
                  </dd>
                </div>
                {item.needsReview ? (
                  <div className="col-span-full">
                    <dd className="rounded-md bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-900">
                      Review required. The original category or location is no
                      longer available.
                    </dd>
                  </div>
                ) : null}
              </dl>

              <div className="col-span-2 col-start-2 flex flex-wrap items-center justify-start gap-2 xl:col-span-1 xl:col-start-auto xl:justify-end">
                <Form method="post">
                  <input type="hidden" name="intent" value="restore" />
                  {item.lifecycleItems.map((lifecycleItem) => (
                    <div
                      key={`${item.id}:restore:${lifecycleItem.itemType}:${lifecycleItem.itemId}`}
                      className="hidden"
                    >
                      <input
                        type="hidden"
                        name="itemType"
                        value={lifecycleItem.itemType}
                      />
                      <input
                        type="hidden"
                        name="itemId"
                        value={lifecycleItem.itemId}
                      />
                    </div>
                  ))}
                  <button
                    type="submit"
                    className={recoverableRestoreActionClassName}
                  >
                    Restore
                  </button>
                </Form>
                {mode === "archive" ? (
                  <Form method="post">
                    <input type="hidden" name="intent" value="trash" />
                    {item.lifecycleItems.map((lifecycleItem) => (
                      <div
                        key={`${item.id}:trash:${lifecycleItem.itemType}:${lifecycleItem.itemId}`}
                        className="hidden"
                      >
                        <input
                          type="hidden"
                          name="itemType"
                          value={lifecycleItem.itemType}
                        />
                        <input
                          type="hidden"
                          name="itemId"
                          value={lifecycleItem.itemId}
                        />
                      </div>
                    ))}
                    <button
                      type="submit"
                      className={recoverableTrashActionClassName}
                    >
                      Trash
                    </button>
                  </Form>
                ) : mode === "trash" ? (
                  <button
                    type="button"
                    onClick={() => setItemToDelete(item)}
                    className={recoverablePermanentDeleteActionClassName}
                  >
                    Delete permanently
                  </button>
                ) : null}
              </div>
            </SelectableRow>
          ))}
        </div>
      )}

      {mode === "trash" ? (
        <>
          <AlertDialog
            open={isPermanentDeleteDialogOpen}
            onOpenChange={setIsPermanentDeleteDialogOpen}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  Delete {selectedItems.length} item
                  {selectedItems.length === 1 ? "" : "s"} permanently?
                </AlertDialogTitle>
                <AlertDialogDescription>
                  This cannot be undone. The selected Shelf records and their
                  Trash entries will be permanently removed.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel asChild>
                  <Button type="button" variant="secondary">
                    Cancel
                  </Button>
                </AlertDialogCancel>
                <Form
                  method="post"
                  onSubmit={() => setIsPermanentDeleteDialogOpen(false)}
                >
                  <input
                    type="hidden"
                    name="intent"
                    value="delete-permanently"
                  />
                  {selectedItems.map((item) => (
                    <div key={item.id}>
                      <input
                        type="hidden"
                        name="itemType"
                        value={item.itemType}
                      />
                      <input type="hidden" name="itemId" value={item.itemId} />
                    </div>
                  ))}
                  <Button
                    type="submit"
                    variant="danger"
                    className={recoverablePermanentDeleteActionClassName}
                  >
                    Delete permanently
                  </Button>
                </Form>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          <AlertDialog
            open={itemToDelete !== null}
            onOpenChange={(open) => {
              if (!open) setItemToDelete(null);
            }}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  Delete {itemToDelete?.name ?? "this item"} permanently?
                </AlertDialogTitle>
                <AlertDialogDescription>
                  This cannot be undone. The Shelf record and its Trash entry
                  will be permanently removed.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel asChild>
                  <Button type="button" variant="secondary">
                    Cancel
                  </Button>
                </AlertDialogCancel>
                {itemToDelete ? (
                  <Form method="post" onSubmit={() => setItemToDelete(null)}>
                    <input
                      type="hidden"
                      name="intent"
                      value="delete-permanently"
                    />
                    {itemToDelete.lifecycleItems.map((lifecycleItem) => (
                      <div
                        key={`${itemToDelete.id}:delete:${lifecycleItem.itemType}:${lifecycleItem.itemId}`}
                      >
                        <input
                          type="hidden"
                          name="itemType"
                          value={lifecycleItem.itemType}
                        />
                        <input
                          type="hidden"
                          name="itemId"
                          value={lifecycleItem.itemId}
                        />
                      </div>
                    ))}
                    <Button
                      type="submit"
                      variant="danger"
                      className={recoverablePermanentDeleteActionClassName}
                    >
                      Delete permanently
                    </Button>
                  </Form>
                ) : null}
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      ) : null}
    </section>
  );
}
