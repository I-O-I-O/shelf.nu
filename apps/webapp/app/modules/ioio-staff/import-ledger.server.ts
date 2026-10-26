import type { Prisma } from "@prisma/client";
import { db } from "~/database/db.server";
import { id } from "~/utils/id/id.server";
import {
  getImportItemIdentityKey,
  type ImportWorkDescription,
} from "./import-planner";

export const IMPORT_ITEM_STATUSES = [
  "PENDING",
  "IN_FLIGHT",
  "DONE",
  "FAILED",
  "CONFLICT",
  "SKIPPED",
] as const;

// Ten minutes is longer than ordinary request-driven row writes and allows
// each row to refresh the lease before the next synchronous Shelf operation.
export const STAFF_IMPORT_LEDGER_STALE_AFTER_MS = 10 * 60 * 1000;

export type ImportItemStatus = (typeof IMPORT_ITEM_STATUSES)[number];

type ImportItemScope = { operationId: string; organizationId: string };

/** Ensure deterministic row/unit work exists without resetting existing state. */
export async function ensureImportLedgerItems({
  operationId,
  organizationId,
  items,
}: ImportItemScope & {
  items: Array<
    ImportWorkDescription & {
      expectedPrior?: Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput;
    }
  >;
}) {
  const operation = await db.ioioWriteOperation.findFirst({
    where: {
      id: operationId,
      organizationId,
      operationType: "INVENTORY_IMPORT",
    },
    select: { id: true },
  });
  if (!operation)
    throw new Error("The inventory import operation was not found.");

  if (items.length === 0) return [];

  await db.ioioImportItem.createMany({
    data: items.map((item) => {
      const isPhysicalIndividualUnit = item.kind === "INDIVIDUAL_UNIT_CREATE";
      return {
        operationId,
        organizationId,
        rowKey: item.rowKey,
        unitIndex: item.unitIndex,
        identityKey: getImportItemIdentityKey(item),
        kind: item.kind,
        idempotencyKey: `${operationId}:${getImportItemIdentityKey(item)}`,
        ...(item.expectedPrior !== undefined
          ? { expectedPrior: item.expectedPrior }
          : {}),
        ...(isPhysicalIndividualUnit
          ? {
              targetAssetId: id(),
              qrId: id(),
            }
          : {}),
      };
    }),
    skipDuplicates: true,
  });
  return getImportLedgerItems({ operationId, organizationId });
}

export function getImportLedgerItem({
  operationId,
  organizationId,
  itemId,
}: ImportItemScope & { itemId: string }) {
  return db.ioioImportItem.findFirst({
    where: { id: itemId, operationId, organizationId },
  });
}

export function getImportLedgerItems({
  operationId,
  organizationId,
}: ImportItemScope) {
  return db.ioioImportItem.findMany({
    where: { operationId, organizationId },
    orderBy: [{ rowKey: "asc" }, { unitIndex: "asc" }, { id: "asc" }],
  });
}

/**
 * Conditional update is the claim: only the request that changes PENDING can
 * proceed. The attempt count and first heartbeat are written in the same SQL
 * statement as the state transition.
 */
export async function claimImportLedgerItem({
  operationId,
  organizationId,
  itemId,
  now = new Date(),
}: ImportItemScope & { itemId: string; now?: Date }) {
  const claim = await db.ioioImportItem.updateMany({
    where: { id: itemId, operationId, organizationId, status: "PENDING" },
    data: {
      status: "IN_FLIGHT",
      attempt: { increment: 1 },
      heartbeatAt: now,
      errorCode: null,
      errorMessage: null,
    },
  });
  if (claim.count !== 1) return null;
  return db.ioioImportItem.findFirst({
    where: { id: itemId, operationId, organizationId },
  });
}

export async function heartbeatImportLedgerItem({
  operationId,
  organizationId,
  itemId,
  now = new Date(),
}: ImportItemScope & { itemId: string; now?: Date }) {
  const result = await db.ioioImportItem.updateMany({
    where: { id: itemId, operationId, organizationId, status: "IN_FLIGHT" },
    data: { heartbeatAt: now },
  });
  return result.count === 1;
}

export async function recordImportLedgerExpectedPrior({
  operationId,
  organizationId,
  itemId,
  expectedPrior,
}: ImportItemScope & {
  itemId: string;
  expectedPrior: Prisma.InputJsonValue;
}) {
  const result = await db.ioioImportItem.updateMany({
    where: { id: itemId, operationId, organizationId, status: "IN_FLIGHT" },
    data: { expectedPrior },
  });
  return result.count === 1;
}

