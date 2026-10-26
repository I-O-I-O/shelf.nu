import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  ioioWriteOperation: { findFirst: vi.fn() },
  ioioImportItem: {
    createMany: vi.fn(),
    findMany: vi.fn(),
    findFirst: vi.fn(),
    updateMany: vi.fn(),
  },
}));

// why: these tests verify ledger coordination queries without connecting to a database.
vi.mock("~/database/db.server", () => ({ db: database }));

import {
  claimImportLedgerItem,
  ensureImportLedgerItems,
  findStaleImportLedgerItems,
  heartbeatImportLedgerItem,
  reconcileStaleImportLedgerItem,
  markImportLedgerItemDone,
  markImportLedgerItemFailed,
  recordImportLedgerExpectedPrior,
  STAFF_IMPORT_LEDGER_STALE_AFTER_MS,
} from "./import-ledger.server";
import { getImportItemIdentityKey } from "./import-planner";

const scope = { operationId: "operation-1", organizationId: "org-1" };
let storedItems: Array<Record<string, unknown>> = [];

function item(unitIndex: number | null = null) {
  const rowKey = "row-2";
  const identityKey = getImportItemIdentityKey({ rowKey, unitIndex });
  return {
    rowKey,
    unitIndex,
    identityKey,
    kind: "CREATE",
    idempotencyKey: `${scope.operationId}:${identityKey}`,
  };
}

