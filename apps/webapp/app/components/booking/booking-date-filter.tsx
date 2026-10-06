import { CaretSortIcon } from "@radix-ui/react-icons";
import {
  Popover,
  PopoverContent,
  PopoverPortal,
  PopoverTrigger,
} from "@radix-ui/react-popover";
import { useNavigation } from "react-router";
import { useSearchParams } from "~/hooks/search-params";
import { isFormProcessing } from "~/utils/form";
import { tw } from "~/utils/tw";

const FIXED_DATE_RANGES = [
  ["all", "All time"],
  ["last-day", "Last day"],
  ["last-week", "Last week"],
  ["last-month", "Last month"],
] as const;

export function BookingDateFilter({ dateYears }: { dateYears: number[] }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigation = useNavigation();
  const disabled = isFormProcessing(navigation.state);
  const orderDirection = searchParams.get("orderDirection") ?? "desc";
  const selectedRange = searchParams.get("dateRange") ?? "all";
  const selectedYear = selectedRange.startsWith("year:")
    ? Number(selectedRange.slice("year:".length))
    : null;
  const years = Array.from(
    new Set([
      ...dateYears,
      ...(selectedYear && Number.isFinite(selectedYear) ? [selectedYear] : []),
    ])
  ).sort((left, right) => right - left);

  function updateSearchParam(name: string, value: string) {
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      if (value === "all") next.delete(name);
      else next.set(name, value);
      next.delete("page");
      return next;
    });
  }

  return (
    <Popover>
      <PopoverTrigger
        className={tw(
          "inline-flex items-center gap-2 text-gray-500",
          disabled ? "cursor-not-allowed opacity-50" : ""
        )}
        asChild
      >
        <button
          type="button"
          disabled={disabled}
          className="flex items-center justify-between whitespace-nowrap rounded border border-gray-300 px-[14px] py-[10px] text-[14px] text-gray-500 hover:cursor-pointer"
        >
          <span className="truncate whitespace-nowrap">
            Sort by:{" "}
            {orderDirection === "desc" ? "Newest first" : "Oldest first"}
          </span>
          <CaretSortIcon aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverPortal>
        <PopoverContent
          align="start"
          className="z-[100] flex w-[min(19rem,calc(100vw-2rem))] flex-col gap-3 rounded-md border border-gray-300 bg-white p-4"
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <label className="flex flex-col gap-1 text-sm font-semibold text-gray-700">
            Date period
            <select
              className="border-gray-300 text-sm font-normal"
              value={selectedRange}
              disabled={disabled}
              onChange={(event) =>
                updateSearchParam("dateRange", event.currentTarget.value)
              }
            >
              {FIXED_DATE_RANGES.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
              {years.map((year) => (
                <option key={year} value={`year:${year}`}>
                  {year}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-sm font-semibold text-gray-700">
            Sort by
            <select
              className="border-gray-300 text-sm font-normal"
              value={orderDirection === "desc" ? "desc" : "asc"}
              disabled={disabled}
              onChange={(event) =>
                updateSearchParam("orderDirection", event.currentTarget.value)
              }
            >
              <option value="asc">Oldest first</option>
              <option value="desc">Newest first</option>
            </select>
          </label>
        </PopoverContent>
      </PopoverPortal>
    </Popover>
  );
}
