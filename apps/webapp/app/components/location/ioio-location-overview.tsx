import type { Location } from "@prisma/client";
import { getEffectiveIoioLocationColor } from "~/components/location/ioio-location-colors";
import { Card } from "~/components/shared/card";

type LocationOption = Pick<Location, "id" | "name" | "parentId" | "color">;
type LocationLevel = "Sections" | "Shelves" | "Containers";
type CreationType = "section" | "shelf" | "container" | "item";

const levels: LocationLevel[] = ["Sections", "Shelves", "Containers"];

function normalizeName(name: string) {
  return name.trim().toLowerCase();
}

function formatLocationName(name: string) {
  return name;
}

function getPath(
  locationsById: Map<string, LocationOption>,
  locationId?: string
) {
  const path: LocationOption[] = [];
  const visited = new Set<string>();
  let current = locationId ? locationsById.get(locationId) : undefined;

  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    path.unshift(current);
    current = current.parentId
      ? locationsById.get(current.parentId)
      : undefined;
  }

  return path;
}

function inferLevel(
  location: LocationOption,
  locationsById: Map<string, LocationOption>
): LocationLevel {
  const name = location.name.toLowerCase();
  const parentName = location.parentId
    ? locationsById.get(location.parentId)?.name.toLowerCase() ?? ""
    : "";

  if (
    name.includes("container") ||
    name.startsWith("box ") ||
    parentName.includes("shelf")
  ) {
    return "Containers";
  }
  if (name.includes("shelf") || parentName.includes("section")) {
    return "Shelves";
  }
  if (name.includes("section") || location.parentId == null) {
    return "Sections";
  }
  return "Shelves";
}

function naturalSort(left: LocationOption, right: LocationOption) {
  return left.name.localeCompare(right.name, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

type Props = {
  locations: LocationOption[];
  roomId?: string;
  creationType?: CreationType;
  parentId?: string;
  itemLocationId?: string;
  candidateName?: string;
};

export function IoioLocationOverview({
  locations,
  roomId,
  creationType,
  parentId,
  itemLocationId,
  candidateName,
}: Props) {
  const locationsById = new Map(
    locations.map((location) => [location.id, location])
  );
  const room = roomId ? locationsById.get(roomId) : undefined;
  const roomColor = room
    ? getEffectiveIoioLocationColor({ location: room, locations })
    : null;
  const focusId =
    creationType === "item" ? itemLocationId ?? roomId : parentId ?? roomId;
  const focusPath = getPath(locationsById, focusId);
  const focusIds = new Set(focusPath.map((location) => location.id));
  const roomLocations = roomId
    ? locations.filter(
        (location) =>
          location.id !== roomId &&
          getPath(locationsById, location.id)[0]?.id === roomId
      )
    : [];
  const grouped = new Map<LocationLevel, LocationOption[]>(
    levels.map((level) => [level, []])
  );

  for (const location of roomLocations) {
    grouped.get(inferLevel(location, locationsById))?.push(location);
  }
  for (const level of levels) grouped.get(level)?.sort(naturalSort);

  const selectedParentId =
    creationType === "section"
      ? roomId
      : creationType === "shelf"
      ? parentId ?? roomId
      : creationType === "container"
      ? parentId
      : undefined;
  const duplicate =
    candidateName?.trim() && selectedParentId
      ? locations.find(
          (location) =>
            location.parentId === selectedParentId &&
            normalizeName(location.name) === normalizeName(candidateName)
        )
      : undefined;
  const focusedLocation = focusId ? locationsById.get(focusId) : undefined;
  const focusedLevel = focusedLocation
    ? inferLevel(focusedLocation, locationsById)
    : undefined;
  const canAdd =
    !roomId || !focusedLocation
      ? []
      : focusedLocation.id === roomId
      ? ["Section", "Shelf", "Individual item"]
      : focusedLevel === "Sections"
      ? ["Shelf", "Individual item"]
      : focusedLevel === "Shelves"
      ? ["Container", "Individual item"]
      : ["Individual item"];

  return (
    <Card className="my-0 w-full p-4 sm:p-5 lg:sticky lg:top-5">
      <div>
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-red-700">
          Location overview
        </p>
        <h2 className="mt-1 text-lg font-black tracking-tight text-gray-950">
          Current hierarchy
        </h2>
      </div>

      {room ? (
        <p
          className="mt-3 rounded-lg border px-3 py-2 text-sm font-bold"
          style={{
            backgroundColor: roomColor?.softBackground,
            borderColor: roomColor?.softBorder,
            color: roomColor?.text,
          }}
        >
          {formatLocationName(room.name)}
        </p>
      ) : (
        <p className="mt-3 text-sm text-gray-500">
          Select a room to see its current hierarchy.
        </p>
      )}

      {room ? (
        <div className="mt-4 space-y-3">
          {levels.map((level) => {
            const entries = grouped.get(level) ?? [];
            return (
              <details key={level} open>
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-xs font-bold uppercase tracking-wide text-gray-500 [&::-webkit-details-marker]:hidden">
                  <span>{level}</span>
                  <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[0.68rem] text-gray-600">
                    {entries.length}
                  </span>
                </summary>
                {entries.length ? (
                  <ul className="mt-1.5 space-y-1 border-l border-gray-200 pl-3">
                    {entries.map((location) => {
                      const locationColor = getEffectiveIoioLocationColor({
                        location,
                        locations,
                      });
                      return (
                        <li
                          key={location.id}
                          className={`rounded-md border-l-4 px-2 py-1 text-sm ${
                            focusIds.has(location.id)
                              ? "font-semibold"
                              : "text-gray-700"
                          }`}
                          style={{
                            borderLeftColor: locationColor.color,
                            ...(focusIds.has(location.id)
                              ? {
                                  backgroundColor: locationColor.softBackground,
                                  color: locationColor.text,
                                }
                              : {}),
                          }}
                        >
                          {location.name}
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="mt-1.5 pl-3 text-sm text-gray-400">None yet</p>
                )}
              </details>
            );
          })}
        </div>
      ) : null}

      {duplicate ? (
        <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-800">
          A location named {duplicate.name} already exists under this parent.
        </p>
      ) : null}

      {canAdd.length ? (
        <div className="mt-4 border-t border-gray-100 pt-3">
          <p className="text-xs font-bold uppercase tracking-wide text-gray-500">
            You can add
          </p>
          <p className="mt-1 text-sm font-semibold text-gray-800">
            {canAdd.join(" · ")}
          </p>
        </div>
      ) : null}
    </Card>
  );
}
