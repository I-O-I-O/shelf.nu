import { useEffect, useMemo, useState } from "react";
import type { Prisma } from "@prisma/client";
import { ChevronRight } from "lucide-react";
import ImageWithPreview from "~/components/image-with-preview/image-with-preview";
import { getEffectiveIoioLocationColor } from "~/components/location/ioio-location-colors";
import LocationQuickActions from "~/components/location/location-quick-actions";
import { Button } from "~/components/shared/button";
import { useSearchParams } from "~/hooks/search-params";
import type { LOCATION_LIST_INCLUDE } from "~/modules/location/service.server";
import { tw } from "~/utils/tw";

export type IoioLocation = Prisma.LocationGetPayload<{
  include: typeof LOCATION_LIST_INCLUDE;
}>;

export type LocationKind = "Rooms" | "Sections" | "Shelves" | "Containers";

const LOCATION_KINDS: LocationKind[] = [
  "Rooms",
  "Sections",
  "Shelves",
  "Containers",
];

export function formatIoioLocationName(name: string) {
  return { label: name, code: null };
}

export function formatIoioRoomHeader(name: string) {
  return name;
}

export function sortIoioLocations(locations: IoioLocation[]) {
  return [...locations].sort((left, right) => {
    const leftDisplay = formatIoioLocationName(left.name);
    const rightDisplay = formatIoioLocationName(right.name);
    return `${leftDisplay.label} ${leftDisplay.code ?? ""}`.localeCompare(
      `${rightDisplay.label} ${rightDisplay.code ?? ""}`,
      undefined,
      { numeric: true, sensitivity: "base" }
    );
  });
}

/**
 * Keeps the existing four-level grouping helper available to presentation
 * checks. The interactive UI below uses the actual parent tree so it never
 * renders unrelated descendants under a room.
 */
export function groupIoioLocations(locations: IoioLocation[]) {
  const groups = new Map<LocationKind, IoioLocation[]>(
    LOCATION_KINDS.map((kind) => [kind, []])
  );

  for (const location of locations) {
    groups.get(inferLocationKind(location, locations))?.push(location);
  }

  return LOCATION_KINDS.map((kind) => ({
    kind,
    locations: sortIoioLocations(groups.get(kind) ?? []),
  }));
}

function inferLocationKind(
  location: IoioLocation,
  locations: IoioLocation[]
): LocationKind {
  if (!location.parentId) return "Rooms";

  const parent = locations.find(
    (candidate) => candidate.id === location.parentId
  );
  const name = location.name.toLocaleLowerCase();
  const parentName = parent?.name.toLocaleLowerCase() ?? "";

  if (name.includes("container") || parentName.includes("shelf")) {
    return "Containers";
  }
  if (name.includes("shelf") || parentName.includes("section")) {
    return "Shelves";
  }
  if (name.includes("section") || parent?.parentId == null) {
    return "Sections";
  }

  return "Shelves";
}

function parentLabel(location: IoioLocation) {
  if (!location.parent) return null;
  const parent = formatIoioLocationName(location.parent.name);
  return parent.code ? `${parent.label} / ${parent.code}` : parent.label;
}

function LocationActions({ location }: { location: IoioLocation }) {
  return (
    <LocationQuickActions
      location={{
        id: location.id,
        name: location.name,
        childCount: location._count.children,
      }}
      className="shrink-0"
    />
  );
}

function LocationCard({
  location,
  locationsById,
  selected,
  onSelect,
}: {
  location: IoioLocation;
  locationsById: Map<string, IoioLocation>;
  selected?: boolean;
  onSelect?: () => void;
}) {
  const display = formatIoioLocationName(location.name);
  const parent = parentLabel(location);
  const locationColor = getEffectiveIoioLocationColor({
    location,
    locations: [...locationsById.values()],
  });

  return (
    <article
      className={tw(
        "flex h-full flex-col rounded-xl border border-l-4 bg-white p-4",
        selected ? "ring-2" : ""
      )}
      style={{
        borderLeftColor: locationColor.color,
        ...(selected
          ? { boxShadow: `0 0 0 2px ${locationColor.softBackground}` }
          : {}),
      }}
    >
      <div className="flex min-w-0 items-start gap-3">
        <ImageWithPreview
          className="size-12 shrink-0 rounded-lg"
          imageUrl={location.imageUrl ?? undefined}
          thumbnailUrl={location.thumbnailUrl}
          alt={location.name}
          withPreview
        />
        <div className="min-w-0 flex-1">
          {onSelect ? (
            <button
              type="button"
              onClick={onSelect}
              aria-pressed={selected}
              className="block w-full overflow-hidden whitespace-normal break-words text-left text-sm font-bold leading-5 text-gray-950 [-webkit-box-orient:vertical] [-webkit-line-clamp:2] [display:-webkit-box] hover:text-red-800"
            >
              {display.label}
            </button>
          ) : (
            <Button
              to={`/assets?location=${encodeURIComponent(location.id)}`}
              variant="link"
              className="block w-full overflow-hidden whitespace-normal break-words p-0 text-left text-sm font-bold leading-5 text-gray-950 [-webkit-box-orient:vertical] [-webkit-line-clamp:2] [display:-webkit-box] hover:text-red-800"
            >
              {display.label}
            </Button>
          )}
          {display.code ? (
            <p
              className="mt-0.5 text-[11px] font-semibold uppercase tracking-wide"
              style={{ color: locationColor.text }}
            >
              {display.code}
            </p>
          ) : null}
          {parent ? (
            <p className="mt-1 overflow-hidden break-words text-xs leading-4 text-gray-600 [-webkit-box-orient:vertical] [-webkit-line-clamp:2] [display:-webkit-box]">
              Parent: {parent}
            </p>
          ) : null}
        </div>
      </div>
      <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-gray-100 pt-3 text-[11px] text-gray-500">
        <span>{location._count.assetLocations} assets</span>
        <span>{location._count.kits} kits</span>
      </div>
      <div className="mt-3 flex min-h-9 justify-end">
        <LocationActions location={location} />
      </div>
    </article>
  );
}

