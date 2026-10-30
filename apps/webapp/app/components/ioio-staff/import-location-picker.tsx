import { useMemo, useState } from "react";
import {
  Popover,
  PopoverContent,
  PopoverPortal,
  PopoverTrigger,
} from "@radix-ui/react-popover";
import { CheckIcon, ChevronDownIcon, SearchIcon } from "lucide-react";
import { useAutoFocus } from "~/hooks/use-auto-focus";

type ImportLocationOption = {
  id: string;
  name: string;
  pathLabel: string;
  operational?: boolean;
};

export function ImportLocationPicker({
  label,
  locations,
  selectedId,
  suggestedId,
  onSelect,
  className,
}: {
  label: string;
  locations: ImportLocationOption[];
  selectedId: string | null;
  suggestedId: string | null;
  onSelect: (locationId: string | null) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useAutoFocus<HTMLInputElement>({ when: open });
  const selected = locations.find((location) => location.id === selectedId);
  const suggested = locations.find(
    (location) => location.id === suggestedId && !location.operational
  );
  const filtered = useMemo(() => {
    const normalizedQuery = query
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLocaleLowerCase()
      .trim();
    return locations.filter((location) => {
      if (!normalizedQuery) return true;
      return `${location.name} ${location.pathLabel}`
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLocaleLowerCase()
        .includes(normalizedQuery);
    });
  }, [locations, query]);
  const suggestedResult =
    suggested && filtered.some(({ id }) => id === suggested.id)
      ? suggested
      : null;
  const allResults = filtered.filter(
    (location) => location.id !== suggestedResult?.id
  );

  const selectLocation = (locationId: string | null) => {
    onSelect(locationId);
    setOpen(false);
    setQuery("");
  };

  const option = (location: ImportLocationOption) => (
    <button
      key={location.id}
      type="button"
      role="option"
      aria-selected={location.id === selectedId}
      onClick={() => selectLocation(location.id)}
      className="flex w-full items-start justify-between gap-2 px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50"
    >
      <span className="min-w-0">
        <span className="block break-words">{location.pathLabel}</span>
        {location.operational ? (
          <span className="block text-xs text-gray-500">
            Operational location
          </span>
        ) : null}
      </span>
      {location.id === selectedId ? (
        <CheckIcon
          className="mt-0.5 size-4 shrink-0 text-primary"
          aria-hidden="true"
        />
      ) : null}
    </button>
  );

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-haspopup="listbox"
          className={`inline-flex max-w-full items-center rounded-md text-left text-sm text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-red-200 ${
            className ?? ""
          }`}
        >
          <span className="line-clamp-2 break-words">
            {selected?.pathLabel ?? "Choose location"}
          </span>
          <ChevronDownIcon
            className="ml-1 size-4 shrink-0 text-gray-500"
            aria-hidden="true"
          />
        </button>
      </PopoverTrigger>
      <PopoverPortal>
        <PopoverContent
          align="start"
          side="bottom"
          className="z-[999999] mt-1 w-[min(34rem,calc(100vw-2rem))] overflow-hidden rounded border bg-white shadow-lg"
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <div className="flex items-center border-b">
            <SearchIcon
              className="ml-3 size-4 shrink-0 text-gray-500"
              aria-hidden="true"
            />
            <input
              ref={searchRef}
              type="search"
              aria-label={`Search locations for ${label.replace(
                /^Location for /,
                ""
              )}`}
              placeholder="Search location..."
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              className="min-w-0 flex-1 border-0 p-2 text-sm focus:border-0 focus:ring-0"
            />
          </div>
          <div
            role="listbox"
            aria-label="Available Shelf locations"
            className="max-h-72 overflow-y-auto py-1"
          >
            <button
              type="button"
              role="option"
              aria-selected={selectedId === null}
              onClick={() => selectLocation(null)}
              className="w-full px-3 py-2 text-left text-sm text-gray-600 hover:bg-gray-50"
            >
              Choose location
            </button>
            {suggestedResult ? (
              <div>
                <p className="px-3 pb-1 pt-2 text-xs font-bold uppercase tracking-wide text-gray-500">
                  Suggested
                </p>
                {option(suggestedResult)}
              </div>
            ) : null}
            {allResults.length > 0 ? (
              <div>
                <p className="px-3 pb-1 pt-2 text-xs font-bold uppercase tracking-wide text-gray-500">
                  All locations
                </p>
                {allResults.map(option)}
              </div>
            ) : null}
            {filtered.length === 0 ? (
              <p className="p-3 text-sm text-gray-500">No locations found.</p>
            ) : null}
          </div>
        </PopoverContent>
      </PopoverPortal>
    </Popover>
  );
}
