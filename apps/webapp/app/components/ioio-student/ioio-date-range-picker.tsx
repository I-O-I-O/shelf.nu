import { DateTimePicker } from "~/components/shared/date-time-picker";
import {
  addCalendarDaysLocal,
  addCalendarMonthLocal,
} from "~/modules/ioio-student/date-range";

export function IoioDateRangePicker({
  startDate,
  returnDate,
  onStartDateChange,
  onReturnDateChange,
  minStartDate,
  maxReturnDate,
  maxDuration,
  maxDurationDays,
  helperText,
  availability,
  availabilityLoading = false,
  availabilityError,
  startName = "startDate",
  returnName = "returnDate",
  error,
}: {
  startDate: string;
  returnDate: string;
  onStartDateChange: (value: string) => void;
  onReturnDateChange: (value: string) => void;
  minStartDate?: Date;
  maxReturnDate?: Date;
  maxDuration?: "one-month" | null;
  maxDurationDays?: number | null;
  helperText?: string;
  availability?: { available: number; total: number };
  availabilityLoading?: boolean;
  availabilityError?: string;
  startName?: string;
  returnName?: string;
  error?: string;
}) {
  const start = startDate ? dateToLocalDate(startDate) : undefined;
  const maxDate =
    maxReturnDate ??
    (start && maxDurationDays != null
      ? addCalendarDaysLocal(start, maxDurationDays)
      : maxDuration === "one-month" && start
      ? addCalendarMonthLocal(start)
      : undefined);

  return (
    <fieldset className="grid gap-2 sm:grid-cols-2">
      <legend className="sr-only">Borrowing period</legend>
      <DateTimePicker
        name={startName}
        label="Start date"
        mode="date"
        value={startDate}
        min={minStartDate}
        max={maxDate}
        onChange={onStartDateChange}
        className="text-sm"
      />
      <DateTimePicker
        name={returnName}
        label="Return date"
        mode="date"
        value={returnDate}
        min={start}
        max={maxDate}
        onChange={onReturnDateChange}
        error={error}
        className="text-sm"
      />
      {helperText ? (
        <p className="text-xs text-gray-500 sm:col-span-2">{helperText}</p>
      ) : null}
      {availabilityLoading ? (
        <p className="text-xs font-semibold text-gray-600 sm:col-span-2">
          Checking availability for these dates...
        </p>
      ) : availabilityError ? (
        <p className="text-xs font-semibold text-red-700 sm:col-span-2">
          {availabilityError}
        </p>
      ) : availability ? (
        <p
          className={`text-xs font-semibold sm:col-span-2 ${
            availability.available > 0 ? "text-green-800" : "text-red-700"
          }`}
        >
          {availability.available > 0
            ? availability.available < availability.total
              ? `Only ${availability.available} of ${availability.total} available for these dates.`
              : `${availability.available} available for these dates.`
            : "Unavailable during these dates."}
        </p>
      ) : null}
    </fieldset>
  );
}

function dateToLocalDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}
