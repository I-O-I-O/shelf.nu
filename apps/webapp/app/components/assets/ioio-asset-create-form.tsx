import { useEffect, useMemo, useState } from "react";
import type {
  Asset,
  AssetModel,
  Barcode,
  CustomField,
  Qr,
} from "@prisma/client";
import { AssetType, ConsumptionType } from "@prisma/client";
import { useAtom, useAtomValue } from "jotai";
import {
  ChevronDownIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PrinterIcon,
} from "lucide-react";
import {
  useActionData,
  useFetcher,
  useLoaderData,
  useLocation,
  useNavigate,
  useNavigation,
  useRevalidator,
} from "react-router";
import type { Tag } from "react-tag-autocomplete";
import { useZorm } from "react-zorm";
import { z } from "zod";
import { updateDynamicTitleAtom } from "~/atoms/dynamic-title-atom";
import { fileErrorAtom, assetImageValidateFileAtom } from "~/atoms/file";
import { useAutoFocus } from "~/hooks/use-auto-focus";
import { assetAdvancedSettingsSchema } from "~/modules/asset/advanced-settings";
import { getPhysicalUnitLabelFromTitle } from "~/modules/asset/physical-unit";
import { isQuantityTracked } from "~/modules/asset/utils";
import {
  getIoioKitDisplayName,
  getIoioPhysicalUnitDisplayName,
} from "~/modules/kit/ioio-kit-presentation";
import { resolveCancelTo } from "~/utils/cancel-destination";
import { ACCEPT_SUPPORTED_IMAGES } from "~/utils/constants";
import type { CustomFieldZodSchema } from "~/utils/custom-fields";
import { mergedSchema } from "~/utils/custom-fields";
import { isFormProcessing } from "~/utils/form";
import { getValidationErrors } from "~/utils/http";
import type { DataOrErrorResponse } from "~/utils/http.server";
import { tw } from "~/utils/tw";
import {
  optionalNumberFromString,
  requiredNumberFromString,
} from "~/utils/zod-numeric";
import {
  AdvancedOptions,
  AssetAdvancedFields,
  DescriptionField,
} from "./advanced-options";
import { AssetImage } from "./asset-image";
import { AssetModelFormRow } from "./asset-model-form-row";
import {
  BulkCreateSuccessModal,
  type BulkCreateSuccess,
} from "./bulk-create-success-modal";
import { Form } from "../custom-form";
import DynamicSelect from "../dynamic-select/dynamic-select";
import FormRow from "../forms/form-row";
import Input from "../forms/input";
import { RefererRedirectInput } from "../forms/referer-redirect-input";
import InlineEntityCreationDialog from "../inline-entity-creation-dialog/inline-entity-creation-dialog";
import { IoioImagePicker } from "../ioio/ioio-image-picker";
import { IoioLocationCascadeSelect } from "../location/ioio-location-cascade-select";
import type { IoioLocationOption } from "../location/ioio-location-cascade-select";
import { Button } from "../shared/button";
import { ButtonGroup } from "../shared/button-group";
import { Card } from "../shared/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../shared/dropdown";
import { SettingHelpLabel } from "../shared/setting-help-label";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../shared/tooltip";
import When from "../when/when";

export const NewAssetFormSchema = z.object({
  // Title is required in single-create mode. In bulk mode the form
  // submits the rendered first-preview title to satisfy this check
  // (the bulk action ignores `title` and uses `nameTemplate` instead).
  title: z
    .string()
    .min(2, "Name is required")
    .transform((val) => val.trim()), // We trim to avoid white spaces at start and end

  description: z
    .string()
    .optional()
    .transform((value) => value?.trim() ?? ""),
  category: z.string(),
  assetModelId: z.string().optional(),

  // ── Bulk-create extension fields ──────────────────────────────────
  // `bulk` is the mode discriminator the action reads to branch to the
  // bulkCreateAssetsFromModel service. The other three are raw string
  // passthroughs validated server-side via bulkCreateAssetsFromModel
  // (which throws labelled 400 ShelfErrors with row-friendly messages).
  bulk: z.string().optional(),
  count: z.string().optional(),
  nameTemplate: z.string().optional(),
  startNumber: z.string().optional(),
  newLocationId: z.string().optional(),
  /** This holds the value of the current location. We need it for comparison reasons on the server.
   * We send it as part of the form data and compare it with the current location of the asset and prevent querying the database if it's the same.
   */
  currentLocationId: z.string().optional(),
  qrId: z.string().optional(),
  tags: z.string().optional(),
  /**
   * Per-asset override of which Barcode to display in list views. Empty
   * string means "use workspace default" (resolver follows
   * `Organization.qrIdDisplayPreference`). A non-empty value must match
   * one of this asset's persisted barcode ids — enforced server-side.
   */
  preferredBarcodeId: z
    .string()
    .optional()
    .transform((val) => (val && val.length > 0 ? val : null)),
  valuation: optionalNumberFromString({ blank: null, fieldName: "Value" }),
  addAnother: z
    .string()
    .optional()
    .transform((val) => val === "true"),
  redirectTo: z.string().optional(),

  // Tracking method & quantity fields
  type: z.nativeEnum(AssetType).default(AssetType.INDIVIDUAL),
  quantity: optionalNumberFromString({
    blank: undefined,
    fieldName: "Quantity",
  }).pipe(
    z
      .number({ invalid_type_error: "Quantity must be a number" })
      .int("Quantity must be a whole number")
      .positive("Quantity is required and must be at least 1")
      .optional()
  ),
  ...assetAdvancedSettingsSchema.shape,
  maxBorrowDays: z.coerce.number().int().min(1).max(365).default(45),
  extensionBorrowDays: z.coerce.number().int().min(1).max(365).optional(),
  consumptionType: z
    .nativeEnum(ConsumptionType, {
      errorMap: () => ({ message: "Please select a consumption type" }),
    })
    .optional(),
});

/**
 * Bulk-create variant of `NewAssetFormSchema`. Extends the base shape
 * (via Zod's `.extend()` which keeps the result as a `ZodObject`, so
 * `mergedSchema` still accepts it) and tightens the fields the bulk
 * flow needs to validate client-side:
 *
 * - `assetModelId` → required (the whole point of the flow; defaults
 *   for category + valuation flow from it)
 * - `nameTemplate` → required (otherwise we can't render N titles)
 * - `count`        → required, whole number between 2 and 100 (server
 *   re-validates with the same bounds in `bulkCreateAssetsFromModel`)
 *
 * The server picks this schema instead of `NewAssetFormSchema` when
 * the request carries `bulk=1`, so client-side Zorm errors and
 * server-side validation messages line up.
 */
export const NewAssetBulkFormSchema = NewAssetFormSchema.extend({
  assetModelId: z.string().min(1, "Please select an asset model"),
  nameTemplate: z
    .string()
    .min(1, "Name template is required")
    .transform((val) => val.trim()),
  count: requiredNumberFromString({ fieldName: "Count" }).pipe(
    z
      .number({ invalid_type_error: "Count must be a number" })
      .int("Count must be a whole number")
      .min(2, "Count must be at least 2")
      .max(100, "Count must be at most 100")
  ),
});

