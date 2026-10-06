import type { Location } from "@prisma/client";
import {
  getEffectiveIoioLocationColor,
  getIoioLocationColorByHex,
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

export function getUsedSiblingColors({
  locations,
  parentId,
  currentLocationId,
  locationType = "section",
}: Pick<
  Props,
  "locations" | "parentId" | "currentLocationId" | "locationType"
>) {
  if (locationType !== "section") return new Set<string>();

  return new Set(
    locations
      .filter(
        (location) =>
          location.parentId === (parentId ?? null) &&
          location.id !== currentLocationId &&
          Boolean(location.color)
      )
      .map((location) => location.color!.toLocaleLowerCase())
  );
}

export function getFirstAvailableLocationColor({
  locations,
  parentId,
  currentLocationId,
  locationType,
}: Pick<
  Props,
  "locations" | "parentId" | "currentLocationId" | "locationType"
>) {
  const used = getUsedSiblingColors({
    locations,
    parentId,
    currentLocationId,
    locationType,
  });
  return (
    IOIO_LOCATION_COLORS.find(
      (color) => !used.has(color.color.toLocaleLowerCase())
    )?.color ?? IOIO_LOCATION_COLORS[0].color
  );
}

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
    locationType,
  });
  const usedSiblingColors = getUsedSiblingColors({
    locations,
    parentId,
    currentLocationId,
    locationType,
  });

  if (inherited) {
    return (
      <div>
        <fieldset>
          <legend className="text-sm font-semibold text-gray-900">Color</legend>
          <p className="mt-1 text-xs text-gray-600">
            This color is inherited from the nearest parent section.
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
          {locationType === "room"
            ? "Choose any supported color for this room."
            : "Sections in the same room use different colors. Colors can be reused in other rooms."}
        </p>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {IOIO_LOCATION_COLORS.map((color) => {
            const normalizedColor = color.color.toLocaleLowerCase();
            const isUsed = usedSiblingColors.has(normalizedColor);
            const isChecked = value?.toLocaleLowerCase() === normalizedColor;

            return (
              <label
                key={color.color}
                className={`flex min-w-0 items-center gap-2 rounded-lg border px-2.5 py-2 text-sm transition ${
                  isUsed
                    ? "cursor-not-allowed border-gray-200 bg-gray-50 text-gray-400 opacity-60"
                    : isChecked
                    ? "border-gray-900 bg-white font-semibold text-gray-950 ring-1 ring-gray-900"
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
                  <span className="ml-auto text-[10px] uppercase tracking-wide">
                    In use
                  </span>
                ) : null}
              </label>
            );
          })}
        </div>
        {value ? (
          <p className="mt-2 text-xs text-gray-500">
            Selected: {getIoioLocationColorByHex(value).name}
          </p>
        ) : null}
      </fieldset>
      {error ? <p className="mt-1 text-sm text-error-500">{error}</p> : null}
    </div>
  );
}