describe("IOIO inventory import ledger", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storedItems = [];
    database.ioioWriteOperation.findFirst.mockResolvedValue({
      id: scope.operationId,
    });
    database.ioioImportItem.createMany.mockImplementation(({ data }) => {
      let count = 0;
      for (const row of data) {
        const exists = storedItems.some(
          (stored) =>
            stored.operationId === row.operationId &&
            stored.identityKey === row.identityKey
        );
        if (!exists) {
          storedItems.push({ ...row, status: "PENDING", attempt: 0 });
          count += 1;
        }
      }
      return { count };
    });
    database.ioioImportItem.findMany.mockImplementation(() => storedItems);
    database.ioioImportItem.findFirst.mockResolvedValue({ id: "item-1" });
    database.ioioImportItem.updateMany.mockResolvedValue({ count: 1 });
  });

  it("ensures the same deterministic ledger rows twice without duplicate work", async () => {
    const rows = [item()];
    await ensureImportLedgerItems({ ...scope, items: rows });
    await ensureImportLedgerItems({ ...scope, items: rows });

    expect(storedItems).toHaveLength(1);
    expect(database.ioioImportItem.createMany).toHaveBeenCalledTimes(2);
    expect(database.ioioImportItem.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          operationId: scope.operationId,
          organizationId: scope.organizationId,
          rowKey: "row-2",
          unitIndex: null,
          identityKey: "row-2:row",
          idempotencyKey: "operation-1:row-2:row",
        }),
      ],
      skipDuplicates: true,
    });
  });

  it("uses unitIndex to distinguish physical units while keeping row identity stable", async () => {
    await ensureImportLedgerItems({ ...scope, items: [item(0), item(1)] });
    const data = database.ioioImportItem.createMany.mock.calls[0][0].data;

    expect(data.map((row: { identityKey: string }) => row.identityKey)).toEqual(
      ["row-2:unit:0", "row-2:unit:1"]
    );
    expect(data[0].rowKey).toBe(data[1].rowKey);
    expect(data[0].idempotencyKey).not.toBe(data[1].idempotencyKey);
  });

  it("gives row-level work without unitIndex a deterministic identity", () => {
    expect(getImportItemIdentityKey({ rowKey: "row-2", unitIndex: null })).toBe(
      "row-2:row"
    );
  });

  it("lets only one concurrent caller claim PENDING work", async () => {
    let status = "PENDING";
    let attempt = 0;
    database.ioioImportItem.updateMany.mockImplementation(({ where, data }) => {
      if (
        where.status !== status ||
        where.organizationId !== scope.organizationId
      ) {
        return { count: 0 };
      }
      status = data.status;
      attempt += data.attempt.increment;
      return { count: 1 };
    });
    database.ioioImportItem.findFirst.mockImplementation(() => ({
      id: "item-1",
      status,
      attempt,
    }));

    const claims = await Promise.all([
      claimImportLedgerItem({ ...scope, itemId: "item-1" }),
      claimImportLedgerItem({ ...scope, itemId: "item-1" }),
    ]);

    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(status).toBe("IN_FLIGHT");
    expect(attempt).toBe(1);
  });

  it("fails a second claim safely and scopes claims to the organization", async () => {
    database.ioioImportItem.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      claimImportLedgerItem({ ...scope, itemId: "item-1" })
    ).resolves.toBeNull();
    expect(database.ioioImportItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: scope.organizationId,
          status: "PENDING",
        }),
      })
    );
    expect(database.ioioImportItem.findFirst).not.toHaveBeenCalled();
  });

  it("updates heartbeat only while the row is IN_FLIGHT", async () => {
    const now = new Date("2026-10-26T12:00:00Z");
    await expect(
      heartbeatImportLedgerItem({ ...scope, itemId: "item-1", now })
    ).resolves.toBe(true);
    expect(database.ioioImportItem.updateMany).toHaveBeenCalledWith({
      where: {
        id: "item-1",
        operationId: scope.operationId,
        organizationId: scope.organizationId,
        status: "IN_FLIGHT",
      },
      data: { heartbeatAt: now },
    });
  });

  it("records recovery evidence only for the active claimant", async () => {
    const expectedPrior = { action: "UPDATE_QUANTITY", before: 3, target: 5 };
    await recordImportLedgerExpectedPrior({
      ...scope,
      itemId: "item-1",
      expectedPrior,
    });
    expect(database.ioioImportItem.updateMany).toHaveBeenCalledWith({
      where: {
        id: "item-1",
        operationId: scope.operationId,
        organizationId: scope.organizationId,
        status: "IN_FLIGHT",
      },
      data: { expectedPrior },
    });
  });

  it("keeps DONE terminal when repeated planning encounters the same row", async () => {
    await ensureImportLedgerItems({ ...scope, items: [item()] });
    storedItems[0].status = "DONE";
    await ensureImportLedgerItems({ ...scope, items: [item()] });

    expect(storedItems).toHaveLength(1);
    expect(storedItems[0].status).toBe("DONE");
    expect(database.ioioImportItem.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true })
    );
    expect(database.ioioImportItem.updateMany).not.toHaveBeenCalled();
  });

  it("preserves attempt information while recording FAILED details", async () => {
    await markImportLedgerItemFailed({
      ...scope,
      itemId: "item-1",
      errorCode: "SHELF_REJECTED",
      errorMessage: "Category is not available.",
    });

    expect(database.ioioImportItem.updateMany).toHaveBeenCalledWith({
      where: {
        id: "item-1",
        operationId: scope.operationId,
        organizationId: scope.organizationId,
        status: "IN_FLIGHT",
      },
      data: {
        errorCode: "SHELF_REJECTED",
        errorMessage: "Category is not available.",
        status: "FAILED",
      },
    });
    expect(
      database.ioioImportItem.updateMany.mock.calls[0][0].data
    ).not.toHaveProperty("attempt");
  });

  it("records DONE only from an active claim", async () => {
    await markImportLedgerItemDone({
      ...scope,
      itemId: "item-1",
      targetAssetId: "asset-1",
    });
    expect(database.ioioImportItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "IN_FLIGHT" }),
        data: expect.objectContaining({
          status: "DONE",
          targetAssetId: "asset-1",
        }),
      })
    );
  });

  it("discovers stale in-flight items without resetting them", async () => {
    const now = new Date("2026-10-26T12:00:00Z");
    const staleBefore = new Date(
      now.getTime() - STAFF_IMPORT_LEDGER_STALE_AFTER_MS
    );
    await findStaleImportLedgerItems({
      now,
      organizationId: scope.organizationId,
      operationId: scope.operationId,
    });
    expect(database.ioioImportItem.findMany).toHaveBeenCalledWith({
      where: {
        status: "IN_FLIGHT",
        organizationId: scope.organizationId,
        operationId: scope.operationId,
        OR: [
          { heartbeatAt: { lt: staleBefore } },
          { heartbeatAt: null, updatedAt: { lt: staleBefore } },
        ],
      },
      orderBy: [{ heartbeatAt: "asc" }, { updatedAt: "asc" }],
    });
    expect(database.ioioImportItem.updateMany).not.toHaveBeenCalled();
  });

  it("only reconciles a row that is still IN_FLIGHT and stale", async () => {
    const staleBefore = new Date("2026-10-26T11:50:00Z");
    await reconcileStaleImportLedgerItem({
      ...scope,
      itemId: "item-1",
      staleBefore,
      status: "PENDING",
    });
    expect(database.ioioImportItem.updateMany).toHaveBeenCalledWith({
      where: {
        id: "item-1",
        operationId: scope.operationId,
        organizationId: scope.organizationId,
        status: "IN_FLIGHT",
        OR: [
          { heartbeatAt: { lt: staleBefore } },
          { heartbeatAt: null, updatedAt: { lt: staleBefore } },
        ],
      },
      data: { status: "PENDING", heartbeatAt: null },
    });
  });

  it("refuses to create rows if the parent is outside the organization", async () => {
    database.ioioWriteOperation.findFirst.mockResolvedValue(null);
    await expect(
      ensureImportLedgerItems({ ...scope, items: [item()] })
    ).rejects.toThrow("The inventory import operation was not found.");
    expect(database.ioioImportItem.createMany).not.toHaveBeenCalled();
  });
});
