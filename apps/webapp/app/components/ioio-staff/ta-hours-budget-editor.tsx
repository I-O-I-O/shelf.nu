import { Form } from "react-router";
import { Dialog } from "~/components/layout/dialog";

export function TAHoursBudgetEditor({
  academicYear,
  hours,
  workedHours,
  scheduledHours,
  action,
  onClose,
}: {
  academicYear: string;
  hours: string;
  workedHours: number;
  scheduledHours: number;
  action: string;
  onClose: () => void;
}) {
  return (
    <Dialog
      open
      onClose={onClose}
      title={<h2 className="text-lg font-bold">Edit TA budget</h2>}
      headerClassName="pb-2"
      className="w-full max-w-lg"
    >
      <Form
        method="post"
        action={action}
        className="space-y-3 px-6 pb-5 pt-2"
        onSubmit={(event) => {
          const proposed = Number(
            new FormData(event.currentTarget).get("totalHoursBudget")
          );
          const overage = workedHours + scheduledHours - proposed;
          if (
            overage > 0 &&
            !window.confirm(
              `The budget will be ${overage.toFixed(
                2
              )} h below confirmed and scheduled hours. Continue?`
            )
          ) {
            event.preventDefault();
            return;
          }
          const field = event.currentTarget.elements.namedItem(
            "confirmedOverBudget"
          );
          if (field instanceof HTMLInputElement) {
            field.value = overage > 0 ? "1" : "0";
          }
        }}
      >
        <input type="hidden" name="intent" value="saveBudget" />
        <input type="hidden" name="academicYear" value={academicYear} />
        <input type="hidden" name="view" value="overview" />
        <input type="hidden" name="confirmedOverBudget" value="0" />
        <label className="block text-sm font-semibold text-gray-700">
          Hours
          <span className="mt-1 flex h-10 items-center rounded-lg border border-gray-300">
            <input
              name="totalHoursBudget"
              type="number"
              min="0"
              max="100000"
              step="0.01"
              required
              defaultValue={hours}
              className="h-full min-w-0 flex-1 rounded-l-lg px-3 outline-none"
            />
            <span className="px-3 text-sm text-gray-500">h</span>
          </span>
        </label>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-10 rounded-lg border border-gray-300 px-4 text-sm font-semibold"
          >
            Cancel
          </button>
          <button className="h-10 rounded-lg bg-red-700 px-4 text-sm font-bold text-white hover:bg-red-800">
            Save
          </button>
        </div>
      </Form>
    </Dialog>
  );
}
