import { AssetType } from "@prisma/client";
import { db } from "~/database/db.server";
import { recordEvent } from "~/modules/activity-event/service.server";
import { deduplicateStaffInventoryRows } from "~/modules/asset/staff-inventory-view";
import { IOIO_STAFF_RESERVATION_DESCRIPTION } from "~/modules/ioio-student/availability.server";
import { getStudentReturnIssueComment } from "~/modules/ioio-student/return-item.shared";
import { createNote } from "~/modules/note/service.server";
import { ShelfError } from "~/utils/error";

export type LabIssueSeverity = "critical" | "attention";
export type LabIssueKind =
  | "report"
  | "incomplete-kit"
  | "overdue-loan"
  | "out-of-stock"
  | "low-stock"
  | "import-warning"
  | "reservation-request"
  | "return-check"
  | "returned-with-issue"
  | "preparation"
  | "cancelled-pickup"
  | "ready-for-pickup"
  | "annual-access";

export type LabIssue = {
  id: string;
  kind: LabIssueKind;
  severity: LabIssueSeverity;
  title: string;
  detail: string;
  href: string;
  targetUnavailable?: boolean;
  resolution?: {
    operationId: string;
  };
};

export type LabStatus = {
  totalIssues: number;
  severity: "healthy" | LabIssueSeverity;
  overdueLoans: number;
  lowStock: number;
  outOfStock: number;
  unresolvedReports: number;
  incompleteKits: number;
  importWarnings: number;
  pendingReservationRequests: number;
  returnChecks: number;
  returnedWithIssues: number;
  preparationTasks: number;
  cancelledPickups: number;
  readyForPickup: number;
  annualAccessApprovals: number;
  issues: LabIssue[];
};

const REPORT_LABELS: Record<string, string> = {
  ITEM_MISSING: "Item missing",
  ITEM_DAMAGED: "Item damaged",
  WRONG_LOCATION: "Wrong location",
  LOCATION_FULL: "Location full",
  CANNOT_FIND: "Can't find item",
  KIT_INCOMPLETE: "Kit incomplete",
  OTHER: "Operational report",
};

type QuantityAssetCandidate = {
  id: string;
  title: string;
  quantity: number | null;
  minQuantity: number | null;
  availableToBook: boolean;
  updatedAt: Date;
  category: { name: string } | null;
  assetLocations: Array<{ location: { name: string } }>;
};

function formatQuantity(value: number | null) {
  return value === null ? "0" : String(value);
}

function formatDueDate(value: Date) {
  return value.toISOString().slice(0, 10);
}

type ReportReference = {
  label: string;
  href: string | null;
};

type ReportReferences = {
  assetsById: Map<string, ReportReference>;
  kitsById: Map<string, ReportReference>;
  locationsById: Map<string, ReportReference>;
};

function getReportReference(
  operation: {
    assetId: string | null;
    kitId: string | null;
    locationId: string | null;
  },
  references: ReportReferences
) {
  if (operation.assetId) return references.assetsById.get(operation.assetId);
  if (operation.kitId) return references.kitsById.get(operation.kitId);
  if (operation.locationId)
    return references.locationsById.get(operation.locationId);
  return undefined;
}

/**
 * Mark one report-backed lab task complete without deleting its audit rows.
 * Older duplicate reports for the same reference/type are completed too so
 * the deduplicated notification cannot reappear with stale history.
 */
