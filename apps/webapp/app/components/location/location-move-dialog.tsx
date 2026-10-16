import { useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useFetcher } from "react-router";
import {
  getIoioLocationDepth,
  getIoioLocationDescendantIds,
  getIoioLocationSubtreeDepth,
  getIoioMoveParentDepth,
  type IoioMoveLocationNode,
  type IoioMoveLocationType,
} from "~/modules/location/ioio-location-move";

type MoveResponse = {
  success?: boolean;
  location?: { id: string; name: string; parentId: string | null };
  error?: { message?: string };
};

type Props = {
  location: IoioMoveLocationNode | null;
  locations: IoioMoveLocationNode[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const locationTypes: Array<{ value: IoioMoveLocationType; label: string }> = [
  { value: "room", label: "Room" },
  { value: "section", label: "Section" },
  { value: "shelf", label: "Shelf" },
  { value: "container", label: "Container" },
];

function getLocationTypeForDepth(depth: number | null): IoioMoveLocationType {
  if (depth === 1) return "section";
  if (depth === 2) return "shelf";
  if (depth === 3) return "container";
  return "room";
}

function getLocationPathLabel(
  location: IoioMoveLocationNode,
  locationsById: Map<string, IoioMoveLocationNode>
) {
  const path: string[] = [];
  const visited = new Set<string>();
  let current: IoioMoveLocationNode | undefined = location;
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    path.unshift(current.name);
    current = current.parentId
      ? locationsById.get(current.parentId)
      : undefined;
  }
  return path.join(" / ");
}

export function LocationMoveDialog({
  location,
  locations,
  open,
  onOpenChange,
}: Props) {
  const fetcher = useFetcher<MoveResponse>();
  const resetFetcher = fetcher.reset;
  const fetcherState = fetcher.state;
  const fetcherData = fetcher.data;
  const [locationType, setLocationType] =
    useState<IoioMoveLocationType>("room");
  const [parentId, setParentId] = useState("");
  const locationsById = useMemo(
    () => new Map(locations.map((entry) => [entry.id, entry])),
    [locations]
  );
  const descendants = useMemo(
    () =>
      location
        ? getIoioLocationDescendantIds(location.id, locations)
        : new Set<string>(),
    [location, locations]
  );
  const subtreeDepth = location
    ? getIoioLocationSubtreeDepth(location.id, locations)
    : 0;
  const locationDepth = location
    ? getIoioLocationDepth(location.id, locations)
    : null;
  const initialParentId = location?.parentId ?? "";
  const destinationOptions = useMemo(() => {
    if (locationType === "room") return [];
    const expectedParentDepth = getIoioMoveParentDepth(locationType);
    return locations
      .filter((candidate) => {
        if (candidate.id === location?.id || descendants.has(candidate.id))
          return false;
        const depth = getIoioLocationDepth(candidate.id, locations);
        return depth === expectedParentDepth && depth + 1 + subtreeDepth <= 3;
      })
      .sort((left, right) =>
        getLocationPathLabel(left, locationsById).localeCompare(
          getLocationPathLabel(right, locationsById),
          undefined,
          { numeric: true, sensitivity: "base" }
        )
      );
  }, [
    descendants,
    location?.id,
    locationType,
    locations,
    locationsById,
    subtreeDepth,
  ]);

  useEffect(() => {
    if (!open || !location?.id) return;
    setLocationType(getLocationTypeForDepth(locationDepth));
    setParentId(initialParentId);
    resetFetcher();
  }, [open, location?.id, locationDepth, initialParentId, resetFetcher]);

  useEffect(() => {
    if (fetcherState !== "idle" || !fetcherData?.success) return;
    onOpenChange(false);
    resetFetcher();
  }, [fetcherState, fetcherData, onOpenChange, resetFetcher]);

  const isRoom = locationType === "room";
  const busy = fetcherState !== "idle";
  const canSubmit = Boolean(location && (isRoom || parentId));

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[100] bg-black/50 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[101] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg bg-white p-5 shadow-xl">
          <Dialog.Title className="text-lg font-semibold text-gray-900">
            Move “{location?.name}”
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-gray-500">
            Choose the hierarchy level and destination for this location.
          </Dialog.Description>

          {location ? (
            <fetcher.Form method="post" action="." className="mt-4 space-y-4">
              <input type="hidden" name="intent" value="move-location" />
              <input type="hidden" name="locationId" value={location.id} />
              <div>
                <label
                  htmlFor="move-location-type"
                  className="mb-1 block text-sm font-medium text-gray-700"
                >
                  Move as
                </label>
                <select
                  id="move-location-type"
                  name="locationType"
                  value={locationType}
                  onChange={(event) => {
                    const nextType = event.currentTarget
                      .value as IoioMoveLocationType;
                    setLocationType(nextType);
                    setParentId(
                      nextType ===
                        getLocationTypeForDepth(
                          getIoioLocationDepth(location.id, locations)
                        )
                        ? location.parentId ?? ""
                        : ""
                    );
                  }}
                  className="h-10 w-full rounded-md border border-gray-300 bg-white px-3 text-sm focus:border-red-600 focus:outline-none focus:ring-2 focus:ring-red-100"
                >
                  {locationTypes.map((type) => {
                    const expectedParentDepth = getIoioMoveParentDepth(
                      type.value
                    );
                    const hasDestination =
                      type.value === "room" ||
                      locations.some(
                        (candidate) =>
                          candidate.id !== location.id &&
                          !descendants.has(candidate.id) &&
                          getIoioLocationDepth(candidate.id, locations) ===
                            expectedParentDepth &&
                          (expectedParentDepth ?? -1) + 1 + subtreeDepth <= 3
                      );
                    const exceedsDepth =
                      (expectedParentDepth ?? -1) + 1 + subtreeDepth > 3;
                    return (
                      <option
                        key={type.value}
                        value={type.value}
                        disabled={!hasDestination || exceedsDepth}
                      >
                        {type.label}
                      </option>
                    );
                  })}
                </select>
              </div>

              {!isRoom ? (
                <div>
                  <label
                    htmlFor="move-location-parent"
                    className="mb-1 block text-sm font-medium text-gray-700"
                  >
                    Destination
                  </label>
                  <select
                    id="move-location-parent"
                    name="parentId"
                    value={parentId}
                    onChange={(event) => setParentId(event.currentTarget.value)}
                    required
                    className="h-10 w-full rounded-md border border-gray-300 bg-white px-3 text-sm focus:border-red-600 focus:outline-none focus:ring-2 focus:ring-red-100"
                  >
                    <option value="">Select a destination</option>
                    {destinationOptions.map((option) => (
                      <option key={option.id} value={option.id}>
                        {getLocationPathLabel(option, locationsById)}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}

              {fetcherData?.error?.message ? (
                <p role="alert" className="text-sm text-red-700">
                  {fetcherData.error.message}
                </p>
              ) : null}

              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => onOpenChange(false)}
                  className="rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!canSubmit || busy}
                  className="rounded-md bg-red-700 px-3 py-2 text-sm font-semibold text-white hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busy ? "Moving…" : "Move"}
                </button>
              </div>
            </fetcher.Form>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