export async function markImportLedgerItemDone({
  operationId,
  organizationId,
  itemId,
  writtenState,
  targetAssetId,
  targetKitId,
  qrId,
}: ImportItemScope & {
  itemId: string;
  writtenState?: Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput;
  targetAssetId?: string | null;
  targetKitId?: string | null;
  qrId?: string | null;
}) {
  return markInFlightItem({
    operationId,
    organizationId,
    itemId,
    status: "DONE",
    data: {
      ...(writtenState !== undefined ? { writtenState } : {}),
      ...(targetAssetId !== undefined ? { targetAssetId } : {}),
      ...(targetKitId !== undefined ? { targetKitId } : {}),
      ...(qrId !== undefined ? { qrId } : {}),
      errorCode: null,
      errorMessage: null,
    },
  });
}

export async function markImportLedgerItemFailed({
  operationId,
  organizationId,
  itemId,
  errorCode,
  errorMessage,
  writtenState,
}: ImportItemScope & {
  itemId: string;
  errorCode: string;
  errorMessage: string;
  writtenState?: Prisma.InputJsonValue;
}) {
  return markInFlightItem({
    operationId,
    organizationId,
    itemId,
    status: "FAILED",
    data: {
      errorCode,
      errorMessage: errorMessage.slice(0, 1000),
      ...(writtenState !== undefined ? { writtenState } : {}),
    },
  });
}

export async function markImportLedgerItemConflict({
  operationId,
  organizationId,
  itemId,
  errorCode,
  errorMessage,
  writtenState,
}: ImportItemScope & {
  itemId: string;
  errorCode?: string | null;
  errorMessage?: string | null;
  writtenState?: Prisma.InputJsonValue;
}) {
  return markInFlightItem({
    operationId,
    organizationId,
    itemId,
    status: "CONFLICT",
    data: {
      errorCode: errorCode ?? null,
      errorMessage: errorMessage?.slice(0, 1000) ?? null,
      ...(writtenState !== undefined ? { writtenState } : {}),
    },
  });
}

export async function markImportLedgerItemSkipped({
  operationId,
  organizationId,
  itemId,
}: ImportItemScope & { itemId: string }) {
  return markInFlightItem({
    operationId,
    organizationId,
    itemId,
    status: "SKIPPED",
    data: { errorCode: null, errorMessage: null },
  });
}

async function markInFlightItem({
  operationId,
  organizationId,
  itemId,
  status,
  data,
}: ImportItemScope & {
  itemId: string;
  status: Extract<ImportItemStatus, "DONE" | "FAILED" | "CONFLICT" | "SKIPPED">;
  data: Prisma.IoioImportItemUpdateManyMutationInput;
}) {
  const result = await db.ioioImportItem.updateMany({
    where: { id: itemId, operationId, organizationId, status: "IN_FLIGHT" },
    data: { ...data, status },
  });
  return result.count === 1;
}

/** Find abandoned claims for later reconciliation; this does not reset them. */
export function findStaleImportLedgerItems({
  organizationId,
  operationId,
  now = new Date(),
}: {
  organizationId: string;
  operationId: string;
  now?: Date;
}) {
  const staleBefore = new Date(
    now.getTime() - STAFF_IMPORT_LEDGER_STALE_AFTER_MS
  );
  return db.ioioImportItem.findMany({
    where: {
      status: "IN_FLIGHT",
      organizationId,
      operationId,
      OR: [
        { heartbeatAt: { lt: staleBefore } },
        { heartbeatAt: null, updatedAt: { lt: staleBefore } },
      ],
    },
    orderBy: [{ heartbeatAt: "asc" }, { updatedAt: "asc" }],
  });
}

/** Compare-and-set a stale claim after its observed state has been reconciled. */
export async function reconcileStaleImportLedgerItem({
  operationId,
  organizationId,
  itemId,
  staleBefore,
  status,
  writtenState,
  targetAssetId,
  targetKitId,
  qrId,
  errorCode,
  errorMessage,
}: ImportItemScope & {
  itemId: string;
  staleBefore: Date;
  status: Extract<ImportItemStatus, "PENDING" | "DONE" | "FAILED" | "CONFLICT">;
  writtenState?: Prisma.InputJsonValue;
  targetAssetId?: string | null;
  targetKitId?: string | null;
  qrId?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}) {
  const result = await db.ioioImportItem.updateMany({
    where: {
      id: itemId,
      operationId,
      organizationId,
      status: "IN_FLIGHT",
      OR: [
        { heartbeatAt: { lt: staleBefore } },
        { heartbeatAt: null, updatedAt: { lt: staleBefore } },
      ],
    },
    data: {
      status,
      heartbeatAt: null,
      ...(writtenState !== undefined ? { writtenState } : {}),
      ...(targetAssetId !== undefined ? { targetAssetId } : {}),
      ...(targetKitId !== undefined ? { targetKitId } : {}),
      ...(qrId !== undefined ? { qrId } : {}),
      ...(errorCode !== undefined ? { errorCode } : {}),
      ...(errorMessage !== undefined
        ? { errorMessage: errorMessage?.slice(0, 1000) ?? null }
        : {}),
    },
  });
  return result.count === 1;
}
