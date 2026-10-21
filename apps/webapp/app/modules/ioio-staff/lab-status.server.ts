import { AssetType, type Prisma } from "@prisma/client";
import { db } from "~/database/db.server";
import { recordEvent } from "~/modules/activity-event/service.server";
import { IOIO_STAFF_RESERVATION_DESCRIPTION } from "~/modules/ioio-student/availability.server";
import {
  classifyIoioReport,
  IOIO_REPORT_LABELS,
} from "~/modules/ioio-student/report-problem.shared";
import { getStudentReturnIssueComment } from "~/modules/ioio-student/return-item.shared";
import { createNote } from "~/modules/note/service.server";
import { ShelfError } from "~/utils/error";

export type LabIssueSeverity = "critical" | "attention";
export type LabIssueKind =
  | "report"
  | "general-report"
  | "incomplete-kit"
  | "overdue-loan"
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
};

const LAB_ISSUE_OPERATIONS_VIEWS: Partial<Record<LabIssueKind, string>> = {
  report: "broken",
  "incomplete-kit": "broken",
  "general-report": "general",
  "overdue-loan": "overdue",
  "return-check": "returns",
  "returned-with-issue": "returned-with-issues",
  preparation: "to-prepare",
  "cancelled-pickup": "cancelled-pickups",
  "ready-for-pickup": "ready-for-pickup",
  "annual-access": "access-approvals",
};

/** Route each actionable Lab status issue to its Operations queue. */
export function getLabIssueOperationsHref(kind: LabIssueKind) {
  const view = LAB_ISSUE_OPERATIONS_VIEWS[kind];
  return view ? `/operations?view=${view}` : undefined;
}

