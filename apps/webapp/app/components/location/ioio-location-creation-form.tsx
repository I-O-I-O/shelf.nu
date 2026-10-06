import { useEffect, useMemo, useState } from "react";
import type { Location } from "@prisma/client";
import { useAtom, useAtomValue } from "jotai";
import { useActionData, useNavigation } from "react-router";
import { fileErrorAtom, assetImageValidateFileAtom } from "~/atoms/file";
import { Form } from "~/components/custom-form";
import Input from "~/components/forms/input";
import { IoioImagePicker } from "~/components/ioio/ioio-image-picker";
import {
  IoioLocationParentPicker,
  IoioLocationPlacementPicker,
} from "~/components/location/ioio-location-cascade-select";
import {
  getFirstAvailableLocationColor,
  getUsedSiblingColors,
  IoioLocationColorPicker,
} from "~/components/location/ioio-location-color-picker";
import {
  getEffectiveIoioLocationColor,
  getIoioLocationColor,
} from "~/components/location/ioio-location-colors";
import { IoioLocationOverview } from "~/components/location/ioio-location-overview";
import { Button } from "~/components/shared/button";
import { Card } from "~/components/shared/card";
import { Spinner } from "~/components/shared/spinner";
import { ACCEPT_SUPPORTED_IMAGES } from "~/utils/constants";
import { isFormProcessing } from "~/utils/form";

type LocationOption = Pick<Location, "id" | "name" | "parentId" | "color">;
type CreationType = "section" | "shelf" | "container";

const CHILD_TYPES: Array<{
  value: CreationType | "item";
  label: string;
  description: string;
}> = [
  {
    value: "section",
    label: "Section",
    description: "Add a named area inside this room",
  },
  {
    value: "shelf",
    label: "Shelf",
    description: "Add a shelf directly or inside a section",
  },
  {
    value: "container",
    label: "Box / Container",
    description: "Add a box on a shelf",
  },
  {
    value: "item",
    label: "Individual item",
    description: "Open native Asset creation with a placement",
  },
];

type Props = {
  locations: LocationOption[];
};

type ActionData = {
  error?: { message?: string };
};

function displayLocation(location?: LocationOption) {
  return location?.name ?? "";
}

