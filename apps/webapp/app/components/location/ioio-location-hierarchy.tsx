import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { Prisma } from "@prisma/client";
import { ChevronDown, ChevronRight, Plus, Search, X } from "lucide-react";
import { useFetcher } from "react-router";
import type { FetcherWithComponents } from "react-router";
import { IoioLocationColorPicker } from "~/components/location/ioio-location-color-picker";
import { LocationMoveDialog } from "~/components/location/location-move-dialog";
import LocationQuickActions from "~/components/location/location-quick-actions";
import { Button } from "~/components/shared/button";
import { useSearchParams } from "~/hooks/search-params";
import {
  inferIoioLocationKind,
  type IoioLocationInventorySummary,
} from "~/modules/location/ioio-hierarchy";
import type { LOCATION_LIST_INCLUDE } from "~/modules/location/service.server";
import { tw } from "~/utils/tw";

export type IoioLocation = Prisma.LocationGetPayload<{
  include: typeof LOCATION_LIST_INCLUDE;
}>;

export type LocationKind = "Rooms" | "Sections" | "Shelves" | "Containers";
type CreationType = "room" | "section" | "shelf" | "container";
type InlineCreate = { locationType: CreationType; parentId: string | null };
type LevelGroup = "rooms" | "sections" | "shelves" | "containers";
const LOCATION_KINDS: LocationKind[] = [
  "Rooms",
  "Sections",
  "Shelves",
  "Containers",
];

type InlineActionData = {
  success?: boolean;
  location?: { id: string; name: string; parentId: string | null };
  error?: { message?: string };
};

export function formatIoioLocationName(name: string) {
  return { label: name, code: null };
}

export function formatIoioRoomHeader(name: string) {
  return name;
}

export function sortIoioLocations(locations: IoioLocation[]) {
  return [...locations].sort((left, right) =>
    left.name.localeCompare(right.name, undefined, {
      numeric: true,
      sensitivity: "base",
    })
  );
}

export function groupIoioLocations(locations: IoioLocation[]) {
  const locationsById = new Map(
    locations.map((location) => [location.id, location])
  );
  const groups = new Map<LocationKind, IoioLocation[]>(
    LOCATION_KINDS.map((kind) => [kind, []])
  );

  for (const location of locations) {
    groups.get(inferIoioLocationKind(location, locationsById))?.push(location);
  }

  return LOCATION_KINDS.map((kind) => ({
    kind,
    locations: sortIoioLocations(groups.get(kind) ?? []),
  }));
}

function buildLocationPath(
  location: IoioLocation,
  locationsById: Map<string, IoioLocation>
) {
  const path: IoioLocation[] = [];
  const visited = new Set<string>();
  let current: IoioLocation | undefined = location;
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    path.unshift(current);
    current = current.parentId
      ? locationsById.get(current.parentId)
      : undefined;
  }
  return path;
}

function AssetCount({ count }: { count: number }) {
  return (
    <span
      className="shrink-0 text-xs tabular-nums text-gray-500"
      title="Active inventory assets assigned to this container"
    >
      {count} {count === 1 ? "asset" : "assets"}
    </span>
  );
}