type IoioAssetFormLoaderData = {
  customFields: Array<
    Pick<
      CustomField,
      "id" | "name" | "helpText" | "required" | "type" | "options" | "active"
    >
  >;
  locations: IoioLocationOption[];
  assetModels?: Array<
    Pick<
      AssetModel,
      "id" | "name" | "defaultCategoryId" | "image" | "thumbnailImage"
    >
  >;
};

/** Pass props of the values to be used as default for the form fields */

type Props = Partial<
  Pick<
    Asset,
    | "id"
    | "sequentialId"
    | "title"
    | "thumbnailImage"
    | "mainImage"
    | "mainImageExpiration"
    | "categoryId"
    | "assetModelId"
    | "description"
    | "valuation"
    | "type"
    | "quantity"
    | "minQuantity"
    | "consumptionType"
    | "unitOfMeasure"
    | "requiresBorrowApproval"
    | "requiresStaffPreparation"
    | "requiresReturnPhoto"
    | "maxBorrowDays"
    | "extensionBorrowDays"
    | "returnHandling"
    | "preferredBarcodeId"
  >
> & {
  qrId?: Qr["id"] | null;
  tags?: Tag[];
  barcodes?: Pick<Barcode, "id" | "value" | "type">[];
  referer?: string | null;
  /**
   * Location is not a column on `Asset` — it lives on the `AssetLocation`
   * pivot. Callers derive the single primary-location id via
   * `getPrimaryLocation()` and pass it explicitly.
   */
  locationId?: string | null;
  /**
   * When `true`, the form renders in bulk-create mode:
   * - The Title field is replaced with Name template + Count + Start at
   *   inputs (and the rendered first preview is also submitted as `title`
   *   so the shared schema still validates).
   * - Tracking method is forced to INDIVIDUAL (qty-tracked stock pools
   *   are single-create + restock, not bulk).
   * - Custodian, QR, and Barcodes sections are hidden — they don't
   *   make sense as shared values across N assets.
   * - AssetModel becomes required (the whole point of bulk-create).
   * - A hidden `bulk=1` field flags the server-side action to route
   *   through `bulkCreateAssetsFromModel` instead of `createAsset`.
   * Default `false` preserves the single-create behaviour.
   */
  bulkMode?: boolean;
  /** Hide the optional Shelf Asset Model selector in the IOIO single-item form. */
  showAssetModel?: boolean;
  /** Active physical units in the logical individual-product group. */
  physicalUnits?: Array<{
    id: string;
    title: string;
    status: string;
    qrId?: string | null;
    qrCreatedAt?: Date | string | null;
  }>;
  /** Product-level editing mode for a grouped set of individual assets. */
  productGroup?: {
    name: string;
    locationIsMixed: boolean;
    hasImage: boolean;
  };
};

function customFieldType(type: string): CustomFieldZodSchema["type"] {
  switch (type) {
    case "TEXT":
      return "text";
    case "OPTION":
      return "option";
    case "BOOLEAN":
      return "boolean";
    case "DATE":
      return "date";
    case "MULTILINE_TEXT":
      return "multiline_text";
    case "AMOUNT":
      return "amount";
    case "NUMBER":
      return "number";
    default:
      throw new Error(`Unsupported custom field type: ${type}`);
  }
}

