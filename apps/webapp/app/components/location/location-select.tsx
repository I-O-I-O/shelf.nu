import { useEffect, useState } from "react";
import { useNavigation } from "react-router";
import { Button } from "~/components/shared/button";
import { isFormProcessing } from "~/utils/form";
import { tw } from "~/utils/tw";
import DynamicSelect from "../dynamic-select/dynamic-select";

import { XIcon } from "../icons/library";
import ImageWithPreview from "../image-with-preview/image-with-preview";
import InlineEntityCreationDialog from "../inline-entity-creation-dialog/inline-entity-creation-dialog";

type IsBulk = {
  isBulk: true;
  locationId?: undefined;
};

type IsNotBulk = {
  isBulk: false;
  locationId?: string | null;
};

type BulkProps = IsBulk | IsNotBulk;

type LocationHierarchyItem = {
  name: string;
  parent?: LocationHierarchyItem | null;
};

/** Returns a root-to-leaf path from Shelf's parent relation. */
export function getLocationHierarchyPath(
  location: LocationHierarchyItem
): string[] {
  const path: string[] = [];
  const visited = new Set<LocationHierarchyItem>();
  let current: LocationHierarchyItem | null | undefined = location;

  while (current && !visited.has(current)) {
    visited.add(current);
    path.unshift(current.name);
    current = current.parent;
  }

  return path;
}

/**
 * Shared props for rendering the location selector in bulk or single-item contexts.
 */
type LocationSelectProps = BulkProps & {
  /** Hides the clear (X) button that resets the selection. */
  hideClearButton?: boolean;
  /** Text to show when there is no selected location. */
  placeholder?: string;
  /** Which form field name to bind the selected value to. */
  fieldName?: string;
  /** Additional classes for the outer container. */
  className?: string;
  /** Custom z-index class for dropdown when used inside dialogs. */
  popoverZIndexClassName?: string;
  /** External value to pre-populate the selector with. */
  defaultValue?: string | null;
  /**
   * When true, the hidden `currentLocationId` input is omitted.
   * Useful when the field is not tied to an existing entity.
   */
  hideCurrentLocationInput?: boolean;
  /** List of location ids that should be hidden from the dropdown (e.g., the current record). */
  excludeIds?: string[];
  /**
   * When true, hides the "Create new location" button in extraContent.
   * Used to prevent nested creation buttons when LocationSelect is used inside LocationForm.
   */
  hideExtraContent?: boolean;
  /** Always query Shelf's current location records while searching. */
  forceServerSearch?: boolean;
  /** Disable interaction while the containing form is saving. */
  disabled?: boolean;
};

/**
 * LocationSelect wraps DynamicSelect with Shelf-specific behavior such as thumbnail rendering,
 * optional "create new location" entry, and support for excluding certain ids.
 */
export const LocationSelect = ({
  hideClearButton = false,
  placeholder,
  fieldName = "newLocationId",
  className,
  popoverZIndexClassName,
  defaultValue,
  hideCurrentLocationInput = false,
  excludeIds,
  hideExtraContent = false,
  forceServerSearch = false,
  disabled: formDisabled = false,
  ...restProps
}: LocationSelectProps) => {
  const navigation = useNavigation();

  const locationIdToUse = !restProps.isBulk ? restProps.locationId : undefined;
  const initialLocationId = defaultValue ?? locationIdToUse;
  const [locationId, setLocationId] = useState(initialLocationId ?? undefined);
  const disabled = formDisabled || isFormProcessing(navigation.state);
  const showCurrentLocationInput =
    !restProps.isBulk && !hideCurrentLocationInput;

  useEffect(() => {
    setLocationId(initialLocationId ?? undefined);
  }, [initialLocationId]);

  return (
    <div className={tw("relative w-full", className)}>
      {showCurrentLocationInput && (
        <input
          type="hidden"
          name="currentLocationId"
          value={locationIdToUse ?? undefined}
        />
      )}
      <div className={tw("flex items-center gap-2")}>
        <DynamicSelect
          disabled={disabled}
          fieldName={fieldName}
          defaultValue={locationId ?? undefined}
          model={{ name: "location", queryKey: "name" }}
          contentLabel="Locations"
          placeholder={placeholder || "Without location"}
          initialDataKey="locations"
          countKey="totalLocations"
          forceServerSearch={forceServerSearch}
          closeOnSelect
          allowClear
          excludeItems={excludeIds}
          onChange={(value) => setLocationId(value)}
          popoverZIndexClassName={popoverZIndexClassName}
          extraContent={
            hideExtraContent
              ? undefined
              : ({ onItemCreated, closePopover }) => (
                  <InlineEntityCreationDialog
                    type="location"
                    title="Create new location"
                    buttonLabel="Create new location"
                    onCreated={(created) => {
                      if (created?.type !== "location") return;
                      const createdLocation = created.entity;

                      const item = {
                        id: createdLocation.id,
                        name: createdLocation.name,
                        metadata: {
                          ...createdLocation,
                        },
                      };

                      setLocationId(createdLocation.id);
                      onItemCreated(item);
                      closePopover();
                    }}
                  />
                )
          }
          renderItem={({ name, metadata }) => {
            const ancestors = getLocationHierarchyPath({
              name,
              parent: metadata?.parent,
            }).slice(0, -1);

            return (
              <div className="flex min-w-0 items-center gap-2">
                {metadata?.thumbnailUrl ? (
                  <ImageWithPreview
                    thumbnailUrl={metadata.thumbnailUrl}
                    alt={metadata.name}
                    className="size-6 rounded-[2px]"
                  />
                ) : null}
                <div className="min-w-0">
                  <div className="truncate">{name}</div>
                  {ancestors.length ? (
                    <div
                      className="truncate text-xs text-gray-500"
                      title={ancestors.join(" › ")}
                    >
                      {ancestors.join(" › ")}
                    </div>
                  ) : null}
                </div>
              </div>
            );
          }}
        />

        {hideClearButton ? null : (
          <Button
            variant="secondary"
            type="button"
            className="p-3.5"
            onClick={() => setLocationId(undefined)}
            disabled={!locationId || disabled}
          >
            <XIcon />
          </Button>
        )}
      </div>
    </div>
  );
};
