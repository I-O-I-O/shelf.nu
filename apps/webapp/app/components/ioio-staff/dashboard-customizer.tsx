import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { Dialog, DialogPortal } from "~/components/layout/dialog";
import { Button } from "~/components/shared/button";
import {
  DEFAULT_STAFF_DASHBOARD_PREFERENCES,
  normalizeStaffDashboardPreferences,
  STAFF_DASHBOARD_WIDGETS,
  type StaffDashboardPreferences,
  type StaffDashboardWidgetId,
} from "~/modules/ioio-staff/dashboard-preferences";

export function DashboardCustomizer({
  preferences,
}: {
  preferences: StaffDashboardPreferences;
}) {
  const fetcher = useFetcher<{
    kind?: string;
    message?: string;
    error?: { message?: string };
  }>();
  const [open, setOpen] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [draft, setDraft] = useState(preferences);
  const draggedWidget = useRef<StaffDashboardWidgetId | null>(null);

  useEffect(() => {
    if (open) {
      setDraft(normalizeStaffDashboardPreferences(preferences));
      setConfirmReset(false);
    }
  }, [open, preferences]);

  useEffect(() => {
    if (
      fetcher.state === "idle" &&
      fetcher.data?.kind === "dashboard-preferences-saved"
    ) {
      setOpen(false);
      setConfirmReset(false);
    }
  }, [fetcher.state, fetcher.data]);

  function moveWidget(id: StaffDashboardWidgetId, direction: -1 | 1) {
    setDraft((current) => {
      const order = [...current.order];
      const index = order.indexOf(id);
      const nextIndex = index + direction;
      if (index < 0 || nextIndex < 0 || nextIndex >= order.length) {
        return current;
      }
      [order[index], order[nextIndex]] = [order[nextIndex], order[index]];
      return { ...current, order };
    });
  }

  function moveWidgetTo(id: StaffDashboardWidgetId, targetIndex: number) {
    setDraft((current) => {
      const order = [...current.order];
      const sourceIndex = order.indexOf(id);
      if (sourceIndex < 0 || targetIndex < 0 || targetIndex >= order.length) {
        return current;
      }
      order.splice(sourceIndex, 1);
      order.splice(
        sourceIndex < targetIndex ? targetIndex - 1 : targetIndex,
        0,
        id
      );
      return { ...current, order };
    });
  }

  function toggleVisibility(id: StaffDashboardWidgetId) {
    setDraft((current) => ({
      ...current,
      hidden: current.hidden.includes(id)
        ? current.hidden.filter((hiddenId) => hiddenId !== id)
        : [...current.hidden, id],
    }));
  }

  function resetToDefault() {
    setDraft(DEFAULT_STAFF_DASHBOARD_PREFERENCES);
    setConfirmReset(false);
    void fetcher.submit(
      { intent: "reset-dashboard" },
      { method: "post", action: "/home" }
    );
  }

  const fetcherError =
    fetcher.data?.kind === "dashboard-preferences-error"
      ? fetcher.data.message
      : fetcher.data?.error?.message ?? null;
  const isSaving = fetcher.state !== "idle";

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        className="h-9 px-3 text-sm"
        onClick={() => setOpen(true)}
      >
        Customize dashboard
      </Button>
      <DialogPortal>
        <Dialog
          title={
            <div>
              <h2 className="text-lg font-bold text-gray-950">
                Customize dashboard
              </h2>
              <p className="mt-1 text-sm text-gray-600">Arrange widgets</p>
            </div>
          }
          open={open}
          onClose={() => setOpen(false)}
          className="w-full max-w-xl"
        >
          <fetcher.Form method="post" action="/home" className="px-6 pb-6">
            <input type="hidden" name="intent" value="save-dashboard" />
            <input
              type="hidden"
              name="preferences"
              value={JSON.stringify(draft)}
            />
            <ol className="divide-y divide-gray-100 rounded-xl border border-gray-200">
              {draft.order.map((id, index) => {
                const widget = STAFF_DASHBOARD_WIDGETS.find(
                  (candidate) => candidate.id === id
                );
                if (!widget) return null;
                const isHidden = draft.hidden.includes(id);

                return (
                  <li
                    key={id}
                    className="flex flex-wrap items-center gap-3 p-3 sm:flex-nowrap"
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.preventDefault();
                      if (draggedWidget.current) {
                        moveWidgetTo(draggedWidget.current, index);
                        draggedWidget.current = null;
                      }
                    }}
                  >
                    <span
                      aria-hidden="true"
                      draggable={!isSaving}
                      onDragStart={() => {
                        draggedWidget.current = id;
                      }}
                      onDragEnd={() => {
                        draggedWidget.current = null;
                      }}
                      className="cursor-grab select-none text-xl leading-none text-gray-400 active:cursor-grabbing"
                    >
                      ≡
                    </span>
                    <span className="min-w-0 flex-1 text-sm font-semibold text-gray-900">
                      {widget.label}
                    </span>
                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        variant="secondary"
                        className="h-8 px-2 text-xs"
                        aria-label={`Move ${widget.label} up`}
                        disabled={index === 0 || isSaving}
                        onClick={() => moveWidget(id, -1)}
                      >
                        Move up
                      </Button>
                      <Button
                        type="button"
                        variant="secondary"
                        className="h-8 px-2 text-xs"
                        aria-label={`Move ${widget.label} down`}
                        disabled={index === draft.order.length - 1 || isSaving}
                        onClick={() => moveWidget(id, 1)}
                      >
                        Move down
                      </Button>
                    </div>
                    <label className="flex w-20 shrink-0 items-center justify-end gap-2 text-sm text-gray-700">
                      <input
                        type="checkbox"
                        checked={!isHidden}
                        disabled={isSaving}
                        onChange={() => toggleVisibility(id)}
                        aria-label={`${widget.label} shown`}
                        className="size-4 accent-red-700"
                      />
                      {isHidden ? "Hidden" : "Shown"}
                    </label>
                  </li>
                );
              })}
            </ol>

            {fetcherError ? (
              <p role="alert" className="mt-3 text-sm text-red-700">
                {fetcherError}
              </p>
            ) : null}

            {confirmReset ? (
              <div className="mt-4 rounded-lg border border-gray-200 bg-gray-50 p-3">
                <p className="text-sm font-semibold text-gray-900">
                  Reset dashboard layout?
                </p>
                <div className="mt-3 flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={isSaving}
                    onClick={() => setConfirmReset(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    variant="primary"
                    disabled={isSaving}
                    onClick={resetToDefault}
                  >
                    Reset
                  </Button>
                </div>
              </div>
            ) : (
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                <Button
                  type="button"
                  variant="secondary"
                  disabled={isSaving}
                  onClick={() => setConfirmReset(true)}
                >
                  Reset to default
                </Button>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={isSaving}
                    onClick={() => setOpen(false)}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" variant="primary" disabled={isSaving}>
                    {isSaving ? "Saving..." : "Done"}
                  </Button>
                </div>
              </div>
            )}
          </fetcher.Form>
        </Dialog>
      </DialogPortal>
    </>
  );
}
