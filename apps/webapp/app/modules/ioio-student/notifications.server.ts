import { db } from "~/database/db.server";
import { getPickupLocationDisplay } from "~/modules/ioio-staff/pickup-zone.server";
import { getIoioPhysicalUnitDisplayName } from "~/modules/kit/ioio-kit-presentation";
import type { getStudentAnnualAccessApproval } from "./annual-access.server";
import { withIoioStudentLoadStage } from "./load-diagnostics.server";

export type IoioNotification = {
  id: string;
  title: string;
  message: string;
  href: string;
  tone: "info" | "success" | "warning";
  annualAccessApprovalNotificationId?: string;
};

type AnnualApproval = Awaited<
  ReturnType<typeof getStudentAnnualAccessApproval>
>;

/**
 * Student notifications are derived from canonical current workflow state.
 * This keeps conditions such as approval-required and ready-for-pickup from
 * generating duplicate database rows on every page load.
 */
export async function getStudentIoioNotifications({
  organizationId,
  userId,
  annualApproval,
  diagnostics = false,
}: {
  organizationId: string;
  userId: string;
  annualApproval: AnnualApproval;
  diagnostics?: boolean;
}) {
  const reminderCutoff = new Date();
  reminderCutoff.setDate(reminderCutoff.getDate() + 3);
  const approvalId = annualApproval.approvalId;
  const approvalEventAt = annualApproval.approvedAt;
  const currentApprovalNotification =
    annualApproval.status === "APPROVED" && approvalId && approvalEventAt
      ? withIoioStudentLoadStage(
          "3 notification query (annualAccessApprovalNotification.findFirst)",
          diagnostics,
          () =>
            db.annualAccessApprovalNotification.findFirst({
              where: {
                organizationId,
                userId,
                approvalId,
                eventAt: approvalEventAt,
                readAt: null,
              },
              select: { id: true },
            })
        )
      : Promise.resolve(null);
  const [
    preparation,
    declinedPreparationRequests,
    extensions,
    cardAccess,
    returnReminders,
    approvalNotification,
  ] = await Promise.all([
    withIoioStudentLoadStage(
      "3 notification query (ioioWriteOperation preparation findMany)",
      diagnostics,
      () =>
        db.ioioWriteOperation.findMany({
          where: {
            organizationId,
            userId,
            operationType: "IOIO_PREPARATION",
            status: "READY_FOR_PICKUP",
          },
          select: {
            id: true,
            assetId: true,
            bookingAssetId: true,
            locationId: true,
          },
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
          take: 20,
        })
    ),
    withIoioStudentLoadStage(
      "3 notification query (ioioWriteOperation declined preparation findMany)",
      diagnostics,
      () =>
        db.ioioWriteOperation.findMany({
          where: {
            organizationId,
            userId,
            operationType: "IOIO_PREPARATION",
            source: "IOIO_PREPARATION_REQUEST",
            status: "DECLINED",
          },
          select: {
            id: true,
            assetId: true,
            reviewComment: true,
            updatedAt: true,
          },
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
          take: 5,
        })
    ),
    withIoioStudentLoadStage(
      "3 notification query (ioioWriteOperation extension findMany)",
      diagnostics,
      () =>
        db.ioioWriteOperation.findMany({
          where: {
            organizationId,
            userId,
            operationType: "IOIO_EXTENSION_REQUEST",
            status: { in: ["APPROVED", "REJECTED"] },
          },
          select: { id: true, assetId: true, status: true, to: true },
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
          take: 5,
        })
    ),
    withIoioStudentLoadStage(
      "3 notification query (cardAccessRequest.findFirst)",
      diagnostics,
      () =>
        db.cardAccessRequest.findFirst({
          where: {
            organizationId,
            applicantId: userId,
            status: { in: ["SUBMITTED", "NEEDS_ATTENTION"] },
          },
          select: { id: true },
          orderBy: { createdAt: "desc" },
        })
    ),
    withIoioStudentLoadStage(
      "3 notification query (booking returnReminders findMany)",
      diagnostics,
      () =>
        db.booking.findMany({
          where: {
            organizationId,
            custodianUserId: userId,
            status: { in: ["ONGOING", "OVERDUE"] },
            to: { lte: reminderCutoff },
          },
          select: { id: true, name: true, to: true, status: true },
          orderBy: [{ to: "asc" }, { id: "asc" }],
          take: 5,
        })
    ),
    currentApprovalNotification,
  ]);

  const assetIds = [
    ...preparation.map((item) => item.assetId),
    ...declinedPreparationRequests.map((item) => item.assetId),
    ...extensions.map((item) => item.assetId),
  ].filter((id): id is string => Boolean(id));
  const assets = assetIds.length
    ? await withIoioStudentLoadStage(
        "3 notification query (asset.findMany)",
        diagnostics,
        () =>
          db.asset.findMany({
            where: { organizationId, id: { in: [...new Set(assetIds)] } },
            select: { id: true, title: true, type: true, sequentialId: true },
          })
      )
    : [];
  const assetById = new Map(assets.map((asset) => [asset.id, asset.title]));
  const preparationBookingAssetIds = preparation
    .map((operation) => operation.bookingAssetId)
    .filter((id): id is string => Boolean(id));
  const preparationBookingAssets = preparationBookingAssetIds.length
    ? await withIoioStudentLoadStage(
        "3 notification query (bookingAsset.findMany)",
        diagnostics,
        () =>
          db.bookingAsset.findMany({
            where: {
              id: { in: preparationBookingAssetIds },
              booking: { organizationId },
            },
            select: {
              id: true,
              sourceKitId: true,
              asset: {
                select: {
                  id: true,
                  title: true,
                  type: true,
                  sequentialId: true,
                },
              },
            },
          })
      )
    : [];
  const sourceKitIds = preparationBookingAssets
    .map((bookingAsset) => bookingAsset.sourceKitId)
    .filter((id): id is string => Boolean(id));
  const sourceKits = sourceKitIds.length
    ? await withIoioStudentLoadStage(
        "3 notification query (kit.findMany)",
        diagnostics,
        () =>
          db.kit.findMany({
            where: { organizationId, id: { in: [...new Set(sourceKitIds)] } },
            select: { id: true, name: true },
          })
      )
    : [];
  const bookingAssetById = new Map(
    preparationBookingAssets.map((bookingAsset) => [
      bookingAsset.id,
      bookingAsset,
    ])
  );
  const kitNameById = new Map(sourceKits.map((kit) => [kit.id, kit.name]));
  const preparationNameByOperationId = new Map(
    preparation.map((operation) => {
      const bookingAsset = operation.bookingAssetId
        ? bookingAssetById.get(operation.bookingAssetId)
        : null;
      const asset =
        bookingAsset?.asset ??
        (operation.assetId
          ? assets.find((item) => item.id === operation.assetId)
          : null);
      const sourceKitName = bookingAsset?.sourceKitId
        ? kitNameById.get(bookingAsset.sourceKitId) ?? null
        : null;
      const unitNumber =
        asset?.title.match(/(?:^|\s)(#\d+)\s*$/u)?.[1] ??
        (asset?.type === "INDIVIDUAL" ? asset.sequentialId : null);
      const name = asset
        ? getIoioPhysicalUnitDisplayName({
            logicalProductName: sourceKitName ?? asset.title,
            unitNumber,
            ...(sourceKitName || asset.type === "INDIVIDUAL"
              ? { missingUnitLabel: "Unit number missing" }
              : {}),
          })
        : "Equipment";
      return [operation.id, name] as const;
    })
  );
  const pickupLabels = new Map(
    await Promise.all(
      preparation
        .filter((operation) => operation.locationId)
        .map(
          async (operation) =>
            [
              operation.id,
              (
                await getPickupLocationDisplay({
                  organizationId,
                  locationId: operation.locationId as string,
                })
              ).label,
            ] as const
        )
    )
  );
  const notifications: IoioNotification[] = [];

  if (approvalNotification) {
    notifications.push({
      id: `annual-access-approved-${approvalNotification.id}`,
      annualAccessApprovalNotificationId: approvalNotification.id,
      title: "Borrowing access approved",
      message: "You can now borrow IOIO Lab equipment.",
      href: "/ioio",
      tone: "success",
    });
  }

  if (
    annualApproval.required &&
    (annualApproval.status === "NOT_REQUESTED" ||
      annualApproval.status === "EXPIRED")
  ) {
    notifications.push({
      id: `access-approval-required-${annualApproval.status}-${
        annualApproval.approvalId ?? annualApproval.approvalYear
      }`,
      title: "Borrowing approval required",
      message: "Request approval before borrowing equipment.",
      href: "/ioio/settings/access-approval",
      tone: "warning",
    });
  } else if (annualApproval.required && annualApproval.status === "DECLINED") {
    notifications.push({
      id: `access-approval-declined-${
        annualApproval.approvalId ?? annualApproval.approvalYear
      }`,
      title: "Approval request update",
      message:
        "Your request was not approved. Review the details and request again if needed.",
      href: "/ioio/settings/access-approval",
      tone: "info",
    });
  } else if (annualApproval.required && annualApproval.status === "REVOKED") {
    notifications.push({
      id: `access-approval-revoked-${
        annualApproval.approvalId ?? annualApproval.approvalYear
      }`,
      title: "Borrowing approval revoked",
      message: "You can still browse; reapply before borrowing equipment.",
      href: "/ioio/settings/access-approval",
      tone: "warning",
    });
  } else if (annualApproval.required && annualApproval.status === "PENDING") {
    notifications.push({
      id: `access-approval-pending-${
        annualApproval.approvalId ?? annualApproval.approvalYear
      }`,
      title: "Approval pending",
      message: "Your IOIO access request is waiting for Staff review.",
      href: "/ioio/settings/access-approval",
      tone: "info",
    });
  }

  preparation.forEach((operation) => {
    const itemName =
      preparationNameByOperationId.get(operation.id) ?? "Equipment";
    notifications.push({
      id: `ready-for-pickup-${operation.id}`,
      title: "Ready for pickup",
      message: `${itemName} is ready at ${
        pickupLabels.get(operation.id) ?? "the Pickup Zone"
      }.`,
      href: "/ioio/loans",
      tone: "success",
    });
  });

  declinedPreparationRequests.forEach((operation) => {
    const reason = operation.reviewComment?.trim();
    notifications.push({
      id: `preparation-declined-${operation.id}`,
      title: "Preparation request declined",
      message: `${
        assetById.get(operation.assetId ?? "") ?? "Your item"
      } was declined.${reason ? ` Reason: ${reason}` : ""}`,
      href: "/ioio/loans",
      tone: "info",
    });
  });

  extensions.forEach((operation) => {
    const itemName = assetById.get(operation.assetId ?? "") ?? "Equipment";
    notifications.push({
      id: `extension-${operation.id}`,
      title:
        operation.status === "APPROVED"
          ? "Extension approved"
          : "Extension declined",
      message:
        operation.status === "APPROVED" && operation.to
          ? `${itemName} is now due ${operation.to.toLocaleDateString()}.`
          : `${itemName} keeps its current return date.`,
      href: "/ioio/loans",
      tone: operation.status === "APPROVED" ? "success" : "warning",
    });
  });

  if (cardAccess) {
    notifications.push({
      id: `card-access-${cardAccess.id}`,
      title: "Card access pending",
      message: "Your card access request has been submitted.",
      href: "/ioio/settings",
      tone: "info",
    });
  }

  returnReminders.forEach((booking) => {
    notifications.push({
      id: `return-reminder-${booking.id}`,
      title: booking.status === "OVERDUE" ? "Loan overdue" : "Return reminder",
      message: booking.to
        ? `${booking.name} is due ${booking.to.toLocaleDateString()}.`
        : `${booking.name} needs to be returned.`,
      href: "/ioio/loans",
      tone: "warning",
    });
  });

  return notifications;
}