export async function resolveLabIssue({
  organizationId,
  operationId,
}: {
  organizationId: string;
  operationId: string;
}) {
  const operation = await db.ioioWriteOperation.findFirst({
    where: {
      id: operationId,
      organizationId,
      operationType: "REPORT_PROBLEM",
      status: "SUCCEEDED",
    },
    select: {
      reportType: true,
      assetId: true,
      kitId: true,
      locationId: true,
    },
  });

  if (!operation) {
    throw new ShelfError({
      cause: null,
      message: "That lab task is no longer open.",
      label: "Notification",
      status: 409,
      shouldBeCaptured: false,
    });
  }

  const result = await db.ioioWriteOperation.updateMany({
    where: {
      organizationId,
      operationType: "REPORT_PROBLEM",
      status: "SUCCEEDED",
      reportType: operation.reportType,
      assetId: operation.assetId,
      kitId: operation.kitId,
      locationId: operation.locationId,
    },
    data: {
      status: "RESOLVED",
      completedAt: new Date(),
    },
  });

  if (result.count === 0) {
    throw new ShelfError({
      cause: null,
      message: "That lab task is no longer open.",
      label: "Notification",
      status: 409,
      shouldBeCaptured: false,
    });
  }

  return { resolvedCount: result.count };
}

/** Return a repaired, report-backed asset to normal borrowing and inventory. */
export async function returnBrokenAssetToService({
  organizationId,
  operationId,
  staffUserId,
}: {
  organizationId: string;
  operationId: string;
  staffUserId: string;
}) {
  const brokenTypes = [
    "ITEM_DAMAGED",
    "ITEM_NOT_WORKING",
    "PART_MISSING",
    "KIT_INCOMPLETE",
  ];

  return db.$transaction(async (tx) => {
    const operation = await tx.ioioWriteOperation.findFirst({
      where: {
        id: operationId,
        organizationId,
        operationType: "REPORT_PROBLEM",
        status: "SUCCEEDED",
        reportType: { in: brokenTypes },
        assetId: { not: null },
      },
      select: { id: true, assetId: true, reportType: true },
    });
    if (!operation?.assetId || !operation.reportType) {
      throw new ShelfError({
        cause: null,
        message: "This broken item is no longer waiting for repair.",
        label: "Operations",
        status: 409,
        shouldBeCaptured: false,
      });
    }

    const asset = await tx.asset.findFirst({
      where: { id: operation.assetId, organizationId },
      select: { id: true, title: true, status: true, availableToBook: true },
    });
    if (!asset) {
      throw new ShelfError({
        cause: null,
        message: "The broken item could not be found in this workspace.",
        label: "Operations",
        status: 404,
        shouldBeCaptured: false,
      });
    }
    if (asset.status !== "AVAILABLE") {
      throw new ShelfError({
        cause: null,
        message:
          "This item is still checked out, reserved, or in custody and cannot return to service yet.",
        label: "Operations",
        status: 409,
        shouldBeCaptured: false,
      });
    }

    const [custody, activeBooking, preparationHold, otherOpenReport] =
      await Promise.all([
        tx.custody.findFirst({
          where: { assetId: asset.id },
          select: { id: true },
        }),
        tx.bookingAsset.findFirst({
          where: {
            assetId: asset.id,
            checkedInAt: null,
            booking: {
              organizationId,
              status: { in: ["RESERVED", "ONGOING", "OVERDUE"] },
              OR: [
                { description: { not: IOIO_STAFF_RESERVATION_DESCRIPTION } },
                { description: null },
              ],
            },
          },
          select: { id: true },
        }),
        tx.ioioWriteOperation.findFirst({
          where: {
            organizationId,
            assetId: asset.id,
            operationType: "IOIO_PREPARATION",
            status: { in: ["READY_FOR_PICKUP", "CANCELLED_PICKUP"] },
          },
          select: { id: true },
        }),
        tx.ioioWriteOperation.findFirst({
          where: {
            organizationId,
            assetId: asset.id,
            operationType: "REPORT_PROBLEM",
            status: "SUCCEEDED",
            id: { not: operation.id },
            reportType: { not: operation.reportType },
          },
          select: { id: true },
        }),
      ]);
    if (custody || activeBooking || preparationHold || otherOpenReport) {
      throw new ShelfError({
        cause: null,
        message:
          "Resolve the remaining hold or issue before returning this item to service.",
        label: "Operations",
        status: 409,
        shouldBeCaptured: false,
      });
    }

    const resolved = await tx.ioioWriteOperation.updateMany({
      where: {
        organizationId,
        operationType: "REPORT_PROBLEM",
        status: "SUCCEEDED",
        reportType: operation.reportType,
        assetId: asset.id,
      },
      data: { status: "RESOLVED", completedAt: new Date() },
    });
    if (!resolved.count) {
      throw new ShelfError({
        cause: null,
        message: "This broken item is no longer waiting for repair.",
        label: "Operations",
        status: 409,
        shouldBeCaptured: false,
      });
    }

    await tx.asset.update({
      where: { id: asset.id, organizationId },
      data: { availableToBook: true },
    });
    await createNote(
      {
        content: "Repaired and returned to service.",
        type: "UPDATE",
        userId: staffUserId,
        assetId: asset.id,
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
        entityId: asset.id,
        assetId: asset.id,
        field: "availableToBook",
        fromValue: asset.availableToBook,
        toValue: true,
        meta: { source: "IOIO_OPERATIONS_RETURN_TO_SERVICE" },
      },
      tx
    );

    return { assetId: asset.id, title: asset.title, status: "AVAILABLE" };
  });
}

