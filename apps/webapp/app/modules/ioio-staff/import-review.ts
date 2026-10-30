export type StaffImportReviewState =
  | "READY"
  | "NEEDS_REVIEW"
  | "CONFLICT"
  | "INVALID"
  | "SKIPPED";

export type ImportReviewDecision = {
  decision: "APPROVE" | "IGNORE" | null;
  title?: string;
  assetId?: string | null;
  categoryId?: string | null;
  newCategoryName?: string | null;
  approveNewCategory?: boolean;
  locationId?: string | null;
  quantity?: number | null;
  type?: "INDIVIDUAL" | "QUANTITY_TRACKED" | null;
  trackingModeConfirmed?: boolean;
  trackingModeSelectedByStaff?: boolean;
  productChoice?: "EXISTING" | "NEW" | null;
  minQuantity?: number | null;
  unitOfMeasure?: string | null;
  consumptionType?: "ONE_WAY" | "TWO_WAY" | null;
};

export type ImportReviewRow = {
  action: string;
  title: string;
  assetId: string | null;
  categoryId: string | null;
  locationId: string | null;
  type: "INDIVIDUAL" | "QUANTITY_TRACKED" | null;
  trackingSource?:
    | "EXISTING_MODEL"
    | "DETERMINISTIC_DEFAULT"
    | "DETERMINISTIC_EQUIPMENT_EVIDENCE"
    | "SOURCE_EXPLICIT"
    | "CLAUDE_ASSISTED"
    | "MANUAL_OVERRIDE";
  quantity: number | null;
  helperCandidate?: unknown;
  categoryResolution?: string;
  locationResolution?: string;
  categoryOptional?: boolean;
  mouserLineItem?: boolean;
  reviewConflictReason?: string | null;
  uncertainFields?: string[];
};

export function resolveImportReviewState({
  row,
  decision,
  categoryAvailable,
  locationAvailable,
  categoryPermission = true,
}: {
  row: ImportReviewRow;
  decision: ImportReviewDecision | undefined;
  categoryAvailable: boolean;
  locationAvailable: boolean;
  categoryPermission?: boolean;
}): StaffImportReviewState {
  if (decision?.decision === "IGNORE") return "SKIPPED";
  if (row.action === "REJECT") return "INVALID";
  if (row.reviewConflictReason || row.action === "CONFLICT") return "CONFLICT";
  if (!decision || decision.decision !== "APPROVE") return "NEEDS_REVIEW";
  if (!decision.title?.trim()) return "NEEDS_REVIEW";
  if (
    (row.action === "POSSIBLE_DUPLICATE" || row.action === "AMBIGUOUS") &&
    (!decision.productChoice ||
      (decision.productChoice === "EXISTING" && !decision.assetId))
  ) {
    return "NEEDS_REVIEW";
  }
  if (decision.productChoice === "NEW" && decision.assetId) return "INVALID";
  if (row.locationResolution === "AMBIGUOUS" && !decision.locationId) {
    return "NEEDS_REVIEW";
  }
  if (
    ["UNMATCHED", "OPERATIONAL"].includes(row.locationResolution ?? "") &&
    !decision.locationId
  ) {
    return "NEEDS_REVIEW";
  }
  if (decision.locationId && !locationAvailable) return "CONFLICT";
  if (decision.categoryId && !categoryAvailable) return "CONFLICT";
  if (row.categoryResolution === "AMBIGUOUS" && !decision.categoryId) {
    return "NEEDS_REVIEW";
  }
  if (row.categoryResolution === "ARCHIVED_MATCH" && !decision.categoryId) {
    return "NEEDS_REVIEW";
  }
  if (decision.approveNewCategory) {
    if (decision.categoryId) return "INVALID";
    if (
      !decision.newCategoryName?.trim() ||
      decision.newCategoryName.trim().length < 3
    ) {
      return "NEEDS_REVIEW";
    }
    if (!categoryPermission) return "NEEDS_REVIEW";
  } else if (
    !decision.categoryId &&
    !row.categoryOptional &&
    !row.mouserLineItem
  ) {
    return "NEEDS_REVIEW";
  }
  const requiresTracking =
    !row.mouserLineItem &&
    (row.action === "CREATE" ||
      Boolean(row.helperCandidate) ||
      (!row.assetId &&
        (row.action === "NEEDS_REVIEW" || decision.productChoice === "NEW")));
  if (requiresTracking && !decision.type) return "NEEDS_REVIEW";
  const existingModelSelection =
    row.trackingSource === "EXISTING_MODEL" ||
    (decision.productChoice === "EXISTING" && Boolean(decision.assetId));
  if (
    existingModelSelection &&
    row.trackingSource === "EXISTING_MODEL" &&
    decision.type &&
    row.type &&
    decision.type !== row.type
  ) {
    return "CONFLICT";
  }
  if (
    requiresTracking &&
    decision.type === "INDIVIDUAL" &&
    !existingModelSelection
  ) {
    if (
      decision.trackingModeConfirmed !== true ||
      (decision.trackingModeSelectedByStaff !== true &&
        row.trackingSource !== "MANUAL_OVERRIDE")
    ) {
      return "NEEDS_REVIEW";
    }
  }
  if (
    requiresTracking &&
    (!Number.isInteger(decision.quantity) || (decision.quantity ?? 0) <= 0)
  ) {
    return "NEEDS_REVIEW";
  }
  if (requiresTracking && decision.type === "QUANTITY_TRACKED") {
    if (
      decision.minQuantity != null &&
      (!Number.isInteger(decision.minQuantity) || decision.minQuantity < 0)
    )
      return "INVALID";
    if (!decision.unitOfMeasure?.trim() || !decision.consumptionType) {
      return "NEEDS_REVIEW";
    }
    if (
      decision.unitOfMeasure != null &&
      (!decision.unitOfMeasure.trim() || decision.unitOfMeasure.length > 100)
    )
      return "INVALID";
    if (
      decision.consumptionType != null &&
      !["ONE_WAY", "TWO_WAY"].includes(decision.consumptionType)
    )
      return "INVALID";
  }
  const resolvedFields = new Set([
    "Helper proposal",
    ...(decision.title?.trim() ? ["Item name"] : []),
    ...(decision.productChoice ? ["Product match"] : []),
    ...(decision.categoryId || decision.approveNewCategory ? ["Category"] : []),
    ...(row.categoryOptional || row.mouserLineItem ? ["Category"] : []),
    ...(decision.locationId !== undefined ? ["Location"] : []),
    ...(decision.quantity !== null ? ["Quantity", "Received quantity"] : []),
    ...(decision.type ? ["Tracking type", "Tracking mode"] : []),
  ]);
  if (row.uncertainFields?.some((field) => !resolvedFields.has(field))) {
    return "NEEDS_REVIEW";
  }
  return "READY";
}

