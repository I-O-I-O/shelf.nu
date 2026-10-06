import { useState } from "react";
import { Form, Link } from "react-router";
import { AssetImage } from "~/components/assets/asset-image";
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
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 bg-gray-50 px-4 py-3">
          <label className="flex items-center gap-2 text-sm font-semibold text-gray-700">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={(event) => toggleAll(event.target.checked)}
              className="size-4 rounded border-gray-300 text-red-700 focus:ring-red-700"
              aria-label="Select all items"
            />
            Select all
            {selected.size > 0 ? ` (${selected.size} selected)` : null}
          </label>
          <div className="flex flex-wrap gap-2">
            <Form method="post" id={formId}>
              <button
                type="submit"
                name="intent"
                value="restore"
                disabled={selected.size === 0}
                className="rounded-lg border border-red-200 px-3 py-2 text-sm font-semibold text-red-700 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Restore selected
              </button>
              {mode === "archive" ? (
                <button
                  type="submit"
                  name="intent"
                  value="trash"
                  disabled={selected.size === 0}
                  className="ml-2 rounded-lg border border-gray-300 px-3 py-2 text-sm font-semibold text-gray-700 transition hover:border-red-300 hover:bg-red-50 hover:text-red-800 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Move selected to Trash
                </button>
              ) : null}
            </Form>
            {mode === "trash" ? (
              <button
                type="button"
                disabled={selected.size === 0}
                onClick={() => setIsPermanentDeleteDialogOpen(true)}
                className="rounded-lg border border-red-600 bg-red-600 px-3 py-2 text-sm font-semibold text-white transition hover:border-red-800 hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Delete permanently
              </button>
            ) : null}
          </div>
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
              className="grid gap-4 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center"
            >
              <input
                type="checkbox"
                checked={selected.has(item.id)}
                onChange={(event) => toggleItem(item, event.target.checked)}
                className="mt-1 size-4 rounded border-gray-300 text-red-700 focus:ring-red-700 sm:mt-0"
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

              <div className="flex min-w-0 items-start gap-4">
                <div className="size-20 shrink-0 overflow-hidden rounded-xl border border-gray-200 bg-gray-50">
                  {item.assetImage ? (
                    <AssetImage
                      asset={item.assetImage}
                      alt={item.name}
                      className="size-full"
                    />
                  ) : item.kitImage ? (
                    <KitImage
                      kit={{ ...item.kitImage, alt: item.name }}
                      className="size-full"
                    />
                  ) : (
                    <img
                      src="/static/images/asset-placeholder.jpg"
                      alt=""
                      className="size-full object-cover"
                    />
                  )}
                </div>
                <div className="min-w-0">
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
                  <dl className="mt-2 grid gap-x-5 gap-y-1 text-sm text-gray-600 sm:grid-cols-2">
                    <div>
                      <dt className="inline font-semibold text-gray-500">
                        Category:{" "}
                      </dt>
                      <dd className="inline">
                        {item.category ?? "Uncategorized"}
                      </dd>
                    </div>
                    {item.quantity !== null ? (
                      <div>
                        <dt className="inline font-semibold text-gray-500">
                          Quantity: {""}
                        </dt>
                        <dd className="inline">{item.quantity}</dd>
                      </div>
                    ) : null}
                    <div>
                      <dt className="inline font-semibold text-gray-500">
                        Previous location:{" "}
                      </dt>
                      <dd className="inline">
                        {item.location ?? "Not recorded"}
                      </dd>
                    </div>
                    <div>
                      <dt className="inline font-semibold text-gray-500">
                        {mode === "archive" ? "Archived" : "Deleted"}:{" "}
                      </dt>
                      <dd className="inline">
                        <DateS date={item.archivedAt} />
                      </dd>
                    </div>
                    <div>
                      <dt className="inline font-semibold text-gray-500">
                        By:{" "}
                      </dt>
                      <dd className="inline">{item.archivedBy}</dd>
                    </div>
                  </dl>
                  {item.needsReview ? (
                    <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-900">
                      Review required. The original category or location is no
                      longer available.
                    </p>
                  ) : null}
                </div>
              </div>

              <div className="flex items-center justify-between gap-2 sm:justify-end">
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
                    className="rounded-lg border border-red-200 px-3 py-2 text-sm font-semibold text-red-700 transition hover:bg-red-50 focus:outline-none focus:ring-2 focus:ring-red-700 focus:ring-offset-2"
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
                      className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-semibold text-gray-700 transition hover:border-red-300 hover:bg-red-50 hover:text-red-800 focus:outline-none focus:ring-2 focus:ring-red-700 focus:ring-offset-2"
                    >
                      Trash
                    </button>
                  </Form>
                ) : mode === "trash" ? (
                  <button
                    type="button"
                    onClick={() => setItemToDelete(item)}
                    className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-semibold text-gray-700 transition hover:border-red-300 hover:bg-red-50 hover:text-red-800 focus:outline-none focus:ring-2 focus:ring-red-700 focus:ring-offset-2"
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
                    className="border-error-600 bg-error-600 hover:border-error-800 hover:bg-error-800"
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
                      className="border-error-600 bg-error-600 hover:border-error-800 hover:bg-error-800"
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
