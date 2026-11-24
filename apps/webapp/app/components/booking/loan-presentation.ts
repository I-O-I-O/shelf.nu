import { BookingStatus } from "@prisma/client";
import { getIoioPhysicalUnitDisplayName } from "../../modules/kit/ioio-kit-presentation";

export type LoanLifecycleAsset = {
  checkedOutAt: Date | string | null;
  checkedInAt: Date | string | null;
  checkedOutQuantity?: number | null;
  quantity?: number | null;
  asset?: {
    id: string;
    title: string;
    type?: string;
    quantity?: number | null;
    sequentialId?: string | null;
    logicalProductName?: string | null;
    mainImage: string | null;
    thumbnailImage: string | null;
    assetModel?: {
      image: string | null;
      thumbnailImage: string | null;
    } | null;
  };
};

export type LoanAssetDisplaySource = {
  title: string;
  type?: string;
  sequentialId?: string | null;
  logicalProductName?: string | null;
};

export function getLoanPhysicalUnitNumber({
  title,
  type,
}: LoanAssetDisplaySource) {
  if (type && type !== "INDIVIDUAL") return null;

  const titleUnit = title.match(/(?:^|\s)(?:-\s*)?#(\d+)\s*$/u)?.[1];
  const normalizedTitleUnit = titleUnit ? normalizeUnitNumber(titleUnit) : null;
  return normalizedTitleUnit ? `#${normalizedTitleUnit}` : null;
}

function normalizeUnitNumber(value: string) {
  const trimmed = value.trim().replace(/^#/u, "");
  if (!/^\d+$/u.test(trimmed)) return null;
  return trimmed.replace(/^0+(?=\d)/u, "").padStart(3, "0");
}

export function getLoanAssetDisplayName(asset: LoanAssetDisplaySource) {
  const unitNumber = getLoanPhysicalUnitNumber(asset);
  const titleWithoutUnit = asset.title.replace(/(?:\s+#\d+)+\s*$/u, "").trim();
  const logicalName = (
    asset.logicalProductName?.trim() ||
    titleWithoutUnit ||
    asset.title
  ).replace(/(?:\s+#\d+)+\s*$/u, "");

  const isPhysicalUnit =
    asset.type === "INDIVIDUAL" || (!asset.type && Boolean(unitNumber));
  if (!isPhysicalUnit) return logicalName;
  return getIoioPhysicalUnitDisplayName({
    logicalProductName: logicalName,
    unitNumber,
    missingUnitLabel: "Unit number missing",
  });
}

export type LoanReturnLog = {
  category: string;
  quantity?: number | null;
  createdAt: Date | string;
};

export type LoanLifecycleSource = {
  status: BookingStatus;
  to: Date | string | null;
  originalTo?: Date | string | null;
  archivedWithoutCheckin?: boolean;
  bookingAssets?: LoanLifecycleAsset[];
  consumptionLogs?: LoanReturnLog[];
};

export type LoanLifecycle = {
  borrowedAt: Date | string | null;
  dueAt: Date | string | null;
  returnedAt: Date | string | null;
  statusLabel: "Active" | "Partially returned" | "Returned" | "Overdue";
};

/** Friendly status text for IOIO-facing loan details. */
export function getLoanStatusLabel(status: BookingStatus) {
  const labels: Record<BookingStatus, string> = {
    [BookingStatus.DRAFT]: "Draft",
    [BookingStatus.RESERVED]: "Reserved",
    [BookingStatus.ONGOING]: "Borrowed",
    [BookingStatus.OVERDUE]: "Overdue",
    [BookingStatus.COMPLETE]: "Returned",
    [BookingStatus.ARCHIVED]: "Archived",
    [BookingStatus.CANCELLED]: "Cancelled",
  };
  return labels[status];
}

/**
 * Converts a planned booking value into a calendar-date string before display.
 * Planned return dates are calendar values in the staff UI, so formatting the
 * UTC instant directly must not move them across a viewer's timezone boundary.
 */
export function getLoanListDateValue(
  value: Date | string | null | undefined,
  planned = false
) {
  if (!value) return null;
  if (planned && typeof value === "string") {
    const dateOnly = value.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
    if (dateOnly) return dateOnly;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return planned ? date.toISOString().slice(0, 10) : value;
}

function asTimestamp(value: Date | string | null | undefined) {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? null : timestamp;
}

function minDate(values: Array<Date | string | null | undefined>) {
  const valid = values
    .map((value) => ({ value, timestamp: asTimestamp(value) }))
    .filter(
      (entry): entry is { value: Date | string; timestamp: number } =>
        entry.timestamp !== null
    )
    .sort((left, right) => left.timestamp - right.timestamp);
  return valid[0]?.value ?? null;
}

function maxDate(values: Array<Date | string | null | undefined>) {
  const valid = values
    .map((value) => ({ value, timestamp: asTimestamp(value) }))
    .filter(
      (entry): entry is { value: Date | string; timestamp: number } =>
        entry.timestamp !== null
    )
    .sort((left, right) => right.timestamp - left.timestamp);
  return valid[0]?.value ?? null;
}

/**
 * Resolves the staff-facing lifecycle from actual checkout/check-in markers.
 * Planned booking dates never become a return timestamp.
 */
export function getLoanLifecycle(booking: LoanLifecycleSource): LoanLifecycle {
  const assets = booking.bookingAssets ?? [];
  const checkedOutAssets = assets.filter((asset) => asset.checkedOutAt);
  const hasCheckedOutActivity = checkedOutAssets.length > 0;
  const hasCheckedInActivity = assets.some((asset) => asset.checkedInAt);
  const returnLogs = (booking.consumptionLogs ?? []).filter(
    (log) => log.category === "RETURN" || log.category === "DAMAGE"
  );
  const returnedAt = maxDate([
    ...assets.map((asset) => asset.checkedInAt),
    ...returnLogs.map((log) => log.createdAt),
  ]);
  const allCheckedOutAssetsReturned =
    hasCheckedOutActivity &&
    checkedOutAssets.every((asset) => Boolean(asset.checkedInAt));
  const returned =
    !booking.archivedWithoutCheckin &&
    (booking.status === BookingStatus.COMPLETE ||
      (allCheckedOutAssetsReturned && hasCheckedInActivity));
  const partiallyReturned = !returned && Boolean(returnedAt);

  let statusLabel: LoanLifecycle["statusLabel"] = "Active";
  if (returned) {
    statusLabel = "Returned";
  } else if (partiallyReturned) {
    statusLabel = "Partially returned";
  } else if (booking.status === BookingStatus.OVERDUE) {
    statusLabel = "Overdue";
  }

  return {
    borrowedAt: minDate(checkedOutAssets.map((asset) => asset.checkedOutAt)),
    dueAt: booking.originalTo ?? booking.to,
    returnedAt,
    statusLabel,
  };
}
