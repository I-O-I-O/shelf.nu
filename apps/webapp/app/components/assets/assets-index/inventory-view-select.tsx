import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/forms/select";
import { tw } from "~/utils/tw";
import {
  INVENTORY_QUICK_FILTERS,
  type InventoryQuickFilter,
} from "./inventory-quick-filters";

export const INVENTORY_FILTER_TRIGGER_CLASS_NAME =
  "h-9 w-[170px] shrink-0 rounded-lg border border-gray-300 bg-white px-3 py-0 text-sm font-medium text-gray-700 text-left transition hover:border-red-300 hover:bg-red-50 hover:text-red-800 focus:outline-none focus:ring-2 focus:ring-red-600 focus:ring-offset-1";

function isInventoryQuickFilter(value: string): value is InventoryQuickFilter {
  return INVENTORY_QUICK_FILTERS.some((filter) => filter.key === value);
}

export function InventoryViewSelect({
  value,
  onChange,
}: {
  value: InventoryQuickFilter;
  onChange: (value: InventoryQuickFilter) => void;
}) {
  return (
    <Select
      value={value}
      onValueChange={(nextValue) => {
        if (isInventoryQuickFilter(nextValue)) {
          onChange(nextValue);
        }
      }}
    >
      <SelectTrigger
        aria-label="View"
        className={tw(
          INVENTORY_FILTER_TRIGGER_CLASS_NAME,
          value !== "all" && "border-red-200 bg-red-50 text-red-800"
        )}
      >
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
          <span className="shrink-0">View:</span>
          <SelectValue />
        </span>
      </SelectTrigger>
      <SelectContent position="popper" align="start" className="min-w-40">
        {INVENTORY_QUICK_FILTERS.map((filter) => (
          <SelectItem key={filter.key} value={filter.key}>
            {filter.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
