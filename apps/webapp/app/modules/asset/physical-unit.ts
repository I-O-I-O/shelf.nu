/** Shared physical-unit number parsing used by Inventory and borrowing. */

export function normalizePhysicalUnitNumber(value: string): string | null {
  const trimmed = value.trim().replace(/^#/u, "").trim();
  if (!/^\d+$/u.test(trimmed)) return null;

  const withoutLeadingZeroes = trimmed.replace(/^0+(?=\d)/u, "");
  return withoutLeadingZeroes.padStart(3, "0");
}

export function getPhysicalUnitNumberFromTitle(title: string): string | null {
  const match = title.match(/(?:^|\s)#(\d+)\s*$/u);
  return match?.[1] ? normalizePhysicalUnitNumber(match[1]) : null;
}

export function getPhysicalUnitBaseTitle(title: string): string {
  return title.replace(/\s+#\d+\s*$/u, "").trim();
}

export function getPhysicalUnitLabelFromTitle(title: string): string | null {
  const unitNumber = getPhysicalUnitNumberFromTitle(title);
  return unitNumber ? `#${unitNumber}` : null;
}
