import { z } from "zod";

export const ASSET_RETURN_HANDLING = {
  RETURN_TO_STORAGE: "RETURN_TO_STORAGE",
  RETURN_TO_RETURN_ZONE: "RETURN_TO_RETURN_ZONE",
} as const;

/** The same form validation for Inventory and Kit member settings. */
export const assetAdvancedSettingsSchema = z.object({
  minQuantity: z
    .string()
    .optional()
    .transform((val) => (val === "" || val === undefined ? null : +val))
    .pipe(
      z
        .number({ invalid_type_error: "Min quantity must be a number" })
        .int("Min quantity must be a whole number")
        .positive("Min quantity must be at least 1")
        .nullable()
    ),
  unitOfMeasure: z
    .string()
    .optional()
    .refine(
      (v) => !v || !/{%|%}/.test(v),
      "Unit of measure may not contain Markdoc syntax (`{%` / `%}`)"
    ),
  requiresBorrowApproval: z
    .string()
    .optional()
    .transform((value) => value === "true"),
  requiresStaffPreparation: z
    .string()
    .optional()
    .transform((value) => value === "true"),
  requiresReturnPhoto: z
    .string()
    .optional()
    .transform((value) => value === "true"),
  returnHandling: z
    .enum([
      ASSET_RETURN_HANDLING.RETURN_TO_STORAGE,
      ASSET_RETURN_HANDLING.RETURN_TO_RETURN_ZONE,
    ])
    .default(ASSET_RETURN_HANDLING.RETURN_TO_STORAGE),
});
