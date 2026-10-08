import { useEffect, useState } from "react";
import type { Location } from "@prisma/client";
import { useAtom, useAtomValue } from "jotai";
import { Link, useActionData } from "react-router";
import { useZorm } from "react-zorm";
import { z } from "zod";
import { updateDynamicTitleAtom } from "~/atoms/dynamic-title-atom";
import {
  assetImageValidateFileAtom,
  fileErrorAtom,
  defaultValidateFileAtom,
} from "~/atoms/file";
import { useAutoFocus } from "~/hooks/use-auto-focus";
import { useDisabled } from "~/hooks/use-disabled";
import useFetcherWithReset from "~/hooks/use-fetcher-with-reset";
import type { action as editLocationAction } from "~/routes/_layout+/locations.$locationId_.edit";
import type { action as newLocationAction } from "~/routes/_layout+/locations.new";
import { ACCEPT_SUPPORTED_IMAGES } from "~/utils/constants";
import { tw } from "~/utils/tw";
import { zodFieldIsRequired } from "~/utils/zod";
import {
  IoioLocationParentPicker,
  type IoioLocationCreationType,
} from "./ioio-location-cascade-select";
import { IoioLocationColorPicker } from "./ioio-location-color-picker";
import { LocationImageField } from "./location-image-field";
import { LocationSelect } from "./location-select";
import { Form } from "../custom-form";
import FormRow from "../forms/form-row";
import Input from "../forms/input";
import { RefererRedirectInput } from "../forms/referer-redirect-input";
import { IoioImagePicker } from "../ioio/ioio-image-picker";
import { AbsolutePositionedHeaderActions } from "../layout/header/absolute-positioned-header-actions";
import { Button } from "../shared/button";
import { ButtonGroup } from "../shared/button-group";
import { Card } from "../shared/card";
import { Spinner } from "../shared/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../shared/tooltip";
import When from "../when/when";

export const NewLocationFormSchema = z.object({
  name: z.string().min(2, "Name is required"),
  description: z.string(),
  address: z.string(),
  parentId: z
    .string()
    .optional()
    .transform((value) => (value ? value : null)),
  color: z
    .string()
    .optional()
    .transform((value) => (value === undefined ? undefined : value || null)),
  locationType: z.enum(["room", "section", "shelf", "container"]).optional(),
  addAnother: z
    .string()
    .optional()
    .transform((val) => val === "true"),
  preventRedirect: z.string().optional(),
  redirectTo: z.string().optional(),
});

type NewLocationPayload = Pick<Location, "id" | "name"> & {
  imageUrl?: string | null;
  thumbnailUrl?: string | null;
  parentId?: Location["parentId"];
};

type LocationOption = Pick<Location, "id" | "name" | "parentId" | "color">;
type IoioLocationFormType = "room" | IoioLocationCreationType;

interface Props {
  className?: string;
  name?: Location["name"];
  address?: Location["address"];
  description?: Location["description"];
  /** Saved image of the location being edited, shown next to the file input. */
  imageUrl?: Location["imageUrl"];
  /** Saved thumbnail of the location being edited. */
  thumbnailUrl?: Location["thumbnailUrl"];
  color?: Location["color"];
  apiUrl?: string;
  /** Callback function to handle cancel action when form is used inline (e.g., in a dialog). When provided, Cancel button will call this instead of navigating. */
  onCancel?: () => void;
  /** Callback function triggered on successful location creation/update */
  onSuccess?: (data?: { location?: NewLocationPayload }) => void;
  parentId?: Location["parentId"];
  referer?: string | null;
  excludeLocationId?: Location["id"];
  excludeLocationIds?: Location["id"][];
  locations?: LocationOption[];
  locationType?: IoioLocationFormType;
  ioioMode?: boolean;
}

/**
 * Create and edit form for locations. Renders as a full page, or compact
 * inside a dialog when `onSuccess` is passed (inline creation).
 *
 * @param props - See {@link Props}; image props show the saved image when editing
 */