export function IoioLocationCreationForm({ locations }: Props) {
  const [roomId, setRoomId] = useState<string>();
  const [creationType, setCreationType] = useState<CreationType | "item">();
  const [parentId, setParentId] = useState<string>();
  const [itemLocationId, setItemLocationId] = useState<string>();
  const [locationName, setLocationName] = useState("");
  const [locationColor, setLocationColor] = useState(
    getFirstAvailableLocationColor({
      locations,
      parentId: null,
      locationType: "room",
    })
  );
  const [isCreatingRoom, setIsCreatingRoom] = useState(false);
  const [isChoosingRoom, setIsChoosingRoom] = useState(false);
  const navigation = useNavigation();
  const actionData = useActionData<ActionData>();
  const fileError = useAtomValue(fileErrorAtom);
  const [, validateFile] = useAtom(assetImageValidateFileAtom);
  const disabled = isFormProcessing(navigation.state);
  const room = useMemo(
    () => locations.find((location) => location.id === roomId),
    [locations, roomId]
  );
  const roomColor = room
    ? getIoioLocationColor({
        name: room.name,
        isRoom: true,
        color: room.color,
      })
    : null;
  const selectedChildType = CHILD_TYPES.find(
    (option) => option.value === creationType
  );
  const activeCreationType = creationType === "item" ? undefined : creationType;
  const colorParentId =
    activeCreationType === "section"
      ? roomId
      : activeCreationType === "shelf" || activeCreationType === "container"
      ? parentId
      : null;
  const inheritedColor = getEffectiveIoioLocationColor({
    locations,
    parentId: colorParentId,
    locationType: activeCreationType,
  });

  useEffect(() => {
    const usedSiblingColors = getUsedSiblingColors({
      locations,
      parentId: colorParentId,
      locationType: activeCreationType,
    });
    if (
      activeCreationType === "section" &&
      usedSiblingColors.has(locationColor.toLocaleLowerCase())
    ) {
      setLocationColor(
        getFirstAvailableLocationColor({
          locations,
          parentId: colorParentId,
          locationType: activeCreationType,
        })
      );
    }
    if (activeCreationType && activeCreationType !== "section") {
      setLocationColor(inheritedColor.color);
    }
  }, [
    activeCreationType,
    colorParentId,
    inheritedColor.color,
    locationColor,
    locations,
  ]);

  const selectRoom = (nextRoomId?: string) => {
    if (!nextRoomId) return;
    setRoomId(nextRoomId);
    // The room is the stable part of this flow. A room change invalidates the
    // old descendants, but it should not make staff choose the operation again.
    setParentId(undefined);
    setItemLocationId(nextRoomId);
    setLocationColor(
      getFirstAvailableLocationColor({
        locations,
        parentId: null,
        locationType: "room",
      })
    );
    setIsChoosingRoom(false);
  };

  return (
    <div className="mx-auto my-6 grid w-full max-w-6xl items-start gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(15rem,1fr)]">
      <Card className="my-0 w-full max-w-none p-5 sm:p-6">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold text-gray-950">New location</h1>
            <p className="mt-1 text-sm text-gray-600">
              Choose a room first, then add the next level where it belongs.
            </p>
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="shrink-0"
            disabled={disabled || isCreatingRoom}
            onClick={() => setIsCreatingRoom(true)}
          >
            New room
          </Button>
        </div>

        {actionData?.error?.message ? (
          <p
            role="alert"
            className="mb-5 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-800"
          >
            {actionData.error.message}
          </p>
        ) : null}

        {isCreatingRoom ? (
          <Form
            method="post"
            encType="multipart/form-data"
            className="space-y-6"
          >
            <input type="hidden" name="locationType" value="room" />
            <input type="hidden" name="color" value={locationColor} />
            <div className="rounded-xl border border-gray-200 bg-gray-50/60 p-4 sm:p-5">
              <div className="mb-4">
                <h2 className="text-base font-semibold text-gray-950">
                  New room
                </h2>
                <p className="mt-1 text-xs text-gray-600">
                  A room is a top-level Shelf Location.
                </p>
              </div>
              <Input
                label="Name"
                name="name"
                placeholder="IOIO Lab - B477"
                required
                disabled={disabled}
              />
              <div className="mt-4">
                <IoioLocationColorPicker
                  locations={locations}
                  parentId={null}
                  value={locationColor}
                  locationType="room"
                  name="roomColorPicker"
                  onChange={setLocationColor}
                />
              </div>
              <div className="mt-4">
                <p className="mb-2 text-sm font-semibold text-gray-900">
                  Main image
                </p>
                <IoioImagePicker
                  name="image"
                  accept={ACCEPT_SUPPORTED_IMAGES}
                  disabled={disabled}
                  uploading={disabled}
                  error={fileError}
                  onChange={validateFile}
                />
              </div>
            </div>
            <div className="flex flex-wrap justify-end gap-2 border-t border-gray-200 pt-4">
              <Button
                type="button"
                variant="secondary"
                disabled={disabled}
                onClick={() => setIsCreatingRoom(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={disabled}>
                {disabled ? <Spinner /> : "Create room"}
              </Button>
            </div>
          </Form>
        ) : (
          <Form
            method="post"
            encType="multipart/form-data"
            className="space-y-6"
          >
            <input
              type="hidden"
              name="locationType"
              value={activeCreationType ?? ""}
            />
            <input type="hidden" name="color" value={locationColor} />

            {!room ? (
              <div>
                <div className="mt-4">
                  <IoioLocationParentPicker
                    locations={locations}
                    type="section"
                    value={roomId}
                    disabled={disabled}
                    hideParentInput
                    onChange={selectRoom}
                  />
                </div>
              </div>
            ) : (
              <>
                <div className="rounded-xl border border-red-200 bg-red-50/60 p-4">
                  {isChoosingRoom ? (
                    <div>
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <p className="text-xs font-semibold uppercase tracking-wide text-red-800">
                            Change room
                          </p>
                          <p className="mt-1 text-sm text-gray-600">
                            Your selected type and entered name will stay in the
                            form.
                          </p>
                        </div>
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          onClick={() => setIsChoosingRoom(false)}
                          disabled={disabled}
                        >
                          Keep current room
                        </Button>
                      </div>
                      <div className="mt-4">
                        <IoioLocationParentPicker
                          locations={locations}
                          type="section"
                          value={roomId}
                          disabled={disabled}
                          hideParentInput
                          onChange={selectRoom}
                        />
                      </div>
                    </div>
                  ) : (
                    <div
                      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-2"
                      style={{
                        backgroundColor: roomColor?.softBackground,
                        borderColor: roomColor?.softBorder,
                      }}
                    >
                      <div>
                        <p
                          className="text-xs font-semibold uppercase tracking-wide"
                          style={{ color: roomColor?.text }}
                        >
                          Selected room
                        </p>
                        <p className="mt-1 text-base font-bold text-gray-950">
                          {displayLocation(room)}
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() => setIsChoosingRoom(true)}
                        disabled={disabled}
                      >
                        Change room
                      </Button>
                    </div>
                  )}
                </div>

                {!creationType ? (
                  <div>
                    <h2 className="text-base font-semibold text-gray-950">
                      What would you like to add?
                    </h2>
                    <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                      {CHILD_TYPES.map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          onClick={() => {
                            setCreationType(option.value);
                            setParentId(
                              option.value === "item" ? roomId : undefined
                            );
                            setItemLocationId(roomId);
                          }}
                          className="rounded-xl border border-gray-200 bg-white p-3 text-left transition hover:border-red-300 hover:bg-red-50 focus:outline-none focus:ring-2 focus:ring-red-600 focus:ring-offset-1"
                        >
                          <span className="block text-sm font-semibold text-gray-900">
                            {option.label}
                          </span>
                          <span className="mt-1 block text-xs text-gray-500">
                            {option.description}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}

                {activeCreationType ? (
                  <div className="space-y-5 rounded-xl border border-gray-200 bg-gray-50/60 p-4 sm:p-5">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <p className="text-sm font-semibold text-gray-950">
                        Add {selectedChildType?.label.toLowerCase()}
                      </p>
                      <Button
                        type="button"
                        variant="link-gray"
                        size="sm"
                        onClick={() => {
                          setCreationType(undefined);
                          setParentId(undefined);
                        }}
                      >
                        Choose another
                      </Button>
                    </div>

                    <Input
                      label={`${selectedChildType?.label} name`}
                      name="name"
                      placeholder={
                        activeCreationType === "section"
                          ? "Section A"
                          : activeCreationType === "shelf"
                          ? "Shelf A1"
                          : "Container A1-13"
                      }
                      value={locationName}
                      onChange={(event) =>
                        setLocationName(event.currentTarget.value)
                      }
                      required
                      disabled={disabled}
                    />

                    <div>
                      <IoioLocationColorPicker
                        locations={locations}
                        parentId={colorParentId}
                        value={locationColor}
                        locationType={activeCreationType}
                        name="locationColorPicker"
                        onChange={
                          activeCreationType === "section"
                            ? setLocationColor
                            : undefined
                        }
                      />
                    </div>

                    <div>
                      <p className="mb-2 text-sm font-semibold text-gray-900">
                        Main image
                      </p>
                      <IoioImagePicker
                        name="image"
                        accept={ACCEPT_SUPPORTED_IMAGES}
                        disabled={disabled}
                        uploading={disabled}
                        error={fileError}
                        onChange={validateFile}
                      />
                    </div>

                    <div>
                      <h3 className="mb-2 text-sm font-semibold text-gray-900">
                        Parent hierarchy
                      </h3>
                      <IoioLocationParentPicker
                        key={`${roomId}-${activeCreationType}`}
                        locations={locations}
                        type={activeCreationType}
                        fixedRoomId={roomId}
                        value={parentId}
                        disabled={disabled}
                        onChange={setParentId}
                      />
                    </div>
                  </div>
                ) : null}

                {creationType === "item" ? (
                  <div className="space-y-4 rounded-xl border border-gray-200 bg-gray-50/60 p-4 sm:p-5">
                    <div>
                      <p className="text-sm font-semibold text-gray-950">
                        Place an individual item
                      </p>
                      <p className="mt-1 text-xs text-gray-600">
                        Choose an optional section, shelf, or container, then
                        continue in Shelf Asset creation.
                      </p>
                    </div>
                    <IoioLocationPlacementPicker
                      key={roomId}
                      locations={locations}
                      roomId={roomId ?? ""}
                      value={itemLocationId}
                      disabled={disabled}
                      onChange={setItemLocationId}
                    />
                    <div className="flex flex-wrap justify-end gap-2 border-t border-gray-200 pt-4">
                      <Button
                        to={`/assets/new?location=${encodeURIComponent(
                          itemLocationId ?? roomId ?? ""
                        )}`}
                        variant="secondary"
                      >
                        Create new item
                      </Button>
                      <Button
                        to={`/assets?location=${encodeURIComponent(
                          itemLocationId ?? roomId ?? ""
                        )}`}
                        variant="link-gray"
                      >
                        Select existing item
                      </Button>
                    </div>
                  </div>
                ) : null}

                {activeCreationType ? (
                  <div className="flex flex-wrap justify-end gap-2 border-t border-gray-200 pt-4">
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={disabled}
                      onClick={() => setCreationType(undefined)}
                    >
                      Cancel
                    </Button>
                    <Button type="submit" disabled={disabled}>
                      {disabled ? (
                        <Spinner />
                      ) : (
                        `Create ${selectedChildType?.label.toLowerCase()}`
                      )}
                    </Button>
                  </div>
                ) : null}
              </>
            )}
          </Form>
        )}
      </Card>
      <IoioLocationOverview
        locations={locations}
        roomId={roomId}
        creationType={creationType}
        parentId={parentId}
        itemLocationId={itemLocationId}
        candidateName={locationName}
      />
    </div>
  );
}