/**
 * Read-only operational summary for the IOIO staff surfaces.
 *
 * This deliberately uses existing Shelf records. It does not create an alert
 * table, alter booking/report state, or expose custody identities.
 */
export async function getLabStatus({
  organizationId,
  preparationOrganizationId = organizationId,
}: {
  organizationId: string;
  preparationOrganizationId?: string;
}): Promise<LabStatus> {
  const [
    overdueLoanCount,
    overdueLoans,
    quantityAssets,
    reportOperations,
    importOperations,
    pendingReservationRequestCount,
    submittedReturnOperations,
    archivedMarkers,
    preparationTaskCount,
    cancelledPickupOperations,
    readyForPickupCount,
    annualAccessApprovalCount,
  ] = await Promise.all([
    db.booking.count({
      where: {
        organizationId,
        status: "OVERDUE",
        OR: [
          { description: { not: IOIO_STAFF_RESERVATION_DESCRIPTION } },
          { description: null },
        ],
      },
    }),
    db.booking.findMany({
      where: {
        organizationId,
        status: "OVERDUE",
        OR: [
          { description: { not: IOIO_STAFF_RESERVATION_DESCRIPTION } },
          { description: null },
        ],
      },
      select: { id: true, to: true },
      orderBy: [{ to: "asc" }, { id: "asc" }],
    }),
    db.asset.findMany({
      where: {
        organizationId,
        type: AssetType.QUANTITY_TRACKED,
        minQuantity: { not: null },
      },
      select: {
        id: true,
        title: true,
        quantity: true,
        minQuantity: true,
        availableToBook: true,
        updatedAt: true,
        category: { select: { name: true } },
        assetLocations: {
          select: { location: { select: { name: true } } },
        },
      },
      orderBy: [{ title: "asc" }, { id: "asc" }],
    }),
    db.ioioWriteOperation.findMany({
      where: {
        organizationId,
        operationType: "REPORT_PROBLEM",
        status: "SUCCEEDED",
      },
      select: {
        id: true,
        source: true,
        reportType: true,
        assetId: true,
        kitId: true,
        locationId: true,
        bookingAssetId: true,
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    }),
    db.ioioWriteOperation.findMany({
      where: {
        organizationId,
        operationType: "INVENTORY_IMPORT",
        status: { in: ["PREPARED", "APPLYING", "FAILED"] },
      },
      select: { id: true, status: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    }),
    db.ioioWriteOperation.count({
      where: {
        organizationId,
        operationType: { in: ["BORROW_ITEM", "IOIO_EXTENSION_REQUEST"] },
        status: "PENDING_APPROVAL",
      },
    }),
    db.ioioWriteOperation.findMany({
      where: {
        organizationId,
        operationType: "RETURN_ITEM",
        status: "SUBMITTED",
      },
      select: {
        id: true,
        assetId: true,
        bookingAssetId: true,
        reportType: true,
        description: true,
        locationId: true,
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
    db.ioioArchivedItem.findMany({
      where: {
        organizationId,
        restoredAt: null,
        itemType: { in: ["ASSET", "KIT"] },
      },
      select: { itemType: true, itemId: true },
    }),
    db.ioioWriteOperation.count({
      where: {
        organizationId: preparationOrganizationId,
        operationType: "IOIO_PREPARATION",
        status: "PENDING_PREPARATION",
        source: { in: ["IOIO_PREPARATION_REQUEST", "IOIO_ASSISTANT"] },
      },
    }),
    db.ioioWriteOperation.findMany({
      where: {
        organizationId,
        operationType: "IOIO_PREPARATION",
        status: "CANCELLED_PICKUP",
      },
      select: {
        id: true,
        userId: true,
        assetId: true,
        reviewComment: true,
      },
      orderBy: [{ reviewedAt: "asc" }, { id: "asc" }],
    }),
    db.ioioWriteOperation.count({
      where: {
        organizationId,
        operationType: "IOIO_PREPARATION",
        status: "READY_FOR_PICKUP",
      },
    }),
    db.annualAccessApproval.count({
      where: {
        organizationId,
        status: "PENDING",
      },
    }),
  ]);

  const archivedAssetIds = new Set(
    archivedMarkers
      .filter((marker) => marker.itemType === "ASSET")
      .map((marker) => marker.itemId)
  );
  const archivedKitIds = new Set(
    archivedMarkers
      .filter((marker) => marker.itemType === "KIT")
      .map((marker) => marker.itemId)
  );

  const returnBookingAssetIds = submittedReturnOperations
    .map((operation) => operation.bookingAssetId)
    .filter((id): id is string => Boolean(id));
  const returnBookingAssets = returnBookingAssetIds.length
    ? await db.bookingAsset.findMany({
        where: {
          id: { in: returnBookingAssetIds },
          booking: { organizationId },
        },
        select: {
          id: true,
          checkedInAt: true,
          asset: { select: { returnHandling: true } },
        },
      })
    : [];
  const returnBookingAssetById = new Map(
    returnBookingAssets.map((bookingAsset) => [bookingAsset.id, bookingAsset])
  );
  const pendingReturnOperations = submittedReturnOperations.filter(
    (operation) => {
      const bookingAsset = operation.bookingAssetId
        ? returnBookingAssetById.get(operation.bookingAssetId)
        : null;
      if (bookingAsset?.checkedInAt) return false;
      return (
        operation.reportType !== "RETURN_ITEM" ||
        bookingAsset?.asset.returnHandling === "RETURN_TO_RETURN_ZONE"
      );
    }
  );
  const reportedReturnIssueBookingAssetIds = new Set(
    reportOperations.flatMap((operation) =>
      operation.source === "IOIO_STUDENT_RETURN" && operation.bookingAssetId
        ? [operation.bookingAssetId]
        : []
    )
  );
  const returnedWithIssueOperations = pendingReturnOperations.filter(
    (operation) =>
      operation.reportType !== "RETURN_ITEM" ||
      reportedReturnIssueBookingAssetIds.has(operation.bookingAssetId ?? "")
  );
  const ordinaryReturnOperations = pendingReturnOperations.filter(
    (operation) => !returnedWithIssueOperations.includes(operation)
  );
  const activeIssueReturnBookingAssetIds = new Set(
    returnedWithIssueOperations
      .map((operation) => operation.bookingAssetId)
      .filter((id): id is string => Boolean(id))
  );
  const reportOperationsForBrokenItems = reportOperations.filter(
    (operation) =>
      operation.source !== "IOIO_STUDENT_RETURN" ||
      !activeIssueReturnBookingAssetIds.has(operation.bookingAssetId ?? "")
  );
  const returnAssetIds = pendingReturnOperations
    .map((operation) => operation.assetId)
    .filter((id): id is string => Boolean(id));
  const returnAssets = returnAssetIds.length
    ? await db.asset.findMany({
        where: { organizationId, id: { in: returnAssetIds } },
        select: { id: true, title: true },
      })
    : [];
  const returnAssetById = new Map(
    returnAssets.map((asset) => [asset.id, asset.title])
  );
  const returnCheckIssues: LabIssue[] = ordinaryReturnOperations.map(
    (operation) => ({
      id: `return-check:${operation.id}`,
      kind: "return-check",
      severity: "attention",
      title: returnAssetById.get(operation.assetId ?? "") ?? "Returned item",
      detail:
        operation.reportType === "RETURN_ITEM"
          ? "Kit return waiting for Staff check."
          : "Returned with an issue. Staff inspection is required.",
      href: `/bookings/return-check/${operation.id}`,
    })
  );
  const returnedWithIssueItems: LabIssue[] = returnedWithIssueOperations.map(
    (operation) => ({
      id: `returned-with-issue:${operation.id}`,
      kind: "returned-with-issue",
      severity: "attention",
      title: returnAssetById.get(operation.assetId ?? "") ?? "Returned item",
      detail:
        getStudentReturnIssueComment(operation.description) ??
        "The Student reported a problem. Staff review is required.",
      href: `/bookings/return-check/${operation.id}`,
    })
  );

  const canonicalQuantityAssets = deduplicateStaffInventoryRows(
    (quantityAssets as QuantityAssetCandidate[])
      .filter((asset) => !archivedAssetIds.has(asset.id))
      .filter((asset) => (asset.quantity ?? 0) <= (asset.minQuantity ?? 0))
  );
  const quantityIssues: LabIssue[] = canonicalQuantityAssets.flatMap(
    (asset): LabIssue[] => {
      const quantity = asset.quantity ?? 0;
      const minQuantity = asset.minQuantity ?? 0;
      const location = asset.assetLocations[0]?.location.name;
      const locationSuffix = location ? ` in ${location}` : "";
      if (quantity <= 0) {
        return [
          {
            id: `out-of-stock:${asset.id}`,
            kind: "out-of-stock" as const,
            severity: "critical" as const,
            title: `${asset.title} is out of stock`,
            detail: `Quantity 0 of ${formatQuantity(
              minQuantity
            )} minimum${locationSuffix}.`,
            href: `/assets/${asset.id}/overview`,
          },
        ];
      }
      return [
        {
          id: `low-stock:${asset.id}`,
          kind: "low-stock" as const,
          severity: "attention" as const,
          title: `${asset.title} is low stock`,
          detail: `${quantity} available, minimum ${formatQuantity(
            minQuantity
          )}${locationSuffix}.`,
          href: `/assets/${asset.id}/overview`,
        },
      ];
    }
  );

  const reportAssetIds = reportOperationsForBrokenItems.flatMap((operation) =>
    operation.assetId ? [operation.assetId] : []
  );
  const reportKitIds = reportOperationsForBrokenItems.flatMap((operation) =>
    operation.kitId ? [operation.kitId] : []
  );
  const reportLocationIds = reportOperationsForBrokenItems.flatMap(
    (operation) => (operation.locationId ? [operation.locationId] : [])
  );
  const [reportAssets, reportKits, reportLocations] = await Promise.all([
    db.asset.findMany({
      where: { organizationId, id: { in: reportAssetIds } },
      select: { id: true, title: true },
    }),
    db.kit.findMany({
      where: { organizationId, id: { in: reportKitIds } },
      select: { id: true, name: true },
    }),
    db.location.findMany({
      where: { organizationId, id: { in: reportLocationIds } },
      select: { id: true, name: true },
    }),
  ]);
  const references: ReportReferences = {
    assetsById: new Map(
      reportAssets.map((asset) => [
        asset.id,
        {
          label: asset.title,
          href: archivedAssetIds.has(asset.id)
            ? null
            : `/assets/${asset.id}/overview`,
        },
      ])
    ),
    kitsById: new Map(
      reportKits.map((kit) => [
        kit.id,
        {
          label: kit.name,
          href: archivedKitIds.has(kit.id) ? null : `/kits/${kit.id}`,
        },
      ])
    ),
    locationsById: new Map(
      reportLocations.map((location) => [
        location.id,
        { label: location.name, href: `/locations/${location.id}` },
      ])
    ),
  };

  // Keep the most recent open report for each reference/type so repeated
  // submissions do not inflate the status count or notification list.
  const seenReportKeys = new Set<string>();
  const reportIssues: LabIssue[] = [];
  for (const operation of reportOperationsForBrokenItems) {
    const referenceId =
      operation.assetId ??
      operation.kitId ??
      operation.locationId ??
      "unscoped";
    const key = `${operation.reportType}:${referenceId}`;
    if (seenReportKeys.has(key)) continue;
    seenReportKeys.add(key);
    const label = REPORT_LABELS[operation.reportType] ?? "Operational report";
    const reference = getReportReference(operation, references);
    const isIncompleteKit = operation.reportType === "KIT_INCOMPLETE";
    const targetUnavailable = Boolean(
      (operation.assetId || operation.kitId || operation.locationId) &&
        (!reference || reference.href === null)
    );
    reportIssues.push({
      id: `report:${operation.id}`,
      kind: isIncompleteKit ? "incomplete-kit" : "report",
      severity: "critical",
      title: reference ? `${label}: ${reference.label}` : label,
      detail: targetUnavailable
        ? "The linked item is no longer active. Review the submitted report."
        : "Staff review is required.",
      href: reference?.href ?? "/reports/operational",
      targetUnavailable,
      resolution: { operationId: operation.id },
    });
  }

  const overdueIssues: LabIssue[] = overdueLoans.map((loan) => ({
    id: `overdue-loan:${loan.id}`,
    kind: "overdue-loan",
    severity: "attention",
    title: "Overdue loan",
    detail: `Due ${formatDueDate(loan.to)}.`,
    href: `/bookings/${loan.id}`,
  }));

  const importIssues: LabIssue[] = importOperations.map((operation) => ({
    id: `import-warning:${operation.id}`,
    kind: "import-warning",
    severity: operation.status === "FAILED" ? "critical" : "attention",
    title:
      operation.status === "FAILED"
        ? "Inventory import needs attention"
        : "Inventory import is awaiting review",
    detail: "Open Imports to review the current proposal status.",
    href: "/staff/import",
  }));
  const reservationIssues: LabIssue[] = pendingReservationRequestCount
    ? [
        {
          id: "reservation-requests:pending",
          kind: "reservation-request",
          severity: "attention",
          title: `${pendingReservationRequestCount} IOIO request${
            pendingReservationRequestCount === 1 ? "" : "s"
          } need review`,
          detail: "Open the IOIO request queue to approve or reject them.",
          href: "/calendar/ioio-requests",
        },
      ]
    : [];
  const preparationIssues: LabIssue[] = preparationTaskCount
    ? [
        {
          id: "preparation:pending",
          kind: "preparation",
          severity: "attention",
          title: `${preparationTaskCount} item${
            preparationTaskCount === 1 ? "" : "s"
          } to prepare`,
          detail: "Prepare equipment and move it to the Pickup Zone.",
          href: "/operations?view=to-prepare",
        },
      ]
    : [];
  const annualAccessIssues: LabIssue[] = annualAccessApprovalCount
    ? [
        {
          id: "annual-access:pending",
          kind: "annual-access",
          severity: "attention",
          title: `${annualAccessApprovalCount} Student access approval${
            annualAccessApprovalCount === 1 ? "" : "s"
          } need review`,
          detail: "Review Student borrowing access requests.",
          href: "/operations?view=access-approvals",
        },
      ]
    : [];

  const cancelledPickupAssetIds = [
    ...new Set(
      cancelledPickupOperations
        .map((operation) => operation.assetId)
        .filter((id): id is string => Boolean(id))
    ),
  ];
  const cancelledPickupUserIds = [
    ...new Set(cancelledPickupOperations.map((operation) => operation.userId)),
  ];
  const [cancelledPickupAssets, cancelledPickupUsers] = await Promise.all([
    cancelledPickupAssetIds.length
      ? db.asset.findMany({
          where: { organizationId, id: { in: cancelledPickupAssetIds } },
          select: { id: true, title: true },
        })
      : Promise.resolve([]),
    cancelledPickupUserIds.length
      ? db.user.findMany({
          where: {
            id: { in: cancelledPickupUserIds },
            userOrganizations: { some: { organizationId } },
          },
          select: {
            id: true,
            email: true,
            displayName: true,
            firstName: true,
            lastName: true,
          },
        })
      : Promise.resolve([]),
  ]);
  const cancelledPickupAssetById = new Map(
    cancelledPickupAssets.map((asset) => [asset.id, asset])
  );
  const cancelledPickupUserById = new Map(
    cancelledPickupUsers.map((user) => [user.id, user])
  );
  const cancelledPickupIssues: LabIssue[] = cancelledPickupOperations.map(
    (operation) => {
      const asset = cancelledPickupAssetById.get(operation.assetId ?? "");
      const user = cancelledPickupUserById.get(operation.userId);
      const borrower = user
        ? user.displayName ||
          [user.firstName, user.lastName].filter(Boolean).join(" ") ||
          user.email
        : "Student";
      return {
        id: `cancelled-pickup:${operation.id}`,
        kind: "cancelled-pickup",
        severity: "attention",
        title: `${asset?.title ?? "Prepared item"} needs to be put back`,
        detail: operation.reviewComment?.startsWith("Pickup expired")
          ? "Pickup expired. Return it from the Pickup Zone."
          : `${borrower} cancelled a prepared pickup. Return it from the Pickup Zone.`,
        href: "/operations?view=cancelled-pickups",
      };
    }
  );

  const issues: LabIssue[] = [
    ...reportIssues,
    ...overdueIssues,
    ...quantityIssues.filter((issue) => issue.kind === "out-of-stock"),
    ...quantityIssues.filter((issue) => issue.kind === "low-stock"),
    ...importIssues,
    ...reservationIssues,
    ...preparationIssues,
    ...cancelledPickupIssues,
    ...annualAccessIssues,
    ...returnCheckIssues,
    ...returnedWithIssueItems,
  ];
  const incompleteKits = reportIssues.filter(
    (issue) => issue.kind === "incomplete-kit"
  ).length;
  const unresolvedReports = reportIssues.length - incompleteKits;
  const outOfStock = quantityIssues.filter(
    (issue) => issue.kind === "out-of-stock"
  ).length;
  const lowStock = quantityIssues.filter(
    (issue) => issue.kind === "low-stock"
  ).length;
  const importWarnings = importIssues.length;
  const totalIssues = issues.length;
  const severity = totalIssues
    ? issues.some((issue) => issue.severity === "critical")
      ? "critical"
      : "attention"
    : "healthy";

  return {
    totalIssues,
    severity,
    overdueLoans: overdueLoanCount,
    lowStock,
    outOfStock,
    unresolvedReports,
    incompleteKits,
    importWarnings,
    pendingReservationRequests: pendingReservationRequestCount,
    returnChecks: returnCheckIssues.length,
    returnedWithIssues: returnedWithIssueItems.length,
    preparationTasks: preparationTaskCount,
    cancelledPickups: cancelledPickupOperations.length,
    readyForPickup: readyForPickupCount,
    annualAccessApprovals: annualAccessApprovalCount,
    issues,
  };
}