// react-doctor:no-giant-component — deferred for follow-up refactor
export const IoioAssetCreateForm = ({
  id,
  title,
  thumbnailImage,
  mainImage,
  mainImageExpiration,
  categoryId,
  assetModelId,
  locationId,
  description,
  type: assetType,
  quantity,
  minQuantity,
  consumptionType,
  unitOfMeasure,
  requiresBorrowApproval,
  requiresStaffPreparation,
  requiresReturnPhoto,
  maxBorrowDays,
  extensionBorrowDays,
  returnHandling,
  qrId,
  tags,
  barcodes,
  referer,
  bulkMode = false,
  showAssetModel = true,
  physicalUnits = [],
  productGroup,
}: Props) => {
  const navigation = useNavigation();
  const navigate = useNavigate();
  const {
    customFields: loaderCustomFields,
    locations,
    assetModels,
  } = useLoaderData<IoioAssetFormLoaderData>();
  const customFields = loaderCustomFields
    .filter((field) => field.active)
    .map(
      (field): CustomFieldZodSchema => ({
        id: field.id,
        name: field.name,
        helpText: field.helpText ?? "",
        required: field.required,
        type: customFieldType(field.type),
        options: field.options,
      })
    );

  // Bulk mode tightens a few fields (assetModelId, nameTemplate,
  // count). Same `mergedSchema` pipeline either way — both base
  // schemas are plain `ZodObject`s so custom-field merging works.
  // Cast the union to the base schema's type so `mergedSchema`'s
  // generic resolves cleanly (the bulk schema is structurally a
  // superset of the base — same fields, stricter rules).
  const FormSchema = useMemo(
    () =>
      mergedSchema({
        baseSchema: (bulkMode
          ? NewAssetBulkFormSchema
          : NewAssetFormSchema) as typeof NewAssetFormSchema,
        customFields,
      }),
    [bulkMode, customFields]
  );

  const zo = useZorm("NewAssetFormScreen", FormSchema);
  const disabled = isFormProcessing(navigation.state);

  // Focus the asset Title field on mount so create/edit pages start
  // ready for typing instead of relying on the removed autoFocus prop.
  const titleInputRef = useAutoFocus<HTMLInputElement>();

  const actionData = useActionData<
    DataOrErrorResponse & {
      errors?: Record<string, { message: string }>;
      /** Present when /assets/new posted with `bulk=1` and the bulk
       * create service succeeded. Drives BulkCreateSuccessModal. */
      bulkSuccess?: BulkCreateSuccess;
    }
  >();

  /** Server-side validation errors as fallback when client-side validation fails */
  const validationErrors = getValidationErrors<typeof NewAssetFormSchema>(
    actionData?.error
  );

  const fileError = useAtomValue(fileErrorAtom);
  const [, validateFile] = useAtom(assetImageValidateFileAtom);
  const [, updateDynamicTitle] = useAtom(updateDynamicTitleAtom);

  /** Whether we are in edit mode (asset already exists). */
  const isEditMode = Boolean(id);
  const isProductGroupEdit = Boolean(productGroup);
  /** Track the selected asset type for conditional field rendering. */
  const [selectedAssetType, setSelectedAssetType] = useState<AssetType>(
    bulkMode ? AssetType.INDIVIDUAL : assetType ?? AssetType.QUANTITY_TRACKED
  );
  const isQtyTracked = isQuantityTracked(selectedAssetType);
  const [quantityInput, setQuantityInput] = useState(
    quantity == null ? "" : String(quantity)
  );
  const [conversionResult, setConversionResult] = useState<{
    assetIds: string[];
    convertedCount: number;
  } | null>(null);
  const sourceQuantity = quantity ?? 0;
  const needsIndividualConversion =
    isEditMode &&
    assetType === AssetType.QUANTITY_TRACKED &&
    selectedAssetType === AssetType.INDIVIDUAL &&
    sourceQuantity > 1 &&
    !conversionResult;
  const needsProductGroupQuantityConversion =
    isProductGroupEdit &&
    assetType === AssetType.INDIVIDUAL &&
    selectedAssetType === AssetType.QUANTITY_TRACKED;
  const showQuantityForConversion =
    isEditMode &&
    assetType === AssetType.QUANTITY_TRACKED &&
    selectedAssetType === AssetType.INDIVIDUAL;
  const conversionFetcher = useFetcher<{
    convertedAssetIds?: string[];
    convertedCount?: number;
    error?: { message?: string };
  }>();
  const productGroupConversionFetcher = useFetcher<{
    quantityAssetId?: string;
    error?: { message?: string };
  }>();
  const isConversionPending = conversionFetcher.state !== "idle";
  const [selectedAssetModelId, setSelectedAssetModelId] = useState<
    string | undefined
  >(assetModelId ?? undefined);
  const individualModelFetcher = useFetcher<{
    assetModelId?: string;
    error?: { message?: string };
  }>();
  const physicalUnitFetcher = useFetcher<{
    success?: boolean;
    intent?: string;
    unitId?: string;
    qrId?: string;
    error?: { message?: string };
  }>();
  const [editingPhysicalUnitId, setEditingPhysicalUnitId] = useState<
    string | null
  >(null);
  const [physicalUnitNumberInput, setPhysicalUnitNumberInput] = useState("");

  useEffect(() => {
    const convertedAssetIds = conversionFetcher.data?.convertedAssetIds;
    const convertedCount = conversionFetcher.data?.convertedCount;
    if (!convertedAssetIds?.length || typeof convertedCount !== "number") {
      return;
    }

    if (id) {
      void navigate(`/assets/${encodeURIComponent(convertedAssetIds[0])}/edit`);
      return;
    }

    setConversionResult({
      assetIds: convertedAssetIds,
      convertedCount,
    });
  }, [conversionFetcher.data, id, navigate]);

  useEffect(() => {
    const quantityAssetId = productGroupConversionFetcher.data?.quantityAssetId;
    if (!quantityAssetId) return;
    void navigate(`/assets/${encodeURIComponent(quantityAssetId)}/edit`);
  }, [productGroupConversionFetcher.data, navigate]);

  const handleTrackingTypeChange = (nextType: AssetType) => {
    setSelectedAssetType(nextType);
    setConversionResult(null);
    if (isProductGroupEdit && nextType === AssetType.QUANTITY_TRACKED) {
      setQuantityInput(String(physicalUnits.length));
      return;
    }
    if (
      (nextType === AssetType.INDIVIDUAL ||
        nextType === AssetType.QUANTITY_TRACKED) &&
      !quantityInput
    ) {
      setQuantityInput("1");
    }
  };

  const convertAllUnits = () => {
    if (!id || !needsIndividualConversion || isConversionPending) return;

    const confirmed = window.confirm(
      `Convert ${sourceQuantity} physical units to individual tracking?`
    );
    if (!confirmed) return;

    void conversionFetcher.submit(
      { intent: "convert-all-units" },
      { method: "post", action: "." }
    );
  };

  const convertProductGroupToQuantity = () => {
    if (!id || !needsProductGroupQuantityConversion) return;
    void productGroupConversionFetcher.submit(
      { intent: "convert-product-to-quantity", productGroup: "1" },
      { method: "post", action: "." }
    );
  };

  // ── Bulk-mode controlled state ─────────────────────────────────────
  // Three related inputs grouped into one useState object so they
  // travel together and keep the AssetForm's total useState count
  // below react-doctor's `prefer-useReducer` threshold. Each field has
  // its own update helper below.
  // Defaults are tuned for the most common case (a 5-item starter
  // batch). The `{i}` token in the placeholder teaches the convention
  // without forcing users to type it — they can drop it and the
  // renderer auto-appends.
  const [bulkFields, setBulkFields] = useState<{
    nameTemplate: string;
    count: number;
    startNumber: number;
  }>({
    nameTemplate: bulkMode ? "Asset {i}" : "",
    count: 5,
    startNumber: 1,
  });
  const {
    nameTemplate: bulkNameTemplate,
    count: bulkCount,
    startNumber: bulkStartNumber,
  } = bulkFields;
  const setBulkNameTemplate = (nameTemplate: string) =>
    setBulkFields((prev) => ({ ...prev, nameTemplate }));
  const setBulkCount = (count: number) =>
    setBulkFields((prev) => ({ ...prev, count }));
  const setBulkStartNumber = (startNumber: number) =>
    setBulkFields((prev) => ({ ...prev, startNumber }));

  /** Render the title for the Nth bulk-created asset. Mirrors the
   * server-side `renderBulkAssetTitle` (intentionally a local copy to
   * keep the form bundle free of server modules). */
  const renderBulkTitle = (template: string, indexValue: number): string => {
    const renderedIndex = template.includes("#{i}")
      ? String(indexValue).padStart(3, "0")
      : String(indexValue);
    if (template.includes("{i}")) {
      return template.replace(/\{i\}/g, renderedIndex).trim();
    }
    return `${template.trim()} ${renderedIndex}`.trim();
  };

  const bulkPreviewTitles = useMemo(() => {
    if (!bulkMode) return [] as string[];
    const safeCount =
      Number.isInteger(bulkCount) && bulkCount > 0 ? bulkCount : 0;
    return Array.from({ length: safeCount }, (_, i) =>
      renderBulkTitle(bulkNameTemplate, bulkStartNumber + i)
    );
  }, [bulkMode, bulkNameTemplate, bulkCount, bulkStartNumber]);

  /** First rendered title — also submitted as the hidden `title` input
   * so the shared NewAssetFormSchema (title.min(2)) still passes in
   * bulk mode. The server-side action ignores `title` when `bulk=1`. */
  const bulkFirstTitle = bulkPreviewTitles[0] || "";
  /** Live mirror of whether the user has picked an asset model.
   * Seeded from the initial prop (truthy when editing an existing
   * asset that already has a model). Used by the row's error-display
   * gate so a Zorm "required" error after a failed submit clears
   * immediately when the user picks a model — Zorm itself only
   * re-validates on the next submit. */
  const [hasPickedAssetModel, setHasPickedAssetModel] = useState<boolean>(
    Boolean(assetModelId)
  );
  /**
   * The model currently chosen in the form. Mirrors the DynamicSelect rather
   * than reading the `assetModelId` prop, so the inherited-image preview
   * updates the moment the user picks a different model on the create form —
   * before anything is saved.
   */
  const revalidator = useRevalidator();
  const location = useLocation();
  const [showPhysicalUnits, setShowPhysicalUnits] = useState(false);
  const isGroupedIndividualProduct =
    !bulkMode &&
    selectedAssetType === AssetType.INDIVIDUAL &&
    physicalUnits.length > 0;
  const availablePhysicalUnitCount = physicalUnits.filter(
    (unit) => unit.status === "AVAILABLE"
  ).length;
  useEffect(() => {
    const ensuredModelId = individualModelFetcher.data?.assetModelId;
    if (!ensuredModelId) return;

    setSelectedAssetModelId(ensuredModelId);
  }, [individualModelFetcher.data]);

  useEffect(() => {
    const result = physicalUnitFetcher.data;
    if (!result?.success || !result.intent || !result.unitId) return;

    if (result.intent === "ensure-physical-unit-qr") {
      void navigate(`/labels?assetIds=${encodeURIComponent(result.unitId)}`);
      return;
    }

    if (result.intent === "update-physical-unit-number") {
      setEditingPhysicalUnitId(null);
      setPhysicalUnitNumberInput("");
      void revalidator.revalidate();
    }
  }, [navigate, physicalUnitFetcher.data, revalidator]);

  const startEditingPhysicalUnitNumber = (unitId: string, value: string) => {
    setEditingPhysicalUnitId(unitId);
    setPhysicalUnitNumberInput(value.replace(/^#/u, ""));
  };

  const submitPhysicalUnitNumber = (unitId: string) => {
    void physicalUnitFetcher.submit(
      {
        intent: "update-physical-unit-number",
        unitId,
        unitNumber: physicalUnitNumberInput,
      },
      { method: "post", action: "." }
    );
  };

  const openPhysicalUnitLabel = (unit: {
    id: string;
    qrId?: string | null;
  }) => {
    if (unit.qrId) {
      void navigate(`/labels?assetIds=${encodeURIComponent(unit.id)}`);
      return;
    }

    void physicalUnitFetcher.submit(
      { intent: "ensure-physical-unit-qr", unitId: unit.id },
      { method: "post", action: "." }
    );
  };

  /**
   * Snapshot of the referer as it was when this form first mounted.
   *
   * Deliberately ignores later updates to the `referer` prop — this is not a
   * stale-state bug. The Referer header is only meaningful at the moment the
   * user arrives. Any in-route navigation re-runs the loader and overwrites it
   * with this page's own URL: picking a Category navigates to
   * `/assets/new?category=<id>` (see the effect below), so the prop becomes
   * `/assets/new` and "where I came from" is lost. ~93% of assets carry a
   * category, so that is the normal path, not an edge case.
   *
   * Capturing once keeps Cancel pointing at the user's real origin (including
   * its filters) for the whole life of the form.
   */
  const [initialReferer] = useState(referer);

  /**
   * Where Cancel goes. The referer is best-effort and unusable in three
   * separate cases (absent prop, no Referer header, and self-reference).
   * `resolveCancelTo` owns all three — see its JSDoc.
   *
   * The self-reference guard is still load-bearing even with the snapshot
   * above: if this form ever mounts *after* an in-route navigation, the very
   * first value it captures is already self-referential. Worst case it falls
   * back to the index, which is exactly the pre-snapshot behaviour, so the
   * snapshot can only ever improve the destination, never worsen it.
   */
  const cancelTo = resolveCancelTo({
    referer: initialReferer,
    currentPathname: location.pathname,
    fallback: "/assets",
  });

  /** Asset models from the loader, used to look up defaults on selection. */
  const assetModelsData = assetModels;

  /** The chosen model's row, used for the inherited-image preview + copy. */
  const selectedAssetModel = selectedAssetModelId
    ? assetModelsData?.find((m) => m.id === selectedAssetModelId)
    : undefined;

  /**
   * Intent to drop this asset's own image so it falls back down the cascade —
   * to its model's cover image, or to the placeholder. Submitted as a hidden
   * field and applied by the edit action.
   *
   * Without this the override is one-way: there is no other way to remove an
   * asset image, so an asset that once had its own could never show its
   * model's again.
   */
  const [clearMainImage, setClearMainImage] = useState(false);

  /**
   * True when the asset currently stores an image of its own.
   *
   * Decided by `mainImage` ALONE, mirroring the resolver. Requiring a
   * thumbnail or an expiration here would misclassify every asset that has an
   * image but no thumbnail yet — CSV imports, duplicated assets and legacy
   * rows all land in that state, and thumbnails are generated lazily. Such an
   * asset would be told it "inherits" its model's image and would lose access
   * to the Remove control.
   *
   * @see {@link file://./../../modules/asset/image-resolution.ts}
   */
  const hasOwnImage = Boolean(id && mainImage);

  /** Whether the preview should show the asset's own image. */
  const showOwnImagePreview = hasOwnImage && !clearMainImage;

  /**
   * The model's cover image in the shape `AssetImage` expects. This is what
   * makes "pick a model → see its picture" work with no copying: the create
   * request simply omits an image and the cascade resolves it at render time.
   */
  const inheritableAssetModelImage = selectedAssetModel?.image
    ? {
        image: selectedAssetModel.image,
        thumbnailImage: selectedAssetModel.thumbnailImage ?? null,
      }
    : null;

  /**
   * When a model is selected, apply its default category by updating
   * the search params. When cleared, remove the category param.
   * This triggers a revalidation so the Category DynamicSelect
   * picks up the new default.
   */
  const handleAssetModelChange = (modelId: string | undefined) => {
    // Mirror the DynamicSelect's current selection so the row's error
    // display can suppress the Zorm "required" message once the user
    // picks something. Zorm only re-validates on submit by default,
    // and calling `zo.validate()` here reads stale FormData (React
    // hasn't committed the hidden input update yet) so it would
    // wrongly flash the error.
    setHasPickedAssetModel(Boolean(modelId));
    setSelectedAssetModelId(modelId);
    const params = new URLSearchParams(location.search);

    if (!modelId) {
      // Model was cleared — remove the category param
      params.delete("category");
    } else if (assetModelsData) {
      const model = assetModelsData.find((m) => m.id === modelId);
      if (model?.defaultCategoryId) {
        params.set("category", model.defaultCategoryId);
      }
    }

    void navigate(`${location.pathname}?${params.toString()}`, {
      preventScrollReset: true,
      replace: true,
    });
  };

  const mainImageError =
    actionData?.errors?.mainImage?.message ??
    (actionData?.error?.additionalData?.field ===
    (isProductGroupEdit ? "image" : "mainImage")
      ? actionData?.error?.message
      : undefined) ??
    fileError;

  const assetImagePreview =
    id && showOwnImagePreview ? (
      <AssetImage
        className="size-full"
        asset={{
          id,
          thumbnailImage: thumbnailImage ?? null,
          mainImage: mainImage ?? null,
          mainImageExpiration: mainImageExpiration
            ? new Date(mainImageExpiration)
            : null,
          assetModel: inheritableAssetModelImage,
        }}
        alt={`${title} main image`}
      />
    ) : inheritableAssetModelImage ? (
      <AssetImage
        className="size-full"
        asset={{
          id: id ?? "new-asset",
          mainImage: null,
          thumbnailImage: null,
          mainImageExpiration: null,
          assetModel: inheritableAssetModelImage,
        }}
        alt={`Image from asset model ${
          selectedAssetModel?.name ?? "selected model"
        }`}
      />
    ) : null;
  /**
   * Asset Model selector — rendered in two positions depending on mode
   * (see the two render sites in the JSX below). Hidden entirely for
   * QUANTITY_TRACKED — that visibility gate lives here so each render
   * site stays a single `<When>` toggle on `bulkMode`.
   */
  const assetModelFormRow =
    isQtyTracked || (!showAssetModel && !bulkMode) ? null : (
      <AssetModelFormRow
        disabled={disabled}
        required={bulkMode}
        assetModelId={selectedAssetModelId}
        onChange={handleAssetModelChange}
        // Zorm validation against the dynamic schema covers the
        // required-when-bulk rule; server-returned error after a
        // tampered POST falls back via validationErrors (per CLAUDE.md).
        // Suppress once the user has picked a model — Zorm only
        // re-validates on submit, so without this gate a failed submit
        // would leave the inline error stuck even after a valid pick.
        error={
          hasPickedAssetModel
            ? undefined
            : validationErrors?.assetModelId?.message ||
              zo.errors.assetModelId()?.message
        }
      />
    );

  return (
    <>
      <Card className="w-full lg:w-min">
        <BulkCreateSuccessModal
          success={actionData?.bulkSuccess}
          sampleTitles={bulkPreviewTitles}
        />
        <Form
          ref={zo.ref}
          method="post"
          action="."
          className="flex w-full flex-col gap-2"
          encType="multipart/form-data"
        >
          {isProductGroupEdit ? (
            <input type="hidden" name="productGroup" value="1" />
          ) : null}
          {/* QR linkage is per-asset; in bulk mode each created asset
            gets its own fresh QR via createAsset and we never reuse one. */}
          {qrId && !bulkMode ? (
            <input type="hidden" name="qrId" value={qrId} />
          ) : null}
          {!showAssetModel &&
          !bulkMode &&
          selectedAssetType === AssetType.INDIVIDUAL &&
          selectedAssetModelId ? (
            <input
              type="hidden"
              name="assetModelId"
              value={selectedAssetModelId}
            />
          ) : null}
          <RefererRedirectInput fieldName="redirectTo" referer={referer} />

          {/* These controls are intentionally not part of the simplified
            setup flow. Preserve existing values on edit so hiding the UI
            does not clear tags or alternative barcodes. */}
          {tags && tags.length > 0 ? (
            <input
              type="hidden"
              name="tags"
              value={tags.map((tag) => tag.value).join(",")}
              readOnly
            />
          ) : null}
          {barcodes?.map((barcode, index) => (
            <span key={barcode.id ?? `${barcode.type}-${barcode.value}`}>
              <input
                type="hidden"
                name={`barcodes[${index}].type`}
                value={barcode.type}
                readOnly
              />
              <input
                type="hidden"
                name={`barcodes[${index}].value`}
                value={barcode.value}
                readOnly
              />
              <input
                type="hidden"
                name={`barcodes[${index}].id`}
                value={barcode.id}
                readOnly
              />
            </span>
          ))}

          {/* Bulk-mode discriminator + synthetic title (satisfies the
            shared schema's title.min(2) check; the action ignores it
            when bulk=1 and uses nameTemplate instead). */}
          <When truthy={bulkMode}>
            <input type="hidden" name="bulk" value="1" />
            <input type="hidden" name="title" value={bulkFirstTitle} />
          </When>

          <div className="flex items-start justify-between border-b pb-5">
            <div className=" ">
              <h2 className="mb-1 text-[18px] font-semibold">
                {bulkMode ? "Bulk create from model" : "Basic fields"}
              </h2>
              <p>
                {bulkMode
                  ? "Create multiple assets from a model in one go. Common fields below apply to every asset created."
                  : isProductGroupEdit
                  ? "Shared information for this inventory product."
                  : "Basic information about your asset."}
              </p>
            </div>
            <div className="hidden flex-1 justify-end gap-2 md:flex">
              <Actions
                disabled={disabled}
                cancelTo={cancelTo}
                showAddAnother={!bulkMode && !isProductGroupEdit}
                hideSubmit={Boolean(
                  conversionResult ||
                    needsIndividualConversion ||
                    needsProductGroupQuantityConversion
                )}
              />
            </div>
          </div>

          <When truthy={!bulkMode}>
            <FormRow
              rowLabel={"Name"}
              className="border-b-0 pb-[10px]"
              required={true}
            >
              <Input
                ref={titleInputRef}
                label="Name"
                hideLabel
                name="title"
                disabled={disabled}
                error={
                  actionData?.errors?.title?.message ||
                  zo.errors.title()?.message
                }
                onChange={updateDynamicTitle}
                className="w-full"
                defaultValue={title || ""}
                required={true}
              />
            </FormRow>
          </When>

          {/* Bulk mode: Asset Model is the key field. Defaults for category and
            valuation flow from it, so it sits before Batch. Single mode keeps
            the model before Category below the tracking controls. */}
          <When truthy={bulkMode}>{assetModelFormRow}</When>

          <When truthy={bulkMode}>
            <FormRow
              rowLabel="Batch"
              className="border-b-0 pb-[10px]"
              subHeading={
                <p>
                  Each asset will be named using the template below. Use{" "}
                  <code className="rounded bg-gray-100 px-1 py-0.5 text-xs">
                    {"{i}"}
                  </code>{" "}
                  to substitute the asset number; otherwise it&apos;s appended.
                </p>
              }
              required={true}
            >
              <div className="flex w-full flex-col gap-3">
                <div className="flex flex-col gap-3 md:flex-row md:items-end">
                  <div className="flex-1">
                    <Input
                      label="Name template"
                      name="nameTemplate"
                      disabled={disabled}
                      value={bulkNameTemplate}
                      onChange={(e) => setBulkNameTemplate(e.target.value)}
                      placeholder="Dell Latitude {i}"
                      error={
                        validationErrors?.nameTemplate?.message ||
                        zo.errors.nameTemplate()?.message ||
                        (actionData?.error?.additionalData?.field ===
                        "nameTemplate"
                          ? actionData?.error?.message
                          : undefined)
                      }
                      required
                    />
                  </div>
                  <div className="w-full md:w-32">
                    <Input
                      type="number"
                      label="Count"
                      name="count"
                      disabled={disabled}
                      value={bulkCount}
                      onChange={(e) =>
                        setBulkCount(
                          Number.isFinite(+e.target.value)
                            ? Math.max(2, Math.min(100, +e.target.value))
                            : 2
                        )
                      }
                      min={2}
                      max={100}
                      step={1}
                      required
                      error={
                        validationErrors?.count?.message ||
                        zo.errors.count()?.message ||
                        (actionData?.error?.additionalData?.field === "count"
                          ? actionData?.error?.message
                          : undefined)
                      }
                    />
                  </div>
                  <div className="w-full md:w-32">
                    <Input
                      type="number"
                      label="Start at"
                      name="startNumber"
                      disabled={disabled}
                      value={bulkStartNumber}
                      onChange={(e) =>
                        setBulkStartNumber(
                          Number.isFinite(+e.target.value)
                            ? Math.max(0, +e.target.value)
                            : 1
                        )
                      }
                      min={0}
                      step={1}
                    />
                  </div>
                </div>
                <BulkCreatePreview titles={bulkPreviewTitles} />
              </div>
            </FormRow>
          </When>

          <When truthy={!bulkMode}>
            <FormRow
              rowLabel={"Tracking method"}
              className="border-b-0 pb-[10px]"
              subHeading={
                isProductGroupEdit
                  ? "Each physical unit has its own QR identity."
                  : isEditMode
                  ? "Changes are allowed while this asset has no kit, custody, or booking records."
                  : "Choose how this asset is tracked."
              }
              required={true}
            >
              <input type="hidden" name="type" value={selectedAssetType} />
              <TrackingMethodCards
                selectedAssetType={selectedAssetType}
                onSelect={handleTrackingTypeChange}
                disabled={
                  disabled || productGroupConversionFetcher.state !== "idle"
                }
              />
              {needsIndividualConversion ? (
                <div className="mt-3 w-full rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
                  <p className="font-semibold">
                    Switch to individual QR tracking
                  </p>
                  <p className="mt-1">
                    {sourceQuantity} physical units will become {sourceQuantity}{" "}
                    individual QR units.
                  </p>
                  <p className="mt-1 text-xs text-amber-900">
                    Each will receive its own QR identity.
                  </p>
                  {conversionFetcher.data?.error?.message ? (
                    <p
                      className="mt-2 text-xs font-medium text-red-700"
                      role="alert"
                    >
                      {conversionFetcher.data.error.message}
                    </p>
                  ) : null}
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={isConversionPending}
                      onClick={() =>
                        handleTrackingTypeChange(AssetType.QUANTITY_TRACKED)
                      }
                    >
                      Cancel
                    </Button>
                    <Button
                      type="button"
                      disabled={isConversionPending}
                      onClick={convertAllUnits}
                    >
                      {isConversionPending
                        ? "Converting..."
                        : "Convert all " + sourceQuantity}
                    </Button>
                  </div>
                </div>
              ) : null}
              {needsProductGroupQuantityConversion ? (
                <div className="mt-3 w-full rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
                  <p className="font-semibold">Switch to Quantity</p>
                  <p className="mt-1">
                    The {physicalUnits.length} active QR-tracked units will be
                    consolidated into one quantity item. Existing unit records,
                    QR identities, and history will be kept in Archive. The new
                    quantity item will get its own QR code.
                  </p>
                  <p className="mt-1 text-xs text-amber-900">
                    This action only changes tracking. Other unsaved edits on
                    this form will not be applied.
                  </p>
                  {productGroupConversionFetcher.data?.error?.message ? (
                    <p
                      className="mt-2 text-xs font-medium text-red-700"
                      role="alert"
                    >
                      {productGroupConversionFetcher.data.error.message}
                    </p>
                  ) : null}
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={productGroupConversionFetcher.state !== "idle"}
                      onClick={() =>
                        handleTrackingTypeChange(AssetType.INDIVIDUAL)
                      }
                    >
                      Cancel
                    </Button>
                    <Button
                      type="button"
                      disabled={productGroupConversionFetcher.state !== "idle"}
                      onClick={convertProductGroupToQuantity}
                    >
                      {productGroupConversionFetcher.state === "idle"
                        ? "Switch to Quantity"
                        : "Switching..."}
                    </Button>
                  </div>
                </div>
              ) : null}
              {conversionResult ? (
                <div className="mt-3 w-full rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-950">
                  <p className="font-semibold">
                    {conversionResult.convertedCount} individual QR units
                    created.
                  </p>
                  <Button
                    to={
                      "/labels?assetIds=" +
                      encodeURIComponent(conversionResult.assetIds.join(","))
                    }
                    variant="link"
                    className="mt-2 !p-0 text-green-800 underline"
                  >
                    Print all {conversionResult.convertedCount} labels
                  </Button>
                </div>
              ) : null}
            </FormRow>
          </When>

          {isGroupedIndividualProduct ? (
            <FormRow
              rowLabel={isProductGroupEdit ? "Quantity" : "Physical units"}
              className="border-b-0 pb-[10px]"
              subHeading={
                isProductGroupEdit
                  ? "Quantity is derived from active physical units."
                  : "Each unit keeps its own settings and QR identity."
              }
            >
              <div className="w-full space-y-3">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-lg font-semibold tabular-nums text-gray-900">
                    {physicalUnits.length}
                  </span>
                  <span className="text-sm text-gray-600">
                    physical units, {availablePhysicalUnitCount} available
                  </span>
                  <div className="ml-auto flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="secondary"
                      className="inline-flex flex-row items-center justify-center gap-2 whitespace-nowrap"
                      aria-expanded={showPhysicalUnits}
                      aria-controls="asset-physical-units"
                      onClick={() => setShowPhysicalUnits((value) => !value)}
                    >
                      <span className="flex flex-row items-center gap-2 whitespace-nowrap leading-5">
                        <ChevronDownIcon
                          className={`size-4 shrink-0 transition-transform ${
                            showPhysicalUnits ? "rotate-180" : ""
                          }`}
                        />
                        <span>
                          {showPhysicalUnits ? "Hide units" : "Show units"}
                        </span>
                      </span>
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={individualModelFetcher.state !== "idle"}
                      onClick={() => {
                        if (selectedAssetModelId) {
                          return;
                        }

                        if (isEditMode) {
                          void individualModelFetcher.submit(
                            { intent: "ensure-individual-model" },
                            { method: "post", action: "." }
                          );
                        }
                      }}
                    >
                      {individualModelFetcher.state === "idle"
                        ? "Add units"
                        : "Preparing..."}
                    </Button>
                  </div>
                </div>
                {showPhysicalUnits && physicalUnits.length > 0 ? (
                  <div
                    id="asset-physical-units"
                    className="space-y-2"
                    aria-label="Physical units"
                  >
                    {physicalUnits.map((unit) => {
                      const unitNumber = getPhysicalUnitLabelFromTitle(
                        unit.title
                      );
                      const displayName = getIoioPhysicalUnitDisplayName({
                        logicalProductName: getIoioKitDisplayName({
                          name: productGroup?.name ?? unit.title,
                        }),
                        unitNumber,
                        missingUnitLabel: "Unit number missing",
                      });
                      const isEditing = editingPhysicalUnitId === unit.id;
                      const isBusy =
                        physicalUnitFetcher.state !== "idle" &&
                        physicalUnitFetcher.formData?.get("unitId") === unit.id;
                      const unitError =
                        physicalUnitFetcher.data?.unitId === unit.id
                          ? physicalUnitFetcher.data.error?.message
                          : undefined;

                      return (
                        <div
                          key={unit.id}
                          className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2"
                        >
                          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
                            <div className="min-w-0 flex-1">
                              <p className="min-w-0 whitespace-normal break-words text-xs font-semibold text-gray-800">
                                {displayName}
                              </p>
                              <p
                                className={`mt-0.5 text-[11px] font-medium ${
                                  unit.qrId
                                    ? "text-green-700"
                                    : "text-amber-700"
                                }`}
                              >
                                {unit.qrId ? "QR active" : "QR label missing"}
                              </p>
                            </div>
                            {isEditing ? (
                              <div className="flex min-w-[220px] flex-1 items-center justify-end gap-2">
                                <Input
                                  label="Unit number"
                                  hideLabel
                                  value={physicalUnitNumberInput}
                                  onChange={(event) =>
                                    setPhysicalUnitNumberInput(
                                      event.target.value
                                    )
                                  }
                                  placeholder="001"
                                  className="w-24"
                                  disabled={isBusy}
                                  autoFocus
                                />
                                <Button
                                  type="button"
                                  size="sm"
                                  disabled={isBusy}
                                  onClick={() =>
                                    submitPhysicalUnitNumber(unit.id)
                                  }
                                >
                                  {isBusy ? "Saving..." : "Save"}
                                </Button>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="secondary"
                                  disabled={isBusy}
                                  onClick={() => {
                                    setEditingPhysicalUnitId(null);
                                    setPhysicalUnitNumberInput("");
                                  }}
                                >
                                  Cancel
                                </Button>
                              </div>
                            ) : (
                              <DropdownMenu modal={false}>
                                <DropdownMenuTrigger asChild>
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="secondary"
                                    className="size-8 shrink-0 rounded-lg p-1.5"
                                    aria-label={`Actions for ${displayName}`}
                                  >
                                    <MoreHorizontalIcon className="size-4" />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent
                                  align="end"
                                  className="min-w-48"
                                >
                                  <DropdownMenuItem
                                    className="flex flex-row items-center gap-3 whitespace-nowrap"
                                    onSelect={() =>
                                      startEditingPhysicalUnitNumber(
                                        unit.id,
                                        unitNumber ?? ""
                                      )
                                    }
                                  >
                                    <PencilIcon className="size-4 shrink-0" />
                                    <span>
                                      {unitNumber
                                        ? "Edit unit number"
                                        : "Assign number"}
                                    </span>
                                  </DropdownMenuItem>
                                  <DropdownMenuItem
                                    className="flex flex-row items-center gap-3 whitespace-nowrap"
                                    onSelect={() => openPhysicalUnitLabel(unit)}
                                  >
                                    <PrinterIcon className="size-4 shrink-0" />
                                    <span>
                                      {unit.qrId
                                        ? "Print label / QR"
                                        : "Generate label / QR"}
                                    </span>
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            )}
                          </div>
                          {unitError ? (
                            <p
                              className="mt-2 text-xs font-medium text-red-700"
                              role="alert"
                            >
                              {unitError}
                            </p>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            </FormRow>
          ) : null}

          <When truthy={bulkMode}>
            {/* Bulk-create assets are always INDIVIDUAL by design. */}
            <input type="hidden" name="type" value={AssetType.INDIVIDUAL} />
          </When>

          <When
            truthy={
              isQtyTracked ||
              showQuantityForConversion ||
              (!isEditMode && selectedAssetType === AssetType.INDIVIDUAL)
            }
          >
            <div className="flex flex-col gap-2">
              <FormRow
                rowLabel={
                  isQtyTracked || showQuantityForConversion
                    ? "Quantity"
                    : "Number of physical units"
                }
                className="border-b-0 pb-[10px]"
                subHeading={
                  showQuantityForConversion
                    ? "The current quantity will be split into individual physical items."
                    : isQtyTracked
                    ? "Identical units managed as one quantity."
                    : "Each physical unit will receive its own QR identity."
                }
                required={true}
              >
                <Input
                  type="number"
                  label={
                    isQtyTracked || showQuantityForConversion
                      ? "Quantity"
                      : "Number of physical units"
                  }
                  hideLabel
                  name="quantity"
                  disabled={disabled}
                  min={1}
                  step={1}
                  className="w-full"
                  value={quantityInput}
                  readOnly={showQuantityForConversion}
                  onChange={(event) => setQuantityInput(event.target.value)}
                  required={true}
                  error={
                    validationErrors?.quantity?.message ||
                    zo.errors.quantity()?.message
                  }
                />
              </FormRow>

              {isQtyTracked || showQuantityForConversion ? (
                <input
                  type="hidden"
                  name="consumptionType"
                  value={consumptionType ?? ConsumptionType.TWO_WAY}
                />
              ) : null}
            </div>
          </When>

          <FormRow rowLabel="Main image" className="pt-[10px]">
            <input
              type="hidden"
              name="clearMainImage"
              value={clearMainImage ? "true" : "false"}
            />
            <When
              truthy={
                Boolean(inheritableAssetModelImage) && !isProductGroupEdit
              }
            >
              <p className="mb-3 text-sm text-gray-600">
                {showOwnImagePreview ? (
                  <>
                    This asset uses its own image.{" "}
                    <Button
                      type="button"
                      variant="link"
                      className="!p-0 text-sm"
                      onClick={() => setClearMainImage(true)}
                    >
                      Use the model's image instead
                    </Button>
                  </>
                ) : (
                  <>
                    Using the image from{" "}
                    <span className="font-medium text-gray-700">
                      {selectedAssetModel?.name ?? "selected model"}
                    </span>
                    . Upload one below to override it for this asset.
                    <When truthy={clearMainImage}>
                      {" "}
                      <Button
                        type="button"
                        variant="link"
                        className="!p-0 text-sm"
                        onClick={() => setClearMainImage(false)}
                      >
                        Undo
                      </Button>
                    </When>
                  </>
                )}
              </p>
            </When>
            <IoioImagePicker
              name={isProductGroupEdit ? "image" : "mainImage"}
              accept={ACCEPT_SUPPORTED_IMAGES}
              disabled={disabled}
              uploading={disabled}
              error={mainImageError}
              existingPreview={assetImagePreview}
              canRemoveExisting={
                isProductGroupEdit
                  ? Boolean(id && productGroup?.hasImage)
                  : Boolean(hasOwnImage && !inheritableAssetModelImage)
              }
              onChange={(event) => {
                if (event.currentTarget.files?.length) {
                  setClearMainImage(false);
                }
                validateFile(event);
              }}
              onRemove={() => setClearMainImage(true)}
            />
          </FormRow>

          {/* Asset Model — single-create position before Category. In bulk mode
            this row is rendered at the top of the form instead; see the
            matching `<When truthy={bulkMode}>` block above the Batch row.
            Always hidden for QUANTITY_TRACKED because models are an
            INDIVIDUAL-only concept enforced server-side too. */}
          <When truthy={!bulkMode}>{assetModelFormRow}</When>

          <FormRow
            rowLabel="Category"
            subHeading={
              <p>
                Make it unique. Each asset can have 1 category. It will show on
                your index.{" "}
                <Button
                  to="/categories/new"
                  variant="link-gray"
                  className="text-gray-600 underline"
                  target="_blank"
                >
                  Create categories
                </Button>
              </p>
            }
            className="border-b-0 pb-[10px]"
          >
            <DynamicSelect
              disabled={disabled}
              defaultValue={
                new URLSearchParams(location.search).get("category") ||
                categoryId ||
                undefined
              }
              model={{ name: "category", queryKey: "name" }}
              triggerWrapperClassName="flex flex-col !gap-0 justify-start items-start [&_.inner-label]:w-full [&_.inner-label]:text-left "
              contentLabel="Categories"
              label="Category"
              hideLabel
              initialDataKey="categories"
              countKey="totalCategories"
              closeOnSelect
              selectionMode="set"
              allowClear={true}
              extraContent={({ onItemCreated, closePopover }) => (
                <InlineEntityCreationDialog
                  title="Create new category"
                  type="category"
                  buttonLabel="Create new category"
                  onCreated={(created) => {
                    if (created?.type !== "category") return;
                    const category = created.entity;
                    onItemCreated({
                      id: category.id,
                      name: category.name,
                      color: category.color,
                      metadata: { ...category },
                    });
                    closePopover();
                  }}
                />
              )}
            />
          </FormRow>

          <FormRow
            rowLabel="Location"
            subHeading={
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-600">
                <span>Choose a room, section, then shelf.</span>
                <Button
                  to="/locations/new"
                  className="text-gray-600 underline"
                  target="_blank"
                  variant="link-gray"
                >
                  Create location
                </Button>
              </div>
            }
            className="border-b-0 py-3"
          >
            {productGroup?.locationIsMixed ? (
              <p className="mb-2 text-xs text-gray-600">
                This product is stored in multiple locations. Choosing a
                location here moves all active physical units there.
              </p>
            ) : null}
            <input
              type="hidden"
              name="currentLocationId"
              value={locationId || ""}
            />
            <IoioLocationCascadeSelect
              locations={locations}
              value={locationId}
              fieldName="newLocationId"
              disabled={disabled}
            />
          </FormRow>

          <AdvancedOptions>
            <div className="border-b border-gray-200 pb-2 pt-3">
              <h3 className="text-sm font-semibold text-gray-900">Borrowing</h3>
            </div>
            <FormRow
              rowLabel={
                <SettingHelpLabel
                  label="Maximum borrowing period"
                  help="How long this item can be borrowed before an extension is required."
                />
              }
              className="border-b-0 py-3"
            >
              <div className="flex items-center gap-2">
                <Input
                  label="Maximum borrowing period"
                  hideLabel
                  name="maxBorrowDays"
                  type="number"
                  min={1}
                  max={365}
                  defaultValue={maxBorrowDays ?? 45}
                  disabled={disabled}
                  className="w-24"
                  required
                />
                <span className="text-sm text-gray-600">days</span>
              </div>
            </FormRow>
            <FormRow
              rowLabel={
                <SettingHelpLabel
                  label="Extension period"
                  help="Additional borrowing time available after Staff approves an extension request."
                />
              }
              className="border-b-0 py-3"
            >
              <div className="flex items-center gap-2">
                <Input
                  label="Extension period"
                  hideLabel
                  name="extensionBorrowDays"
                  type="number"
                  min={1}
                  max={365}
                  defaultValue={extensionBorrowDays ?? maxBorrowDays ?? 45}
                  disabled={disabled}
                  className="w-24"
                  required
                />
                <span className="text-sm text-gray-600">days</span>
              </div>
            </FormRow>
            <DescriptionField description={description} disabled={disabled} />
            {isProductGroupEdit ? (
              <p className="pb-2 text-xs text-gray-600">
                Borrowing and return settings below apply to the current active
                physical units. Each unit keeps its availability, custody,
                history, and QR identity.
              </p>
            ) : null}
            <AssetAdvancedFields
              values={{
                type: selectedAssetType,
                unitOfMeasure: unitOfMeasure ?? null,
                minQuantity: minQuantity ?? null,
                requiresBorrowApproval: requiresBorrowApproval ?? false,
                requiresStaffPreparation: requiresStaffPreparation ?? false,
                requiresReturnPhoto: requiresReturnPhoto ?? false,
                returnHandling: returnHandling ?? "RETURN_TO_STORAGE",
              }}
              disabled={disabled}
            />
          </AdvancedOptions>

          <FormRow className="border-y-0 pb-0 pt-5" rowLabel="">
            <div className="flex flex-1 justify-end gap-2">
              <Actions
                disabled={disabled}
                cancelTo={cancelTo}
                showAddAnother={!bulkMode && !isProductGroupEdit}
                hideSubmit={Boolean(
                  conversionResult ||
                    needsIndividualConversion ||
                    needsProductGroupQuantityConversion
                )}
              />
            </div>
          </FormRow>
        </Form>
      </Card>
    </>
  );
};

const Actions = ({
  disabled,
  cancelTo,
  showAddAnother = true,
  hideSubmit = false,
}: {
  disabled: boolean;
  /** Already-resolved Cancel destination. Must never be null/undefined —
   * the caller applies the fallback, because `<Button to>` degrades
   * silently (dead button on `undefined`, links to `/` on `null`). */
  cancelTo: string;
  /** "Add another" submits the form and reloads `/assets/new?` to clear
   * the fields for a second entry. In bulk-create mode it makes no
   * sense — one submit already creates many assets, and the success
   * modal offers the natural follow-up CTAs — so the caller hides it. */
  showAddAnother?: boolean;
  hideSubmit?: boolean;
}) => (
  <>
    {/* Save button is first in DOM order so Enter key triggers it by default */}
    {!hideSubmit ? (
      <Button type="submit" disabled={disabled} className="order-last">
        Save
      </Button>
    ) : null}

    <ButtonGroup>
      <Button to={cancelTo} variant="secondary" disabled={disabled}>
        Cancel
      </Button>
      {showAddAnother ? <AddAnother disabled={disabled} /> : null}
    </ButtonGroup>
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
        <p className="text-sm">Save the asset and add a new one</p>
      </TooltipContent>
    </Tooltip>
  </TooltipProvider>
);

/**
 * Live-preview block rendered inside the bulk-create row.
 *
 * Renders up to the first 5 titles inline so the user sees exactly what
 * names will land in the database before submitting, with an "…and N
 * more" tail for larger batches. Empty array → nothing rendered.
 */
function BulkCreatePreview({ titles }: { titles: string[] }) {
  if (titles.length === 0) return null;
  const PREVIEW_LIMIT = 5;
  const head = titles.slice(0, PREVIEW_LIMIT);
  const remaining = titles.length - head.length;
  // Render as a single comma-joined string — avoids per-item React keys
  // (titles can transiently collide while the user is editing the
  // template, which would log key-duplication warnings if we mapped
  // them into individual <span>s).
  return (
    <div
      className="rounded border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-700"
      data-test-id="bulkCreatePreview"
    >
      <span className="font-medium text-gray-900">Preview:</span>{" "}
      <span className="font-mono">{head.join(", ")}</span>
      {remaining > 0 ? (
        <span className="text-gray-500"> …and {remaining} more</span>
      ) : null}
    </div>
  );
}

/** Radio card options for the tracking method selector. */
const TRACKING_OPTIONS = [
  {
    value: AssetType.QUANTITY_TRACKED,
    title: "Quantity",
    description: "Identical units managed as one quantity.",
  },
  {
    value: AssetType.INDIVIDUAL,
    title: "Individual QR tracking",
    description: "Each physical unit has its own QR code and history.",
  },
] as const;

/**
 * Styled radio-card selector for choosing the asset tracking method.
 * Renders compact cards with radio circle, title, and description.
 */
function TrackingMethodCards({
  selectedAssetType,
  onSelect,
  disabled,
}: {
  selectedAssetType: AssetType;
  onSelect: (type: AssetType) => void;
  disabled: boolean;
}) {
  const cards = (
    <div className="grid gap-2 sm:grid-cols-2">
      {TRACKING_OPTIONS.map((option) => {
        const isSelected = selectedAssetType === option.value;
        return (
          <button
            key={option.value}
            type="button"
            disabled={disabled}
            aria-pressed={isSelected}
            onClick={() => onSelect(option.value)}
            className={tw(
              "flex min-h-16 items-start gap-2 rounded-md border px-3 py-2 text-left transition-colors",
              isSelected
                ? "border-primary-500 bg-primary-500 text-white"
                : "border-gray-200 bg-white hover:border-gray-300",
              disabled && "cursor-not-allowed opacity-50"
            )}
          >
            {/* Radio circle indicator */}
            <span
              className={tw(
                "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border-2",
                isSelected ? "border-white" : "border-gray-300"
              )}
            >
              {isSelected && <span className="size-2 rounded-full bg-white" />}
            </span>
            <div className="flex min-w-0 flex-col">
              <span
                className={tw(
                  "text-sm font-medium",
                  isSelected ? "text-white" : "text-gray-900"
                )}
              >
                {option.title}
              </span>
              <span
                className={tw(
                  "text-xs leading-4",
                  isSelected ? "text-white/90" : "text-gray-600"
                )}
              >
                {option.description}
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );

  return cards;
}
