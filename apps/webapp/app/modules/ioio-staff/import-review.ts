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
