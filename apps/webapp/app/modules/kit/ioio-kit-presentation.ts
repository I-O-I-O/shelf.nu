/**
 * Presentation-only Kit identity used by IOIO surfaces.
 *
 * Shelf Kit records remain independent database records. This helper only
 * chooses one canonical option when the same active Kit was accidentally
 * surfaced more than once, using more than the display name as its identity.
 */

export type IoioKitPresentationCandidate = {
  id: string;
  name: string;
  categoryId?: string | null;
  locationId?: string | null;
  assetCount?: number | null;
  status?: string | null;
  updatedAt?: Date | string | null;
};

/**
 * Use Shelf's native Kit.name as the one display name for Kit surfaces. Old
 * imported unit identifiers are presentation suffixes, not part of a Kit's
 * canonical name. Contents, QR metadata, and historical values are not name
 * sources.
 */
export function getIoioKitDisplayName(kit: { name: string }) {
  const canonicalName = kit.name.replace(/\s+(?:-\s*)?#\d+\b.*$/u, "").trim();
  return canonicalName || kit.name;
}

/** Return an explicitly stored trailing physical-unit number, if present. */
export function getIoioKitPhysicalUnitNumber(kit: { name: string }) {
  const explicitNumber = kit.name.match(/(?:^|\s)(?:-\s*)?#(\d+)\s*$/u)?.[1];
  const normalizedExplicitNumber = explicitNumber
    ? normalizeUnitNumber(explicitNumber)
    : null;
  return normalizedExplicitNumber ? `#${normalizedExplicitNumber}` : null;
}

export type IoioPhysicalUnitDisplayInput = {
  logicalProductName: string;
  unitNumber?: string | null;
  /** Used only for a known physical unit whose canonical number is missing. */
  missingUnitLabel?: string;
};

/**
 * Build one display name for a physical unit without duplicating a suffix
 * that may already be present in an imported asset title.
 */
export function getIoioPhysicalUnitDisplayName(
  nameOrInput: string | IoioPhysicalUnitDisplayInput,
  unitLabel?: string | null
) {
  const isStructuredInput = typeof nameOrInput !== "string";
  const name = isStructuredInput ? nameOrInput.logicalProductName : nameOrInput;
  const requestedUnitLabel = isStructuredInput
    ? nameOrInput.unitNumber
    : unitLabel;
  const trimmedName = name.trim();
  const logicalName = trimmedName.replace(/\s+(?:-\s*)?#\d+\b.*$/u, "").trim();
  if (!requestedUnitLabel?.trim()) {
    return isStructuredInput && nameOrInput.missingUnitLabel
      ? `${logicalName || trimmedName} ${nameOrInput.missingUnitLabel}`
      : trimmedName;
  }

  const numericUnit = normalizeUnitNumber(requestedUnitLabel);
  if (!numericUnit) {
    return isStructuredInput && nameOrInput.missingUnitLabel
      ? `${logicalName || trimmedName} ${nameOrInput.missingUnitLabel}`
      : logicalName || trimmedName;
  }
  const normalizedUnit = `#${numericUnit}`;

  return logicalName ? `${logicalName} ${normalizedUnit}` : normalizedUnit;
}

function normalizeUnitNumber(value: string) {
  const trimmed = value.trim().replace(/^#/u, "");
  if (!/^\d+$/u.test(trimmed)) return null;
  return trimmed.replace(/^0+(?=\d)/u, "").padStart(3, "0");
}

export function deduplicateIoioKitPresentationCandidates<
  T extends IoioKitPresentationCandidate,
>(items: T[], preferredId?: string): T[] {
  const groups = new Map<string, T[]>();

  for (const item of items) {
    const key = [
      normalizeKitName(getIoioKitDisplayName(item)),
      item.categoryId ?? "",
      item.locationId ?? "",
    ].join("\u0000");
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }

  return [...groups.values()].map((candidates) =>
    selectCanonicalIoioKitCandidate(candidates, preferredId)
  );
}

export function selectCanonicalIoioKitCandidate<
  T extends IoioKitPresentationCandidate,
>(candidates: T[], preferredId?: string): T {
  if (candidates.length === 0) {
    throw new Error("At least one Kit candidate is required");
  }

  return [...candidates].sort((left, right) => {
    const preferredDifference =
      Number(right.id === preferredId) - Number(left.id === preferredId);
    if (preferredDifference !== 0) return preferredDifference;

    const assetCountDifference =
      Math.max(0, right.assetCount ?? 0) - Math.max(0, left.assetCount ?? 0);
    if (assetCountDifference !== 0) return assetCountDifference;

    const availableDifference =
      Number(right.status === "AVAILABLE") -
      Number(left.status === "AVAILABLE");
    if (availableDifference !== 0) return availableDifference;

    const updatedDifference =
      toTimestamp(right.updatedAt) - toTimestamp(left.updatedAt);
    if (updatedDifference !== 0) return updatedDifference;

    return left.id.localeCompare(right.id);
  })[0];
}

function normalizeKitName(name: string) {
  return name.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function toTimestamp(value: Date | string | null | undefined) {
  if (!value) return 0;
  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? 0 : timestamp;
}
