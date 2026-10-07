import { useEffect } from "react";
import { useFetcher } from "react-router";
import { Button } from "~/components/shared/button";
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
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded border border-gray-200 bg-white px-4 py-3 text-sm text-gray-700 shadow-sm"
    >
      <span>{action.entries.length} inventory items updated.</span>
      {fetcher.data?.error?.message ? (
        <span className="text-error-600">{fetcher.data.error.message}</span>
      ) : (
        <Button
          type="button"
          variant="link"
          size="sm"
          className="p-0 font-semibold text-red-700 hover:text-red-800"
          disabled={isUndoing}
          onClick={undo}
        >
          {isUndoing ? "Undoing..." : "Undo"}
        </Button>
      )}
    </div>
  );
}