// react-doctor:no-giant-component — deferred for follow-up refactor
export const LocationForm = ({
  className,
  name,
  address,
  description,
  imageUrl,
  thumbnailUrl,
  color,
  apiUrl,
  onSuccess,
  parentId,
  referer,
  excludeLocationId,
  excludeLocationIds,
  locations,
  locationType,
  ioioMode = false,
  onCancel,
}: Props) => {
  const zo = useZorm("NewQuestionWizardScreen", NewLocationFormSchema);
  const fetcher = useFetcherWithReset<{
    success?: boolean;
    location?: NewLocationPayload;
    error?: { message?: string; additionalData?: { field?: string } };
    errors?: Record<string, { message?: string }>;
  }>();
  const fetcherData = fetcher.data;
  const hasOnSuccessFunc = typeof onSuccess === "function";
  const disabled = useDisabled(hasOnSuccessFunc ? fetcher : undefined);

  const actionData = useActionData<
    typeof newLocationAction | typeof editLocationAction
  >();
  const fileError = useAtomValue(fileErrorAtom);
  const [, validateDefaultFile] = useAtom(defaultValidateFileAtom);
  const [, validateAssetImage] = useAtom(assetImageValidateFileAtom);
  const validateFile = ioioMode ? validateAssetImage : validateDefaultFile;
  const [clearImage, setClearImage] = useState(false);
  const [selectedParentId, setSelectedParentId] = useState(parentId);
  const [locationColor, setLocationColor] = useState(color);
  const [, updateName] = useAtom(updateDynamicTitleAtom);

  // Focus the name input on mount. Replaces `autoFocus` to satisfy
  // jsx-a11y/no-autofocus. When the form is rendered inside a dialog,
  // the dialog's `data-dialog-initial-focus` handler typically wins;
  // otherwise this provides the intentional initial focus.
  const nameInputRef = useAutoFocus<HTMLInputElement>();

  useEffect(() => {
    setSelectedParentId(parentId);
  }, [parentId]);

  useEffect(() => {
    setLocationColor(color);
  }, [color]);

  useEffect(() => {
    if (!hasOnSuccessFunc) return;

    if (fetcherData?.success) {
      onSuccess(fetcherData);
      fetcher.reset();
    }
  }, [fetcher, fetcherData, hasOnSuccessFunc, onSuccess]);

  const imageError =
    (hasOnSuccessFunc
      ? fetcherData?.errors?.image?.message ??
        (fetcherData?.error?.additionalData?.field === "image"
          ? fetcherData?.error?.message
          : undefined)
      : undefined) ??
    (actionData as any)?.errors?.image?.message ??
    ((actionData as any)?.error?.additionalData?.field === "image"
      ? (actionData as any)?.error?.message
      : undefined) ??
    fileError;

  const nameError =
    (hasOnSuccessFunc
      ? fetcherData?.error?.message || fetcherData?.errors?.name?.message
      : (actionData as any)?.error?.message ||
        (actionData as any)?.errors?.name?.message) ||
    zo.errors.name()?.message;

  const FormComponent = hasOnSuccessFunc ? fetcher.Form : Form;
  const showIoioHierarchy = Boolean(ioioMode && locations && locationType);

  return (
    <Card
      className={tw(
        "w-full max-w-full md:w-min",
        hasOnSuccessFunc ? "border-none  shadow-none" : "",
        className
      )}
    >
      <FormComponent
        ref={zo.ref}
        method="post"
        className="flex w-full max-w-full flex-col gap-2"
        encType="multipart/form-data"
        action={apiUrl}
      >
        <RefererRedirectInput
          fieldName={zo.fields.redirectTo()}
          referer={referer}
        />

        {hasOnSuccessFunc ? null : (
          <AbsolutePositionedHeaderActions className="hidden md:flex">
            <Actions
              disabled={disabled}
              referer={referer}
              onCancel={onCancel}
            />
          </AbsolutePositionedHeaderActions>
        )}

        <When
          truthy={hasOnSuccessFunc}
          fallback={
            <FormRow
              rowLabel={"Name"}
              className="border-b-0 pb-[10px] pt-0"
              required={zodFieldIsRequired(NewLocationFormSchema.shape.name)}
            >
              <Input
                ref={nameInputRef}
                label="Name"
                hideLabel
                name={zo.fields.name()}
                disabled={disabled}
                error={nameError}
                data-dialog-initial-focus
                onChange={hasOnSuccessFunc ? undefined : updateName}
                className="w-full"
                defaultValue={name || undefined}
                placeholder="Storage room"
                required={zodFieldIsRequired(NewLocationFormSchema.shape.name)}
              />
            </FormRow>
          }
        >
          <Input
            ref={nameInputRef}
            label="Name"
            hideLabel
            name={zo.fields.name()}
            disabled={disabled}
            error={nameError}
            data-dialog-initial-focus
            onChange={hasOnSuccessFunc ? undefined : updateName}
            className="w-full"
            defaultValue={name || undefined}
            placeholder="Storage room"
            required={zodFieldIsRequired(NewLocationFormSchema.shape.name)}
          />
        </When>

        {showIoioHierarchy ? (
          <>
            <input
              type="hidden"
              name="locationType"
              value={locationType}
              readOnly
            />
            <input
              type="hidden"
              name={zo.fields.parentId()}
              value={selectedParentId ?? ""}
              readOnly
            />
            {locationType === "room" ? null : (
              <FormRow
                rowLabel="Location"
                subHeading={
                  <p className="text-xs text-gray-600">
                    {locationType === "container"
                      ? "Choose a room, section, and shelf."
                      : locationType === "shelf"
                      ? "Choose a room and an optional section."
                      : "Choose the room for this section."}
                  </p>
                }
              >
                <IoioLocationParentPicker
                  locations={locations ?? []}
                  type={locationType as IoioLocationCreationType}
                  value={selectedParentId}
                  disabled={disabled}
                  onChange={setSelectedParentId}
                  excludeIds={excludeLocationIds ?? []}
                />
                <Link
                  to="/locations/new"
                  className="mt-2 inline-flex text-sm font-medium text-red-700 underline-offset-2 hover:underline focus:outline-none focus:ring-2 focus:ring-red-600 focus:ring-offset-2"
                >
                  Create location
                </Link>
              </FormRow>
            )}
            {!locations ? null : (
              <FormRow rowLabel="Location color">
                <IoioLocationColorPicker
                  locations={locations}
                  parentId={selectedParentId}
                  currentLocationId={excludeLocationId}
                  value={locationColor}
                  locationType={locationType}
                  onChange={setLocationColor}
                />
              </FormRow>
            )}
          </>
        ) : (
          <FormRow
            rowLabel="Parent location"
            subHeading={
              <p>
                Optional. Nest this location under an existing one to build
                breadcrumbs.
              </p>
            }
          >
            <div className="mb-2 block lg:hidden">
              <div className="text-sm font-medium text-gray-700">
                Parent location
              </div>
              <p className="text-xs text-gray-600">
                Optional. Nest this location under an existing one to build
                breadcrumbs.
              </p>
            </div>
            <LocationSelect
              isBulk={false}
              className="w-full max-w-full"
              popoverZIndexClassName={
                hasOnSuccessFunc ? "z-[10000]" : undefined
              }
              hideExtraContent={hasOnSuccessFunc}
              fieldName={zo.fields.parentId()}
              placeholder="No parent"
              defaultValue={parentId ?? undefined}
              hideCurrentLocationInput
              excludeIds={excludeLocationId ? [excludeLocationId] : undefined}
            />
          </FormRow>
        )}

        {ioioMode ? (
          <FormRow rowLabel="Main image" className="border-b-0 pt-[10px]">
            <input
              type="hidden"
              name="clearImage"
              value={clearImage ? "true" : "false"}
            />
            <IoioImagePicker
              name="image"
              accept={ACCEPT_SUPPORTED_IMAGES}
              disabled={disabled}
              uploading={disabled}
              error={imageError}
              canRemoveExisting={Boolean(imageUrl || thumbnailUrl)}
              existingPreview={
                imageUrl || thumbnailUrl ? (
                  <img
                    src={thumbnailUrl ?? imageUrl ?? ""}
                    alt={`${name ?? "Location"} preview`}
                    className="size-full object-contain"
                  />
                ) : null
              }
              onChange={(event) => {
                if (event.currentTarget.files?.length) setClearImage(false);
                validateFile(event);
              }}
              onRemove={() => setClearImage(true)}
            />
          </FormRow>
        ) : (
          <When
            truthy={hasOnSuccessFunc}
            fallback={
              <FormRow rowLabel="Main image">
                <LocationImageField
                  imageUrl={imageUrl}
                  thumbnailUrl={thumbnailUrl}
                  error={imageError}
                  disabled={disabled}
                />
              </FormRow>
            }
          >
            <Input
              disabled={disabled}
              accept={ACCEPT_SUPPORTED_IMAGES}
              name="image"
              type="file"
              onChange={validateFile}
              label="Main image"
              error={imageError}
              className="mt-2"
              inputClassName="border-0 shadow-none p-0 rounded-none"
            />
            <p className="hidden lg:block">
              Accepts PNG, JPG, JPEG, or WebP (max.4 MB)
            </p>
          </When>
        )}

        {ioioMode ? (
          <input
            type="hidden"
            name={zo.fields.address()}
            value={address ?? ""}
            readOnly
          />
        ) : null}

        {ioioMode ? null : (
          <When
            truthy={hasOnSuccessFunc}
            fallback={
              <FormRow
                rowLabel={"Address"}
                subHeading={
                  <p>
                    Will set location’s geo position to address. Make sure to
                    add an accurate address, to ensure the map location is as
                    accurate as possible
                  </p>
                }
                className="pt-[10px]"
                required={zodFieldIsRequired(
                  NewLocationFormSchema.shape.address
                )}
              >
                <Input
                  label="Address"
                  hideLabel
                  name={zo.fields.address()}
                  disabled={disabled}
                  error={zo.errors.address()?.message}
                  className="w-full"
                  defaultValue={address || undefined}
                  required={zodFieldIsRequired(
                    NewLocationFormSchema.shape.address
                  )}
                />
              </FormRow>
            }
          >
            <Input
              label="Address"
              name={zo.fields.address()}
              disabled={disabled}
              error={zo.errors.address()?.message}
              className="w-full"
              defaultValue={address || undefined}
              required={zodFieldIsRequired(NewLocationFormSchema.shape.address)}
            />
          </When>
        )}

        {ioioMode ? (
          <FormRow
            rowLabel="Description"
            subHeading={<p className="text-xs text-gray-600">Optional</p>}
          >
            <Input
              inputType="textarea"
              rows={3}
              maxLength={1000}
              label="Description"
              hideLabel
              name={zo.fields.description()}
              defaultValue={description || ""}
              placeholder="Optional description..."
              disabled={disabled}
              data-test-id="locationDescription"
              className="w-full"
              inputClassName="text-sm"
            />
          </FormRow>
        ) : (
          <When
            truthy={hasOnSuccessFunc}
            fallback={
              <FormRow
                rowLabel="Description"
                subHeading={
                  <p>
                    This is the initial object description. It will be shown on
                    the location page. You can always change it.
                  </p>
                }
                required={zodFieldIsRequired(
                  NewLocationFormSchema.shape.description
                )}
              >
                <Input
                  inputType="textarea"
                  label="Description"
                  hideLabel
                  name={zo.fields.description()}
                  defaultValue={description || ""}
                  placeholder="Add a description for your location."
                  disabled={disabled}
                  data-test-id="locationDescription"
                  className="w-full"
                  required={zodFieldIsRequired(
                    NewLocationFormSchema.shape.description
                  )}
                />
              </FormRow>
            }
          >
            <Input
              inputType="textarea"
              label="Description"
              name={zo.fields.description()}
              defaultValue={description || ""}
              placeholder="Add a description for your location."
              disabled={disabled}
              data-test-id="locationDescription"
              className="w-full"
              required={zodFieldIsRequired(
                NewLocationFormSchema.shape.description
              )}
            />
          </When>
        )}

        {hasOnSuccessFunc ? (
          <input type="hidden" name="preventRedirect" value="true" />
        ) : null}

        <FormRow className="border-y-0 py-2" rowLabel="">
          <div className="ml-auto">
            <Button type="submit" disabled={disabled}>
              {disabled ? <Spinner /> : "Save"}
            </Button>
          </div>
        </FormRow>
      </FormComponent>
    </Card>
  );
};

const Actions = ({
  disabled,
  referer,
  onCancel,
}: {
  disabled: boolean;
  referer?: string | null;
  onCancel?: () => void;
}) => (
  <>
    <ButtonGroup>
      {/* When onCancel is provided (inline mode), use onClick instead of navigation */}
      {onCancel ? (
        <Button
          type="button"
          onClick={onCancel}
          variant="secondary"
          disabled={disabled}
        >
          Cancel
        </Button>
      ) : (
        <Button to={referer ?? ".."} variant="secondary" disabled={disabled}>
          Cancel
        </Button>
      )}
      <AddAnother disabled={disabled} />
    </ButtonGroup>

    <Button type="submit" disabled={disabled}>
      Save
    </Button>
  </>
);

const AddAnother = ({ disabled }: { disabled: boolean }) => (
  <TooltipProvider delayDuration={100}>
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="submit"
          variant="secondary"
          disabled={disabled}
          name="addAnother"
          value="true"
        >
          Add another
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <p className="text-sm">Save the location and add a new one</p>
      </TooltipContent>
    </Tooltip>
  </TooltipProvider>
);
