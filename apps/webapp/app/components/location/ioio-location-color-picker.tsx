import type { Location } from "@prisma/client";
import {
  getEffectiveIoioLocationColor,
  getFirstAvailableIoioColor,
  getIoioLocationColorByHex,
  getUsedIoioRoomColors,
  getUsedIoioSectionColors,
  IOIO_LOCATION_COLORS,
  type IoioLocationType,
} from "./ioio-location-colors";

type LocationColorOption = Pick<Location, "id" | "name" | "parentId" | "color">;

type Props = {
  locations: LocationColorOption[];
  parentId?: string | null;
  currentLocationId?: string;
  value?: string | null;
  name?: string;
  locationType?: IoioLocationType;
  error?: string;
  onChange?: (color: string) => void;
};

export function IoioLocationColorPicker({
  locations,
  parentId,
  currentLocationId,
  value,
  name = "color",
  locationType = "section",
  error,
  onChange,
}: Props) {
  const inherited = locationType === "shelf" || locationType === "container";
  const effectiveColor = getEffectiveIoioLocationColor({
    locations,
    location: currentLocationId
      ? locations.find((location) => location.id === currentLocationId)
      : undefined,
    parentId,
  });
  const usedColors =
    locationType === "section"
      ? getUsedIoioSectionColors({ locations, parentId, currentLocationId })
      : getUsedIoioRoomColors({ locations, currentLocationId });
  const selectedColor = value ?? getFirstAvailableIoioColor(usedColors) ?? "";
  if (inherited) {
    return (
      <div>
        <fieldset>
          <legend className="text-sm font-semibold text-gray-900">Color</legend>
          <p className="mt-1 text-xs text-gray-600">
            This color is inherited from the containing section, or the room
            when there is no section.
          </p>
          <div className="mt-3 flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700">
            <span
              aria-hidden="true"
              className="size-4 shrink-0 rounded-full border border-black/10"
              style={{ backgroundColor: effectiveColor.color }}
            />
            <span>{effectiveColor.name}</span>
          </div>
        </fieldset>
        <input type="hidden" name={name} value={effectiveColor.color} />
        {error ? <p className="mt-1 text-sm text-error-500">{error}</p> : null}
      </div>
    );
  }

  return (
    <div>
      <fieldset>
        <legend className="text-sm font-semibold text-gray-900">Color</legend>
        <p className="mt-1 text-xs text-gray-600">
          {locationType === "section"
            ? "Choose a color unused by other sections in this room."
            : "Choose a color unused by other rooms."}
        </p>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {IOIO_LOCATION_COLORS.map((color) => {
            const normalizedColor = color.color.toLocaleLowerCase();
            const isChecked =
              selectedColor.toLocaleLowerCase() === normalizedColor;
            const isUsed = usedColors.has(normalizedColor);

            return (
              <label
                key={color.color}
                className={`flex min-w-0 items-center gap-2 rounded-lg border px-2.5 py-2 text-sm transition ${
                  isChecked
                    ? "border-gray-900 bg-white font-semibold text-gray-950 ring-1 ring-gray-900"
                    : isUsed
                    ? "cursor-not-allowed border-gray-200 bg-gray-100 text-gray-400"
                    : "cursor-pointer border-gray-200 bg-white text-gray-700 hover:border-gray-400"
                }`}
              >
                <input
                  type="radio"
                  name={name}
                  value={color.color}
                  checked={isChecked}
                  disabled={isUsed}
                  onChange={() => onChange?.(color.color)}
                  className="sr-only"
                />
                <span
                  aria-hidden="true"
                  className="size-4 shrink-0 rounded-full border border-black/10"
                  style={{ backgroundColor: color.color }}
                />
                <span className="truncate">{color.name}</span>
                {isUsed ? (
                  <span className="sr-only">
                    Already used{" "}
                    {locationType === "room"
                      ? "by another room"
                      : "in this room"}
                  </span>
                ) : null}
              </label>
            );
          })}
        </div>
        {selectedColor ? (
          <p className="mt-2 text-xs text-gray-500">
            Selected: {getIoioLocationColorByHex(selectedColor).name}
          </p>
        ) : null}
        {usedColors.has(selectedColor.toLowerCase()) ? (
          <p className="mt-1 text-sm text-error-500">
            This color is already used{" "}
            {locationType === "room" ? "by another room" : "in this room"}.
            Choose another color.
          </p>
        ) : null}
        {!selectedColor ? (
          <p className="mt-1 text-sm text-error-500">
            {locationType === "room"
              ? "No room colors are available. Reassign a room color first."
              : "No section colors are available in this room."}
          </p>
        ) : null}
      </fieldset>
      {error ? <p className="mt-1 text-sm text-error-500">{error}</p> : null}
    </div>
  );
}
