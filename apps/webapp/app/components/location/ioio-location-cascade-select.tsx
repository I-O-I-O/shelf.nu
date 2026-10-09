import { useMemo, useState } from "react";
import type { Location } from "@prisma/client";
import type { ModelFilterItem } from "~/hooks/use-model-filters";
import DynamicSelect from "../dynamic-select/dynamic-select";

export type IoioLocationOption = Pick<Location, "id" | "name" | "parentId">;
type LocationOption = IoioLocationOption;

type Selection = {
  roomId?: string;
  sectionId?: string;
  shelfId?: string;
  containerId?: string;
};

export type IoioLocationCreationType = "section" | "shelf" | "container";

type Props = {
  locations: LocationOption[];
  value?: string | null;
  fieldName: string;
  disabled?: boolean;
  required?: boolean;
  error?: string;
  onChange?: (value: string | undefined) => void;
};

const locationNames = (name: string) => {
  const match = name.match(/^([A-Z]\d{3})\s+(?:—|-|–)\s+(.+)$/u);
  return match ? `${match[2]} - ${match[1]}` : name;
};

const renderLocation = (item: ModelFilterItem) => (
  <span className="truncate text-sm font-medium">
    {locationNames(item.name)}
  </span>
);

function getLocationPath(
  locationsById: Map<string, LocationOption>,
  locationId?: string | null
): LocationOption[] {
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

function inferLocationKind(
  location: LocationOption,
  locationsById: Map<string, LocationOption>
) {
  if (!location.parentId) return "room";

  const parent = locationsById.get(location.parentId);
  const name = location.name.toLocaleLowerCase();
  const parentName = parent?.name.toLocaleLowerCase() ?? "";

  if (
    name.includes("container") ||
    name.includes("box") ||
    parentName.includes("shelf")
  ) {
    return "container";
  }
  if (name.includes("shelf") || parentName.includes("section")) {
    return "shelf";
  }
  if (name.includes("section") || parent?.parentId == null) {
    return "section";
  }

  return "shelf";
}

export function IoioLocationCascadeSelect({
  locations,
  value,
  fieldName,
  disabled = false,
  required = false,
  error,
  onChange,
}: Props) {
  const locationsById = useMemo(
    () => new Map(locations.map((location) => [location.id, location])),
    [locations]
  );
  const childrenByParentId = useMemo(() => {
    const children = new Map<string, LocationOption[]>();
    for (const location of locations) {
      if (!location.parentId) continue;
      const siblings = children.get(location.parentId) ?? [];
      siblings.push(location);
      children.set(location.parentId, siblings);
    }
    return children;
  }, [locations]);
  const allLocationIds = useMemo(
    () => locations.map((location) => location.id),
    [locations]
  );
  const initialPath = useMemo(
    () => getLocationPath(locationsById, value),
    [locationsById, value]
  );
  const [selection, setSelection] = useState<Selection>(() => ({
    roomId: initialPath[0]?.id,
    sectionId: initialPath[1]?.id,
    shelfId: initialPath[2]?.id,
    containerId: initialPath[3]?.id,
  }));

  const rooms = useMemo(
    () => locations.filter((location) => !location.parentId),
    [locations]
  );
  const sections = selection.roomId
    ? childrenByParentId.get(selection.roomId) ?? []
    : [];
  const shelves = selection.sectionId
    ? childrenByParentId.get(selection.sectionId) ?? []
    : [];
  const containers = selection.shelfId
    ? childrenByParentId.get(selection.shelfId) ?? []
    : [];
  const cascadeTriggerClassName =
    "flex flex-col !items-stretch !gap-1 [&_.inner-label]:w-full [&_.inner-label]:text-left";

  const excludedIds = (allowed: LocationOption[]) => {
    const allowedIds = new Set(allowed.map((location) => location.id));
    return allLocationIds.filter((id) => !allowedIds.has(id));
  };

  const selectedLocationId =
    selection.containerId ??
    selection.shelfId ??
    selection.sectionId ??
    selection.roomId;

  const updateSelection = (next: Selection) => {
    setSelection(next);
    onChange?.(
      next.containerId ?? next.shelfId ?? next.sectionId ?? next.roomId
    );
  };

  return (
    <div className="flex w-full flex-col gap-2">
      <DynamicSelect
        key="ioio-room"
        fieldName="ioioRoomId"
        model={{ name: "location", queryKey: "name" }}
        contentLabel="Rooms"
        label="Pick a room"
        triggerWrapperClassName={cascadeTriggerClassName}
        required={required}
        defaultValue={selection.roomId}
        initialDataKey="locations"
        countKey="totalLocations"
        selectionMode="none"
        closeOnSelect
        resetSearchOnClose
        hideShowAll={false}
        excludeItems={excludedIds(rooms)}
        renderItem={renderLocation}
        disabled={disabled}
        onChange={(roomId) => updateSelection({ roomId: roomId || undefined })}
      />

      {selection.roomId ? (
        <DynamicSelect
          key={`ioio-section-${selection.roomId}`}
          fieldName="ioioSectionId"
          model={{ name: "location", queryKey: "name" }}
          contentLabel="Sections"
          label="Pick a section"
          triggerWrapperClassName={cascadeTriggerClassName}
          defaultValue={selection.sectionId}
          initialDataKey="locations"
          countKey="totalLocations"
          selectionMode="none"
          closeOnSelect
          resetSearchOnClose
          hideShowAll={false}
          excludeItems={excludedIds(sections)}
          renderItem={renderLocation}
          disabled={disabled}
          onChange={(sectionId) =>
            updateSelection({
              roomId: selection.roomId,
              sectionId: sectionId || undefined,
            })
          }
        />
      ) : null}

      <DynamicSelect
        key={`ioio-shelf-${selection.sectionId ?? "empty"}`}
        fieldName="ioioShelfId"
        model={{ name: "location", queryKey: "name" }}
        contentLabel="Shelves"
        label="Pick a shelf"
        triggerWrapperClassName={cascadeTriggerClassName}
        defaultValue={selection.shelfId}
        initialDataKey="locations"
        countKey="totalLocations"
        selectionMode="none"
        closeOnSelect
        resetSearchOnClose
        hideShowAll={false}
        excludeItems={excludedIds(shelves)}
        renderItem={renderLocation}
        disabled={disabled || !selection.sectionId}
        onChange={(shelfId) =>
          updateSelection({
            roomId: selection.roomId,
            sectionId: selection.sectionId,
            shelfId: shelfId || undefined,
          })
        }
      />

      {containers.length > 0 ? (
        <DynamicSelect
          fieldName="ioioContainerId"
          model={{ name: "location", queryKey: "name" }}
          contentLabel="Containers"
          label="Pick a container (optional)"
          triggerWrapperClassName={cascadeTriggerClassName}
          defaultValue={selection.containerId}
          initialDataKey="locations"
          countKey="totalLocations"
          selectionMode="none"
          closeOnSelect
          resetSearchOnClose
          hideShowAll={false}
          allowClear
          excludeItems={excludedIds(containers)}
          renderItem={renderLocation}
          disabled={disabled || !selection.shelfId}
          onChange={(containerId) =>
            updateSelection({
              roomId: selection.roomId,
              sectionId: selection.sectionId,
              shelfId: selection.shelfId,
              containerId: containerId || undefined,
            })
          }
        />
      ) : null}

      <input type="hidden" name={fieldName} value={selectedLocationId ?? ""} />
      {error ? <p className="text-sm text-error-500">{error}</p> : null}
    </div>
  );
}

type ParentPickerProps = {
  locations: LocationOption[];
  type: IoioLocationCreationType;
  fixedRoomId?: string;
  value?: string | null;
  excludeIds?: string[];
  disabled?: boolean;
  error?: string;
  hideParentInput?: boolean;
  onChange?: (value: string | undefined) => void;
};

/**
 * Parent picker for the IOIO New location flow. It deliberately shares the
 * same DynamicSelect controls and path logic as asset creation, while allowing
 * a shelf to be placed directly under a room when that is the real hierarchy.
 */
export function IoioLocationParentPicker({
  locations,
  type,
  fixedRoomId,
  value,
  excludeIds = [],
  disabled = false,
  error,
  hideParentInput = false,
  onChange,
}: ParentPickerProps) {
  const locationsById = useMemo(
    () => new Map(locations.map((location) => [location.id, location])),
    [locations]
  );
  const childrenByParentId = useMemo(() => {
    const children = new Map<string, LocationOption[]>();
    for (const location of locations) {
      if (!location.parentId) continue;
      const siblings = children.get(location.parentId) ?? [];
      siblings.push(location);
      children.set(location.parentId, siblings);
    }
    return children;
  }, [locations]);
  const allLocationIds = useMemo(
    () => locations.map((location) => location.id),
    [locations]
  );
  const initialPath = useMemo(
    () => getLocationPath(locationsById, value),
    [locationsById, value]
  );
  const [selection, setSelection] = useState<Selection>(() => ({
    roomId: fixedRoomId ?? initialPath[0]?.id,
    sectionId:
      initialPath[1] &&
      inferLocationKind(initialPath[1], locationsById) === "section"
        ? initialPath[1].id
        : undefined,
    shelfId:
      initialPath[2]?.id ??
      (initialPath[1] &&
      inferLocationKind(initialPath[1], locationsById) === "shelf"
        ? initialPath[1].id
        : undefined),
  }));

  const rooms = useMemo(
    () => locations.filter((location) => !location.parentId),
    [locations]
  );
  const roomId = fixedRoomId ?? selection.roomId;
  const roomChildren = roomId ? childrenByParentId.get(roomId) ?? [] : [];
  const sections = roomChildren.filter(
    (location) => inferLocationKind(location, locationsById) === "section"
  );
  const selectedSection = sections.find(
    (section) => section.id === selection.sectionId
  );
  const directShelves = roomChildren.filter(
    (location) => inferLocationKind(location, locationsById) === "shelf"
  );
  const allowsDirectShelf =
    type === "shelf" || (type === "container" && directShelves.length > 0);
  const shelves = selectedSection
    ? // In this hierarchy a Section's direct children are its shelves. Keep this
      // relationship-based so shelf names do not control whether the selector is
      // enabled or which records are offered.
      childrenByParentId.get(selectedSection.id) ?? []
    : type === "container" && roomId
    ? directShelves
    : [];
  const selectedParentId =
    type === "section"
      ? roomId
      : type === "shelf"
      ? selection.sectionId ?? roomId
      : selection.shelfId;
  const cascadeTriggerClassName =
    "flex flex-col !items-stretch !gap-1 [&_.inner-label]:w-full [&_.inner-label]:text-left";

  const excludedIds = (allowed: LocationOption[]) => {
    const allowedSet = new Set(allowed.map((location) => location.id));
    return allLocationIds.filter(
      (id) => excludeIds.includes(id) || !allowedSet.has(id)
    );
  };

  const updateSelection = (next: Selection) => {
    setSelection(next);
    const nextRoomId = fixedRoomId ?? next.roomId;
    const nextParentId =
      type === "section"
        ? nextRoomId
        : type === "shelf"
        ? next.sectionId ?? nextRoomId
        : next.shelfId;
    onChange?.(nextParentId);
  };

  return (
    <div className="flex w-full flex-col gap-2">
      {fixedRoomId ? null : (
        <DynamicSelect
          key="ioio-create-room"
          fieldName="ioioParentRoomId"
          model={{ name: "location", queryKey: "name" }}
          contentLabel="Rooms"
          label="Pick a room"
          triggerWrapperClassName={cascadeTriggerClassName}
          defaultValue={selection.roomId}
          initialDataKey="locations"
          countKey="totalLocations"
          selectionMode="none"
          closeOnSelect
          resetSearchOnClose
          hideShowAll={false}
          excludeItems={excludedIds(rooms)}
          renderItem={renderLocation}
          disabled={disabled}
          onChange={(nextRoomId) =>
            updateSelection({
              roomId: rooms.some((room) => room.id === nextRoomId)
                ? nextRoomId
                : undefined,
            })
          }
        />
      )}

      {type !== "section" && roomId && sections.length > 0 ? (
        <DynamicSelect
          key={`ioio-create-section-${roomId}`}
          fieldName="ioioParentSectionId"
          model={{ name: "location", queryKey: "name" }}
          contentLabel="Sections"
          label={
            type === "shelf"
              ? "Pick a section (optional for direct room placement)"
              : allowsDirectShelf
              ? "Pick a section (optional for direct shelf placement)"
              : "Pick a section"
          }
          triggerWrapperClassName={cascadeTriggerClassName}
          defaultValue={selection.sectionId}
          initialDataKey="locations"
          countKey="totalLocations"
          selectionMode="none"
          closeOnSelect
          resetSearchOnClose
          hideShowAll={false}
          allowClear={allowsDirectShelf}
          withoutValueItem={
            allowsDirectShelf
              ? {
                  id: "no-section",
                  name:
                    type === "container"
                      ? "Choose a shelf directly in room"
                      : "Place directly in room",
                }
              : undefined
          }
          excludeItems={excludedIds(sections)}
          renderItem={renderLocation}
          disabled={disabled}
          onChange={(sectionId) =>
            updateSelection({
              roomId,
              sectionId:
                sectionId &&
                sectionId !== "no-section" &&
                sections.some((section) => section.id === sectionId)
                  ? sectionId
                  : undefined,
              shelfId: undefined,
            })
          }
        />
      ) : null}

      {type === "container" ? (
        <>
          <DynamicSelect
            key={`ioio-create-shelf-${
              selection.sectionId ?? roomId ?? "empty"
            }`}
            fieldName="ioioParentShelfId"
            model={{ name: "location", queryKey: "name" }}
            contentLabel="Shelves"
            label="Pick a shelf"
            triggerWrapperClassName={cascadeTriggerClassName}
            defaultValue={
              shelves.some((shelf) => shelf.id === selection.shelfId)
                ? selection.shelfId
                : undefined
            }
            initialDataKey="locations"
            countKey="totalLocations"
            selectionMode="none"
            closeOnSelect
            resetSearchOnClose
            hideShowAll={false}
            excludeItems={excludedIds(shelves)}
            renderItem={renderLocation}
            disabled={disabled || shelves.length === 0}
            onChange={(shelfId) =>
              updateSelection({
                roomId,
                sectionId: selectedSection?.id,
                shelfId: shelves.some((shelf) => shelf.id === shelfId)
                  ? shelfId
                  : undefined,
              })
            }
          />
          {selection.sectionId && shelves.length === 0 ? (
            <p role="status" className="text-sm text-gray-600">
              No shelves in this section.
            </p>
          ) : null}
        </>
      ) : null}

      {hideParentInput ? null : (
        <input type="hidden" name="parentId" value={selectedParentId ?? ""} />
      )}
      {error ? <p className="text-sm text-error-500">{error}</p> : null}
    </div>
  );
}

type PlacementPickerProps = {
  locations: LocationOption[];
  roomId: string;
  value?: string | null;
  disabled?: boolean;
  onChange?: (value: string | undefined) => void;
};

/** Optional room-to-container placement used before opening native Asset creation. */
export function IoioLocationPlacementPicker({
  locations,
  roomId,
  value,
  disabled = false,
  onChange,
}: PlacementPickerProps) {
  const locationsById = useMemo(
    () => new Map(locations.map((location) => [location.id, location])),
    [locations]
  );
  const childrenByParentId = useMemo(() => {
    const children = new Map<string, LocationOption[]>();
    for (const location of locations) {
      if (!location.parentId) continue;
      const siblings = children.get(location.parentId) ?? [];
      siblings.push(location);
      children.set(location.parentId, siblings);
    }
    return children;
  }, [locations]);
  const initialPath = useMemo(
    () => getLocationPath(locationsById, value),
    [locationsById, value]
  );
  const [selection, setSelection] = useState<Selection>(() => ({
    roomId,
    sectionId: initialPath[1]?.id,
    shelfId: initialPath[2]?.id,
    containerId: initialPath[3]?.id,
  }));
  const sections = childrenByParentId.get(roomId) ?? [];
  const shelfParentId =
    selection.sectionId ?? (sections.length === 0 ? roomId : undefined);
  const shelves = shelfParentId
    ? childrenByParentId.get(shelfParentId) ?? []
    : [];
  const containers = selection.shelfId
    ? childrenByParentId.get(selection.shelfId) ?? []
    : [];
  const selectedLocationId =
    selection.containerId ?? selection.shelfId ?? selection.sectionId ?? roomId;
  const selectedPath = getLocationPath(locationsById, selectedLocationId);
  const allLocationIds = useMemo(
    () => locations.map((location) => location.id),
    [locations]
  );
  const cascadeTriggerClassName =
    "flex flex-col !items-stretch !gap-1 [&_.inner-label]:w-full [&_.inner-label]:text-left";

  const excludedIds = (allowed: LocationOption[]) => {
    const allowedSet = new Set(allowed.map((location) => location.id));
    return allLocationIds.filter((id) => !allowedSet.has(id));
  };

  const updateSelection = (next: Selection) => {
    setSelection(next);
    onChange?.(next.containerId ?? next.shelfId ?? next.sectionId ?? roomId);
  };

  return (
    <div className="flex w-full flex-col gap-2">
      {sections.length > 0 ? (
        <DynamicSelect
          key={`ioio-placement-section-${roomId}`}
          fieldName="ioioPlacementSectionId"
          model={{ name: "location", queryKey: "name" }}
          contentLabel="Sections"
          label="Pick a section (optional)"
          triggerWrapperClassName={cascadeTriggerClassName}
          defaultValue={selection.sectionId}
          initialDataKey="locations"
          countKey="totalLocations"
          selectionMode="none"
          closeOnSelect
          resetSearchOnClose
          hideShowAll={false}
          allowClear
          withoutValueItem={{
            id: "no-placement-section",
            name: "Directly in room",
          }}
          excludeItems={excludedIds(sections)}
          renderItem={renderLocation}
          disabled={disabled}
          onChange={(sectionId) =>
            updateSelection({
              roomId,
              sectionId:
                sectionId && sectionId !== "no-placement-section"
                  ? sectionId
                  : undefined,
              shelfId: undefined,
              containerId: undefined,
            })
          }
        />
      ) : null}

      {shelves.length > 0 ? (
        <DynamicSelect
          key={`ioio-placement-shelf-${shelfParentId ?? "empty"}`}
          fieldName="ioioPlacementShelfId"
          model={{ name: "location", queryKey: "name" }}
          contentLabel="Shelves"
          label="Pick a shelf (optional)"
          triggerWrapperClassName={cascadeTriggerClassName}
          defaultValue={selection.shelfId}
          initialDataKey="locations"
          countKey="totalLocations"
          selectionMode="none"
          closeOnSelect
          resetSearchOnClose
          hideShowAll={false}
          allowClear
          excludeItems={excludedIds(shelves)}
          renderItem={renderLocation}
          disabled={disabled}
          onChange={(shelfId) =>
            updateSelection({
              roomId,
              sectionId: selection.sectionId,
              shelfId: shelfId || undefined,
              containerId: undefined,
            })
          }
        />
      ) : null}

      {containers.length > 0 ? (
        <DynamicSelect
          key={`ioio-placement-container-${selection.shelfId}`}
          fieldName="ioioPlacementContainerId"
          model={{ name: "location", queryKey: "name" }}
          contentLabel="Containers"
          label="Pick a container (optional)"
          triggerWrapperClassName={cascadeTriggerClassName}
          defaultValue={selection.containerId}
          initialDataKey="locations"
          countKey="totalLocations"
          selectionMode="none"
          closeOnSelect
          resetSearchOnClose
          hideShowAll={false}
          allowClear
          excludeItems={excludedIds(containers)}
          renderItem={renderLocation}
          disabled={disabled}
          onChange={(containerId) =>
            updateSelection({
              roomId,
              sectionId: selection.sectionId,
              shelfId: selection.shelfId,
              containerId: containerId || undefined,
            })
          }
        />
      ) : null}

      <p className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs text-gray-600">
        Placing under:{" "}
        {selectedPath
          .map((location) => locationNames(location.name))
          .join(" / ")}
      </p>
    </div>
  );
}