export type LabStatus = {
  totalIssues: number;
  severity: "healthy" | LabIssueSeverity;
  overdueLoans: number;
  unresolvedReports: number;
  generalReports: number;
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
  resolveRelatedReports = true,
}: {
  organizationId: string;
  operationId: string;
  /** Bulk selection should resolve only the explicitly selected report rows. */
  resolveRelatedReports?: boolean;
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
    where: resolveRelatedReports
      ? {
          organizationId,
          operationType: "REPORT_PROBLEM",
          status: "SUCCEEDED",
          reportType: operation.reportType,
          assetId: operation.assetId,
          kitId: operation.kitId,
          locationId: operation.locationId,
        }
      : {
          id: operationId,
          organizationId,
          operationType: "REPORT_PROBLEM",
          status: "SUCCEEDED",
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
    "ITEM_MISSING",
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

    const asset = await ensureIoioAssetCanReturnToService({
      tx,
      organizationId,
      assetId: operation.assetId,
      ignoreReportOperationId: operation.id,
    });

    const resolved = await tx.ioioWriteOperation.updateMany({
      where: {
        id: operation.id,
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
 * Explicitly restore a previously resolved physical unit. Generic report
 * resolution deliberately leaves this persisted out-of-service condition
 * alone, so Staff need a safe recovery path after a report has been closed.
 */
export async function returnResolvedAssetToService({
  organizationId,
  assetId,
  staffUserId,
}: {
  organizationId: string;
  assetId: string;
  staffUserId: string;
}) {
  return db.$transaction(async (tx) => {
    const asset = await ensureIoioAssetCanReturnToService({
      tx,
      organizationId,
      assetId,
      requireIndividual: true,
    });
    if (asset.availableToBook) {
      throw new ShelfError({
        cause: null,
        message: "This physical unit is already available for borrowing.",
        label: "Inventory",
        status: 409,
        shouldBeCaptured: false,
      });
    }

    await markIoioAssetAvailable({ tx, asset, organizationId, staffUserId });
    return { assetId: asset.id, title: asset.title, status: "AVAILABLE" };
  });
}

async function ensureIoioAssetCanReturnToService({
  tx,
  organizationId,
  assetId,
  ignoreReportOperationId,
  requireIndividual = false,
}: {
  tx: Prisma.TransactionClient;
  organizationId: string;
  assetId: string;
  ignoreReportOperationId?: string;
  requireIndividual?: boolean;
}) {
  const asset = await tx.asset.findFirst({
    where: {
      id: assetId,
      organizationId,
      ...(requireIndividual ? { type: AssetType.INDIVIDUAL } : {}),
    },
    select: { id: true, title: true, status: true, availableToBook: true },
  });
  if (!asset) {
    throw new ShelfError({
      cause: null,
      message: "The physical unit could not be found in this workspace.",
      label: "Inventory",
      status: 404,
      shouldBeCaptured: false,
    });
  }
  if (asset.status !== "AVAILABLE") {
    throw new ShelfError({
      cause: null,
      message:
        "This unit is still checked out or in custody and cannot return to service yet.",
      label: "Inventory",
      status: 409,
      shouldBeCaptured: false,
    });
  }

  const [archived, custody, activeBooking, preparationHold, openIssue] =
    await Promise.all([
      tx.ioioArchivedItem.findFirst({
        where: {
          organizationId,
          itemType: "ASSET",
          itemId: asset.id,
          restoredAt: null,
        },
        select: { id: true },
      }),
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
          status: {
            in: ["PENDING_PREPARATION", "READY_FOR_PICKUP", "ASSIGNED"],
          },
          // The assigned request is a parent marker; its BookingAsset carries the actual hold.
          NOT: { source: "IOIO_PREPARATION_REQUEST", status: "ASSIGNED" },
        },
        select: { id: true },
      }),
      tx.ioioWriteOperation.findFirst({
        where: {
          organizationId,
          assetId: asset.id,
          operationType: "REPORT_PROBLEM",
          status: { in: ["SUCCEEDED", "PROCESSING"] },
          reportType: {
            in: [
              "ITEM_MISSING",
              "ITEM_DAMAGED",
              "ITEM_NOT_WORKING",
              "PART_MISSING",
              "KIT_INCOMPLETE",
            ],
          },
          ...(ignoreReportOperationId
            ? { id: { not: ignoreReportOperationId } }
            : {}),
        },
        select: { id: true },
      }),
    ]);
  const cancelledPreparationPickups = await tx.ioioWriteOperation.findMany({
    where: {
      organizationId,
      assetId: asset.id,
      operationType: "IOIO_PREPARATION",
      status: "CANCELLED_PICKUP",
      bookingId: { not: null },
      bookingAssetId: { not: null },
    },
    select: { bookingAssetId: true },
  });
  const cancelledPickupBookingAssetIds = cancelledPreparationPickups
    .map((operation) => operation.bookingAssetId)
    .filter((id): id is string => Boolean(id));
  const activeCancelledPickup = cancelledPickupBookingAssetIds.length
    ? await tx.bookingAsset.findFirst({
        where: {
          id: { in: cancelledPickupBookingAssetIds },
          assetId: asset.id,
          checkedInAt: null,
          booking: {
            organizationId,
            status: { in: ["RESERVED", "CANCELLED"] },
          },
        },
        select: { id: true },
      })
    : null;
  if (
    archived ||
    custody ||
    activeBooking ||
    preparationHold ||
    activeCancelledPickup ||
    openIssue
  ) {
    throw new ShelfError({
      cause: null,
      message:
        "Resolve the remaining loan, preparation, report, or archive hold before returning this unit to service.",
      label: "Inventory",
      status: 409,
      shouldBeCaptured: false,
    });
  }
  return asset;
}

async function markIoioAssetAvailable({
  tx,
  asset,
  organizationId,
  staffUserId,
}: {
  tx: Prisma.TransactionClient;
  asset: { id: string; title: string; availableToBook: boolean };
  organizationId: string;
  staffUserId: string;
}) {
  await tx.asset.update({
    where: { id: asset.id, organizationId },
    data: { availableToBook: true },
  });
  await createNote(
    {
      content: "Returned to service.",
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
      meta: { source: "IOIO_INVENTORY_RETURN_TO_SERVICE" },
    },
    tx
  );
}

/** Resolve a reviewed broken-item report while keeping its exact unit disabled. */
export async function resolveBrokenAssetOutOfService({
  organizationId,
  operationId,
}: {
  organizationId: string;
  operationId: string;
}) {
  const brokenTypes = [
    "ITEM_MISSING",
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
    if (!operation?.assetId) {
      throw new ShelfError({
        cause: null,
        message: "This broken item is no longer waiting for review.",
        label: "Operations",
        status: 409,
        shouldBeCaptured: false,
      });
    }

    const asset = await tx.asset.findFirst({
      where: {
        id: operation.assetId,
        organizationId,
        type: AssetType.INDIVIDUAL,
      },
      select: { id: true, availableToBook: true },
    });
    if (!asset) {
      throw new ShelfError({
        cause: null,
        message: "The reported physical unit could not be found.",
        label: "Operations",
        status: 404,
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
        message: "This broken item is no longer waiting for review.",
        label: "Operations",
        status: 409,
        shouldBeCaptured: false,
      });
    }

    await tx.asset.update({
      where: { id: asset.id, organizationId },
      data: { availableToBook: false },
    });
    return { assetId: asset.id, status: "OUT_OF_SERVICE" as const };
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
    reportOperations,
    importOperations,
    pendingReservationRequestCount,
    submittedReturnOperations,
    archivedMarkers,
    preparationTaskRows,
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
    db.ioioWriteOperation.findMany({
      where: {
        organizationId: preparationOrganizationId,
        operationType: "IOIO_PREPARATION",
        status: "PENDING_PREPARATION",
        source: { in: ["IOIO_PREPARATION_REQUEST", "IOIO_ASSISTANT"] },
      },
      select: { quantity: true },
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
      href: getLabIssueOperationsHref("return-check")!,
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
      href: getLabIssueOperationsHref("returned-with-issue")!,
    })
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
    const classification = classifyIoioReport(operation.reportType);
    const label =
      IOIO_REPORT_LABELS[
        operation.reportType as keyof typeof IOIO_REPORT_LABELS
      ] ?? "Operational report";
    const reference = getReportReference(operation, references);
    const isIncompleteKit = operation.reportType === "KIT_INCOMPLETE";
    const targetUnavailable = Boolean(
      (operation.assetId || operation.kitId || operation.locationId) &&
        (!reference || reference.href === null)
    );
    const kind: LabIssueKind =
      classification === "equipment-condition"
        ? isIncompleteKit
          ? "incomplete-kit"
          : "report"
        : "general-report";
    reportIssues.push({
      id: `report:${operation.id}`,
      kind,
      severity:
        classification === "equipment-condition" ? "critical" : "attention",
      title: reference ? `${label}: ${reference.label}` : label,
      detail: targetUnavailable
        ? "The linked item is no longer active. Review the submitted report."
        : "Staff review is required.",
      href:
        getLabIssueOperationsHref(kind) ??
        reference?.href ??
        "/reports/operational",
      targetUnavailable,
    });
  }

  const overdueIssues: LabIssue[] = overdueLoans.map((loan) => ({
    id: `overdue-loan:${loan.id}`,
    kind: "overdue-loan",
    severity: "attention",
    title: "Overdue loan",
    detail: `Due ${formatDueDate(loan.to)}.`,
    href: getLabIssueOperationsHref("overdue-loan")!,
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
  const preparationTaskCount = preparationTaskRows.reduce(
    (total, row) => total + Math.max(1, row.quantity ?? 1),
    0
  );
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
          href: getLabIssueOperationsHref("preparation")!,
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
          href: getLabIssueOperationsHref("annual-access")!,
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
        href: getLabIssueOperationsHref("cancelled-pickup")!,
      };
    }
  );

  // IOIO attention is reserved for operational work; Shelf quantity and
  // minimum-stock settings remain available without creating attention items.
  const issues: LabIssue[] = [
    ...reportIssues,
    ...overdueIssues,
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
  const generalReports = reportIssues.filter(
    (issue) => issue.kind === "general-report"
  ).length;
  const unresolvedReports =
    reportIssues.length - generalReports - incompleteKits;
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
    unresolvedReports,
    generalReports,
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
