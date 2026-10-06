import { useEffect, useState } from "react";
import { MoreHorizontalIcon } from "lucide-react";
import { useFetcher } from "react-router";
import { Dialog, DialogPortal } from "~/components/layout/dialog";
import { Button } from "~/components/shared/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/shared/dropdown";

export type PhysicalUnitAvailabilityRow = {
  id: string;
  title: string;
  status: string;
  canChangeAvailability: boolean;
  unavailableReason: string | null;
};

type AvailabilityAction = "unavailable" | "available" | "broken";

function statusStyle(status: string) {
  if (status === "Available") return "bg-green-50 text-green-800";
  if (status === "Broken") return "bg-red-50 text-red-800";
  if (status === "Temporarily unavailable" || status === "Unavailable") {
    return "bg-gray-100 text-gray-700";
  }
  return "bg-amber-50 text-amber-800";
}

export function PhysicalUnitAvailabilityList({
  units,
  actionUrl,
  canEdit,
}: {
  units: PhysicalUnitAvailabilityRow[];
  actionUrl: string;
  canEdit: boolean;
}) {
  if (!units.length) return null;

  return (
    <section aria-labelledby="physical-units-heading">
      <h2
        id="physical-units-heading"
        className="text-sm font-bold uppercase tracking-wide text-gray-500"
      >
        Physical units
      </h2>
      <div className="mt-3 divide-y divide-gray-100 rounded-xl border border-gray-200 bg-white">
        {units.map((unit) => (
          <PhysicalUnitRow
            key={unit.id}
            unit={unit}
            actionUrl={actionUrl}
            canEdit={canEdit}
          />
        ))}
      </div>
    </section>
  );
}

function PhysicalUnitRow({
  unit,
  actionUrl,
  canEdit,
}: {
  unit: PhysicalUnitAvailabilityRow;
  actionUrl: string;
  canEdit: boolean;
}) {
  const [pendingAction, setPendingAction] = useState<AvailabilityAction | null>(
    null
  );
  const fetcher = useFetcher<{
    ok: boolean;
    intent: string;
    unitId: string;
    error?: string;
  }>();
  const busy = fetcher.state !== "idle";

  useEffect(() => {
    if (
      fetcher.data?.ok &&
      fetcher.data.unitId === unit.id &&
      fetcher.data.intent === "physicalUnitAvailability"
    ) {
      setPendingAction(null);
    }
  }, [fetcher.data, unit.id]);

  const actionLabel =
    pendingAction === "unavailable"
      ? "Temporarily disable"
      : pendingAction === "available"
      ? "Make available"
      : "Mark broken";
  const dialogTitle =
    pendingAction === "unavailable"
      ? `Temporarily disable ${unit.title}?`
      : pendingAction === "available"
      ? `Make ${unit.title} available?`
      : `Mark ${unit.title} as broken?`;

  return (
    <>
      <div className="flex min-w-0 items-center gap-3 px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-gray-900">
            {unit.title}
          </p>
        </div>
        <span
          className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${statusStyle(
            unit.status
          )}`}
        >
          {unit.status}
        </span>
        {canEdit ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="size-9 shrink-0 p-0"
                aria-label={`Actions for ${unit.title}`}
              >
                <MoreHorizontalIcon className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-48">
              {unit.status === "Available" ? (
                <>
                  <DropdownMenuItem
                    onSelect={() => setPendingAction("unavailable")}
                  >
                    Temporarily disable
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setPendingAction("broken")}>
                    Mark broken
                  </DropdownMenuItem>
                </>
              ) : unit.status === "Temporarily unavailable" ||
                unit.status === "Unavailable" ||
                unit.status === "Broken" ||
                unit.status === "Issue reported" ? (
                <>
                  <DropdownMenuItem
                    disabled={!unit.canChangeAvailability}
                    onSelect={() => setPendingAction("available")}
                  >
                    Make available
                  </DropdownMenuItem>
                  {!unit.canChangeAvailability && unit.unavailableReason ? (
                    <p className="px-2 py-1 text-xs leading-5 text-gray-500">
                      {unit.unavailableReason}
                    </p>
                  ) : null}
                </>
              ) : (
                <>
                  <DropdownMenuItem disabled>
                    Availability actions unavailable
                  </DropdownMenuItem>
                  {unit.unavailableReason ? (
                    <p className="px-2 py-1 text-xs leading-5 text-gray-500">
                      {unit.unavailableReason}
                    </p>
                  ) : null}
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>

      <DialogPortal>
        <Dialog
          title={dialogTitle}
          open={pendingAction !== null}
          onClose={() => {
            if (!busy) setPendingAction(null);
          }}
          className="w-full max-w-lg"
        >
          {pendingAction ? (
            <fetcher.Form
              method="post"
              action={actionUrl}
              className="space-y-4 px-6 pb-6"
            >
              <input
                type="hidden"
                name="intent"
                value="physicalUnitAvailability"
              />
              <input type="hidden" name="unitId" value={unit.id} />
              <input type="hidden" name="action" value={pendingAction} />
              <p className="text-sm text-gray-700">
                {pendingAction === "unavailable"
                  ? "Students will not be able to borrow this kit until a TA makes it available again."
                  : pendingAction === "available"
                  ? "Students will be able to borrow this kit again."
                  : "This will create an item-damaged report for Staff review and keep the unit out of circulation."}
              </p>
              {pendingAction !== "available" ? (
                <label className="block text-sm font-medium text-gray-800">
                  Optional note
                  <textarea
                    name="note"
                    maxLength={500}
                    rows={3}
                    className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-red-500 focus:outline-none focus:ring-1 focus:ring-red-500"
                  />
                </label>
              ) : null}
              {fetcher.data?.unitId === unit.id && !fetcher.data.ok ? (
                <p role="alert" className="text-sm text-red-700">
                  {fetcher.data.error ?? "The unit could not be updated."}
                </p>
              ) : null}
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => setPendingAction(null)}
                >
                  Cancel
                </Button>
                <Button type="submit" variant="primary" disabled={busy}>
                  {busy ? "Saving…" : actionLabel}
                </Button>
              </div>
            </fetcher.Form>
          ) : null}
        </Dialog>
      </DialogPortal>
    </>
  );
}
