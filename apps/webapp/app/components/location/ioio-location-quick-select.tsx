import { useId, useMemo, useState } from "react";
import Input from "~/components/forms/input";

export type QuickLocationNode = {
  id: string;
  name: string;
  parentId: string | null;
};

export type QuickLocationSelection = {
  roomId?: string;
  sectionId?: string;
  shelfId?: string;
  containerId?: string;
};

/** Resolves a location to its room-to-leaf path using Shelf's location tree. */
export function getQuickLocationPath(
  location: QuickLocationNode,
  locationsById: Map<string, QuickLocationNode>
) {
  const path: QuickLocationNode[] = [];
  const visited = new Set<string>();
  let current: QuickLocationNode | undefined = location;

  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    path.unshift(current);
    current = current.parentId
      ? locationsById.get(current.parentId)
      : undefined;
  }

  return path;
}

export function getQuickLocationSelection(
  pathIds: string[]
): QuickLocationSelection {
  return {
    roomId: pathIds[0],
    sectionId: pathIds[1],
    shelfId: pathIds[2],
    containerId: pathIds[3],
  };
}

/** Search shortcut that fills the existing four-level location cascade. */
export function IoioLocationQuickSelect({
  locations,
  disabled,
  onSelect,
}: {
  locations: QuickLocationNode[];
  disabled?: boolean;
  onSelect: (pathIds: string[]) => void;
}) {
  const resultsId = useId();
  const [query, setQuery] = useState("");
  const locationsById = useMemo(
    () => new Map(locations.map((location) => [location.id, location])),
    [locations]
  );
  const results = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) return [];

    return locations
      .filter((location) =>
        location.name.toLocaleLowerCase().includes(normalizedQuery)
      )
      .map((location) => ({
        location,
        path: getQuickLocationPath(location, locationsById),
      }))
      .sort((left, right) =>
        left.path
          .map(({ name }) => name)
          .join(" › ")
          .localeCompare(
            right.path.map(({ name }) => name).join(" › "),
            undefined,
            { numeric: true, sensitivity: "base" }
          )
      );
  }, [locations, locationsById, query]);

  const visibleResults = results.slice(0, 25);

  return (
    <div className="space-y-2">
      <Input
        label="Quick location"
        placeholder="Search room, section, shelf or container..."
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
        disabled={disabled}
        autoComplete="off"
        role="combobox"
        aria-expanded={query.trim().length > 0}
        aria-controls={resultsId}
        aria-autocomplete="list"
      />
      {query.trim() ? (
        <ul
          id={resultsId}
          role="listbox"
          aria-label="Quick location results"
          className="max-h-52 overflow-y-auto rounded border border-gray-200 bg-white"
        >
          {visibleResults.length ? (
            visibleResults.map(({ location, path }) => (
              <li key={location.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected="false"
                  className="block w-full px-3 py-2 text-left hover:bg-gray-50 focus:bg-gray-50 focus:outline-none"
                  disabled={disabled}
                  onClick={() => {
                    onSelect(path.map(({ id }) => id));
                    setQuery("");
                  }}
                >
                  <span className="block truncate text-sm font-medium text-gray-900">
                    {location.name}
                  </span>
                  <span className="block truncate text-xs text-gray-500">
                    {path
                      .slice(0, -1)
                      .map(({ name }) => name)
                      .join(" › ") || "Top level room"}
                  </span>
                </button>
              </li>
            ))
          ) : (
            <li className="px-3 py-2 text-xs text-gray-500" role="status">
              No locations found.
            </li>
          )}
          {results.length > visibleResults.length ? (
            <li className="border-t border-gray-100 px-3 py-2 text-xs text-gray-500">
              Showing 25 results. Refine your search.
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
