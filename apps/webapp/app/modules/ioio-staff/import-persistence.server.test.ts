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
  return {
    organizationId: "org",
    result: {
      operationId: "operation",
      createdIds: ["asset"],
      updatedIds: [],
      reusedIds: [],
      failedRows: [],
      totalRows: 1,
      succeededRows: 1,
    } as unknown as StaffImportResult,
    ledger: [
      {
        status: "DONE",
        writtenState: { outcome: "created", assetId: "asset" },
      },
    ] as ImportLedgerItem[],
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
