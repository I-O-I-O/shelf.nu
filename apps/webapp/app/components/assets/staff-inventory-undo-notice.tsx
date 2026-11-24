import { useEffect } from "react";
import { useFetcher } from "react-router";
import type { BulkUndoRequest } from "~/modules/ioio-staff/bulk-undo";

const UNDO_WINDOW_MS = 15_000;

export function StaffInventoryUndoNotice({
  action,
  onExpire,
}: {
  action: BulkUndoRequest;
  onExpire: () => void;
}) {
  const fetcher = useFetcher<{
    success?: boolean;
    error?: { message?: string };
  }>();
  const isUndoing = fetcher.state !== "idle";
  const isTrash = action.operation === "trash";
  const itemCount = action.entries.length;
  const statusMessage = isTrash
    ? `${itemCount} item${itemCount === 1 ? "" : "s"} deleted`
    : `${itemCount} inventory item${itemCount === 1 ? "" : "s"} updated.`;

  useEffect(() => {
    const timeout = window.setTimeout(onExpire, UNDO_WINDOW_MS);
    return () => window.clearTimeout(timeout);
  }, [action, onExpire]);

  useEffect(() => {
    if (fetcher.data?.success) onExpire();
  }, [fetcher.data, onExpire]);

  const undo = () => {
    const formData = new FormData();
    formData.set("undo", JSON.stringify(action));
    void fetcher.submit(formData, {
      method: "post",
      action: "/api/assets/bulk-undo",
    });
  };

  return (
    <div
      role="status"
      className={
        isTrash
          ? "fixed bottom-4 left-4 z-50 flex w-max max-w-[calc(100vw-2rem)] items-center gap-5 whitespace-nowrap rounded-md bg-gray-900 px-4 py-2 text-sm text-white shadow-lg md:left-[calc(15rem+1.5rem)] md:max-w-[calc(100vw-16.5rem)] lg:left-[calc(15rem+2rem)] lg:max-w-[calc(100vw-17rem)]"
          : "flex flex-wrap items-center gap-x-3 gap-y-2 rounded border border-gray-200 bg-white px-4 py-3 text-sm text-gray-700 shadow-sm"
      }
    >
      <span>{statusMessage}</span>
      {fetcher.data?.error?.message ? (
        <span className={isTrash ? "text-red-300" : "text-error-600"}>
          {fetcher.data.error.message}
        </span>
      ) : (
        <button
          type="button"
          className={
            isTrash
              ? "rounded-sm p-0 font-semibold text-blue-300 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-900 disabled:opacity-60"
              : "rounded-sm p-0 font-semibold text-red-700 hover:text-red-800 disabled:opacity-60"
          }
          disabled={isUndoing}
          onClick={undo}
        >
          {isUndoing && !isTrash ? "Undoing..." : "Undo"}
        </button>
      )}
    </div>
  );
}