export type ImportReviewIssueCode =
  | "MISSING_QUANTITY"
  | "INVALID_QUANTITY"
  | "MISSING_CATEGORY"
  | "MISSING_LOCATION"
  | "AMBIGUOUS_EXISTING_MATCH"
  | "TRACKING_REVIEW_REQUIRED"
  | "INVALID_PRODUCT_IDENTITY"
  | "INVALID_CATEGORY"
  | "INVALID_LOCATION"
  | "INVALID_INVENTORY_SETTINGS"
  | "CANONICAL_DATA_CHANGED"
  | "SOURCE_REVIEW_REQUIRED"
  | "ALREADY_IMPORTED"
  | "IGNORED";
export type ImportReviewIssue = {
  code: ImportReviewIssueCode;
  message: string;
};
export type ImportRowReadiness = {
  ready: boolean;
  state: "READY" | "NEEDS_REVIEW" | "IMPORTED" | "IGNORED";
  issues: ImportReviewIssue[];
};

/** Required decisions, independent of historical classification or approval clicks. */
export function validateImportRowForApply({
  row,
  decision,
  categoryAvailable,
  locationAvailable,
  categoryPermission = true,
  alreadyImported = false,
  canonicalIssue,
}: {
  row: ImportReviewRow;
  decision?: ImportReviewDecision;
  categoryAvailable: boolean;
  locationAvailable: boolean;
  categoryPermission?: boolean;
  alreadyImported?: boolean;
  canonicalIssue?: ImportReviewIssue;
}): ImportRowReadiness {
  const title = decision?.title?.trim() || row.title?.trim() || "This item";
  const issues: ImportReviewIssue[] = [];
  const add = (code: ImportReviewIssueCode, message: string) =>
    issues.push({ code, message });
  if (alreadyImported)
    return {
      ready: false,
      state: "IMPORTED",
      issues: [
        {
          code: "ALREADY_IMPORTED",
          message: `${title} has already been imported.`,
        },
      ],
    };
  if (decision?.decision === "IGNORE" || row.action === "IGNORE")
    return {
      ready: false,
      state: "IGNORED",
      issues: [{ code: "IGNORED", message: `${title} is ignored.` }],
    };
  if (!(decision?.title ?? row.title)?.trim() || row.action === "REJECT")
    add(
      "INVALID_PRODUCT_IDENTITY",
      `Review the product identity for ${title} before importing it.`
    );
  const quantity =
    decision?.quantity !== undefined ? decision.quantity : row.quantity;
  if (quantity == null)
    add("MISSING_QUANTITY", `Enter the received quantity for ${title}.`);
  else if (
    !Number.isSafeInteger(quantity) ||
    quantity <= 0 ||
    quantity > 1_000_000
  )
    add(
      "INVALID_QUANTITY",
      `${title} needs a positive whole-number quantity within the import limit.`
    );
  const categoryId =
    decision?.categoryId !== undefined ? decision.categoryId : row.categoryId;
  if (decision?.approveNewCategory) {
    if (
      categoryId ||
      !categoryPermission ||
      (decision.newCategoryName?.trim().length ?? 0) < 3
    )
      add(
        "INVALID_CATEGORY",
        `Choose an existing category or review permission to create a category for ${title}.`
      );
  } else if (!categoryId && !row.categoryOptional && !row.mouserLineItem)
    add(
      "MISSING_CATEGORY",
      `${title} needs a category before it can be imported.`
    );
  if (categoryId && !categoryAvailable)
    add(
      "INVALID_CATEGORY",
      `Choose a valid active category for ${title}; the reviewed category is no longer available.`
    );
  const locationId =
    decision?.locationId !== undefined ? decision.locationId : row.locationId;
  if (
    !locationId &&
    ["AMBIGUOUS", "UNMATCHED", "OPERATIONAL"].includes(
      row.locationResolution ?? ""
    )
  )
    add(
      "MISSING_LOCATION",
      `Choose a location for ${title} before importing it.`
    );
  if (locationId && !locationAvailable)
    add(
      "INVALID_LOCATION",
      `Choose a valid location for ${title}; the reviewed location changed or is no longer available.`
    );
  if (
    (["POSSIBLE_DUPLICATE", "AMBIGUOUS"].includes(row.action) &&
      !decision?.productChoice) ||
    (decision?.productChoice === "EXISTING" && !decision.assetId)
  )
    add(
      "AMBIGUOUS_EXISTING_MATCH",
      `${title} may already exist. Choose Use existing, Create new, or Ignore.`
    );
  if (decision?.productChoice === "NEW" && decision.assetId)
    add(
      "INVALID_PRODUCT_IDENTITY",
      `Clear the existing product selection before creating ${title} as new.`
    );
  const type = decision?.type !== undefined ? decision.type : row.type;
  const existing =
    decision?.productChoice !== "NEW" &&
    (Boolean(row.assetId) ||
      row.trackingSource === "EXISTING_MODEL" ||
      (decision?.productChoice === "EXISTING" && Boolean(decision.assetId)));
  if (
    (!type && !row.mouserLineItem) ||
    (type === "INDIVIDUAL" &&
      !existing &&
      (decision?.trackingModeConfirmed !== true ||
        (decision?.trackingModeSelectedByStaff !== true &&
          row.trackingSource !== "MANUAL_OVERRIDE"))) ||
    (existing && row.type && type !== row.type)
  )
    add(
      "TRACKING_REVIEW_REQUIRED",
      `Confirm the tracking type for ${title}. Existing Shelf tracking cannot be changed during import.`
    );
  if (
    type === "QUANTITY_TRACKED" &&
    ((decision?.minQuantity != null &&
      (!Number.isSafeInteger(decision.minQuantity) ||
        decision.minQuantity < 0)) ||
      (decision?.unitOfMeasure != null &&
        (!decision.unitOfMeasure.trim() ||
          decision.unitOfMeasure.length > 100)) ||
      (decision?.consumptionType != null &&
        !["ONE_WAY", "TWO_WAY"].includes(decision.consumptionType)))
  )
    add(
      "INVALID_INVENTORY_SETTINGS",
      `Review the stock unit, minimum quantity, and consumption settings for ${title}.`
    );
  if (canonicalIssue) issues.push(canonicalIssue);
  const knownFields = new Set([
    "Item name",
    "Product match",
    "Category",
    "Location",
    "Quantity",
    "Received quantity",
    "Tracking type",
    "Tracking mode",
    "Helper proposal",
  ]);
  const unresolved = row.uncertainFields?.filter(
    (field) => !knownFields.has(field) && !/image|description/i.test(field)
  );
  if (unresolved?.length)
    add(
      "SOURCE_REVIEW_REQUIRED",
      `Review ${unresolved.join(", ")} for ${title}.`
    );
  return {
    ready: issues.length === 0,
    state: issues.length ? "NEEDS_REVIEW" : "READY",
    issues,
  };
}
