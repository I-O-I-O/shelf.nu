import { beforeEach, expect, it, vi } from "vitest";
import type { ImportLedgerItem } from "./import-ledger.server";
import { verifyImportResult } from "./import-persistence.server";
import type { StaffImportResult } from "./inventory-import.server";
const assets = vi.hoisted(() => vi.fn());
// why: test committed database evidence and missing assets without live writes.
vi.mock("~/database/db.server", () => ({
  db: { asset: { findMany: assets } },
}));
function args() {
  const result: StaffImportResult = {
    operationId: "operation",
    createdIds: ["asset"],
    updatedIds: [],
    reusedIds: [],
    failedRows: [],
    conflictRows: [],
    ignoredRows: 0,
    reviewedRows: 1,
    totalRows: 1,
    succeededRows: 1,
    failedRowsCount: 0,
    conflictedRowsCount: 0,
    skippedRows: 0,
  };
  const ledgerItem: ImportLedgerItem = {
    id: "item",
    operationId: "operation",
    organizationId: "org",
    rowKey: "row-1",
    unitIndex: null,
    identityKey: "row-1",
    kind: "CREATE",
    status: "DONE",
    idempotencyKey: "operation:row-1",
    expectedPrior: null,
    writtenState: { outcome: "created", assetId: "asset" },
    targetAssetId: "asset",
    targetKitId: null,
    qrId: null,
    attempt: 1,
    heartbeatAt: new Date("2026-01-01T00:00:00.000Z"),
    errorCode: null,
    errorMessage: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
  return {
    organizationId: "org",
    result,
    ledger: [ledgerItem],
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  assets.mockResolvedValue([{ id: "asset" }]);
});
it("verifies canonical existence and persisted DONE evidence before reporting a create", async () => {
  expect(await verifyImportResult(args())).toMatchObject({
    persistenceVerified: true,
    createdIds: ["asset"],
  });
  expect(assets).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { organizationId: "org", id: { in: ["asset"] } },
    })
  );
});
it("refuses phantom or rolled-back creates despite DONE ledger evidence", async () => {
  assets.mockResolvedValue([]);
  await expect(verifyImportResult(args())).rejects.toThrow(
    "persistence could not be verified"
  );
});
it("refuses success without persisted DONE history", async () => {
  await expect(verifyImportResult({ ...args(), ledger: [] })).rejects.toThrow(
    "persistence could not be verified"
  );
});
