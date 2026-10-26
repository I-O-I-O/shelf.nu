export type ImportWorkDescription = {
  rowKey: string;
  unitIndex: number | null;
  kind: string;
  idempotencyKey: string;
  identityKey: string;
  expectedPrior?: Record<string, string | number | null>;
};

/**
 * Builds deterministic row-level work for a prepared proposal. Unit-level
 * descriptors can use the same identity helper when a later phase needs them.
 */
export function planStaffInventoryImport(proposal: {
  operationId: string;
  rows: ReadonlyArray<{ rowNumber: number; action: string }>;
}): ImportWorkDescription[] {
  return proposal.rows.map((row) => {
    const rowKey = `row-${row.rowNumber}`;
    const unitIndex = null;
    const identityKey = getImportItemIdentityKey({ rowKey, unitIndex });
    return {
      rowKey,
      unitIndex,
      kind: row.action,
      identityKey,
      idempotencyKey: `${proposal.operationId}:${identityKey}`,
    };
  });
}

/** Plan stable per-unit ledger identities; IDs are assigned by ledger ensure. */
export function planIndividualUnitWork({
  operationId,
  rowNumber,
  units,
  assetModelId,
}: {
  operationId: string;
  rowNumber: number;
  assetModelId: string;
  units: Array<{ unitIndex: number; title: string }>;
}): ImportWorkDescription[] {
  const rowKey = `row-${rowNumber}`;
  return units.map(({ unitIndex, title }) => {
    const identityKey = getImportItemIdentityKey({ rowKey, unitIndex });
    return {
      rowKey,
      unitIndex,
      kind: "INDIVIDUAL_UNIT_CREATE",
      identityKey,
      idempotencyKey: `${operationId}:${identityKey}`,
      expectedPrior: { kind: "INDIVIDUAL_UNIT", assetModelId, title },
    };
  });
}

/** Format physical units consistently with Shelf's bulk-create route. */
export function formatIndividualUnitTitle({
  productTitle,
  quantity,
  unitIndex,
}: {
  productTitle: string;
  quantity: number;
  unitIndex: number;
}) {
  if (quantity === 1) return productTitle.trim();
  const width = Math.max(3, String(quantity).length);
  return `${productTitle.trim()} #${String(unitIndex + 1).padStart(
    width,
    "0"
  )}`;
}

/**
 * Resolve colliding display titles deterministically. Identity remains the
 * operation/row/unit ledger key, and callers persist the resolved title.
 */
export function resolveIndividualUnitTitles({
  productTitle,
  quantity,
  rowNumber,
  operationId,
  existingTitles,
}: {
  productTitle: string;
  quantity: number;
  rowNumber: number;
  operationId: string;
  existingTitles: ReadonlySet<string>;
}) {
  const usedTitles = new Set(existingTitles);
  const importSuffix = `${operationId.slice(-6)}-r${rowNumber}`;
  return Array.from({ length: quantity }, (_, unitIndex) => {
    const baseTitle = formatIndividualUnitTitle({
      productTitle,
      quantity,
      unitIndex,
    });
    let resolvedTitle = baseTitle;
    if (usedTitles.has(resolvedTitle)) {
      const unitSuffix = `${importSuffix}-u${String(unitIndex + 1).padStart(
        3,
        "0"
      )}`;
      resolvedTitle = `${baseTitle} (import ${unitSuffix})`;
      let collisionIndex = 2;
      while (usedTitles.has(resolvedTitle)) {
        resolvedTitle = `${baseTitle} (import ${unitSuffix}-${collisionIndex})`;
        collisionIndex += 1;
      }
    }
    usedTitles.add(resolvedTitle);
    return { unitIndex, title: resolvedTitle };
  });
}

/** Chunk work without renumbering its stable global unitIndex identities. */
export function chunkImportUnitWork<T extends { unitIndex: number }>(
  units: readonly T[],
  chunkSize: number
): T[][] {
  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    throw new Error("Import unit chunk size must be a positive integer.");
  }
  const chunks: T[][] = [];
  for (let index = 0; index < units.length; index += chunkSize) {
    chunks.push(units.slice(index, index + chunkSize));
  }
  return chunks;
}

export function getImportItemIdentityKey({
  rowKey,
  unitIndex,
}: {
  rowKey: string;
  unitIndex: number | null;
}) {
  return unitIndex === null ? `${rowKey}:row` : `${rowKey}:unit:${unitIndex}`;
}
