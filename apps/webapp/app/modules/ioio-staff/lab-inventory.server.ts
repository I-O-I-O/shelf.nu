import { AssetType, Prisma } from "@prisma/client";
import type { ITXClientDenyList } from "@prisma/client/runtime/library";
import { db, type ExtendedPrismaClient } from "~/database/db.server";
import { recordEvent } from "~/modules/activity-event/service.server";
import { getAssetAvailability } from "~/modules/asset/availability.server";
import { reconcileManualPlacementsForStockDecrease } from "~/modules/asset/placement-reconcile.server";
import {
  cleanupDeletedAsset,
  deleteAssetInTransaction,
} from "~/modules/asset/service.server";
import { lockAssetForQuantityUpdate } from "~/modules/consumption-log/quantity-lock.server";
import { adjustQuantity } from "~/modules/consumption-log/service.server";
import { IOIO_PHYSICAL_UNIT_BLOCKING_REPORT_TYPES } from "~/modules/ioio-student/report-problem.shared";
import { createNote } from "~/modules/note/service.server";
import { ShelfError } from "~/utils/error";
import { Logger } from "~/utils/logger";
import type { LabInventoryAction } from "./lab-inventory";
import {
  ensureIoioAssetCanReturnToService,
  markIoioAssetAvailable,
} from "./lab-status.server";

type LabStatusTransactionClient = Omit<ExtendedPrismaClient, ITXClientDenyList>;

function inventoryConflict(message: string) {
  return new ShelfError({
    cause: null,
    message,
    label: "Assets",
    status: 409,
    shouldBeCaptured: false,
  });
}

