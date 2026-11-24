import type { StaffImportProposalRow } from "./inventory-import.server";

export function buildLegacyImportedDescription(
  filename: string,
  row: StaffImportProposalRow
) {
  const parts = [
    `Imported from ${filename}`,
    row.sourceOrganization ? `Source lab: ${row.sourceOrganization}` : null,
    row.sourceRoom ? `Source room: ${row.sourceRoom}` : null,
    row.sourceStorageLocation
      ? `Source storage location: ${row.sourceStorageLocation}`
      : null,
    row.quantityIsEstimated
      ? `Source estimated quantity: ${row.sourceQuantity ?? row.quantity}`
      : null,
    row.sourceDescription
      ? `Source description: ${row.sourceDescription}`
      : null,
    row.manufacturer ? `Manufacturer: ${row.manufacturer}` : null,
    row.manufacturerPartNumber
      ? `Manufacturer part number: ${row.manufacturerPartNumber}`
      : null,
    row.supplierPartNumber
      ? `Supplier part number: ${row.supplierPartNumber}`
      : null,
    row.unitDescription ? `Unit: ${row.unitDescription}` : null,
    row.sourceNotes ? `Source notes: ${row.sourceNotes}` : null,
  ].filter(Boolean);
  return parts.join(". ").slice(0, 2000);
}

/** Product text only; source evidence remains in the immutable import proposal. */
export function importedDescription(
  row: Pick<
    StaffImportProposalRow,
    "title" | "assetModelDescription" | "sourceDescription"
  >
): string {
  for (const value of [row.assetModelDescription, row.sourceDescription]) {
    const text = value?.trim();
    if (
      !text ||
      text.length > 600 ||
      /Imported from|Source (?:lab|room|storage location|description|notes|estimated quantity):|Manufacturer(?: part number)?:|Supplier part number:|(?:debug|helper|parsing)\s*(?:metadata|notes|output):|\.(?:pdf|xlsx?|csv)\b/i.test(
        text
      )
    )
      continue;
    const normalize = (input: string) =>
      input
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "")
        .trim();
    if (
      normalize(text) === normalize(row.title) ||
      text.split(/\s+/).length < 5
    )
      continue;
    return (text.match(/[^.!?]+(?:[.!?]+|$)/g) ?? [text])
      .slice(0, 2)
      .join("")
      .trim();
  }
  return "";
}

/** Only exact historical generator output can be repaired automatically. */
export function repairImportedDescription(
  current: string | null,
  filename: string,
  row: StaffImportProposalRow
): string | null {
  const legacy = buildLegacyImportedDescription(filename, row);
  const enriched = [
    row.assetModelDescription?.trim(),
    row.sourceRoom || row.sourceOrganization || row.sourceStorageLocation
      ? legacy
      : null,
  ]
    .filter(Boolean)
    .join("\n\n");
  if (current !== legacy && current !== enriched) return null;
  if (!current?.includes(`Imported from ${filename}`)) return null;
  return importedDescription(row);
}
