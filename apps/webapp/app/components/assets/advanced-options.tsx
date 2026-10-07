import type { ReactNode } from "react";
import type { Asset } from "@prisma/client";
import { ChevronDownIcon } from "lucide-react";
import { ASSET_RETURN_HANDLING } from "~/modules/asset/advanced-settings";
import { isQuantityTracked } from "~/modules/asset/utils";
import FormRow from "../forms/form-row";
import Input from "../forms/input";
import { SettingHelpLabel } from "../shared/setting-help-label";

/** Presentation extracted directly from the Inventory edit form. */
export function AdvancedOptions({ children }: { children: ReactNode }) {
  return (
    <details className="rounded-md border border-gray-200">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-medium text-gray-800 [&::-webkit-details-marker]:hidden">
        <ChevronDownIcon className="size-4 shrink-0 text-gray-500" />
        <span>Advanced options</span>
      </summary>
      <div className="border-t border-gray-200 px-4">{children}</div>
    </details>
  );
}

export function DescriptionField({
  description,
  disabled,
  itemType = "asset",
}: {
  description?: string | null;
  disabled: boolean;
  itemType?: "asset" | "kit";
}) {
  return (
    <FormRow
      rowLabel="Description"
      subHeading={
        <p className="text-xs">
          This is the initial object description shown on the {itemType}{" "}
          overview page. You can change it later.
        </p>
      }
      className="border-b-0 py-4"
    >
      <Input
        inputType="textarea"
        maxLength={1000}
        rows={3}
        label="Description"
        name="description"
        defaultValue={description || ""}
        hideLabel
        placeholder={`Add a description for your ${itemType}.`}
        disabled={disabled}
        data-test-id={`${itemType}Description`}
        className="w-full"
        inputClassName="text-sm"
      />
    </FormRow>
  );
}

export type AssetAdvancedSettings = Pick<
  Asset,
  | "type"
  | "unitOfMeasure"
  | "minQuantity"
  | "requiresBorrowApproval"
  | "requiresStaffPreparation"
  | "requiresReturnPhoto"
  | "returnHandling"
>;

export function AssetAdvancedFields({
  values,
  disabled,
  fieldPrefix = "",
}: {
  values: AssetAdvancedSettings;
  disabled: boolean;
  fieldPrefix?: string;
}) {
  return (
    <>
      {isQuantityTracked(values.type) ? (
        <>
          <FormRow
            rowLabel="Unit of measure"
            subHeading="Label for the unit (e.g. pcs, boxes, liters)."
            className="border-b-0 py-4"
          >
            <Input
              label="Unit of measure"
              hideLabel
              name={`${fieldPrefix}unitOfMeasure`}
              disabled={disabled}
              className="w-full"
              placeholder="e.g., pcs, boxes, liters"
              defaultValue={values.unitOfMeasure ?? ""}
            />
          </FormRow>
          <FormRow
            rowLabel="Min quantity"
            subHeading="Low-stock alert threshold. Defaults to 1."
            className="border-b-0 py-4"
          >
            <Input
              type="number"
              label="Min quantity"
              hideLabel
              name={`${fieldPrefix}minQuantity`}
              disabled={disabled}
              min={1}
              step={1}
              className="w-full"
              defaultValue={values.minQuantity ?? 1}
            />
          </FormRow>
        </>
      ) : null}
      <FormRow
        rowLabel={
          <SettingHelpLabel
            label="Staff preparation"
            help="When enabled, Staff must prepare or check the item before the borrower can pick it up."
          />
        }
        className="border-b-0 py-4"
      >
        <label className="flex items-start gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            name={`${fieldPrefix}requiresStaffPreparation`}
            value="true"
            defaultChecked={values.requiresStaffPreparation}
            disabled={disabled}
            className="mt-0.5 size-4 rounded border-gray-300 text-primary-500 focus:ring-primary-500"
          />
          <span>Requires preparation</span>
        </label>
      </FormRow>
      <FormRow
        rowLabel={
          <SettingHelpLabel
            label="Return handling"
            help="Choose where a working item should be placed after return. Items with a reported problem follow the configured problem-return workflow."
          />
        }
        className="border-b-0 py-4"
      >
        <div className="space-y-2 text-sm text-gray-700">
          <label className="flex items-start gap-2">
            <input
              type="radio"
              name={`${fieldPrefix}returnHandling`}
              value={ASSET_RETURN_HANDLING.RETURN_TO_STORAGE}
              defaultChecked={
                values.returnHandling ===
                ASSET_RETURN_HANDLING.RETURN_TO_STORAGE
              }
              disabled={disabled}
              className="mt-0.5 size-4 border-gray-300 text-primary-500 focus:ring-primary-500"
            />
            <span>Assigned storage location</span>
          </label>
          <label className="flex items-start gap-2">
            <input
              type="radio"
              name={`${fieldPrefix}returnHandling`}
              value={ASSET_RETURN_HANDLING.RETURN_TO_RETURN_ZONE}
              defaultChecked={
                values.returnHandling ===
                ASSET_RETURN_HANDLING.RETURN_TO_RETURN_ZONE
              }
              disabled={disabled}
              className="mt-0.5 size-4 border-gray-300 text-primary-500 focus:ring-primary-500"
            />
            <span>Return Zone for staff check</span>
          </label>
        </div>
      </FormRow>
    </>
  );
}