/** Applies one inventory change per selected equipment report, atomically. */
export async function manageLabInventory({
  organizationId,
  staffUserId,
  action,
  targets,
}: {
  organizationId: string;
  staffUserId: string;
  action: LabInventoryAction;
  targets: { reportId: string; pooled: boolean }[];
}) {
  if (!targets.length)
    throw inventoryConflict("Select at least one inventory item.");
  const targetByReportId = new Map(
    targets.map((target) => [target.reportId, target])
  );
  const removedAssets = await db.$transaction(
    async (tx) => {
      const reports = await tx.ioioWriteOperation.findMany({
        where: {
          organizationId,
          id: { in: [...targetByReportId.keys()] },
          operationType: "REPORT_PROBLEM",
          status: "SUCCEEDED",
          reportType: {
            in: [...IOIO_PHYSICAL_UNIT_BLOCKING_REPORT_TYPES],
            not: "KIT_INCOMPLETE",
          },
          assetId: { not: null },
          kitId: null,
        },
        select: { id: true, assetId: true, bookingAssetId: true },
      });
      if (
        reports.length !== targets.length ||
        new Set(reports.map((report) => report.assetId)).size !== reports.length
      ) {
        throw inventoryConflict(
          "Select one current equipment report per inventory item and try again."
        );
      }

      const deleted: {
        id: string;
        record: Awaited<ReturnType<typeof deleteAssetInTransaction>>;
      }[] = [];
      // The stock and booking services also lock Asset first. A stable lock
      // order keeps concurrent bulk requests from locking assets in reverse order.
      for (const report of reports.sort((a, b) =>
        (a.assetId ?? "").localeCompare(b.assetId ?? "")
      )) {
        if (!report.assetId)
          throw inventoryConflict(
            "This report no longer identifies an inventory item."
          );
        const asset = await lockAssetForQuantityUpdate(
          tx,
          report.assetId,
          organizationId
        );
        const { id, title, assetModelId } = asset;
        const quantity =
          asset.type === AssetType.INDIVIDUAL ? 1 : asset.quantity ?? 0;
        const pooled = quantity > 1;
        if (
          quantity <= 0 ||
          pooled !== targetByReportId.get(report.id)?.pooled
        ) {
          throw inventoryConflict(
            `${title}: stock changed. Review the item before trying again.`
          );
        }
        const archived = await tx.ioioArchivedItem.findFirst({
          where: {
            organizationId,
            itemType: "ASSET",
            itemId: id,
            restoredAt: null,
          },
          select: { id: true },
        });
        if (archived)
          throw inventoryConflict(
            `${title}: this item is archived or in Trash.`
          );

        const resolveReport = async () => {
          const result = await tx.ioioWriteOperation.updateMany({
            where: {
              id: report.id,
              organizationId,
              status: "SUCCEEDED",
              assetId: id,
            },
            data: {
              status: "RESOLVED",
              completedAt: new Date(),
              reviewedAt: new Date(),
              reviewedByUserId: staffUserId,
            },
          });
          if (result.count !== 1)
            throw inventoryConflict(
              `${title}: this equipment report has already changed.`
            );
        };

        if (action === "enable") {
          if (pooled || asset.availableToBook)
            throw inventoryConflict(`${title}: select a disabled single unit.`);
          const unit = await ensureIoioAssetCanReturnToService({
            tx,
            organizationId,
            assetId: id,
            ignoreReportOperationId: report.id,
            includeStaffReservations: true,
          });
          await markIoioAssetAvailable({
            tx,
            asset: unit,
            organizationId,
            staffUserId,
          });
          await resolveReport();
        } else if (action === "disable") {
          if (pooled || !asset.availableToBook)
            throw inventoryConflict(`${title}: select an enabled single unit.`);
          await tx.asset.update({
            where: { id, organizationId },
            data: { availableToBook: false },
          });
          await createNote(
            {
              content: "Disabled from Lab status.",
              type: "UPDATE",
              userId: staffUserId,
              assetId: id,
              organizationId,
            },
            tx
          );
          await recordEvent(
            {
              organizationId,
              actorUserId: staffUserId,
              action: "ASSET_STATUS_CHANGED",
              entityType: "ASSET",
              entityId: id,
              assetId: id,
              field: "availableToBook",
              fromValue: true,
              toValue: false,
              meta: { source: "IOIO_LAB_STATUS" },
            },
            tx
          );
        } else if (pooled) {
          const availability = await getAssetAvailability({
            assetId: id,
            organizationId,
            db: tx,
          });
          if (availability.physicalAvailable < 1 || availability.bookable < 1) {
            throw inventoryConflict(
              `${title}: no uncommitted unit is available to remove.`
            );
          }
          if (report.bookingAssetId) {
            const loan = await tx.bookingAsset.findFirst({
              where: {
                id: report.bookingAssetId,
                assetId: id,
                checkedInAt: null,
                booking: {
                  organizationId,
                  status: { in: ["RESERVED", "ONGOING", "OVERDUE"] },
                },
              },
              select: { id: true },
            });
            if (loan)
              throw inventoryConflict(
                `${title}: the reported unit is still on a loan or reservation.`
              );
          }
          if (
            assetModelId &&
            (await hasOpenModelReservation(tx, organizationId, assetModelId))
          ) {
            throw inventoryConflict(
              `${title}: its model has an outstanding reservation.`
            );
          }
          const placement = await reconcileManualPlacementsForStockDecrease({
            assetId: id,
            newTotal: quantity - 1,
            tx,
          });
          if (placement.outcome === "ambiguous") {
            throw inventoryConflict(
              `${title}: update the affected location in inventory before removing this unit.`
            );
          }
          await adjustQuantity({
            tx,
            assetId: id,
            organizationId,
            userId: staffUserId,
            quantity: 1,
            category: "LOSS",
            direction: "subtract",
            note: "Reported unit permanently removed from Lab status.",
          });
          await resolveReport();
        } else {
          const [
            booking,
            custody,
            kit,
            audit,
            preparation,
            modelReservation,
            purchase,
            usage,
          ] = await Promise.all([
            tx.bookingAsset.findFirst({
              where: { assetId: id, booking: { organizationId } },
              select: { id: true },
            }),
            tx.custody.findFirst({
              where: { assetId: id },
              select: { id: true },
            }),
            tx.assetKit.findFirst({
              where: { assetId: id, organizationId },
              select: { id: true },
            }),
            tx.auditAsset.findFirst({
              where: { assetId: id },
              select: { id: true },
            }),
            tx.ioioWriteOperation.findFirst({
              where: {
                assetId: id,
                organizationId,
                operationType: "IOIO_PREPARATION",
                status: {
                  in: [
                    "PENDING_PREPARATION",
                    "ASSIGNED",
                    "READY_FOR_PICKUP",
                    "CANCELLED_PICKUP",
                  ],
                },
              },
              select: { id: true },
            }),
            assetModelId
              ? hasOpenModelReservation(tx, organizationId, assetModelId)
              : false,
            tx.purchaseItem.findFirst({
              where: { linkedAssetId: id },
              select: { id: true },
            }),
            tx.consumptionLog.findFirst({
              where: { assetId: id },
              select: { id: true },
            }),
          ]);
          if (
            asset.status !== "AVAILABLE" ||
            booking ||
            custody ||
            kit ||
            audit ||
            preparation ||
            modelReservation ||
            purchase ||
            usage
          ) {
            throw inventoryConflict(
              `${title}: a loan, reservation, kit, or inventory history blocks permanent deletion.`
            );
          }
          await resolveReport();
          await tx.ioioWriteOperation.updateMany({
            where: {
              organizationId,
              assetId: id,
              kitId: null,
              operationType: "REPORT_PROBLEM",
              status: "SUCCEEDED",
              reportType: {
                in: [...IOIO_PHYSICAL_UNIT_BLOCKING_REPORT_TYPES],
                not: "KIT_INCOMPLETE",
              },
            },
            data: {
              status: "RESOLVED",
              reviewedAt: new Date(),
              reviewedByUserId: staffUserId,
            },
          });
          const record = await deleteAssetInTransaction(
            { id, organizationId, actorUserId: staffUserId },
            tx
          );
          deleted.push({ id, record });
        }
      }
      return deleted;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );

  // These best-effort external cleanups cannot undo the committed inventory
  // changes. Always return the actual result of the transaction to the UI.
  await Promise.all(
    removedAssets.map(async ({ id, record }) => {
      try {
        await cleanupDeletedAsset(id, record, true);
      } catch (cause) {
        Logger.warn("Could not clean up deleted asset resources", {
          id,
          cause,
        });
      }
    })
  );
  return { count: targets.length };
}

async function hasOpenModelReservation(
  tx: LabStatusTransactionClient,
  organizationId: string,
  assetModelId: string
) {
  return Boolean(
    await tx.bookingModelRequest.findFirst({
      where: {
        assetModelId,
        fulfilledAt: null,
        booking: {
          organizationId,
          status: { in: ["RESERVED", "ONGOING", "OVERDUE"] },
        },
      },
      select: { id: true },
    })
  );
}
