import { db } from "~/database/db.server";
import { ShelfError } from "~/utils/error";
import { Logger } from "~/utils/logger";
import type { ImportLedgerItem } from "./import-ledger.server";
import type { StaffImportResult } from "./inventory-import.server";

/** Reconcile reported IDs with persisted DONE evidence and canonical assets. */
export async function verifyImportResult({
  result,
  ledger,
  organizationId,
}: {
  result: StaffImportResult;
  ledger: ImportLedgerItem[];
  organizationId: string;
}) {
  const proof = new Set<string>();
  for (const item of ledger) {
    if (
      item.status !== "DONE" ||
      !item.writtenState ||
      typeof item.writtenState !== "object" ||
      Array.isArray(item.writtenState)
    )
      continue;
    const state = item.writtenState;
    if (typeof state.assetId === "string") proof.add(state.assetId);
    if (Array.isArray(state.assetIds))
      for (const id of state.assetIds)
        if (typeof id === "string") proof.add(id);
  }
  const ids = [
    ...new Set([
      ...result.createdIds,
      ...result.updatedIds,
      ...result.reusedIds,
    ]),
  ];
  const assets = ids.length
    ? await db.asset.findMany({
        where: { organizationId, id: { in: ids } },
        select: { id: true },
      })
    : [];
  const existing = new Set(assets.map((asset) => asset.id));
  const missing = ids.filter((id) => !proof.has(id) || !existing.has(id));
  if (missing.length) {
    Logger.info({
      event: "ioio_import_persistence_mismatch",
      operationId: result.operationId,
      claimedWrites: ids.length,
      canonicalWritesCommitted: ids.filter((id) => existing.has(id)).length,
      historyRowsPersisted: ledger.filter((item) => item.status === "DONE")
        .length,
      unverifiedAssetIds: missing,
    });
    throw new ShelfError({
      cause: null,
      label: "Assets",
      status: 409,
      shouldBeCaptured: false,
      message:
        "Import persistence could not be verified. No success summary is available; reload the import and inspect its history.",
    });
  }
  return { ...result, persistenceVerified: true as const };
}
