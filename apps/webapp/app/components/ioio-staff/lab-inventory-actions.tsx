import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { useFetcher } from "react-router";
import { Dialog, DialogPortal } from "~/components/layout/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/shared/dropdown";
import {
  LAB_INVENTORY_ACTIONS,
  type LabInventoryAction,
} from "~/modules/ioio-staff/lab-inventory";
import type { LabIssue } from "~/modules/ioio-staff/lab-status.server";

const actionLabels: Record<LabInventoryAction, [string, string]> = {
  disable: ["Disable item", "Disable selected"],
  enable: ["Re-enable item", "Re-enable selected"],
  delete: ["Delete permanently", "Delete selected permanently"],
};

function supports(issue: LabIssue, action: LabInventoryAction) {
  const target = issue.inventoryTarget;
  return Boolean(
    target &&
      (action === "delete" ||
        (!target.pooled && target.disabled === (action === "enable")))
  );
}

export function LabInventoryActions({
  issues,
  renderIssue,
}: {
  issues: LabIssue[];
  renderIssue: (issue: LabIssue, controls?: ReactNode) => ReactNode;
}) {
  const fetcher = useFetcher<{
    kind?: string;
    count?: number;
    error?: { message: string };
  }>();
  const [selection, setSelection] = useState<string[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [pending, setPending] = useState<{
    action: LabInventoryAction;
    issues: LabIssue[];
    previousResult: typeof fetcher.data;
  } | null>(null);
  const targetIds = new Set<string>();
  const eligible = issues.filter((issue) => {
    const id = issue.inventoryTarget?.assetId;
    if (!id || targetIds.has(id)) return false;
    targetIds.add(id);
    return true;
  });
  const eligibleIds = new Set(eligible.map((issue) => issue.id));
  const selected = eligible.filter((issue) => selection.includes(issue.id));
  const busy = fetcher.state !== "idle";
  const result =
    fetcher.data !== pending?.previousResult ? fetcher.data : undefined;

  useEffect(() => {
    if (busy || result?.kind !== "lab-inventory-updated") return;
    setPending(null);
    setSelection([]);
  }, [busy, result]);

  function confirm(action: LabInventoryAction, targets: LabIssue[]) {
    setPending({ action, issues: targets, previousResult: fetcher.data });
  }

  return (
    <>
      {eligible.length ? (
        <div className="mt-3 space-y-2">
          <label className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-gray-800">
            <input
              type="checkbox"
              checked={selected.length === eligible.length}
              ref={(element) => {
                if (element)
                  element.indeterminate =
                    selected.length > 0 && selected.length < eligible.length;
              }}
              onChange={(event) => {
                if (event.target.checked) setShowAll(true);
                setSelection(
                  event.target.checked ? eligible.map((issue) => issue.id) : []
                );
              }}
              className="size-4 accent-red-700"
            />
            Select all reported inventory items
          </label>
          {selected.length ? (
            <div
              role="group"
              aria-label="Selected inventory item actions"
              className="flex flex-wrap items-center gap-2 rounded-lg bg-gray-50 p-2"
            >
              <span role="status" className="text-sm font-semibold">
                {selected.length} selected
              </span>
              {LAB_INVENTORY_ACTIONS.map((action) => {
                const targets = selected.filter((issue) =>
                  supports(issue, action)
                );
                return targets.length ? (
                  <button
                    key={action}
                    type="button"
                    className="min-h-11 rounded-lg border border-gray-300 bg-white px-2 text-sm font-semibold text-gray-800 hover:bg-red-50"
                    onClick={() => confirm(action, targets)}
                    disabled={busy}
                  >
                    {actionLabels[action][1]} ({targets.length})
                  </button>
                ) : null;
              })}
            </div>
          ) : null}
        </div>
      ) : null}

      <ul className="mt-3 space-y-2" aria-label="Current lab issues">
        {(showAll ? issues : issues.slice(0, 3)).map((issue) =>
          renderIssue(
            issue,
            eligibleIds.has(issue.id) ? (
              <>
                <label className="grid min-h-11 min-w-11 shrink-0 place-items-center">
                  <input
                    type="checkbox"
                    aria-label={`Select ${issue.title}`}
                    checked={selection.includes(issue.id)}
                    onChange={(event) => {
                      const checked = event.currentTarget.checked;
                      setSelection((ids) =>
                        checked
                          ? [...ids, issue.id]
                          : ids.filter((id) => id !== issue.id)
                      );
                    }}
                    className="size-4 accent-red-700"
                  />
                </label>
                <DropdownMenu modal={false}>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={`Actions for ${issue.title}`}
                      className="mr-1 inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-gray-700 hover:bg-gray-100"
                      disabled={busy}
                    >
                      <MoreHorizontal aria-hidden="true" className="size-5" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="z-50">
                    {LAB_INVENTORY_ACTIONS.filter((action) =>
                      supports(issue, action)
                    ).map((action) => (
                      <DropdownMenuItem
                        key={action}
                        onSelect={() => confirm(action, [issue])}
                        className="min-h-11 md:min-h-0"
                      >
                        {actionLabels[action][0]}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            ) : undefined
          )
        )}
      </ul>
      {!showAll && issues.length > 3 ? (
        <button
          type="button"
          className="mt-2 min-h-11 text-sm font-bold text-red-700 hover:underline"
          onClick={() => setShowAll(true)}
        >
          Show all {issues.length} items
        </button>
      ) : null}
      {!pending && result?.kind === "lab-inventory-updated" ? (
        <p role="status" className="mt-2 text-sm text-green-800">
          Inventory updated for {result.count}{" "}
          {result.count === 1 ? "item" : "items"}.
        </p>
      ) : null}

      <DialogPortal>
        <Dialog
          open={Boolean(pending)}
          onClose={() => {
            if (!busy) setPending(null);
          }}
          title={
            pending
              ? `${
                  actionLabels[pending.action][
                    pending.issues.length === 1 ? 0 : 1
                  ]
                }?`
              : ""
          }
          className="w-full max-w-lg max-md:bg-white max-md:pt-[env(safe-area-inset-top)]"
          headerClassName="shrink-0 max-md:px-4"
        >
          {pending ? (
            <fetcher.Form
              method="post"
              action="/home"
              className="min-w-0 space-y-4 px-4 pb-4 sm:px-6"
            >
              <input type="hidden" name="intent" value="manage-lab-inventory" />
              <input
                type="hidden"
                name="inventoryAction"
                value={pending.action}
              />
              <input type="hidden" name="confirmed" value="yes" />
              {pending.issues.map((issue) => (
                <input
                  key={issue.id}
                  type="hidden"
                  name="target"
                  value={`${
                    issue.inventoryTarget?.pooled ? "p" : "s"
                  }${issue.id.slice("report:".length)}`}
                />
              ))}
              <p className="text-sm text-gray-800">
                {pending.action === "delete"
                  ? `Permanently remove ${pending.issues.length} ${
                      pending.issues.length === 1 ? "unit" : "units"
                    } from inventory, one per selected item. A stock pool keeps its remaining units. This cannot be undone.`
                  : `${
                      pending.action === "disable"
                        ? "Disable borrowing for"
                        : "Restore borrowing for"
                    } ${pending.issues.length} ${
                      pending.issues.length === 1 ? "item" : "items"
                    }.`}
              </p>
              <ul className="max-h-40 list-disc space-y-1 overflow-y-auto pl-5 text-sm [overflow-wrap:anywhere]">
                {pending.issues.map((issue) => (
                  <li key={issue.id}>{issue.inventoryTarget?.title}</li>
                ))}
              </ul>
              {result?.error ? (
                <p role="alert" className="text-sm text-red-800">
                  {result.error.message}
                </p>
              ) : null}
              <div className="flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  disabled={busy}
                  className="min-h-11 rounded-lg border border-gray-300 px-3 text-sm font-semibold"
                  onClick={() => setPending(null)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={busy}
                  className="min-h-11 rounded-lg bg-red-700 px-3 text-sm font-semibold text-white disabled:opacity-50"
                >
                  {busy
                    ? "Saving…"
                    : actionLabels[pending.action][
                        pending.issues.length === 1 ? 0 : 1
                      ]}
                </button>
              </div>
            </fetcher.Form>
          ) : null}
        </Dialog>
      </DialogPortal>
    </>
  );
}