function ContextualCreateButton({
  label,
  onClick,
  disabled = false,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Add ${label}`}
      title={`Add ${label}`}
      disabled={disabled}
      className="inline-flex size-8 shrink-0 items-center justify-center rounded text-red-700 hover:bg-red-50 focus:outline-none focus:ring-2 focus:ring-red-600 disabled:cursor-not-allowed disabled:text-gray-300 disabled:hover:bg-transparent"
    >
      <Plus className="size-4" aria-hidden="true" />
    </button>
  );
}

function LevelHeader({
  label,
  expanded,
  onToggle,
  onAdd,
  addDisabled = false,
}: {
  label: LevelGroup;
  expanded: boolean;
  onToggle: () => void;
  onAdd: () => void;
  addDisabled?: boolean;
}) {
  const singularLabel: Record<LevelGroup, string> = {
    rooms: "room",
    sections: "section",
    shelves: "shelf",
    containers: "container",
  }[label];
  return (
    <div className="flex items-center gap-1 border-b border-gray-100 py-1">
      <button
        type="button"
        aria-label={`${expanded ? "Collapse" : "Expand"} ${label}`}
        aria-expanded={expanded}
        onClick={onToggle}
        className="inline-flex size-7 shrink-0 items-center justify-center rounded text-gray-500 hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-red-600"
      >
        {expanded ? (
          <ChevronDown className="size-4" aria-hidden="true" />
        ) : (
          <ChevronRight className="size-4" aria-hidden="true" />
        )}
      </button>
      <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-600">
        {label}
      </h2>
      <ContextualCreateButton
        label={singularLabel}
        onClick={onAdd}
        disabled={addDisabled}
      />
    </div>
  );
}

function InlineLocationForm({
  locationType,
  parentId,
  locations,
  fetcher,
  onCancel,
}: {
  locationType: CreationType;
  parentId: string | null;
  locations: IoioLocation[];
  fetcher: FetcherWithComponents<InlineActionData>;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [selectedColor, setSelectedColor] = useState<string>();
  const busy = fetcher.state !== "idle";
  const label = `${locationType[0]?.toUpperCase()}${locationType.slice(1)}`;
  const parentName = parentId
    ? locations.find((location) => location.id === parentId)?.name
    : null;

  useEffect(() => {
    const timeout = window.setTimeout(() => inputRef.current?.focus(), 50);
    return () => window.clearTimeout(timeout);
  }, []);

  return (
    <fetcher.Form
      method="post"
      action="."
      className="flex flex-wrap items-start gap-2"
    >
      <input type="hidden" name="intent" value="inline-create" />
      <input type="hidden" name="locationType" value={locationType} />
      <input type="hidden" name="parentId" value={parentId ?? ""} />
      {locationType === "container" ? (
        <p className="basis-full text-xs text-gray-600" aria-live="polite">
          {parentName
            ? `Adding container under ${parentName}`
            : "Select a shelf before adding a container."}
        </p>
      ) : null}
      <label
        className="sr-only"
        htmlFor={`inline-${locationType}-${parentId ?? "root"}`}
      >
        {label} name
      </label>
      <input
        ref={inputRef}
        id={`inline-${locationType}-${parentId ?? "root"}`}
        name="name"
        type="text"
        required
        minLength={1}
        placeholder={`${label} name...`}
        disabled={busy}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
        className="ioio-identifier h-9 min-w-48 flex-1 rounded-md border border-gray-300 bg-white px-3 text-sm text-gray-950 placeholder:text-gray-400 focus:border-red-600 focus:outline-none focus:ring-2 focus:ring-red-100"
      />
      {locationType === "section" || locationType === "room" ? (
        <div className="basis-full">
          <IoioLocationColorPicker
            locations={locations}
            parentId={parentId}
            locationType={locationType}
            value={selectedColor}
            onChange={setSelectedColor}
          />
        </div>
      ) : null}
      <Button
        type="submit"
        size="sm"
        disabled={busy || (locationType === "container" && !parentId)}
      >
        {busy ? "Adding…" : "Add"}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        disabled={busy}
        onClick={onCancel}
      >
        Cancel
      </Button>
      {fetcher.data?.error?.message ? (
        <p role="alert" className="basis-full text-sm text-red-700">
          {fetcher.data.error.message}
        </p>
      ) : null}
    </fetcher.Form>
  );
}

function LocationOption({
  location,
  selected,
  onSelect,
  assetCount,
  onMove,
}: {
  location: IoioLocation;
  selected: boolean;
  onSelect: () => void;
  assetCount?: number;
  onMove: () => void;
}) {
  return (
    <div
      className={tw(
        "group flex min-h-10 flex-wrap items-center gap-2 rounded-md px-2 py-1",
        selected ? "bg-red-50" : "hover:bg-gray-50"
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className="ioio-identifier min-w-0 flex-1 truncate text-left text-sm font-medium text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-600"
      >
        {location.name}
      </button>
      {assetCount !== undefined ? <AssetCount count={assetCount} /> : null}
      <LocationQuickActions
        location={{
          id: location.id,
          name: location.name,
          childCount: location._count.children,
        }}
        onMove={onMove}
        className="shrink-0 opacity-70 focus-within:opacity-100 group-hover:opacity-100"
      />
    </div>
  );
}

function toggleGroup(
  setter: Dispatch<SetStateAction<Set<LevelGroup>>>,
  group: LevelGroup
) {
  setter((current) => {
    const next = new Set(current);
    if (next.has(group)) next.delete(group);
    else next.add(group);
    return next;
  });
}

export function IoioLocationHierarchy({
  locations,
  inventorySummary,
}: {
  locations: IoioLocation[];
  inventorySummary: IoioLocationInventorySummary;
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const fetcher = useFetcher<InlineActionData>();
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState<InlineCreate | null>(null);
  const [choosingContainerShelf, setChoosingContainerShelf] = useState(false);
  const [lastCreatedLocationId, setLastCreatedLocationId] = useState("");
  const [movingLocation, setMovingLocation] = useState<IoioLocation | null>(
    null
  );
  const handledCreatedId = useRef<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<LevelGroup>>(
    () => new Set(["rooms", "sections", "shelves", "containers"])
  );

  const locationsById = useMemo(
    () => new Map(locations.map((location) => [location.id, location])),
    [locations]
  );
  const childrenByParentId = useMemo(() => {
    const children = new Map<string, IoioLocation[]>();
    for (const location of locations) {
      if (!location.parentId) continue;
      const current = children.get(location.parentId) ?? [];
      current.push(location);
      children.set(location.parentId, sortIoioLocations(current));
    }
    return children;
  }, [locations]);
  const rooms = useMemo(
    () => sortIoioLocations(locations.filter((location) => !location.parentId)),
    [locations]
  );
  const selectedId = searchParams.get("selectedLocation");
  const selectedLocation = selectedId
    ? locationsById.get(selectedId) ?? null
    : null;
  const selectedPath = selectedLocation
    ? buildLocationPath(selectedLocation, locationsById)
    : [];
  const selectedPathRoom =
    selectedPath[0]?.parentId === null &&
    rooms.some((room) => room.id === selectedPath[0]?.id)
      ? selectedPath[0]
      : null;
  const selectedRoom =
    selectedPathRoom ??
    rooms.find((room) => room.id === searchParams.get("room")) ??
    rooms[0] ??
    null;
  const pathMatchesRoom = selectedPath[0]?.id === selectedRoom?.id;
  const selectedPathInRoom = pathMatchesRoom ? selectedPath : [];
  const sections = selectedRoom
    ? (childrenByParentId.get(selectedRoom.id) ?? []).filter(
        (location) =>
          inferIoioLocationKind(location, locationsById) === "Sections"
      )
    : [];
  const sectionFromPath = selectedPathInRoom.find(
    (location) =>
      location.parentId === selectedRoom?.id &&
      inferIoioLocationKind(location, locationsById) === "Sections"
  );
  const sectionFromPathOrQuery =
    sectionFromPath ??
    sections.find((section) => section.id === searchParams.get("section")) ??
    null;
  const selectedSection = sectionFromPathOrQuery;
  const shelves = selectedSection
    ? (childrenByParentId.get(selectedSection.id) ?? []).filter(
        (location) =>
          inferIoioLocationKind(location, locationsById) === "Shelves"
      )
    : [];
  const selectedShelf =
    selectedPathInRoom.find(
      (location) =>
        location.parentId === selectedSection?.id &&
        inferIoioLocationKind(location, locationsById) === "Shelves"
    ) ?? null;
  const containerParentId =
    selectedId && !selectedLocation
      ? null
      : selectedShelf?.id ?? (shelves.length === 1 ? shelves[0]!.id : null);
  const containersByShelf = shelves.map((shelf) => ({
    shelf,
    containers: (childrenByParentId.get(shelf.id) ?? []).filter(
      (location) =>
        inferIoioLocationKind(location, locationsById) === "Containers"
    ),
  }));
  const containers = containersByShelf.flatMap(({ containers }) => containers);
  const selectedContainer =
    containers.find(
      (container) => container.id === selectedPathInRoom.at(-1)?.id
    ) ?? null;
  const selectedPathLabel = [
    selectedRoom?.name,
    selectedSection?.name,
    selectedShelf?.name,
    selectedContainer?.name,
  ]
    .filter(Boolean)
    .join(" / ");

  const searchResults = search.trim()
    ? sortIoioLocations(
        locations.filter((location) =>
          location.name
            .toLocaleLowerCase()
            .includes(search.trim().toLocaleLowerCase())
        )
      )
    : [];
  const updateParams = useCallback(
    (updates: Record<string, string | null>) => {
      setSearchParams((current) => {
        const next = new URLSearchParams(current);
        for (const [key, value] of Object.entries(updates)) {
          if (value) next.set(key, value);
          else next.delete(key);
        }
        return next;
      });
    },
    [setSearchParams]
  );

  const revealAllGroups = () =>
    setExpandedGroups(new Set(["rooms", "sections", "shelves", "containers"]));

  const selectLocation = (location: IoioLocation) => {
    const path = buildLocationPath(location, locationsById);
    const room = path[0];
    const section = path.find(
      (node) =>
        node.parentId === room?.id &&
        inferIoioLocationKind(node, locationsById) === "Sections"
    );
    updateParams({
      selectedLocation: location.id,
      room: room?.id ?? null,
      section: section?.id ?? null,
    });
    revealAllGroups();
    setSearch("");
  };

  const selectRoom = (room: IoioLocation) => {
    updateParams({ room: room.id, section: null, selectedLocation: room.id });
  };

  const selectSection = (section: IoioLocation) => selectLocation(section);
  const selectShelf = (shelf: IoioLocation) => selectLocation(shelf);

  const startCreate = (locationType: CreationType, parentId: string | null) => {
    setChoosingContainerShelf(false);
    const group: LevelGroup =
      locationType === "room"
        ? "rooms"
        : locationType === "section"
        ? "sections"
        : locationType === "shelf"
        ? "shelves"
        : "containers";
    setExpandedGroups((current) => new Set(current).add(group));
    setCreating({ locationType, parentId });
  };

  useEffect(() => {
    if (fetcher.state !== "idle") return;
    const created = fetcher.data?.success ? fetcher.data.location : undefined;
    if (!created || handledCreatedId.current === created.id) return;
    handledCreatedId.current = created.id;
    setLastCreatedLocationId(created.id);
    fetcher.reset();
  }, [fetcher]);

  const renderInlineForm = (
    locationType: CreationType,
    parentId: string | null
  ) => {
    if (
      !creating ||
      creating.locationType !== locationType ||
      (locationType !== "container" && creating.parentId !== parentId)
    )
      return null;
    const formParentId =
      locationType === "container" ? parentId : creating.parentId;
    return (
      <div className="my-2 rounded-md bg-gray-50 px-3 py-2">
        <InlineLocationForm
          key={`${creating.locationType}-${
            creating.parentId ?? "root"
          }-${lastCreatedLocationId}`}
          locationType={creating.locationType}
          parentId={formParentId}
          locations={locations}
          fetcher={fetcher}
          onCancel={() => setCreating(null)}
        />
      </div>
    );
  };

  const toggleLevel = (group: LevelGroup) =>
    toggleGroup(setExpandedGroups, group);

  const renderOptions = (
    items: IoioLocation[],
    selected: IoioLocation | null,
    onSelect: (item: IoioLocation) => void,
    includeCounts = false,
    emptyLabel = "No locations yet."
  ) =>
    items.length ? (
      <ul className="space-y-0.5">
        {items.map((location) => (
          <li key={location.id}>
            <LocationOption
              location={location}
              selected={location.id === selected?.id}
              onSelect={() => onSelect(location)}
              onMove={() => setMovingLocation(location)}
              assetCount={
                includeCounts
                  ? inventorySummary.containerAssetCounts[location.id] ?? 0
                  : undefined
              }
            />
          </li>
        ))}
      </ul>
    ) : (
      <p className="px-3 py-2 text-sm text-gray-500">{emptyLabel}</p>
    );

  const groups: Array<{
    id: LevelGroup;
    type: CreationType;
    parentId: string | null;
    disabled: boolean;
    prompt: string | null;
    items: IoioLocation[];
    selected: IoioLocation | null;
    onSelect: (location: IoioLocation) => void;
    onAdd: () => void;
    showCount?: boolean;
  }> = [
    {
      id: "rooms",
      type: "room",
      parentId: null,
      disabled: false,
      prompt: null,
      items: rooms,
      selected: selectedRoom,
      onSelect: selectRoom,
      onAdd: () => startCreate("room", null),
    },
    {
      id: "sections",
      type: "section",
      parentId: selectedRoom?.id ?? null,
      disabled: !selectedRoom,
      prompt: selectedRoom ? null : "Select a room first.",
      items: sections,
      selected: selectedSection,
      onSelect: selectSection,
      onAdd: () => selectedRoom && startCreate("section", selectedRoom.id),
    },
    {
      id: "shelves",
      type: "shelf",
      parentId: selectedSection?.id ?? null,
      disabled: !selectedSection,
      prompt: !selectedRoom
        ? "Select a room first."
        : selectedSection
        ? null
        : "Select a section first.",
      items: shelves,
      selected: selectedShelf,
      onSelect: selectShelf,
      onAdd: () => selectedSection && startCreate("shelf", selectedSection.id),
    },
    {
      id: "containers",
      type: "container",
      parentId: containerParentId,
      disabled: !selectedSection || shelves.length === 0,
      prompt: !selectedRoom
        ? "Select a room first."
        : !selectedSection
        ? "Select a section first."
        : null,
      items: containers,
      selected: selectedContainer,
      onSelect: selectLocation,
      onAdd: () => {
        if (!selectedSection || shelves.length === 0) return;
        if (selectedShelf) {
          startCreate("container", selectedShelf.id);
        } else if (shelves.length === 1) {
          startCreate("container", shelves[0]!.id);
        } else {
          setChoosingContainerShelf(true);
        }
      },
      showCount: true,
    },
  ];

  return (
    <div className="w-full max-w-4xl">
      <section aria-label="Location Explorer" className="min-w-0">
        <div className="relative mb-4">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-gray-400"
            aria-hidden="true"
          />
          <label htmlFor="location-explorer-search" className="sr-only">
            Search rooms, sections, shelves, or containers
          </label>
          <input
            id="location-explorer-search"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
            placeholder="Search rooms, sections, shelves or containers..."
            className="h-10 w-full rounded-lg border border-gray-200 bg-white px-10 text-sm shadow-sm placeholder:text-gray-400 focus:border-red-600 focus:outline-none focus:ring-2 focus:ring-red-100"
          />
          {search ? (
            <button
              type="button"
              aria-label="Clear location search"
              onClick={() => setSearch("")}
              className="absolute right-3 top-1/2 -translate-y-1/2 rounded p-1 text-gray-500 hover:bg-gray-100"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          ) : null}
        </div>

        {search.trim() ? (
          <div className="mb-4 rounded-lg border border-gray-200 bg-white p-2">
            {searchResults.length ? (
              <ul className="divide-y divide-gray-100">
                {searchResults.map((result) => {
                  const path = buildLocationPath(result, locationsById);
                  return (
                    <li key={result.id}>
                      <button
                        type="button"
                        onClick={() => selectLocation(result)}
                        className="flex w-full flex-col gap-0.5 rounded p-2 text-left hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-red-600 sm:flex-row sm:items-center sm:justify-between"
                      >
                        <span className="text-sm font-semibold text-gray-900">
                          {result.name}
                        </span>
                        <span className="truncate text-xs text-gray-500">
                          {path.map(({ name }) => name).join(" › ")}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="px-2 py-3 text-sm text-gray-500">
                No locations match “{search}”.
              </p>
            )}
          </div>
        ) : null}

        {selectedPathLabel ? (
          <p
            className="mb-3 truncate text-xs text-gray-500"
            aria-label="Selected path"
          >
            {selectedPathLabel}
          </p>
        ) : null}

        <div className="space-y-3">
          {groups.map((group) => {
            const expanded = expandedGroups.has(group.id);
            return (
              <section
                key={group.id}
                aria-label={group.id}
                className="rounded-md border border-gray-100 px-2"
              >
                <LevelHeader
                  label={group.id}
                  expanded={expanded}
                  onToggle={() => toggleLevel(group.id)}
                  onAdd={group.onAdd}
                  addDisabled={group.disabled}
                />
                {expanded ? (
                  <div className="py-1">
                    {renderInlineForm(group.type, group.parentId)}
                    {group.prompt ? (
                      <p className="px-3 py-2 text-sm text-gray-500">
                        {group.prompt}
                      </p>
                    ) : group.id === "containers" ? (
                      <>
                        {choosingContainerShelf ? (
                          <div
                            className="px-3 py-2"
                            aria-label="Choose a shelf"
                          >
                            <p className="mb-2 text-sm text-gray-600">
                              Choose a shelf for the new container.
                            </p>
                            <ul className="space-y-1">
                              {shelves.map((shelf) => (
                                <li key={shelf.id}>
                                  <button
                                    type="button"
                                    onClick={() =>
                                      startCreate("container", shelf.id)
                                    }
                                    className="text-sm text-red-700 underline-offset-2 hover:underline"
                                  >
                                    {shelf.name}
                                  </button>
                                </li>
                              ))}
                            </ul>
                            <button
                              type="button"
                              onClick={() => setChoosingContainerShelf(false)}
                              className="mt-2 text-sm text-gray-600 underline-offset-2 hover:underline"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : containers.length ? (
                          <div className="space-y-2">
                            {containersByShelf
                              .filter(
                                ({ containers: shelfContainers }) =>
                                  shelfContainers.length > 0
                              )
                              .map(({ shelf, containers: shelfContainers }) => (
                                <div key={shelf.id}>
                                  <h3 className="px-3 pt-2 text-xs font-medium text-gray-500">
                                    {shelf.name}
                                  </h3>
                                  {renderOptions(
                                    shelfContainers,
                                    selectedContainer,
                                    group.onSelect,
                                    group.showCount
                                  )}
                                </div>
                              ))}
                          </div>
                        ) : (
                          <p className="px-3 py-2 text-sm text-gray-500">
                            {shelves.length
                              ? "No containers in this section yet."
                              : "No containers yet."}
                          </p>
                        )}
                      </>
                    ) : (
                      renderOptions(
                        group.items,
                        group.selected,
                        group.onSelect,
                        group.showCount,
                        group.id === "shelves" ? "No shelves yet." : undefined
                      )
                    )}
                  </div>
                ) : null}
              </section>
            );
          })}
        </div>
      </section>
      <LocationMoveDialog
        location={movingLocation}
        locations={locations}
        open={movingLocation !== null}
        onOpenChange={(open) => {
          if (!open) setMovingLocation(null);
        }}
      />
    </div>
  );
}