function Breadcrumbs({
  path,
  locationsById,
  onSelect,
}: {
  path: IoioLocation[];
  locationsById: Map<string, IoioLocation>;
  onSelect: (location: IoioLocation | null) => void;
}) {
  return (
    <nav
      aria-label="Location hierarchy"
      className="flex flex-wrap items-center gap-1 text-sm"
    >
      <button
        type="button"
        onClick={() => onSelect(null)}
        className="font-semibold text-red-800 hover:text-red-950"
      >
        Rooms
      </button>
      {path.map((location, index) => {
        const display = formatIoioLocationName(location.name);
        const isLast = index === path.length - 1;
        const locationColor = getEffectiveIoioLocationColor({
          location,
          locations: [...locationsById.values()],
        });
        return (
          <span key={location.id} className="inline-flex items-center gap-1">
            <ChevronRight className="size-3 text-gray-400" aria-hidden="true" />
            {isLast ? (
              <span
                className="rounded px-1 font-semibold"
                style={{
                  color: locationColor.text,
                  backgroundColor: locationColor.softBackground,
                }}
              >
                {display.label}
              </span>
            ) : (
              <button
                type="button"
                onClick={() => onSelect(locationsById.get(location.id) ?? null)}
                className="font-semibold text-red-800 hover:text-red-950"
              >
                {display.label}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
}

function LevelHeading({ kind, count }: { kind: LocationKind; count: number }) {
  return (
    <div className="mb-3 flex items-center gap-2">
      <h3 className="text-base font-bold text-gray-950">{kind}</h3>
      <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-600">
        {count}
      </span>
    </div>
  );
}

export function IoioLocationHierarchy({
  locations,
  initialSelectedId,
}: {
  locations: IoioLocation[];
  initialSelectedId?: string | null;
}) {
  const [, setSearchParams] = useSearchParams();
  const [selectedId, setSelectedId] = useState<string | null>(
    initialSelectedId ?? null
  );
  useEffect(() => {
    setSelectedId(initialSelectedId ?? null);
  }, [initialSelectedId]);
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
      children.set(location.parentId, current);
    }
    for (const [parentId, values] of children) {
      children.set(parentId, sortIoioLocations(values));
    }
    return children;
  }, [locations]);

  const rooms = useMemo(
    () => sortIoioLocations(locations.filter((location) => !location.parentId)),
    [locations]
  );
  const selected = selectedId ? locationsById.get(selectedId) ?? null : null;
  const path = useMemo(() => {
    const result: IoioLocation[] = [];
    let current = selected;
    while (current) {
      result.unshift(current);
      current = current.parentId
        ? locationsById.get(current.parentId) ?? null
        : null;
    }
    return result;
  }, [locationsById, selected]);
  const selectedChildren = selected
    ? childrenByParentId.get(selected.id) ?? []
    : [];
  const childGroups = LOCATION_KINDS.slice(1)
    .map((kind) => ({
      kind,
      locations: selectedChildren.filter(
        (location) => inferLocationKind(location, locations) === kind
      ),
    }))
    .filter((group) => group.locations.length > 0);

  const selectLocation = (location: IoioLocation | null) => {
    const nextSelectedId = location?.id ?? null;
    setSelectedId(nextSelectedId);
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      if (nextSelectedId) {
        next.set("selectedLocation", nextSelectedId);
      } else {
        next.delete("selectedLocation");
      }
      return next;
    });
  };

  return (
    <div className="space-y-6">
      <section aria-labelledby="ioio-location-rooms">
        <LevelHeading kind="Rooms" count={rooms.length} />
        {rooms.length ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {rooms.map((room) => (
              <LocationCard
                key={room.id}
                location={room}
                locationsById={locationsById}
                selected={room.id === selectedId}
                onSelect={() => selectLocation(room)}
              />
            ))}
          </div>
        ) : (
          <p className="rounded-xl border border-dashed border-gray-200 bg-white px-4 py-5 text-sm text-gray-500">
            No rooms found.
          </p>
        )}
      </section>

      {selected ? (
        <section
          aria-labelledby="ioio-location-selected"
          className="rounded-2xl border border-gray-200 bg-gray-50/60 p-4 md:p-5"
        >
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <Breadcrumbs
                path={path}
                locationsById={locationsById}
                onSelect={selectLocation}
              />
              <h2 id="ioio-location-selected" className="sr-only">
                Selected location hierarchy
              </h2>
            </div>
            <Button
              to={`/assets?location=${encodeURIComponent(selected.id)}`}
              variant="secondary"
              size="sm"
            >
              View inventory
            </Button>
          </div>

          {childGroups.length ? (
            <div className="space-y-5">
              {childGroups.map(({ kind, locations: group }) => (
                <div key={kind}>
                  <LevelHeading kind={kind} count={group.length} />
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {group.map((location) => (
                      <LocationCard
                        key={location.id}
                        location={location}
                        locationsById={locationsById}
                        selected={location.id === selectedId}
                        onSelect={() => selectLocation(location)}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-gray-600">
              No child locations. Assets can be placed directly here.
            </p>
          )}
        </section>
      ) : null}
    </div>
  );
}
