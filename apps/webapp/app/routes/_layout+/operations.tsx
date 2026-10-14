import { Fragment, useEffect, useRef, useState } from "react";
import { CalendarDays, MapPin, MoreHorizontal, UserRound } from "lucide-react";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import {
  data,
  Form,
  Link,
  redirect,
  useActionData,
  useFetcher,
  useLoaderData,
} from "react-router";
import { AssetImage } from "~/components/assets/asset-image";
import type { AssetForThumbnail } from "~/components/assets/asset-image/types";
import {
  SelectableRow,
  toggleSelectionId,
} from "~/components/ioio-staff/selectable-row";
import { Dialog, DialogPortal } from "~/components/layout/dialog";
import { ListContentWrapper } from "~/components/list/content-wrapper";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/shared/dropdown";
import { db } from "~/database/db.server";
import {
  getPhysicalUnitBaseTitle,
  getPhysicalUnitNumberFromTitle,
} from "~/modules/asset/physical-unit";
import { resolveAssetImagesForPresentation } from "~/modules/asset/service.server";
import {
  buildOperationsReturnTo,
  withReturnTo,
} from "~/modules/booking/return-review-navigation";
import { getConfiguredBrokenSection } from "~/modules/ioio-lab-information/broken-section.server";
import {
  getLabStatus,
  resolveBrokenAssetOutOfService,
  resolveLabIssue,
  returnBrokenAssetToService,
} from "~/modules/ioio-staff/lab-status.server";
import {
  getPreparationPickupDeadline,
  getPreparationTargetDate,
} from "~/modules/ioio-staff/preparation";
import { getStaffPreparationQueueOrganizationId } from "~/modules/ioio-staff/preparation-queue.server";
import {
  confirmPreparationReady,
  confirmStudentPreparationPickup,
  cancelStudentPreparationRequest,
  declinePreparation,
  IOIO_PREPARATION_OPERATION,
  PREPARATION_CANCELLED_PICKUP,
  PREPARATION_PENDING,
  putBackCancelledPreparationPickup,
} from "~/modules/ioio-staff/preparation.server";
import { disableReturnedAssetFromUse } from "~/modules/ioio-staff/return-inspection.server";
import { formatApprovalDate } from "~/modules/ioio-student/annual-access";
import {
  declineAnnualAccessApproval,
  getStaffAnnualAccessApprovals,
  reapproveAnnualAccessApproval,
  revokeAnnualAccessApproval,
  reviewAnnualAccessApprovals,
} from "~/modules/ioio-student/annual-access.server";
import {
  getIoioAvailability,
  IOIO_STAFF_RESERVATION_ACKNOWLEDGEMENT,
  IOIO_STAFF_RESERVATION_DESCRIPTION,
} from "~/modules/ioio-student/availability.server";
import {
  classifyIoioReport,
  IOIO_REPORT_LABELS,
  isIoioPhysicalUnitBlockingReport,
} from "~/modules/ioio-student/report-problem.shared";
import { completeSubmittedReturn } from "~/modules/ioio-student/return-item.server";
import { getStudentReturnIssueComment } from "~/modules/ioio-student/return-item.shared";
import { getIoioPhysicalUnitDisplayName } from "~/modules/kit/ioio-kit-presentation";
import { getCompactLocationSummary } from "~/modules/location/compact-location";
import { setSelectedOrganizationIdCookie } from "~/modules/organization/context.server";
import { getWorkingHoursForOrganization } from "~/modules/working-hours/service.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { getClientHint } from "~/utils/client-hints";
import { setCookie } from "~/utils/cookies.server";
import { makeShelfError } from "~/utils/error";
import { error, payload } from "~/utils/http.server";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

const VIEWS = [
  "all",
  "overdue",
  "returns",
  "returned-with-issues",
  "broken",
  "general",
  "to-prepare",
  "cancelled-pickups",
  "ready-for-pickup",
  "access-approvals",
] as const;
type OperationsView = (typeof VIEWS)[number];
const SUMMARY_KEYS = [
  "overdue",
  "returns",
  "returned-with-issues",
  "broken",
  "general",
  "to-prepare",
  "cancelled-pickups",
  "ready-for-pickup",
  "access-approvals",
] as const;
const NAVIGATION_VIEWS = [
  "all",
  "overdue",
  "returns",
  "returned-with-issues",
  "broken",
  "general",
  "to-prepare",
  "cancelled-pickups",
  "ready-for-pickup",
  "access-approvals",
] as const satisfies readonly OperationsView[];

type Task = {
  id: string;
  kind: Exclude<OperationsView, "all">;
  title: string;
  detail: string;
  createdAt: Date;
  href: string;
  actionLabel: string;
  operationId?: string;
  preparationStatus?: string;
  bookingId?: string | null;
  borrowerName?: string;
  borrowerEmail?: string | null;
  quantity?: number;
  prepareBy?: string;
  requestedPeriod?: string;
  availableForRequestedPeriod?: number;
  availableNow?: number;
  totalPhysicalUnits?: number;
  physicalUnitAssignment?: string;
  pickupBy?: Date;
  locationName?: string;
  assetId?: string;
  assetImage?: AssetForThumbnail;
  brokenSection?: {
    name: string;
    path: string;
    imageUrl: string | null;
    thumbnailUrl: string | null;
  } | null;
  brokenSectionRelevant?: boolean;
  borrowerId?: string;
  preparationRequest?: boolean;
  bulkReadyEligible?: boolean;
  preparationBlockedReason?: string;
  softReservationOverlap?: boolean;
  returnCheckEligible?: boolean;
  returnIssue?: string;
  reportLabel?: string;
  reporterName?: string;
  reportDescription?: string;
  reportedLocation?: string;
  returnLocation?: string;
  returnIssueReportId?: string | null;
  returnIssueOperationId?: string;
  returnToServiceEligible?: boolean;
  physicalUnit?: boolean;
  cancelledAt?: Date;
  accessApprovalId?: string;
};

type AllBulkFamily = Exclude<OperationsView, "all">;
type AllSelectionEntry = {
  key: string;
  family: AllBulkFamily;
  id: string;
  task: Task;
  secondaryId?: string;
  reportId?: string;
};

function getAllSelectionEntry(task: Task): AllSelectionEntry | null {
  let family: AllBulkFamily | null = null;
  let id: string | undefined;
  let secondaryId: string | undefined;
  let reportId: string | undefined;
  switch (task.kind) {
    case "general":
      family = "general";
      id = task.operationId;
      reportId = task.operationId;
      break;
    case "broken":
      if (!task.physicalUnit || !task.returnToServiceEligible) return null;
      family = "broken";
      id = task.assetId;
      reportId = task.operationId;
      break;
    case "returns":
      if (!task.returnCheckEligible) return null;
      family = "returns";
      id = task.operationId;
      break;
    case "returned-with-issues":
      family = "returned-with-issues";
      id = task.operationId;
      secondaryId = task.returnIssueOperationId;
      reportId = task.returnIssueOperationId;
      break;
    case "to-prepare":
      family = "to-prepare";
      id = task.operationId;
      break;
    case "cancelled-pickups":
      family = "cancelled-pickups";
      id = task.operationId;
      break;
    case "access-approvals":
      family = "access-approvals";
      id = task.accessApprovalId;
      break;
    case "overdue":
    case "ready-for-pickup":
      family = task.kind;
      id = task.id;
      break;
  }
  if (!family || !id || (family === "returned-with-issues" && !secondaryId)) {
    return null;
  }
  return { family, id, secondaryId, reportId, task, key: `${family}:${id}` };
}

function readIdArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function formatOperationsDate(date: Date | null | undefined) {
  if (!date) return null;
  return `${date.toLocaleString("en-US", {
    day: "numeric",
  })} ${date.toLocaleString("en-US", { month: "short" })} ${date.toLocaleString(
    "en-US",
    { year: "numeric" }
  )}`;
}

function formatRequestedPeriod(from: Date, to: Date) {
  const start = from.toLocaleString("en-US", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
  });
  const end = to.toLocaleString("en-US", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
  });
  const startYear = from.getUTCFullYear();
  const endYear = to.getUTCFullYear();
  return startYear === endYear
    ? `${start} – ${end}, ${endYear}`
    : `${start}, ${startYear} – ${end}, ${endYear}`;
}

function BrokenSectionSummary({ task }: { task: Task }) {
  if (!task.brokenSectionRelevant || !task.brokenSection) return null;
  return (
    <p className="break-words text-sm text-gray-600">
      <span className="font-semibold text-gray-700">Broken section · </span>
      {task.brokenSection.path}
    </p>
  );
}

function BrokenReportActions({ task }: { task: Task }) {
  const fetcher = useFetcher();
  if (!task.operationId) return null;
  return (
    <div className="flex shrink-0 items-center justify-end gap-2">
      <Form method="post">
        <input type="hidden" name="intent" value="return-to-service" />
        <input type="hidden" name="operationId" value={task.operationId} />
        <button
          type="submit"
          className="rounded-lg bg-red-700 px-3 py-2 text-sm font-bold text-white hover:bg-red-800"
        >
          Return to service
        </button>
      </Form>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`More actions for ${task.title}`}
            className="inline-flex size-9 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-800 focus:outline-none focus:ring-2 focus:ring-red-300"
          >
            <MoreHorizontal className="size-4" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48 p-1">
          <DropdownMenuItem
            onSelect={() =>
              fetcher.submit(
                {
                  intent: "resolve-broken-report-out-of-service",
                  operationId: task.operationId!,
                },
                { method: "post" }
              )
            }
          >
            Keep out of service
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function formatOperationsLocationPath(
  locationId: string | null | undefined,
  locationsById: Map<
    string,
    { id: string; name: string; parentId: string | null }
  >
) {
  if (!locationId) return undefined;
  const names: string[] = [];
  const visited = new Set<string>();
  let current = locationsById.get(locationId);
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    names.unshift(current.name);
    current = current.parentId
      ? locationsById.get(current.parentId)
      : undefined;
  }
  if (!names.length) return undefined;
  const summary = getCompactLocationSummary(names);
  const storageLabel = summary.storageLabel?.replace(
    /^(?:Section|Shelf|Container)\s+(?=.*\bZone$)/iu,
    ""
  );
  return [summary.room, storageLabel].filter(Boolean).join(" · ");
}

export function getBrokenItemDestination(
  operation: {
    assetId: string | null;
    kitId: string | null;
    locationId: string | null;
  },
  assetById: ReadonlyMap<string, unknown>,
  kitById: ReadonlyMap<string, unknown>,
  locationById: ReadonlyMap<string, unknown>
) {
  if (operation.assetId && assetById.has(operation.assetId)) {
    return { href: `/assets/${operation.assetId}`, actionLabel: "Open unit" };
  }
  if (operation.kitId && kitById.has(operation.kitId)) {
    return { href: `/kits/${operation.kitId}`, actionLabel: "Open kit" };
  }
  if (operation.locationId && locationById.has(operation.locationId)) {
    return {
      href: `/locations/${operation.locationId}`,
      actionLabel: "Open location",
    };
  }
  return {
    href: "/operations?view=broken",
    actionLabel: "Review report",
  };
}

type BulkPreparationItemResult =
  | { operationId: string; ok: true; result: unknown }
  | { operationId: string; ok: false; error: string };

type BulkPreparationResult = {
  results: BulkPreparationItemResult[];
  succeeded: number;
  failed: number;
};

type ReturnCheckItemResult =
  | { operationId: string; ok: true }
  | { operationId: string; ok: false; error: string };

type ReturnCheckActionResult =
  | {
      ok: true;
      intent:
        | "complete-return"
        | "complete-return-bulk"
        | "disable-return"
        | "disable-return-bulk";
      operationId?: string;
      results?: ReturnCheckItemResult[];
      succeeded: number;
      failed: number;
    }
  | {
      ok: false;
      intent:
        | "complete-return"
        | "complete-return-bulk"
        | "disable-return"
        | "disable-return-bulk";
      operationId?: string;
      error: string;
    };

function isSuccessfulAction(
  value: unknown
): value is { ok: true; result: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    value.ok === true &&
    "result" in value
  );
}

function isBulkPreparationResult(
  value: unknown
): value is BulkPreparationResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "succeeded" in value &&
    typeof value.succeeded === "number" &&
    "failed" in value &&
    typeof value.failed === "number" &&
    "results" in value &&
    Array.isArray(value.results)
  );
}

function isAnnualAccessAction(value: unknown): value is {
  ok: true;
  intent:
    | "approve-access"
    | "approve-access-bulk"
    | "decline-access"
    | "decline-access-bulk"
    | "reapprove-access"
    | "revoke-access";
  result: {
    approvedCount?: number;
    failedCount?: number;
    declined?: boolean;
    revoked?: boolean;
    reapproved?: boolean;
    failed?: number | Array<{ id: string; name: string; reason: string }>;
    succeeded?: number;
    failedCount?: number;
  };
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    value.ok === true &&
    "intent" in value &&
    (value.intent === "approve-access" ||
      value.intent === "approve-access-bulk" ||
      value.intent === "decline-access" ||
      value.intent === "decline-access-bulk" ||
      value.intent === "reapprove-access" ||
      value.intent === "revoke-access") &&
    "result" in value
  );
}

function getView(value: string | null): OperationsView {
  return VIEWS.includes(value as OperationsView)
    ? (value as OperationsView)
    : "all";
}

function displayName(
  user: {
    displayName: string | null;
    firstName: string | null;
    lastName: string | null;
    email: string;
  } | null
) {
  if (!user) return "Shelf user";
  return (
    user.displayName ||
    [user.firstName, user.lastName].filter(Boolean).join(" ") ||
    user.email
  );
}

export const meta: MetaFunction<typeof loader> = ({ data: loaderData }) => [
  { title: appendToMetaTitle(loaderData?.header.title ?? "Lab status") },
];

export async function loader({ context, request }: LoaderFunctionArgs) {
  const { userId } = context.getSession();

  try {
    const { organizationId, currentOrganization, userOrganizations } =
      await requirePermission({
        userId,
        request,
        entity: PermissionEntity.reports,
        action: PermissionAction.read,
      });
    const url = new URL(request.url);
    if (
      currentOrganization.type === "PERSONAL" &&
      getView(url.searchParams.get("view")) === "to-prepare"
    ) {
      const queueOrganizationId = await getStaffPreparationQueueOrganizationId({
        organizationId,
        organizationType: currentOrganization.type,
        userOrganizations,
      });
      if (queueOrganizationId !== organizationId) {
        return redirect(url.toString(), {
          headers: [
            setCookie(
              await setSelectedOrganizationIdCookie(queueOrganizationId)
            ),
          ],
        });
      }
    }
    const operationsReturnTo = buildOperationsReturnTo(
      url.searchParams.get("view")
    );

    const [
      overdueLoans,
      submittedReturns,
      reportOperations,
      preparationOperations,
      cancelledPickupOperations,
      readyPickupOperations,
      workingHours,
      labStatus,
      brokenSection,
    ] = await Promise.all([
      db.booking.findMany({
        where: {
          organizationId,
          status: "OVERDUE",
          OR: [
            { description: { not: IOIO_STAFF_RESERVATION_DESCRIPTION } },
            { description: null },
          ],
        },
        select: { id: true, name: true, to: true },
        orderBy: [{ to: "asc" }, { id: "asc" }],
      }),
      db.ioioWriteOperation.findMany({
        where: {
          organizationId,
          operationType: "RETURN_ITEM",
          status: "SUBMITTED",
        },
        select: {
          id: true,
          userId: true,
          assetId: true,
          bookingAssetId: true,
          quantity: true,
          createdAt: true,
          description: true,
          locationId: true,
          reportType: true,
          resultReportId: true,
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
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
          userId: true,
          reportType: true,
          description: true,
          assetId: true,
          kitId: true,
          locationId: true,
          bookingAssetId: true,
          resultReportId: true,
          createdAt: true,
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      }),
      db.ioioWriteOperation.findMany({
        where: {
          organizationId,
          operationType: IOIO_PREPARATION_OPERATION,
          status: PREPARATION_PENDING,
          source: { in: ["IOIO_PREPARATION_REQUEST", "IOIO_ASSISTANT"] },
        },
        select: {
          id: true,
          userId: true,
          assetId: true,
          bookingId: true,
          bookingAssetId: true,
          source: true,
          selectedAssetIds: true,
          quantity: true,
          from: true,
          to: true,
          locationId: true,
          createdAt: true,
          status: true,
          reviewComment: true,
          description: true,
        },
        orderBy: [{ from: "asc" }, { id: "asc" }],
      }),
      db.ioioWriteOperation.findMany({
        where: {
          organizationId,
          operationType: IOIO_PREPARATION_OPERATION,
          status: PREPARATION_CANCELLED_PICKUP,
        },
        select: {
          id: true,
          userId: true,
          assetId: true,
          bookingId: true,
          bookingAssetId: true,
          locationId: true,
          createdAt: true,
          reviewedAt: true,
          reviewComment: true,
        },
        orderBy: [{ reviewedAt: "asc" }, { id: "asc" }],
      }),
      db.ioioWriteOperation.findMany({
        where: {
          organizationId,
          operationType: IOIO_PREPARATION_OPERATION,
          status: "READY_FOR_PICKUP",
        },
        select: {
          id: true,
          userId: true,
          assetId: true,
          bookingId: true,
          quantity: true,
          locationId: true,
          createdAt: true,
          reviewedAt: true,
          reviewComment: true,
        },
        orderBy: [{ reviewedAt: "asc" }, { id: "asc" }],
      }),
      getWorkingHoursForOrganization(organizationId),
      getLabStatus({ organizationId }),
      getConfiguredBrokenSection(organizationId),
    ]);

    const assignmentBookingIds = preparationOperations
      .map((operation) => operation.bookingId)
      .filter((id): id is string => Boolean(id));
    const assignmentBookings = assignmentBookingIds.length
      ? await db.booking.findMany({
          where: { organizationId, id: { in: assignmentBookingIds } },
          select: {
            id: true,
            status: true,
            bookingAssets: {
              select: { id: true, assetId: true, quantity: true },
            },
          },
        })
      : [];

    const annualAccessApprovals = await getStaffAnnualAccessApprovals({
      organizationId,
    });

    const returnBookingAssetIds = submittedReturns
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
            sourceKitId: true,
            asset: { select: { returnHandling: true } },
          },
        })
      : [];
    const returnBookingAssetById = new Map(
      returnBookingAssets.map((bookingAsset) => [bookingAsset.id, bookingAsset])
    );
    const returnTasks = submittedReturns.filter((operation) => {
      const bookingAsset = operation.bookingAssetId
        ? returnBookingAssetById.get(operation.bookingAssetId)
        : null;
      if (bookingAsset?.checkedInAt) return false;
      return (
        operation.reportType !== "RETURN_ITEM" ||
        bookingAsset?.asset.returnHandling === "RETURN_TO_RETURN_ZONE"
      );
    });
    const returnedWithIssueReportBookingAssetIds = new Set(
      reportOperations.flatMap((operation) =>
        operation.source === "IOIO_STUDENT_RETURN" && operation.bookingAssetId
          ? [operation.bookingAssetId]
          : []
      )
    );
    const returnedWithIssueTasks = returnTasks.filter(
      (operation) =>
        operation.reportType !== "RETURN_ITEM" ||
        returnedWithIssueReportBookingAssetIds.has(
          operation.bookingAssetId ?? ""
        )
    );
    const activeIssueReturnBookingAssetIds = new Set(
      returnedWithIssueTasks
        .map((operation) => operation.bookingAssetId)
        .filter((id): id is string => Boolean(id))
    );
    const reportOperationsForAll = reportOperations.filter(
      (operation) =>
        operation.source !== "IOIO_STUDENT_RETURN" ||
        !activeIssueReturnBookingAssetIds.has(operation.bookingAssetId ?? "")
    );
    const ordinaryReturnTasks = returnTasks.filter(
      (operation) => !returnedWithIssueTasks.includes(operation)
    );

    const assetIds = [
      ...returnTasks,
      ...reportOperations,
      ...preparationOperations,
      ...cancelledPickupOperations,
      ...readyPickupOperations,
    ]
      .map((operation) => operation.assetId)
      .filter((id): id is string => Boolean(id))
      .concat(
        assignmentBookings.flatMap((booking) =>
          booking.bookingAssets.map(({ assetId }) => assetId)
        )
      );
    const returnKitIds = returnTasks.flatMap((operation) => {
      const sourceKitId = operation.bookingAssetId
        ? returnBookingAssetById.get(operation.bookingAssetId)?.sourceKitId
        : null;
      return sourceKitId ? [sourceKitId] : [];
    });
    const kitIds = [
      ...reportOperations
        .map((operation) => operation.kitId)
        .filter((id): id is string => Boolean(id)),
      ...returnKitIds,
    ];
    const userIds = [
      ...returnTasks,
      ...reportOperations,
      ...preparationOperations,
      ...cancelledPickupOperations,
      ...readyPickupOperations,
    ].map((operation) => operation.userId);

    const [rawAssets, kits, locations, users] = await Promise.all([
      db.asset.findMany({
        where: {
          organizationId,
          id: { in: [...new Set(assetIds)] },
        },
        select: {
          id: true,
          title: true,
          type: true,
          sequentialId: true,
          mainImage: true,
          thumbnailImage: true,
          mainImageStoragePath: true,
          thumbnailImageStoragePath: true,
          assetModel: {
            select: {
              name: true,
              image: true,
              thumbnailImage: true,
              imageStoragePath: true,
              thumbnailImageStoragePath: true,
            },
          },
          assetKits: {
            take: 1,
            select: {
              kit: {
                select: { name: true, image: true, imageStoragePath: true },
              },
            },
          },
          assetLocations: {
            select: { locationId: true },
          },
        },
      }),
      db.kit.findMany({
        where: { organizationId, id: { in: kitIds } },
        select: { id: true, name: true },
      }),
      db.location.findMany({
        where: { organizationId },
        select: { id: true, name: true, parentId: true },
      }),
      db.user.findMany({
        where: {
          userOrganizations: { some: { organizationId } },
          id: { in: userIds },
        },
        select: {
          id: true,
          email: true,
          displayName: true,
          firstName: true,
          lastName: true,
        },
      }),
    ]);
    const assets = await resolveAssetImagesForPresentation(rawAssets);

    const assetById = new Map(assets.map((asset) => [asset.id, asset]));
    const kitById = new Map(kits.map((kit) => [kit.id, kit]));
    const locationById = new Map(
      locations.map((location) => [location.id, location])
    );
    const userById = new Map(users.map((user) => [user.id, user]));
    const reportedReturnIssueBookingAssetIds = new Set(
      reportOperations.flatMap((operation) =>
        operation.bookingAssetId ? [operation.bookingAssetId] : []
      )
    );
    const returnIssueByBookingAssetId = new Map(
      reportOperations
        .filter((operation) => operation.bookingAssetId)
        .map((operation) => [operation.bookingAssetId!, operation])
    );
    const assignmentBookingById = new Map(
      assignmentBookings.map((booking) => [booking.id, booking])
    );
    const reportedBrokenPhysicalAssetIds = new Set<string>();
    const reportOperationsForQueue = reportOperationsForAll.filter(
      (operation) => {
        const asset = operation.assetId
          ? assetById.get(operation.assetId)
          : undefined;
        const isBrokenPhysicalReport = Boolean(
          asset?.type === "INDIVIDUAL" &&
            classifyIoioReport(operation.reportType) === "equipment-condition"
        );
        if (!isBrokenPhysicalReport || !operation.assetId) return true;
        if (reportedBrokenPhysicalAssetIds.has(operation.assetId)) return false;
        reportedBrokenPhysicalAssetIds.add(operation.assetId);
        return true;
      }
    );
    const now = new Date();
    const nowEnd = new Date(now.getTime() + 1);
    const preparationAvailability = await Promise.all(
      preparationOperations
        .filter(
          (operation) =>
            operation.source === "IOIO_PREPARATION_REQUEST" &&
            operation.assetId &&
            operation.from &&
            operation.to &&
            assignmentBookingById.get(operation.bookingId ?? "")?.status !==
              "RESERVED"
        )
        .map(async (operation) => {
          const product = assetById.get(operation.assetId!);
          const candidateAssetIds = readIdArray(operation.selectedAssetIds);
          if (!product) {
            return [
              operation.id,
              { availableForRequestedPeriod: 0, availableNow: 0, total: 0 },
            ] as const;
          }
          const [periodAvailability, currentAvailability] = await Promise.all([
            getIoioAvailability({
              organizationId,
              productId: product.id,
              candidateAssetIds:
                product.type === "INDIVIDUAL" ? candidateAssetIds : undefined,
              from: operation.from!,
              to: operation.to!,
              excludeBookingId: operation.bookingId ?? undefined,
            }),
            getIoioAvailability({
              organizationId,
              productId: product.id,
              from: now,
              to: nowEnd,
            }),
          ]);
          return [
            operation.id,
            {
              availableForRequestedPeriod:
                product.type === "INDIVIDUAL"
                  ? (operation.description?.includes(
                      IOIO_STAFF_RESERVATION_ACKNOWLEDGEMENT
                    ) ?? false
                      ? periodAvailability.availableUnitIdsWithoutStaffReservations
                      : periodAvailability.availableUnitIds
                    ).length
                  : operation.description?.includes(
                      IOIO_STAFF_RESERVATION_ACKNOWLEDGEMENT
                    ) ?? false
                  ? periodAvailability.availableWithoutStaffReservations
                  : periodAvailability.availableCount,
              availableNow:
                product.type === "INDIVIDUAL"
                  ? currentAvailability.availableCount
                  : currentAvailability.availableWithoutStaffReservations,
              total: periodAvailability.totalActive,
            },
          ] as const;
        })
    );
    const availabilityByPreparationId = new Map(preparationAvailability);
    const tasks: Task[] = [
      ...overdueLoans.map((loan) => ({
        id: `overdue-${loan.id}`,
        kind: "overdue" as const,
        title: loan.name,
        detail: `Due ${loan.to?.toLocaleDateString() ?? "date unavailable"}`,
        createdAt: loan.to ?? new Date(0),
        href: `/bookings/${loan.id}`,
        actionLabel: "Open loan",
      })),
      ...ordinaryReturnTasks.map((operation) => ({
        id: operation.id,
        kind: "returns" as const,
        title: (() => {
          const asset = assetById.get(operation.assetId ?? "");
          const bookingAsset = operation.bookingAssetId
            ? returnBookingAssetById.get(operation.bookingAssetId)
            : null;
          if (!asset) return "Returned item";
          if (!bookingAsset?.sourceKitId && asset.type !== "INDIVIDUAL") {
            return asset.title;
          }
          return getIoioPhysicalUnitDisplayName({
            logicalProductName:
              (bookingAsset?.sourceKitId
                ? kitById.get(bookingAsset.sourceKitId)?.name
                : null) ??
              asset.assetModel?.name ??
              asset.title,
            unitNumber:
              getPhysicalUnitNumberFromTitle(asset.title) ?? asset.sequentialId,
            missingUnitLabel: "Unit number missing",
          });
        })(),
        detail: `${
          operation.reportType === "RETURN_ITEM"
            ? "Return submitted"
            : "Issue reported"
        } by ${displayName(userById.get(operation.userId) ?? null)}`,
        createdAt: operation.createdAt,
        quantity: operation.quantity ?? 1,
        href: withReturnTo(
          `/bookings/return-check/${operation.id}`,
          operationsReturnTo
        ),
        actionLabel: "Review return",
        operationId: operation.id,
        borrowerName: displayName(userById.get(operation.userId) ?? null),
        assetId: operation.assetId ?? undefined,
        assetImage: assetById.get(operation.assetId ?? ""),
        returnCheckEligible:
          operation.reportType === "RETURN_ITEM" &&
          !reportedReturnIssueBookingAssetIds.has(
            operation.bookingAssetId ?? ""
          ),
        returnIssue:
          operation.reportType === "RETURN_ITEM"
            ? reportedReturnIssueBookingAssetIds.has(
                operation.bookingAssetId ?? ""
              )
              ? "Needs review · issue reported"
              : undefined
            : "Needs review · issue reported",
        returnLocation:
          formatOperationsLocationPath(operation.locationId, locationById) ??
          "Return Zone",
      })),
      ...returnedWithIssueTasks.map((operation) => {
        const asset = assetById.get(operation.assetId ?? "");
        const bookingAsset = operation.bookingAssetId
          ? returnBookingAssetById.get(operation.bookingAssetId)
          : null;
        const borrower = userById.get(operation.userId) ?? null;
        const title = !asset
          ? "Returned item"
          : !bookingAsset?.sourceKitId && asset.type !== "INDIVIDUAL"
          ? asset.title
          : getIoioPhysicalUnitDisplayName({
              logicalProductName:
                (bookingAsset?.sourceKitId
                  ? kitById.get(bookingAsset.sourceKitId)?.name
                  : null) ??
                asset.assetModel?.name ??
                asset.title,
              unitNumber:
                getPhysicalUnitNumberFromTitle(asset.title) ??
                asset.sequentialId,
              missingUnitLabel: "Unit number missing",
            });
        return {
          id: operation.id,
          kind: "returned-with-issues" as const,
          title,
          detail: `Returned with issue · ${displayName(borrower)}`,
          createdAt: operation.createdAt,
          quantity: operation.quantity ?? 1,
          href: withReturnTo(
            `/bookings/return-check/${operation.id}`,
            operationsReturnTo
          ),
          actionLabel: "Review return",
          operationId: operation.id,
          borrowerName: displayName(borrower),
          assetId: operation.assetId ?? undefined,
          assetImage: asset,
          returnIssue:
            getStudentReturnIssueComment(operation.description) ??
            "The Student reported a problem; no additional note was provided.",
          returnLocation:
            formatOperationsLocationPath(operation.locationId, locationById) ??
            "Broken Zone",
          returnIssueReportId: operation.resultReportId,
          returnIssueOperationId: operation.bookingAssetId
            ? returnIssueByBookingAssetId.get(operation.bookingAssetId)?.id
            : undefined,
          returnToServiceEligible: Boolean(
            operation.assetId &&
              asset?.type === "INDIVIDUAL" &&
              operation.bookingAssetId &&
              isIoioPhysicalUnitBlockingReport(
                returnIssueByBookingAssetId.get(operation.bookingAssetId)
                  ?.reportType ?? null
              )
          ),
        };
      }),
      ...reportOperationsForQueue.map((operation) => {
        const asset = operation.assetId
          ? assetById.get(operation.assetId)
          : undefined;
        const physicalUnit = asset?.type === "INDIVIDUAL";
        const reference = physicalUnit
          ? getIoioPhysicalUnitDisplayName({
              logicalProductName:
                asset.assetModel?.name ??
                getPhysicalUnitBaseTitle(asset.title) ??
                asset.title,
              unitNumber:
                getPhysicalUnitNumberFromTitle(asset.title) ??
                asset.sequentialId,
              missingUnitLabel: "Unit number missing",
            })
          : operation.assetId
          ? asset?.title
          : operation.kitId
          ? kitById.get(operation.kitId)?.name
          : operation.locationId
          ? locationById.get(operation.locationId)?.name
          : undefined;
        const destination = getBrokenItemDestination(
          operation,
          assetById,
          kitById,
          locationById
        );
        const classification = classifyIoioReport(operation.reportType);
        const reportLabel =
          IOIO_REPORT_LABELS[
            operation.reportType as keyof typeof IOIO_REPORT_LABELS
          ] ?? "Operational report";
        const shouldShowBrokenSection = Boolean(
          physicalUnit && classification === "equipment-condition"
        );
        return {
          id: operation.id,
          kind:
            classification === "equipment-condition"
              ? ("broken" as const)
              : ("general" as const),
          title: reference ?? "Operational report",
          detail: operation.description?.trim() ?? "",
          reportLabel,
          reporterName: displayName(userById.get(operation.userId) ?? null),
          reportDescription: operation.description?.trim() ?? undefined,
          reportedLocation: operation.locationId
            ? formatOperationsLocationPath(operation.locationId, locationById)
            : undefined,
          createdAt: operation.createdAt,
          operationId: operation.id,
          assetId: operation.assetId ?? undefined,
          assetImage: asset,
          physicalUnit,
          brokenSection: shouldShowBrokenSection ? brokenSection : null,
          brokenSectionRelevant: shouldShowBrokenSection,
          locationName: operation.locationId
            ? formatOperationsLocationPath(operation.locationId, locationById)
            : undefined,
          returnToServiceEligible: Boolean(
            operation.assetId &&
              physicalUnit &&
              classification === "equipment-condition"
          ),
          ...destination,
        };
      }),
      ...preparationOperations.map((operation) => {
        const borrower = userById.get(operation.userId) ?? null;
        const asset = assetById.get(operation.assetId ?? "");
        const preparationRequest =
          operation.source === "IOIO_PREPARATION_REQUEST";
        const logicalTitle =
          asset?.assetModel?.name ??
          asset?.assetKits[0]?.kit?.name ??
          (asset?.type === "INDIVIDUAL"
            ? getPhysicalUnitBaseTitle(asset.title)
            : asset?.title);
        const assignedBooking = operation.bookingId
          ? assignmentBookingById.get(operation.bookingId)
          : null;
        const storedCandidateIds = readIdArray(operation.selectedAssetIds);
        const hasValidRequestDetails = Boolean(
          operation.assetId &&
            operation.quantity &&
            operation.from &&
            operation.to
        );
        const eligibleLogicalRequest = preparationRequest
          ? Boolean(
              hasValidRequestDetails &&
                asset &&
                (asset.type !== "INDIVIDUAL" ||
                  storedCandidateIds.length >= (operation.quantity ?? 1)) &&
                (!assignedBooking ||
                  assignedBooking.status === "DRAFT" ||
                  assignedBooking.status === "RESERVED") &&
                (assignedBooking?.status !== "RESERVED" ||
                  (assignedBooking.bookingAssets.length ===
                    (asset?.type === "INDIVIDUAL" ? operation.quantity : 1) &&
                    assignedBooking.bookingAssets.every((bookingAsset) =>
                      asset?.type === "INDIVIDUAL"
                        ? storedCandidateIds.includes(bookingAsset.assetId)
                        : bookingAsset.assetId === asset.id &&
                          bookingAsset.quantity === operation.quantity
                    ))) &&
                (assignedBooking?.status === "RESERVED" ||
                  (availabilityByPreparationId.get(operation.id)
                    ?.availableForRequestedPeriod ?? 0) >=
                    (operation.quantity ?? 1))
            )
          : false;
        const eligibleAssignedTask = Boolean(
          operation.bookingId &&
            operation.bookingAssetId &&
            assignedBooking?.status === "RESERVED" &&
            assignedBooking.bookingAssets.some(
              (bookingAsset) =>
                bookingAsset.id === operation.bookingAssetId &&
                bookingAsset.assetId === operation.assetId
            )
        );
        const bulkReadyEligible = preparationRequest
          ? eligibleLogicalRequest
          : eligibleAssignedTask;
        const preparationBlockedReason = preparationRequest
          ? !hasValidRequestDetails
            ? "The request is missing required booking details."
            : !asset
            ? "The requested item could not be found."
            : asset.type === "INDIVIDUAL" &&
              storedCandidateIds.length < (operation.quantity ?? 1)
            ? "There are not enough valid units attached to this request."
            : assignedBooking?.status !== "RESERVED" &&
              (availabilityByPreparationId.get(operation.id)
                ?.availableForRequestedPeriod ?? 0) < (operation.quantity ?? 1)
            ? "Not enough requested items are currently available."
            : assignedBooking &&
              assignedBooking.status !== "DRAFT" &&
              assignedBooking.status !== "RESERVED"
            ? "The linked booking is no longer reservable."
            : assignedBooking?.status === "RESERVED" && !eligibleLogicalRequest
            ? "The reserved booking does not match this request."
            : undefined
          : !operation.bookingAssetId
          ? "This preparation task has no assigned booking item."
          : !assignedBooking
          ? "The linked Shelf booking could not be found."
          : assignedBooking.status !== "RESERVED"
          ? "The linked Shelf booking is not reserved."
          : "The assigned booking item does not match this request.";
        const assignedUnitNames =
          preparationRequest &&
          asset?.type === "INDIVIDUAL" &&
          assignedBooking?.status === "RESERVED"
            ? assignedBooking.bookingAssets.flatMap(({ assetId }) => {
                const assignedAsset = assetById.get(assetId);
                if (!assignedAsset) return [];
                return [
                  getIoioPhysicalUnitDisplayName({
                    logicalProductName:
                      assignedAsset.assetModel?.name ??
                      assignedAsset.assetKits[0]?.kit?.name ??
                      getPhysicalUnitBaseTitle(assignedAsset.title),
                    unitNumber:
                      getPhysicalUnitNumberFromTitle(assignedAsset.title) ??
                      assignedAsset.sequentialId,
                    missingUnitLabel: "Unit number missing",
                  }),
                ];
              })
            : [];
        return {
          id: operation.id,
          kind: "to-prepare" as const,
          title: logicalTitle ?? "Item",
          detail: operation.reviewComment?.startsWith("Pickup expired")
            ? "Pickup expired"
            : "Cancelled pickup",
          createdAt: operation.createdAt,
          href: "/operations?view=to-prepare",
          actionLabel: "Mark prepared",
          operationId: operation.id,
          preparationStatus: operation.status,
          requiresUnitVerification:
            !preparationRequest && asset?.type === "INDIVIDUAL",
          bookingId: operation.bookingId,
          borrowerName: displayName(borrower),
          borrowerEmail: borrower?.email ?? null,
          borrowerId: borrower?.id,
          preparationRequest,
          softReservationOverlap:
            operation.description?.includes(
              IOIO_STAFF_RESERVATION_ACKNOWLEDGEMENT
            ) ?? false,
          bulkReadyEligible,
          preparationBlockedReason: bulkReadyEligible
            ? undefined
            : preparationBlockedReason,
          assetId: operation.assetId ?? undefined,
          assetImage: asset
            ? {
                id: asset.id,
                mainImage: asset.mainImage,
                thumbnailImage: asset.thumbnailImage,
                assetModel: asset.assetModel,
                kitImage: asset.assetKits[0]?.kit?.image ?? null,
                kitThumbnailImage: null,
              }
            : undefined,
          quantity: operation.quantity ?? 1,
          requestedPeriod:
            preparationRequest && operation.from && operation.to
              ? formatRequestedPeriod(operation.from, operation.to)
              : undefined,
          availableForRequestedPeriod: availabilityByPreparationId.get(
            operation.id
          )?.availableForRequestedPeriod,
          availableNow: availabilityByPreparationId.get(operation.id)
            ?.availableNow,
          totalPhysicalUnits: availabilityByPreparationId.get(operation.id)
            ?.total,
          physicalUnitAssignment:
            asset?.type === "INDIVIDUAL"
              ? assignedUnitNames.length
                ? `Assigned: ${assignedUnitNames.join(", ")}`
                : preparationRequest
                ? "No unit assigned yet"
                : undefined
              : undefined,
          prepareBy:
            formatOperationsDate(
              getPreparationTargetDate(operation.createdAt, workingHours)
            ) ?? undefined,
          locationName: formatOperationsLocationPath(
            operation.locationId ??
              (asset?.assetLocations.length === 1
                ? asset.assetLocations[0]?.locationId
                : undefined),
            locationById
          ),
        };
      }),
      ...cancelledPickupOperations.map((operation) => {
        const asset = assetById.get(operation.assetId ?? "");
        const borrower = userById.get(operation.userId) ?? null;
        const locationName = formatOperationsLocationPath(
          operation.locationId,
          locationById
        );
        const title = asset
          ? getIoioPhysicalUnitDisplayName({
              logicalProductName:
                asset.assetModel?.name ??
                asset.assetKits[0]?.kit?.name ??
                getPhysicalUnitBaseTitle(asset.title),
              unitNumber:
                getPhysicalUnitNumberFromTitle(asset.title) ??
                asset.sequentialId,
              missingUnitLabel: "Unit number missing",
            })
          : "Prepared item";
        return {
          id: operation.id,
          kind: "cancelled-pickups" as const,
          title,
          detail: operation.reviewComment?.startsWith("Pickup expired")
            ? "Pickup expired"
            : "Cancelled pickup",
          createdAt: operation.reviewedAt ?? operation.createdAt,
          cancelledAt: operation.reviewedAt ?? operation.createdAt,
          href: "/operations?view=cancelled-pickups",
          actionLabel: "Put back",
          operationId: operation.id,
          borrowerName: displayName(borrower),
          assetId: operation.assetId ?? undefined,
          assetImage: asset
            ? {
                id: asset.id,
                mainImage: asset.mainImage,
                thumbnailImage: asset.thumbnailImage,
                assetModel: asset.assetModel,
                kitImage: asset.assetKits[0]?.kit?.image ?? null,
                kitThumbnailImage: null,
              }
            : undefined,
          locationName,
        };
      }),
      ...readyPickupOperations.map((operation) => {
        const asset = assetById.get(operation.assetId ?? "");
        const borrower = userById.get(operation.userId) ?? null;
        const title = asset
          ? asset.type === "INDIVIDUAL"
            ? getIoioPhysicalUnitDisplayName({
                logicalProductName:
                  asset.assetModel?.name ??
                  asset.assetKits[0]?.kit?.name ??
                  getPhysicalUnitBaseTitle(asset.title),
                unitNumber:
                  getPhysicalUnitNumberFromTitle(asset.title) ??
                  asset.sequentialId,
                missingUnitLabel: "Unit number missing",
              })
            : asset.title
          : "Prepared item";
        const locationName = formatOperationsLocationPath(
          operation.locationId,
          locationById
        );
        return {
          id: operation.id,
          kind: "ready-for-pickup" as const,
          operationId: operation.id,
          title,
          detail: `Waiting for ${displayName(borrower)} to collect from ${
            locationName || "the Pickup Zone"
          }.`,
          createdAt: operation.reviewedAt ?? operation.createdAt,
          pickupBy: operation.reviewedAt
            ? getPreparationPickupDeadline(operation.reviewedAt)
            : undefined,
          href: operation.bookingId
            ? `/bookings/${operation.bookingId}`
            : "/bookings?status=RESERVED",
          actionLabel: "View booking",
          bookingId: operation.bookingId,
          borrowerName: displayName(borrower),
          quantity: operation.quantity ?? 1,
          physicalUnitAssignment:
            asset?.type === "INDIVIDUAL" ? `Assigned: ${title}` : undefined,
          assetId: operation.assetId ?? undefined,
          assetImage: asset
            ? {
                id: asset.id,
                mainImage: asset.mainImage,
                thumbnailImage: asset.thumbnailImage,
                assetModel: asset.assetModel,
                kitImage: asset.assetKits[0]?.kit?.image ?? null,
                kitThumbnailImage: null,
              }
            : undefined,
          locationName,
        };
      }),
    ];

    return data(
      payload({
        header: { title: "Lab status" },
        view: getView(new URL(request.url).searchParams.get("view")),
        summary: {
          overdue: labStatus.overdueLoans,
          returns: labStatus.returnChecks,
          "returned-with-issues": labStatus.returnedWithIssues,
          broken: new Set(
            tasks
              .filter(
                (task) =>
                  task.kind === "broken" &&
                  task.returnToServiceEligible &&
                  task.physicalUnit &&
                  task.assetId
              )
              .map((task) => task.assetId)
          ).size,
          // Derive the Operations counter from the same pending rows rendered
          // below so the count and Items to prepare list cannot drift apart.
          "to-prepare": preparationOperations.length,
          general: tasks.filter((task) => task.kind === "general").length,
          "cancelled-pickups": labStatus.cancelledPickups,
          "ready-for-pickup": labStatus.readyForPickup,
          "access-approvals": labStatus.annualAccessApprovals,
        },
        tasks,
        annualAccessApprovals,
      })
    );
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    throw data(error(reason), { status: reason.status });
  }
}

export async function action({ context, request }: ActionFunctionArgs) {
  const { userId } = context.getSession();
  try {
    const permission = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.reports,
      action: PermissionAction.update,
    });
    const { organizationId } = permission;
    const staffAuth = { organizationId, userId, role: permission.role };
    const formData = await request.formData();
    const intent = formData.get("intent");
    if (
      [
        "complete-return",
        "complete-return-bulk",
        "disable-return",
        "disable-return-bulk",
        "return-issue-to-service",
        "remove-return-issue-from-service",
        "return-issue-to-service-bulk",
        "remove-return-issue-from-service-bulk",
      ].includes(String(intent)) &&
      permission.role !== "ADMIN" &&
      permission.role !== "OWNER"
    ) {
      throw new Response("Staff access required", { status: 403 });
    }
    if (intent === "return-to-service") {
      if (permission.role !== "ADMIN" && permission.role !== "OWNER") {
        throw new Response("Staff access required", { status: 403 });
      }
      const result = await returnBrokenAssetToService({
        organizationId,
        operationId: String(formData.get("operationId") ?? ""),
        staffUserId: userId,
      });
      return data({ ok: true as const, intent, result });
    }
    if (intent === "resolve-broken-report-out-of-service") {
      if (permission.role !== "ADMIN" && permission.role !== "OWNER") {
        throw new Response("Staff access required", { status: 403 });
      }
      const result = await resolveBrokenAssetOutOfService({
        organizationId,
        operationId: String(formData.get("operationId") ?? ""),
      });
      return data({ ok: true as const, intent, result });
    }
    if (intent === "resolve-report-bulk") {
      const operationIds = [
        ...new Set(formData.getAll("operationIds").map(String).filter(Boolean)),
      ];
      const openReports = operationIds.length
        ? await db.ioioWriteOperation.findMany({
            where: {
              id: { in: operationIds },
              organizationId,
              operationType: "REPORT_PROBLEM",
              status: "SUCCEEDED",
            },
            select: { id: true, reportType: true },
          })
        : [];
      const reportById = new Map(
        openReports.map((operation) => [operation.id, operation])
      );
      const results = [];
      for (const operationId of operationIds) {
        const report = reportById.get(operationId);
        if (!report) {
          results.push({
            operationId,
            ok: false as const,
            error: "This report is no longer open.",
          });
          continue;
        }
        try {
          const result = await resolveLabIssue({
            organizationId,
            operationId,
            resolveRelatedReports: false,
          });
          results.push({ operationId, ok: true as const, result });
        } catch (cause) {
          results.push({
            operationId,
            ok: false as const,
            error:
              cause instanceof Error
                ? cause.message
                : "Could not resolve this report.",
          });
        }
      }
      return data({
        ok: true as const,
        intent,
        results,
        succeeded: results.filter((item) => item.ok).length,
        failed: results.filter((item) => !item.ok).length,
      });
    }
    if (intent === "resolve-report") {
      const operationId = String(formData.get("operationId") ?? "");
      const report = await db.ioioWriteOperation.findFirst({
        where: {
          id: operationId,
          organizationId,
          operationType: "REPORT_PROBLEM",
          status: "SUCCEEDED",
        },
        select: { id: true, reportType: true },
      });
      if (!report || classifyIoioReport(report.reportType) !== "general") {
        return data({
          ok: false as const,
          intent,
          error: "This report is no longer open in General.",
        });
      }
      const result = await resolveLabIssue({
        organizationId,
        operationId,
      });
      return data({ ok: true as const, intent, result });
    }
    if (
      intent === "return-issue-to-service-bulk" ||
      intent === "remove-return-issue-from-service-bulk"
    ) {
      if (permission.role !== "ADMIN" && permission.role !== "OWNER") {
        throw new Response("Staff access required", { status: 403 });
      }
      const operationIds = formData.getAll("operationIds").map(String);
      const reportOperationIds = formData
        .getAll("reportOperationIds")
        .map(String);
      const results = [];
      for (const [index, operationId] of operationIds.entries()) {
        const reportOperationId = reportOperationIds[index];
        const operation = await db.ioioWriteOperation.findFirst({
          where: {
            id: operationId,
            organizationId,
            operationType: "RETURN_ITEM",
            status: "SUBMITTED",
          },
          select: { id: true, assetId: true, bookingAssetId: true },
        });
        const issueReport = reportOperationId
          ? await db.ioioWriteOperation.findFirst({
              where: {
                id: reportOperationId,
                organizationId,
                operationType: "REPORT_PROBLEM",
                source: "IOIO_STUDENT_RETURN",
                status: "SUCCEEDED",
              },
              select: {
                id: true,
                assetId: true,
                reportType: true,
                bookingAssetId: true,
              },
            })
          : null;
        if (
          !operation?.assetId ||
          !operation.bookingAssetId ||
          !issueReport ||
          issueReport.assetId !== operation.assetId ||
          issueReport.bookingAssetId !== operation.bookingAssetId
        ) {
          results.push({
            operationId,
            ok: false as const,
            error: "This returned issue is no longer waiting for review.",
          });
          continue;
        }
        try {
          await completeSubmittedReturn(
            { operationId },
            { context, request, auth: staffAuth }
          );
          if (intent === "return-issue-to-service-bulk") {
            if (isIoioPhysicalUnitBlockingReport(issueReport.reportType)) {
              await returnBrokenAssetToService({
                organizationId,
                operationId: issueReport.id,
                staffUserId: userId,
              });
            } else {
              await resolveLabIssue({
                organizationId,
                operationId: issueReport.id,
              });
            }
          } else {
            await disableReturnedAssetFromUse({
              assetId: operation.assetId,
              organizationId,
              userId,
              note: "Staff removed this reported unit from service.",
            });
          }
          results.push({ operationId, ok: true as const });
        } catch (cause) {
          results.push({
            operationId,
            ok: false as const,
            error:
              cause instanceof Error
                ? cause.message
                : "Could not resolve this returned issue.",
          });
        }
      }
      return data({
        ok: true as const,
        intent,
        results,
        succeeded: results.filter((item) => item.ok).length,
        failed: results.filter((item) => !item.ok).length,
      });
    }
    if (
      intent === "return-issue-to-service" ||
      intent === "remove-return-issue-from-service"
    ) {
      if (permission.role !== "ADMIN" && permission.role !== "OWNER") {
        throw new Response("Staff access required", { status: 403 });
      }
      const operationId = String(formData.get("operationId") ?? "");
      const reportOperationId = String(formData.get("reportOperationId") ?? "");
      const operation = await db.ioioWriteOperation.findFirst({
        where: {
          id: operationId,
          organizationId,
          operationType: "RETURN_ITEM",
          status: "SUBMITTED",
        },
        select: { id: true, assetId: true },
      });
      const issueReport = await db.ioioWriteOperation.findFirst({
        where: {
          id: reportOperationId,
          organizationId,
          operationType: "REPORT_PROBLEM",
          source: "IOIO_STUDENT_RETURN",
          status: "SUCCEEDED",
        },
        select: { id: true, assetId: true, reportType: true },
      });
      if (
        !operation?.assetId ||
        !issueReport ||
        issueReport.assetId !== operation.assetId
      ) {
        return data({
          ok: false as const,
          intent,
          error: "This returned issue is no longer waiting for review.",
        });
      }
      await completeSubmittedReturn(
        { operationId },
        { context, request, auth: staffAuth }
      );
      if (intent === "return-issue-to-service") {
        if (isIoioPhysicalUnitBlockingReport(issueReport.reportType)) {
          await returnBrokenAssetToService({
            organizationId,
            operationId: issueReport.id,
            staffUserId: userId,
          });
        } else {
          await resolveLabIssue({
            organizationId,
            operationId: issueReport.id,
          });
        }
      } else {
        await disableReturnedAssetFromUse({
          assetId: operation.assetId,
          organizationId,
          userId,
          note: String(formData.get("note") ?? ""),
        });
      }
      return data({ ok: true as const, intent, operationId });
    }
    if (intent === "confirm-pickup") {
      if (permission.role !== "ADMIN" && permission.role !== "OWNER") {
        throw new Response("Staff access required", { status: 403 });
      }
      const operation = await db.ioioWriteOperation.findFirst({
        where: {
          id: String(formData.get("operationId") ?? ""),
          organizationId,
          operationType: IOIO_PREPARATION_OPERATION,
          status: "READY_FOR_PICKUP",
        },
        select: {
          id: true,
          userId: true,
          asset: { select: { title: true, sequentialId: true } },
        },
      });
      if (!operation) {
        return data({
          ok: false as const,
          intent,
          error: "This pickup is no longer ready for collection.",
        });
      }
      const result = await confirmStudentPreparationPickup({
        organizationId,
        operationId: operation.id,
        borrowerUserId: operation.userId,
        staffUserId: userId,
        hints: getClientHint(request),
        verificationValue:
          getPhysicalUnitNumberFromTitle(operation.asset?.title ?? "") ??
          operation.asset?.sequentialId ??
          operation.asset?.title,
      });
      return data({ ok: true as const, intent, result });
    }
    if (intent === "cancel-ready-pickup") {
      if (permission.role !== "ADMIN" && permission.role !== "OWNER") {
        throw new Response("Staff access required", { status: 403 });
      }
      const operation = await db.ioioWriteOperation.findFirst({
        where: {
          id: String(formData.get("operationId") ?? ""),
          organizationId,
          operationType: IOIO_PREPARATION_OPERATION,
          status: "READY_FOR_PICKUP",
        },
        select: { id: true, userId: true },
      });
      if (!operation) {
        return data({
          ok: false as const,
          intent,
          error: "This pickup is no longer ready for collection.",
        });
      }
      const result = await cancelStudentPreparationRequest({
        organizationId,
        operationId: operation.id,
        borrowerUserId: operation.userId,
        staffUserId: userId,
        hints: getClientHint(request),
      });
      return data({ ok: true as const, intent, result });
    }
    if (intent === "return-to-service-bulk") {
      if (permission.role !== "ADMIN" && permission.role !== "OWNER") {
        throw new Response("Staff access required", { status: 403 });
      }
      const assetIds = [
        ...new Set(
          formData
            .getAll("assetIds")
            .filter((value): value is string => typeof value === "string")
            .map((value) => value.trim())
            .filter(Boolean)
        ),
      ];
      const physicalAssets = assetIds.length
        ? await db.asset.findMany({
            where: {
              organizationId,
              id: { in: assetIds },
              type: "INDIVIDUAL",
            },
            select: { id: true },
          })
        : [];
      const eligibleAssetIds = new Set(physicalAssets.map((asset) => asset.id));
      const brokenOperations = eligibleAssetIds.size
        ? await db.ioioWriteOperation.findMany({
            where: {
              organizationId,
              operationType: "REPORT_PROBLEM",
              status: "SUCCEEDED",
              reportType: {
                in: [
                  "ITEM_DAMAGED",
                  "ITEM_MISSING",
                  "ITEM_NOT_WORKING",
                  "PART_MISSING",
                  "KIT_INCOMPLETE",
                ],
              },
              assetId: { in: [...eligibleAssetIds] },
            },
            select: { id: true, assetId: true, createdAt: true },
            orderBy: { createdAt: "desc" },
          })
        : [];
      const operationByAssetId = new Map<string, string>();
      for (const operation of brokenOperations) {
        if (operation.assetId && !operationByAssetId.has(operation.assetId)) {
          operationByAssetId.set(operation.assetId, operation.id);
        }
      }
      const results = [];
      for (const assetId of assetIds) {
        const operationId = operationByAssetId.get(assetId);
        if (!eligibleAssetIds.has(assetId) || !operationId) {
          results.push({
            assetId,
            ok: false as const,
            error: "This unit is no longer waiting for repair.",
          });
          continue;
        }
        try {
          const result = await returnBrokenAssetToService({
            organizationId,
            operationId,
            staffUserId: userId,
          });
          results.push({ assetId, ok: true as const, result });
        } catch (cause) {
          results.push({
            assetId,
            ok: false as const,
            error:
              cause instanceof Error
                ? cause.message
                : "This unit could not be returned to service.",
          });
        }
      }
      const succeeded = results.filter((result) => result.ok).length;
      return data({
        ok: true as const,
        intent,
        results,
        succeeded,
        failed: results.length - succeeded,
      });
    }
    if (intent === "complete-return") {
      const operationId = String(formData.get("operationId") ?? "");
      const operation = await db.ioioWriteOperation.findFirst({
        where: {
          id: operationId,
          organizationId,
          operationType: "RETURN_ITEM",
          status: "SUBMITTED",
        },
        select: { id: true, reportType: true, bookingAssetId: true },
      });
      if (!operation) {
        return data({
          ok: false as const,
          intent,
          operationId,
          error: "This return is no longer waiting for a staff check.",
        });
      }
      const linkedProblemReport = operation.bookingAssetId
        ? await db.ioioWriteOperation.findFirst({
            where: {
              organizationId,
              operationType: "REPORT_PROBLEM",
              status: "SUCCEEDED",
              bookingAssetId: operation.bookingAssetId,
            },
            select: { id: true },
          })
        : null;
      if (operation.reportType !== "RETURN_ITEM" || linkedProblemReport) {
        return data({
          ok: false as const,
          intent,
          operationId,
          error:
            "This return reported an issue. Review it before making it available.",
        });
      }
      try {
        await completeSubmittedReturn(
          { operationId },
          { context, request, auth: staffAuth }
        );
        return data({
          ok: true as const,
          intent,
          operationId,
          succeeded: 1,
          failed: 0,
        });
      } catch (cause) {
        const reason = makeShelfError(cause, { userId });
        return data({
          ok: false as const,
          intent,
          operationId,
          error: reason.message,
        });
      }
    }
    if (intent === "disable-return") {
      const operationId = String(formData.get("operationId") ?? "");
      const operation = await db.ioioWriteOperation.findFirst({
        where: {
          id: operationId,
          organizationId,
          operationType: "RETURN_ITEM",
          status: "SUBMITTED",
        },
        select: { id: true, assetId: true },
      });
      if (!operation?.assetId) {
        return data({
          ok: false as const,
          intent,
          operationId,
          error: "This return is no longer waiting for a staff check.",
        });
      }
      try {
        await completeSubmittedReturn(
          { operationId },
          { context, request, auth: staffAuth }
        );
        await disableReturnedAssetFromUse({
          assetId: operation.assetId,
          organizationId,
          userId,
          note: String(formData.get("note") ?? ""),
        });
        return data({
          ok: true as const,
          intent,
          operationId,
          succeeded: 1,
          failed: 0,
        });
      } catch (cause) {
        const reason = makeShelfError(cause, { userId });
        return data({
          ok: false as const,
          intent,
          operationId,
          error: reason.message,
        });
      }
    }
    if (intent === "complete-return-bulk") {
      const operationIds = [
        ...new Set(formData.getAll("operationIds").map(String).filter(Boolean)),
      ];
      if (operationIds.length === 0) {
        return data({
          ok: false as const,
          intent,
          error: "Select at least one return to check.",
        });
      }
      const submittedReturns = operationIds.length
        ? await db.ioioWriteOperation.findMany({
            where: {
              id: { in: operationIds },
              organizationId,
              operationType: "RETURN_ITEM",
              status: "SUBMITTED",
            },
            select: { id: true, reportType: true, bookingAssetId: true },
          })
        : [];
      const submittedById = new Map(
        submittedReturns.map((operation) => [operation.id, operation])
      );
      const bookingAssetIds = submittedReturns
        .map((operation) => operation.bookingAssetId)
        .filter((id): id is string => Boolean(id));
      const linkedProblemReports = bookingAssetIds.length
        ? await db.ioioWriteOperation.findMany({
            where: {
              organizationId,
              operationType: "REPORT_PROBLEM",
              status: "SUCCEEDED",
              bookingAssetId: { in: bookingAssetIds },
            },
            select: { bookingAssetId: true },
          })
        : [];
      const reportedProblemBookingAssetIds = new Set(
        linkedProblemReports.map((report) => report.bookingAssetId)
      );
      const results: ReturnCheckItemResult[] = [];
      for (const operationId of operationIds) {
        const operation = submittedById.get(operationId);
        if (!operation) {
          results.push({
            operationId,
            ok: false,
            error: "This return is no longer waiting for a staff check.",
          });
          continue;
        }
        if (
          operation.reportType !== "RETURN_ITEM" ||
          reportedProblemBookingAssetIds.has(operation.bookingAssetId ?? "")
        ) {
          results.push({
            operationId,
            ok: false,
            error:
              "This return reported an issue. Review it before making it available.",
          });
          continue;
        }
        try {
          await completeSubmittedReturn(
            { operationId },
            { context, request, auth: staffAuth }
          );
          results.push({ operationId, ok: true });
        } catch (cause) {
          const reason = makeShelfError(cause, { userId });
          results.push({ operationId, ok: false, error: reason.message });
        }
      }
      return data({
        ok: true as const,
        intent,
        results,
        succeeded: results.filter((result) => result.ok).length,
        failed: results.filter((result) => !result.ok).length,
      });
    }
    if (intent === "disable-return-bulk") {
      const operationIds = [
        ...new Set(formData.getAll("operationIds").map(String).filter(Boolean)),
      ];
      if (operationIds.length === 0) {
        return data({
          ok: false as const,
          intent,
          error: "Select at least one return to disable.",
        });
      }
      const submittedReturns = await db.ioioWriteOperation.findMany({
        where: {
          id: { in: operationIds },
          organizationId,
          operationType: "RETURN_ITEM",
          status: "SUBMITTED",
        },
        select: { id: true, assetId: true },
      });
      const submittedById = new Map(
        submittedReturns.map((operation) => [operation.id, operation])
      );
      const results: ReturnCheckItemResult[] = [];
      for (const operationId of operationIds) {
        const operation = submittedById.get(operationId);
        if (!operation?.assetId) {
          results.push({
            operationId,
            ok: false,
            error: "This return is no longer waiting for a staff check.",
          });
          continue;
        }
        try {
          await completeSubmittedReturn(
            { operationId },
            { context, request, auth: staffAuth }
          );
          await disableReturnedAssetFromUse({
            assetId: operation.assetId,
            organizationId,
            userId,
          });
          results.push({ operationId, ok: true });
        } catch (cause) {
          const reason = makeShelfError(cause, { userId });
          results.push({ operationId, ok: false, error: reason.message });
        }
      }
      return data({
        ok: true as const,
        intent,
        results,
        succeeded: results.filter((result) => result.ok).length,
        failed: results.filter((result) => !result.ok).length,
      });
    }
    if (intent === "approve-access" || intent === "approve-access-bulk") {
      const result = await reviewAnnualAccessApprovals({
        organizationId,
        staffUserId: userId,
        requestIds:
          intent === "approve-access-bulk"
            ? formData.getAll("requestIds").map(String)
            : [String(formData.get("requestId") ?? "")],
      });
      return data({ ok: true as const, result, intent });
    }
    if (intent === "decline-access") {
      const result = await declineAnnualAccessApproval({
        organizationId,
        staffUserId: userId,
        requestId: String(formData.get("requestId") ?? ""),
        staffComment: String(formData.get("staffComment") ?? ""),
      });
      return data({ ok: true as const, result, intent });
    }
    if (intent === "decline-access-bulk") {
      const requestIds = [
        ...new Set(formData.getAll("requestIds").map(String).filter(Boolean)),
      ];
      const results = [];
      for (const requestId of requestIds) {
        try {
          const result = await declineAnnualAccessApproval({
            organizationId,
            staffUserId: userId,
            requestId,
            staffComment: "",
          });
          results.push({ requestId, ok: true as const, result });
        } catch (cause) {
          results.push({
            requestId,
            ok: false as const,
            error:
              cause instanceof Error
                ? cause.message
                : "Could not reject this request.",
          });
        }
      }
      return data({
        ok: true as const,
        result: {
          results,
          succeeded: results.filter((item) => item.ok).length,
          failed: results.filter((item) => !item.ok).length,
        },
        intent,
      });
    }
    if (intent === "revoke-access") {
      const result = await revokeAnnualAccessApproval({
        organizationId,
        staffUserId: userId,
        requestId: String(formData.get("requestId") ?? ""),
      });
      return data({ ok: true as const, result, intent });
    }
    if (intent === "reapprove-access") {
      const result = await reapproveAnnualAccessApproval({
        organizationId,
        staffUserId: userId,
        requestId: String(formData.get("requestId") ?? ""),
      });
      return data({ ok: true as const, result, intent });
    }
    if (intent === "confirm-prepared") {
      const result = await confirmPreparationReady({
        organizationId,
        operationId: String(formData.get("operationId") ?? ""),
        staffUserId: userId,
        hints: getClientHint(request),
      });
      return data({ ok: true as const, result, intent });
    }
    if (intent === "confirm-prepared-bulk") {
      const operationIds = [
        ...new Set(formData.getAll("operationIds").map(String).filter(Boolean)),
      ];
      const results: BulkPreparationItemResult[] = [];
      for (const operationId of operationIds) {
        try {
          const result = await confirmPreparationReady({
            organizationId,
            operationId,
            staffUserId: userId,
            hints: getClientHint(request),
          });
          results.push({ operationId, ok: true, result });
        } catch (cause) {
          results.push({
            operationId,
            ok: false,
            error:
              cause instanceof Error
                ? cause.message
                : "Could not mark this request ready.",
          });
        }
      }
      const result: BulkPreparationResult = {
        results,
        succeeded: results.filter((item) => item.ok).length,
        failed: results.filter((item) => !item.ok).length,
      };
      return data({ ok: true as const, result, intent });
    }
    if (intent === "decline-preparation-bulk") {
      const operationIds = [
        ...new Set(formData.getAll("operationIds").map(String).filter(Boolean)),
      ];
      const results: BulkPreparationItemResult[] = [];
      for (const operationId of operationIds) {
        try {
          const result = await declinePreparation({
            organizationId,
            operationId,
            staffUserId: userId,
            hints: getClientHint(request),
            staffComment: "",
          });
          results.push({ operationId, ok: true, result });
        } catch (cause) {
          results.push({
            operationId,
            ok: false,
            error:
              cause instanceof Error
                ? cause.message
                : "Could not decline this preparation request.",
          });
        }
      }
      return data({
        ok: true as const,
        result: {
          results,
          succeeded: results.filter((item) => item.ok).length,
          failed: results.filter((item) => !item.ok).length,
        } satisfies BulkPreparationResult,
        intent,
      });
    }
    if (intent === "put-back-cancelled-pickup") {
      const result = await putBackCancelledPreparationPickup({
        organizationId,
        operationId: String(formData.get("operationId") ?? ""),
        staffUserId: userId,
        hints: getClientHint(request),
      });
      return data({ ok: true as const, result, intent });
    }
    if (intent === "put-back-cancelled-pickup-bulk") {
      const operationIds = [
        ...new Set(formData.getAll("operationIds").map(String).filter(Boolean)),
      ];
      if (!operationIds.length) {
        return data({
          ok: false as const,
          intent,
          error: "Select at least one cancelled pickup to put back.",
        });
      }
      const results: BulkPreparationItemResult[] = [];
      for (const operationId of operationIds) {
        try {
          const result = await putBackCancelledPreparationPickup({
            organizationId,
            operationId,
            staffUserId: userId,
            hints: getClientHint(request),
          });
          results.push({ operationId, ok: true, result });
        } catch (cause) {
          results.push({
            operationId,
            ok: false,
            error:
              cause instanceof Error
                ? cause.message
                : "Could not put this item back.",
          });
        }
      }
      return data({
        ok: true as const,
        intent,
        result: {
          results,
          succeeded: results.filter((item) => item.ok).length,
          failed: results.filter((item) => !item.ok).length,
        } satisfies BulkPreparationResult,
      });
    }
    if (intent === "decline-preparation") {
      const result = await declinePreparation({
        organizationId,
        operationId: String(formData.get("operationId") ?? ""),
        staffUserId: userId,
        hints: getClientHint(request),
        staffComment: String(formData.get("staffComment") ?? ""),
      });
      return data({ ok: true as const, result, intent });
    }
    throw new Error("Invalid operations action.");
  } catch (cause) {
    if (cause instanceof Response) throw cause;
    const reason = makeShelfError(cause, { userId });
    return data(error(reason), { status: reason.status });
  }
}

const VIEW_LABELS: Record<OperationsView, string> = {
  all: "All",
  overdue: "Overdue loans",
  returns: "Returns to check",
  "returned-with-issues": "Returned with issues",
  broken: "Broken items",
  general: "General",
  "to-prepare": "Items to prepare",
  "cancelled-pickups": "Cancelled pickups",
  "ready-for-pickup": "Ready for pickup",
  "access-approvals": "Student access approvals",
};

function PreparationItemIdentity({
  task,
  className,
}: {
  task: Task;
  className: string;
}) {
  const quantity = task.quantity ?? 1;
  const content = (
    <>
      <span className="size-16 shrink-0 overflow-hidden rounded-lg bg-gray-100">
        {task.assetImage ? (
          <AssetImage
            asset={task.assetImage}
            alt=""
            className="size-full object-cover"
          />
        ) : null}
      </span>
      <span className="min-w-0">
        <span className="block truncate font-bold text-gray-950">
          {task.title}
        </span>
        {task.kind === "ready-for-pickup" ? (
          <span className="mt-1 inline-flex rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-800">
            Ready for pickup
          </span>
        ) : (
          <span className="mt-0.5 block text-xs text-gray-500">
            {quantity} {quantity === 1 ? "item" : "items"}
          </span>
        )}
        {task.physicalUnitAssignment ? (
          <span className="mt-0.5 block text-xs text-gray-600">
            {task.physicalUnitAssignment}
          </span>
        ) : null}
      </span>
    </>
  );

  return task.assetId ? (
    <Link
      to={`/assets/${task.assetId}`}
      aria-label={`Open asset: ${task.title}`}
      className={`flex min-w-0 items-center gap-3 rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700 ${className}`}
    >
      {content}
    </Link>
  ) : (
    <div className={`flex min-w-0 items-center gap-3 ${className}`}>
      {content}
    </div>
  );
}

function PreparationTaskActions({
  task,
  className = "",
}: {
  task: Task;
  className?: string;
}) {
  const [declineOpen, setDeclineOpen] = useState(false);
  const [readyOpen, setReadyOpen] = useState(false);
  const declineFetcher = useFetcher<{
    ok?: boolean;
    error?: { message?: string } | string;
  }>();
  const readyFetcher = useFetcher<{
    ok?: boolean;
    error?: { message?: string } | string;
  }>();
  const borrowerName = task.borrowerName ?? "Borrower";
  const itemName = task.title;
  const hasAvailabilitySummary =
    task.preparationRequest &&
    task.availableForRequestedPeriod !== undefined &&
    task.availableNow !== undefined &&
    task.totalPhysicalUnits !== undefined;
  const readyError =
    readyFetcher.data && !readyFetcher.data.ok
      ? typeof readyFetcher.data.error === "string"
        ? readyFetcher.data.error
        : readyFetcher.data.error?.message ?? "Could not mark the item ready."
      : null;
  const declineError =
    declineFetcher.data && !declineFetcher.data.ok
      ? typeof declineFetcher.data.error === "string"
        ? declineFetcher.data.error
        : declineFetcher.data.error?.message ?? null
      : null;

  useEffect(() => {
    if (declineFetcher.data?.ok) setDeclineOpen(false);
    if (readyFetcher.data?.ok) setReadyOpen(false);
  }, [declineFetcher.data, readyFetcher.data]);

  return (
    <div
      className={`flex w-full min-w-0 flex-wrap items-center justify-end gap-2 ${className}`}
    >
      {hasAvailabilitySummary ? (
        <div className="min-w-0 max-w-44 text-xs leading-snug">
          {task.softReservationOverlap ? (
            <p className="font-semibold text-amber-800">
              Course reservation overlaps
            </p>
          ) : null}
          {!task.softReservationOverlap ||
          task.availableForRequestedPeriod < task.totalPhysicalUnits ? (
            <p
              className={
                task.availableForRequestedPeriod === 0
                  ? "font-semibold text-amber-900"
                  : "font-semibold text-gray-700"
              }
            >
              {task.availableForRequestedPeriod} of {task.totalPhysicalUnits}{" "}
              {task.softReservationOverlap
                ? "available for requested dates"
                : "available for these dates"}
            </p>
          ) : null}
          {!task.softReservationOverlap ? (
            <p className="mt-0.5 text-gray-500">
              {task.availableNow} of {task.totalPhysicalUnits} available now
            </p>
          ) : null}
        </div>
      ) : null}
      {task.bulkReadyEligible ? (
        <button
          type="button"
          onClick={() => setReadyOpen(true)}
          className="rounded-xl bg-red-700 px-3 py-2 text-sm font-bold text-white hover:bg-red-800"
        >
          Mark prepared
        </button>
      ) : (
        <span
          title={
            hasAvailabilitySummary
              ? "No units are reservable for the requested period."
              : task.preparationBlockedReason
          }
          className="inline-flex rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-900"
        >
          Unavailable
        </span>
      )}

      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`Actions for ${itemName}`}
            className="inline-flex size-9 items-center justify-center rounded-lg border border-gray-200 text-gray-600 hover:border-red-200 hover:text-red-800 focus:outline-none focus:ring-2 focus:ring-red-300"
          >
            <MoreHorizontal className="size-4" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48 p-1">
          <DropdownMenuItem
            onSelect={() => setDeclineOpen(true)}
            className="text-red-800 focus:bg-red-50"
          >
            Decline request
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <DialogPortal>
        <Dialog
          open={readyOpen}
          onClose={() => setReadyOpen(false)}
          title={
            <span className="text-base font-semibold text-gray-900">
              Mark prepared?
            </span>
          }
          headerClassName="items-center py-2"
          className="w-[min(32rem,calc(100vw-2rem))]"
        >
          <readyFetcher.Form method="post" className="space-y-4 px-6 pb-4 pt-1">
            <input type="hidden" name="intent" value="confirm-prepared" />
            <input
              type="hidden"
              name="operationId"
              value={task.operationId ?? ""}
            />
            <p className="text-sm text-gray-700">
              Confirm that {itemName} has been prepared, checked, and includes
              all required parts. The student will be notified that it is ready
              for pickup.
            </p>
            {readyError ? (
              <p role="alert" className="text-sm font-semibold text-red-700">
                {readyError}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setReadyOpen(false)}
                className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-semibold text-gray-700 hover:border-gray-400"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={readyFetcher.state !== "idle"}
                className="rounded-lg bg-red-700 px-3 py-2 text-sm font-semibold text-white hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {readyFetcher.state === "submitting"
                  ? "Saving..."
                  : "Mark prepared"}
              </button>
            </div>
          </readyFetcher.Form>
        </Dialog>
      </DialogPortal>

      <DialogPortal>
        <Dialog
          open={declineOpen}
          onClose={() => setDeclineOpen(false)}
          title={
            <span className="text-base font-semibold text-gray-900">
              Decline preparation request?
            </span>
          }
          headerClassName="items-center py-2"
          className="w-[min(32rem,calc(100vw-2rem))]"
        >
          <declineFetcher.Form
            method="post"
            className="space-y-4 px-6 pb-4 pt-1"
          >
            <input type="hidden" name="intent" value="decline-preparation" />
            <input
              type="hidden"
              name="operationId"
              value={task.operationId ?? ""}
            />
            <p className="text-sm text-gray-700">
              Decline the preparation request for {itemName} from {borrowerName}
              .
            </p>
            <label className="block text-sm font-semibold text-gray-900">
              Reason (optional)
              <textarea
                name="staffComment"
                rows={3}
                className="mt-1.5 w-full rounded-lg border border-gray-300 px-3 py-2 font-normal outline-none focus:border-red-600 focus:ring-2 focus:ring-red-100"
              />
            </label>
            {declineError ? (
              <p role="alert" className="text-sm font-semibold text-red-700">
                {declineError}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeclineOpen(false)}
                className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-semibold text-gray-700 hover:border-gray-400"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={declineFetcher.state !== "idle"}
                className="rounded-lg border border-red-300 px-3 py-2 text-sm font-semibold text-red-800 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {declineFetcher.state === "submitting"
                  ? "Declining..."
                  : "Decline request"}
              </button>
            </div>
          </declineFetcher.Form>
        </Dialog>
      </DialogPortal>
    </div>
  );
}

function ReturnedIssueActions({ task }: { task: Task }) {
  const [removeOpen, setRemoveOpen] = useState(false);
  const fetcher = useFetcher<{
    ok?: boolean;
    error?: string | { message?: string };
  }>();
  const errorMessage =
    fetcher.data && !fetcher.data.ok
      ? typeof fetcher.data.error === "string"
        ? fetcher.data.error
        : fetcher.data.error?.message ?? "Could not resolve this return issue."
      : null;

  return (
    <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
      <Link
        to={task.href}
        className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-bold text-gray-700 hover:border-red-300 hover:text-red-800"
      >
        Review return
      </Link>
      <fetcher.Form method="post">
        <input type="hidden" name="intent" value="return-issue-to-service" />
        <input type="hidden" name="operationId" value={task.operationId} />
        <input
          type="hidden"
          name="reportOperationId"
          value={task.returnIssueOperationId}
        />
        <button
          type="submit"
          disabled={fetcher.state !== "idle"}
          className="rounded-lg bg-red-700 px-3 py-2 text-sm font-bold text-white hover:bg-red-800 disabled:opacity-50"
        >
          Return to service
        </button>
      </fetcher.Form>
      {task.assetId ? (
        <button
          type="button"
          onClick={() => setRemoveOpen(true)}
          className="rounded-lg border border-red-300 px-3 py-2 text-sm font-bold text-red-800 hover:bg-red-50"
        >
          Remove from service
        </button>
      ) : null}
      {errorMessage ? (
        <p role="alert" className="w-full text-right text-sm text-red-700">
          {errorMessage}
        </p>
      ) : null}
      <DialogPortal>
        <Dialog
          open={removeOpen}
          onClose={() => setRemoveOpen(false)}
          title={
            <span className="text-base font-semibold text-gray-900">
              Remove {task.title} from service?
            </span>
          }
          headerClassName="items-center py-2"
          className="w-[min(32rem,calc(100vw-2rem))]"
        >
          <fetcher.Form
            method="post"
            className="space-y-4 px-6 pb-4 pt-1"
            onSubmit={() => setRemoveOpen(false)}
          >
            <input
              type="hidden"
              name="intent"
              value="remove-return-issue-from-service"
            />
            <input type="hidden" name="operationId" value={task.operationId} />
            <input
              type="hidden"
              name="reportOperationId"
              value={task.returnIssueOperationId}
            />
            <p className="text-sm text-gray-700">
              The returned unit will stay unavailable and appear under Broken
              items until it is repaired and returned to service.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setRemoveOpen(false)}
                className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-semibold text-gray-700"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={fetcher.state !== "idle"}
                className="rounded-lg bg-red-700 px-3 py-2 text-sm font-semibold text-white hover:bg-red-800 disabled:opacity-50"
              >
                Remove from service
              </button>
            </div>
          </fetcher.Form>
        </Dialog>
      </DialogPortal>
    </div>
  );
}

function ReadyPickupActions({ task }: { task: Task }) {
  const [cancelOpen, setCancelOpen] = useState(false);
  const fetcher = useFetcher<{
    ok?: boolean;
    error?: string | { message?: string };
  }>();
  const errorMessage =
    fetcher.data && !fetcher.data.ok
      ? typeof fetcher.data.error === "string"
        ? fetcher.data.error
        : fetcher.data.error?.message ?? "Could not confirm this pickup."
      : null;
  const cancelFetcher = useFetcher<{
    ok?: boolean;
    error?: string | { message?: string };
  }>();
  const cancelError =
    cancelFetcher.data && !cancelFetcher.data.ok
      ? typeof cancelFetcher.data.error === "string"
        ? cancelFetcher.data.error
        : cancelFetcher.data.error?.message ?? "Could not cancel this pickup."
      : null;
  useEffect(() => {
    if (cancelFetcher.data?.ok) setCancelOpen(false);
  }, [cancelFetcher.data]);

  return (
    <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
      {task.operationId ? (
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="confirm-pickup" />
          <input type="hidden" name="operationId" value={task.operationId} />
          <button
            type="submit"
            disabled={fetcher.state !== "idle"}
            className="rounded-lg bg-red-700 px-3 py-2 text-sm font-bold text-white hover:bg-red-800 disabled:opacity-50"
          >
            {fetcher.state === "submitting" ? "Confirming…" : "Confirm pickup"}
          </button>
        </fetcher.Form>
      ) : null}
      <Link
        to={task.href}
        className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-bold text-gray-700 hover:border-red-300 hover:text-red-800"
      >
        View loan
      </Link>
      {task.operationId ? (
        <button
          type="button"
          onClick={() => setCancelOpen(true)}
          className="rounded-lg border border-red-300 px-3 py-2 text-sm font-bold text-red-800 hover:bg-red-50"
        >
          Cancel pickup
        </button>
      ) : null}
      {errorMessage ? (
        <p role="alert" className="w-full text-right text-sm text-red-700">
          {errorMessage}
        </p>
      ) : null}
      {cancelError ? (
        <p role="alert" className="w-full text-right text-sm text-red-700">
          {cancelError}
        </p>
      ) : null}
      <DialogPortal>
        <Dialog
          open={cancelOpen}
          onClose={() => setCancelOpen(false)}
          title={
            <span className="text-base font-semibold text-gray-900">
              Cancel this pickup?
            </span>
          }
          headerClassName="items-center py-2"
          className="w-[min(32rem,calc(100vw-2rem))]"
        >
          <cancelFetcher.Form
            method="post"
            className="space-y-4 px-6 pb-4 pt-1"
          >
            <input type="hidden" name="intent" value="cancel-ready-pickup" />
            <input type="hidden" name="operationId" value={task.operationId} />
            <p className="text-sm text-gray-700">
              This pickup will move to Cancelled pickups. A Staff member must
              put the assigned unit back before it becomes available again.
            </p>
            {cancelError ? (
              <p role="alert" className="text-sm font-semibold text-red-700">
                {cancelError}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setCancelOpen(false)}
                className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-semibold text-gray-700"
              >
                Keep pickup
              </button>
              <button
                type="submit"
                disabled={cancelFetcher.state !== "idle"}
                className="rounded-lg bg-red-700 px-3 py-2 text-sm font-semibold text-white hover:bg-red-800 disabled:opacity-50"
              >
                {cancelFetcher.state === "submitting"
                  ? "Cancelling…"
                  : "Cancel pickup"}
              </button>
            </div>
          </cancelFetcher.Form>
        </Dialog>
      </DialogPortal>
    </div>
  );
}

function CancelledPickupActions({ task }: { task: Task }) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const fetcher = useFetcher<{ ok?: boolean; error?: { message?: string } }>();
  const errorMessage =
    fetcher.data && !fetcher.data.ok
      ? fetcher.data.error?.message ?? "Could not put this item back."
      : null;
  useEffect(() => {
    if (fetcher.data?.ok) setConfirmOpen(false);
  }, [fetcher.data]);

  return (
    <>
      <button
        type="button"
        onClick={() => setConfirmOpen(true)}
        className="shrink-0 rounded-xl bg-red-700 px-3 py-2 text-sm font-bold text-white hover:bg-red-800"
      >
        Put back
      </button>
      <DialogPortal>
        <Dialog
          open={confirmOpen}
          onClose={() => setConfirmOpen(false)}
          title={
            <span className="text-base font-semibold text-gray-900">
              Put this item back?
            </span>
          }
          headerClassName="items-center py-2"
          className="w-[min(32rem,calc(100vw-2rem))]"
        >
          <fetcher.Form method="post" className="space-y-4 px-6 pb-4 pt-1">
            <input
              type="hidden"
              name="intent"
              value="put-back-cancelled-pickup"
            />
            <input
              type="hidden"
              name="operationId"
              value={task.operationId ?? ""}
            />
            <p className="text-sm text-gray-700">
              Confirm that <strong>{task.title}</strong> has been collected from
              the Pickup Zone and returned to its normal storage location. It
              will become available again after the reservation is released.
            </p>
            {errorMessage ? (
              <p role="alert" className="text-sm font-semibold text-red-700">
                {errorMessage}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-semibold text-gray-700 hover:border-gray-400"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={fetcher.state !== "idle"}
                className="rounded-lg bg-red-700 px-3 py-2 text-sm font-semibold text-white hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {fetcher.state === "submitting" ? "Putting back…" : "Put back"}
              </button>
            </div>
          </fetcher.Form>
        </Dialog>
      </DialogPortal>
    </>
  );
}

function ReturnTaskActions({ task }: { task: Task }) {
  const [disableOpen, setDisableOpen] = useState(false);

  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <Form method="post">
          <input type="hidden" name="intent" value="complete-return" />
          <input
            type="hidden"
            name="operationId"
            value={task.operationId ?? ""}
          />
          <button
            type="submit"
            className="rounded-lg bg-red-700 px-3 py-2 text-sm font-bold text-white hover:bg-red-800"
          >
            Mark checked
          </button>
        </Form>
        <button
          type="button"
          onClick={() => setDisableOpen(true)}
          className="rounded-lg border border-red-300 px-3 py-2 text-sm font-bold text-red-800 hover:bg-red-50"
        >
          Remove from service
        </button>
      </div>
      <DialogPortal>
        <Dialog
          open={disableOpen}
          onClose={() => setDisableOpen(false)}
          title={
            <span className="text-base font-semibold text-gray-900">
              Remove {task.title} from service?
            </span>
          }
          headerClassName="items-center py-2"
          className="w-[min(32rem,calc(100vw-2rem))]"
        >
          <Form method="post" className="space-y-4 px-6 pb-4 pt-1">
            <input type="hidden" name="intent" value="disable-return" />
            <input
              type="hidden"
              name="operationId"
              value={task.operationId ?? ""}
            />
            <p className="text-sm text-gray-700">
              This item will be moved to Broken items and unavailable for
              borrowing until it is repaired.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDisableOpen(false)}
                className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-semibold text-gray-700 hover:border-gray-400"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="rounded-lg bg-red-700 px-3 py-2 text-sm font-semibold text-white hover:bg-red-800"
              >
                Remove from service
              </button>
            </div>
          </Form>
        </Dialog>
      </DialogPortal>
    </>
  );
}

export default function OperationsPage() {
  const { view, summary, tasks, annualAccessApprovals } =
    useLoaderData<typeof loader>();
  const actionResult = useActionData<typeof action>();
  const possibleReturnAction = actionResult as unknown as
    | ReturnCheckActionResult
    | undefined;
  const returnActionResult =
    possibleReturnAction?.intent === "complete-return" ||
    possibleReturnAction?.intent === "complete-return-bulk" ||
    possibleReturnAction?.intent === "disable-return" ||
    possibleReturnAction?.intent === "disable-return-bulk"
      ? possibleReturnAction
      : null;
  const brokenActionResult =
    actionResult &&
    typeof actionResult === "object" &&
    "intent" in actionResult &&
    actionResult.intent === "return-to-service-bulk"
      ? (actionResult as {
          intent: string;
          results?: Array<{ assetId: string; ok: boolean }>;
          failed?: number;
        })
      : null;
  const [selectedPreparationIds, setSelectedPreparationIds] = useState<
    string[]
  >([]);
  const selectAllPreparationsRef = useRef<HTMLInputElement>(null);
  const [selectedReturnIds, setSelectedReturnIds] = useState<string[]>([]);
  const [bulkDisableReturnsOpen, setBulkDisableReturnsOpen] = useState(false);
  const [bulkRemoveReturnedIssuesOpen, setBulkRemoveReturnedIssuesOpen] =
    useState(false);
  const selectAllReturnsRef = useRef<HTMLInputElement>(null);
  const [selectedBrokenAssetIds, setSelectedBrokenAssetIds] = useState<
    string[]
  >([]);
  const [bulkReturnToServiceOpen, setBulkReturnToServiceOpen] = useState(false);
  const selectAllBrokenRef = useRef<HTMLInputElement>(null);
  const selectAllCancelledPickupsRef = useRef<HTMLInputElement>(null);
  const [selectedCancelledPickupIds, setSelectedCancelledPickupIds] = useState<
    string[]
  >([]);
  const [bulkPutBackOpen, setBulkPutBackOpen] = useState(false);
  const [selectedApprovalIds, setSelectedApprovalIds] = useState<string[]>([]);
  const [selectedGeneralReportIds, setSelectedGeneralReportIds] = useState<
    string[]
  >([]);
  const [selectedReturnedIssueIds, setSelectedReturnedIssueIds] = useState<
    string[]
  >([]);
  const [selectedManagementIds, setSelectedManagementIds] = useState<string[]>(
    []
  );
  const [selectedAllRowKeys, setSelectedAllRowKeys] = useState<string[]>([]);
  const [allConfirmAction, setAllConfirmAction] = useState<
    | "remove-returns"
    | "remove-returned-issues"
    | "release-cancelled-pickups"
    | null
  >(null);
  const selectAllApprovalsRef = useRef<HTMLInputElement>(null);
  const [approvalView, setApprovalView] = useState<"pending" | "access">(
    "pending"
  );
  useEffect(() => {
    setSelectedPreparationIds([]);
    setSelectedReturnIds([]);
    setSelectedBrokenAssetIds([]);
    setSelectedCancelledPickupIds([]);
    setSelectedApprovalIds([]);
    setSelectedGeneralReportIds([]);
    setSelectedReturnedIssueIds([]);
    setSelectedManagementIds([]);
    setSelectedAllRowKeys([]);
    setAllConfirmAction(null);
    setApprovalView("pending");
    setBulkDisableReturnsOpen(false);
    setBulkRemoveReturnedIssuesOpen(false);
    setBulkReturnToServiceOpen(false);
    setBulkPutBackOpen(false);
  }, [view]);
  useEffect(() => {
    if (isSuccessfulAction(actionResult)) {
      if (
        !isBulkPreparationResult(actionResult.result) ||
        actionResult.result.failed === 0
      ) {
        setSelectedPreparationIds([]);
      }
    }
    if (isAnnualAccessAction(actionResult)) setSelectedApprovalIds([]);
    if (returnActionResult?.ok === true) {
      const completedIds = new Set(
        returnActionResult.intent === "complete-return" ||
        returnActionResult.intent === "disable-return"
          ? returnActionResult.succeeded && returnActionResult.operationId
            ? [returnActionResult.operationId]
            : []
          : (returnActionResult.results ?? [])
              .filter((item) => item.ok)
              .map((item) => item.operationId)
      );
      setSelectedReturnIds((current) =>
        current.filter((id) => !completedIds.has(id))
      );
      if (returnActionResult.failed === 0) setBulkDisableReturnsOpen(false);
    }
    if (brokenActionResult) {
      const completedAssetIds = new Set(
        (brokenActionResult.results ?? [])
          .filter((item) => item.ok)
          .map((item) => item.assetId)
      );
      setSelectedBrokenAssetIds((current) =>
        current.filter((id) => !completedAssetIds.has(id))
      );
      if (brokenActionResult.failed === 0) setBulkReturnToServiceOpen(false);
    }
  }, [actionResult, returnActionResult, brokenActionResult]);
  const preparationRequestBookingIds = new Set(
    tasks
      .filter(
        (task) =>
          task.kind === "to-prepare" &&
          task.preparationRequest &&
          task.bookingId
      )
      .map((task) => task.bookingId)
  );
  const allViewAccessTasks: Task[] = annualAccessApprovals.pending.map(
    (approval) => ({
      id: `access-approval:${approval.id}`,
      kind: "access-approvals",
      title: displayName(approval.student),
      detail: approval.student.email,
      createdAt: approval.requestedAt,
      href: "/operations?view=access-approvals",
      actionLabel: "Review request",
      accessApprovalId: approval.id,
    })
  );
  const tasksForView =
    view === "all" ? [...tasks, ...allViewAccessTasks] : tasks;
  const visibleTasks =
    view === "all" || view === "access-approvals"
      ? view === "all"
        ? tasksForView.filter(
            (task) =>
              !(
                task.kind === "to-prepare" &&
                !task.preparationRequest &&
                task.bookingId &&
                preparationRequestBookingIds.has(task.bookingId)
              )
          )
        : []
      : tasksForView.filter(
          (task) =>
            task.kind === view &&
            (view !== "broken" || task.kind === "broken") &&
            !(
              task.kind === "to-prepare" &&
              !task.preparationRequest &&
              task.bookingId &&
              preparationRequestBookingIds.has(task.bookingId)
            )
        );
  const allSelectionEntries =
    view === "all"
      ? visibleTasks.flatMap((task) => {
          const entry = getAllSelectionEntry(task);
          return entry ? [entry] : [];
        })
      : [];
  const visibleAllSelectionKeys = allSelectionEntries.map((entry) => entry.key);
  const visibleAllSelectionKey = JSON.stringify(visibleAllSelectionKeys);
  const selectedAllEntries = allSelectionEntries.filter((entry) =>
    selectedAllRowKeys.includes(entry.key)
  );
  const selectedAllFamilies = [
    ...new Set(selectedAllEntries.map((entry) => entry.family)),
  ];
  const compatibleAllFamily =
    selectedAllFamilies.length === 1 ? selectedAllFamilies[0] : null;
  const selectedOperationalReportIds = selectedAllEntries.flatMap((entry) =>
    entry.reportId ? [entry.reportId] : []
  );
  const canResolveSelectedReports =
    selectedAllEntries.length > 0 &&
    selectedOperationalReportIds.length === selectedAllEntries.length;
  const allVisibleAllRowsSelected =
    allSelectionEntries.length > 0 &&
    allSelectionEntries.every((entry) =>
      selectedAllRowKeys.includes(entry.key)
    );
  const selectAllAllRowsRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (selectAllAllRowsRef.current) {
      selectAllAllRowsRef.current.indeterminate =
        selectedAllEntries.length > 0 && !allVisibleAllRowsSelected;
    }
  }, [allVisibleAllRowsSelected, selectedAllEntries.length]);
  useEffect(() => {
    const visibleKeys = new Set<string>(JSON.parse(visibleAllSelectionKey));
    setSelectedAllRowKeys((current) => {
      const next = current.filter((key) => visibleKeys.has(key));
      return next.length === current.length ? current : next;
    });
  }, [visibleAllSelectionKey]);
  const visibleBulkReadyIds = visibleTasks.flatMap((task) =>
    task.kind === "to-prepare" && task.bulkReadyEligible && task.operationId
      ? [task.operationId]
      : []
  );
  const visiblePreparationIds = visibleTasks.flatMap((task) =>
    task.kind === "to-prepare" && task.operationId ? [task.operationId] : []
  );
  const visibleBulkReadyIdSet = new Set(visibleBulkReadyIds);
  const selectedBulkReadyIds = selectedPreparationIds.filter((id) =>
    visibleBulkReadyIdSet.has(id)
  );
  const visiblePreparationKey = JSON.stringify(visiblePreparationIds);
  const allVisiblePreparationsSelected =
    visibleBulkReadyIds.length > 0 &&
    visibleBulkReadyIds.every((id) => selectedPreparationIds.includes(id));
  const visibleReturnIds = visibleTasks.flatMap((task) =>
    task.kind === "returns" && task.returnCheckEligible && task.operationId
      ? [task.operationId]
      : []
  );
  const visibleReturnedIssueIds = visibleTasks.flatMap((task) =>
    task.kind === "returned-with-issues" &&
    task.operationId &&
    task.returnIssueOperationId
      ? [task.operationId]
      : []
  );
  const visibleGeneralReportIds = visibleTasks.flatMap((task) =>
    task.kind === "general" && task.operationId ? [task.operationId] : []
  );
  const visibleManagementIds = visibleTasks.flatMap((task) =>
    task.kind === "overdue" || task.kind === "ready-for-pickup" ? [task.id] : []
  );
  const allVisibleManagementSelected =
    visibleManagementIds.length > 0 &&
    visibleManagementIds.every((id) => selectedManagementIds.includes(id));
  const visibleBrokenAssetIds = visibleTasks.flatMap((task) =>
    task.kind === "broken" &&
    task.returnToServiceEligible &&
    task.physicalUnit &&
    task.assetId
      ? [task.assetId]
      : []
  );
  const visibleBrokenAssetKey = JSON.stringify(visibleBrokenAssetIds);
  const allVisibleBrokenSelected =
    visibleBrokenAssetIds.length > 0 &&
    visibleBrokenAssetIds.every((id) => selectedBrokenAssetIds.includes(id));
  const visibleCancelledPickupIds = visibleTasks.flatMap((task) =>
    task.kind === "cancelled-pickups" && task.operationId
      ? [task.operationId]
      : []
  );
  const visibleCancelledPickupKey = JSON.stringify(visibleCancelledPickupIds);
  const allVisibleCancelledPickupsSelected =
    visibleCancelledPickupIds.length > 0 &&
    visibleCancelledPickupIds.every((id) =>
      selectedCancelledPickupIds.includes(id)
    );
  const visibleReturnKey = JSON.stringify(visibleReturnIds);
  const allVisibleReturnsSelected =
    visibleReturnIds.length > 0 &&
    visibleReturnIds.every((id) => selectedReturnIds.includes(id));
  const selectedVisibleGeneralReportIds = selectedGeneralReportIds.filter(
    (id) => visibleGeneralReportIds.includes(id)
  );
  const allVisibleGeneralReportsSelected =
    visibleGeneralReportIds.length > 0 &&
    visibleGeneralReportIds.every((id) =>
      selectedVisibleGeneralReportIds.includes(id)
    );
  const selectedVisibleReturnedIssueIds = selectedReturnedIssueIds.filter(
    (id) => visibleReturnedIssueIds.includes(id)
  );
  const allVisibleReturnedIssuesSelected =
    visibleReturnedIssueIds.length > 0 &&
    visibleReturnedIssueIds.every((id) =>
      selectedVisibleReturnedIssueIds.includes(id)
    );
  useEffect(() => {
    if (selectAllReturnsRef.current) {
      selectAllReturnsRef.current.indeterminate =
        selectedReturnIds.some((id) => visibleReturnIds.includes(id)) &&
        !allVisibleReturnsSelected;
    }
  }, [allVisibleReturnsSelected, selectedReturnIds, visibleReturnIds]);
  useEffect(() => {
    if (selectAllBrokenRef.current) {
      selectAllBrokenRef.current.indeterminate =
        selectedBrokenAssetIds.some((id) =>
          visibleBrokenAssetIds.includes(id)
        ) && !allVisibleBrokenSelected;
    }
  }, [allVisibleBrokenSelected, selectedBrokenAssetIds, visibleBrokenAssetIds]);
  useEffect(() => {
    if (selectAllCancelledPickupsRef.current) {
      selectAllCancelledPickupsRef.current.indeterminate =
        selectedCancelledPickupIds.some((id) =>
          visibleCancelledPickupIds.includes(id)
        ) && !allVisibleCancelledPickupsSelected;
    }
  }, [
    allVisibleCancelledPickupsSelected,
    selectedCancelledPickupIds,
    visibleCancelledPickupIds,
  ]);
  useEffect(() => {
    setSelectedCancelledPickupIds((current) => {
      const visible = new Set<string>(JSON.parse(visibleCancelledPickupKey));
      const next = current.filter((id) => visible.has(id));
      return next.length === current.length ? current : next;
    });
  }, [visibleCancelledPickupKey]);
  useEffect(() => {
    if (view !== "cancelled-pickups" && view !== "all") {
      setSelectedCancelledPickupIds([]);
    }
  }, [view]);
  useEffect(() => {
    setSelectedReturnIds((current) => {
      const visible = new Set<string>(JSON.parse(visibleReturnKey));
      const next = current.filter((id) => visible.has(id));
      return next.length === current.length ? current : next;
    });
  }, [visibleReturnKey]);
  useEffect(() => {
    if (view !== "returns") setSelectedReturnIds([]);
  }, [view]);
  useEffect(() => {
    setSelectedBrokenAssetIds((current) => {
      const visible = new Set<string>(JSON.parse(visibleBrokenAssetKey));
      const next = current.filter((id) => visible.has(id));
      return next.length === current.length ? current : next;
    });
  }, [visibleBrokenAssetKey]);
  useEffect(() => {
    if (view !== "broken") setSelectedBrokenAssetIds([]);
  }, [view]);
  useEffect(() => {
    if (selectAllPreparationsRef.current) {
      selectAllPreparationsRef.current.indeterminate =
        selectedBulkReadyIds.length > 0 && !allVisiblePreparationsSelected;
    }
  }, [allVisiblePreparationsSelected, selectedBulkReadyIds.length]);
  useEffect(() => {
    setSelectedPreparationIds((current) => {
      const visible = new Set<string>(JSON.parse(visiblePreparationKey));
      const next = current.filter((id) => visible.has(id));
      return next.length === current.length ? current : next;
    });
  }, [visiblePreparationKey]);
  useEffect(() => {
    if (view !== "to-prepare" && view !== "all") {
      setSelectedPreparationIds([]);
    }
  }, [view]);
  function togglePreparationSelection(id: string) {
    setSelectedPreparationIds((current) => toggleSelectionId(current, id));
  }
  function toggleReturnSelection(id: string) {
    setSelectedReturnIds((current) => toggleSelectionId(current, id));
  }
  function toggleBrokenAssetSelection(id: string) {
    setSelectedBrokenAssetIds((current) => toggleSelectionId(current, id));
  }
  function toggleAllVisibleBroken() {
    setSelectedBrokenAssetIds((current) => {
      const visible = new Set(visibleBrokenAssetIds);
      return allVisibleBrokenSelected
        ? current.filter((id) => !visible.has(id))
        : [...new Set([...current, ...visibleBrokenAssetIds])];
    });
  }
  function toggleAllVisibleReturns() {
    setSelectedReturnIds((current) => {
      const visible = new Set(visibleReturnIds);
      return allVisibleReturnsSelected
        ? current.filter((id) => !visible.has(id))
        : [...new Set([...current, ...visibleReturnIds])];
    });
  }
  function toggleAllVisiblePreparations() {
    setSelectedPreparationIds((current) => {
      const visibleIds = new Set(visibleBulkReadyIds);
      if (visibleBulkReadyIds.every((id) => current.includes(id))) {
        return current.filter((id) => !visibleIds.has(id));
      }
      return [...new Set([...current, ...visibleBulkReadyIds])];
    });
  }
  function toggleAllVisibleCancelledPickups() {
    setSelectedCancelledPickupIds((current) => {
      const visible = new Set(visibleCancelledPickupIds);
      return allVisibleCancelledPickupsSelected
        ? current.filter((id) => !visible.has(id))
        : [...new Set([...current, ...visibleCancelledPickupIds])];
    });
  }
  const bulkResult =
    isSuccessfulAction(actionResult) &&
    "intent" in actionResult &&
    actionResult.intent === "confirm-prepared-bulk" &&
    isBulkPreparationResult(actionResult.result)
      ? actionResult.result
      : null;
  const cancelledPickupBulkResult =
    isSuccessfulAction(actionResult) &&
    "intent" in actionResult &&
    actionResult.intent === "put-back-cancelled-pickup-bulk" &&
    isBulkPreparationResult(actionResult.result)
      ? actionResult.result
      : null;
  useEffect(() => {
    if (!cancelledPickupBulkResult) return;
    const completed = new Set(
      cancelledPickupBulkResult.results
        .filter((result) => result.ok)
        .map((result) => result.operationId)
    );
    setSelectedCancelledPickupIds((current) =>
      current.filter((id) => !completed.has(id))
    );
    if (cancelledPickupBulkResult.failed === 0) setBulkPutBackOpen(false);
  }, [cancelledPickupBulkResult]);
  const failedBulkResults = bulkResult
    ? bulkResult.results.filter(
        (result): result is Extract<BulkPreparationItemResult, { ok: false }> =>
          !result.ok
      )
    : [];
  const returnFailures =
    returnActionResult?.ok === true &&
    (returnActionResult.intent === "complete-return-bulk" ||
      returnActionResult.intent === "disable-return-bulk") &&
    returnActionResult.results
      ? returnActionResult.results.filter(
          (result): result is Extract<ReturnCheckItemResult, { ok: false }> =>
            !result.ok
        )
      : [];
  const approvalResult = isAnnualAccessAction(actionResult)
    ? actionResult.result
    : null;
  const visibleApprovals =
    approvalView === "pending"
      ? annualAccessApprovals.pending.map((approval) => ({
          ...approval,
          accessState: "PENDING" as const,
        }))
      : annualAccessApprovals.access;
  const visiblePendingApprovalIds =
    approvalView === "pending"
      ? visibleApprovals.map((approval) => approval.id)
      : [];
  const visiblePendingApprovalKey = JSON.stringify(visiblePendingApprovalIds);
  const visiblePendingApprovalIdSet = new Set(visiblePendingApprovalIds);
  const selectedVisibleApprovalIds = selectedApprovalIds.filter((id) =>
    visiblePendingApprovalIdSet.has(id)
  );
  const allVisibleApprovalsSelected =
    visiblePendingApprovalIds.length > 0 &&
    visiblePendingApprovalIds.every((id) =>
      selectedVisibleApprovalIds.includes(id)
    );

  useEffect(() => {
    if (selectAllApprovalsRef.current) {
      selectAllApprovalsRef.current.indeterminate =
        selectedVisibleApprovalIds.length > 0 && !allVisibleApprovalsSelected;
    }
  }, [allVisibleApprovalsSelected, selectedVisibleApprovalIds.length]);

  useEffect(() => {
    setSelectedApprovalIds((current) => {
      const visibleIds = new Set<string>(JSON.parse(visiblePendingApprovalKey));
      const next = current.filter((id) => visibleIds.has(id));
      return next.length === current.length ? current : next;
    });
  }, [visiblePendingApprovalKey]);

  function toggleAllSelection(entry: AllSelectionEntry) {
    setSelectedAllRowKeys((current) => toggleSelectionId(current, entry.key));
  }

  function allViewCheckbox(task: Task) {
    const entry = getAllSelectionEntry(task);
    if (!entry) return <span aria-hidden="true" className="size-4 shrink-0" />;
    return (
      <input
        type="checkbox"
        aria-label={`Select ${task.title} ${entry.family}`}
        checked={selectedAllRowKeys.includes(entry.key)}
        onChange={() => toggleAllSelection(entry)}
        className="size-4 shrink-0 rounded border-gray-300 text-red-700 focus:ring-red-700"
      />
    );
  }

  return (
    <>
      <ListContentWrapper>
        <div className="space-y-5">
          <h1 className="text-2xl font-black tracking-tight text-gray-950">
            Lab status
          </h1>
          <div className="grid auto-rows-fr grid-cols-2 items-stretch gap-3 lg:grid-cols-4">
            {SUMMARY_KEYS.map((item) => (
              <Link
                key={item}
                to={`/operations?view=${item}`}
                className={`flex h-full min-w-0 flex-col rounded-2xl border p-4 transition ${
                  view === item
                    ? "border-red-300 bg-red-50"
                    : "border-gray-200 bg-white hover:border-red-200"
                }`}
              >
                <p className="break-words text-xs font-bold uppercase tracking-wide text-gray-500">
                  {VIEW_LABELS[item]}
                </p>
                <p className="mt-1 text-2xl font-black text-gray-950">
                  {summary[item] ?? 0}
                </p>
              </Link>
            ))}
          </div>

          <div
            className="flex flex-wrap items-stretch gap-2"
            aria-label="Operations filters"
          >
            {NAVIGATION_VIEWS.map((item) => (
              <Link
                key={item}
                to={item === "all" ? "/operations" : `/operations?view=${item}`}
                aria-current={view === item ? "page" : undefined}
                className={`inline-flex min-h-10 items-center whitespace-nowrap rounded-full border px-4 py-2 text-sm font-semibold transition ${
                  view === item
                    ? "border-red-700 bg-red-700 text-white"
                    : "border-gray-300 bg-white text-gray-700 hover:border-red-300 hover:text-red-800"
                }`}
              >
                {VIEW_LABELS[item]}
              </Link>
            ))}
          </div>

          {returnActionResult ? (
            <div
              role={
                returnActionResult.ok === true &&
                returnActionResult.failed === 0
                  ? "status"
                  : "alert"
              }
              className={`rounded-xl border px-4 py-3 text-sm font-semibold ${
                returnActionResult.ok === true &&
                returnActionResult.failed === 0
                  ? "border-green-200 bg-green-50 text-green-900"
                  : "border-amber-200 bg-amber-50 text-amber-950"
              }`}
            >
              {returnActionResult.ok === true ? (
                <>
                  {returnActionResult.succeeded} return
                  {returnActionResult.succeeded === 1 ? " was" : "s were"}{" "}
                  {returnActionResult.intent === "disable-return" ||
                  returnActionResult.intent === "disable-return-bulk"
                    ? "disabled from use."
                    : "checked."}
                  {returnActionResult.failed > 0
                    ? ` ${returnActionResult.failed} need review; details are shown on those rows.`
                    : returnActionResult.intent === "disable-return" ||
                      returnActionResult.intent === "disable-return-bulk"
                    ? " They were added to Broken items."
                    : " The item is available again."}
                </>
              ) : (
                returnActionResult.error
              )}
            </div>
          ) : null}

          {bulkResult ? (
            <div
              role={bulkResult.failed ? "alert" : "status"}
              className={`rounded-2xl border p-4 text-sm font-semibold ${
                bulkResult.failed
                  ? "border-amber-200 bg-amber-50 text-amber-900"
                  : "border-green-200 bg-green-50 text-green-900"
              }`}
            >
              {bulkResult.succeeded} item
              {bulkResult.succeeded === 1 ? "" : "s"} marked ready.
              {bulkResult.failed ? (
                <>
                  {" "}
                  {bulkResult.failed} item
                  {bulkResult.failed === 1 ? "" : "s"} could not be updated.
                  <ul className="mt-2 list-disc pl-5 text-xs font-medium">
                    {failedBulkResults.map((result) => (
                      <li key={result.operationId}>
                        {tasks.find(
                          (task) => task.operationId === result.operationId
                        )?.title ?? result.operationId}
                        : {result.error}
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </div>
          ) : null}

          {cancelledPickupBulkResult ? (
            <div
              role={cancelledPickupBulkResult.failed ? "alert" : "status"}
              className={`rounded-xl border px-4 py-3 text-sm font-semibold ${
                cancelledPickupBulkResult.failed
                  ? "border-amber-200 bg-amber-50 text-amber-950"
                  : "border-green-200 bg-green-50 text-green-900"
              }`}
            >
              {cancelledPickupBulkResult.succeeded} item
              {cancelledPickupBulkResult.succeeded === 1
                ? " was"
                : "s were"}{" "}
              put back.
              {cancelledPickupBulkResult.failed ? (
                <ul className="mt-2 list-disc pl-5 text-xs font-medium">
                  {cancelledPickupBulkResult.results
                    .filter((result) => !result.ok)
                    .map((result) => (
                      <li key={result.operationId}>
                        {tasks.find(
                          (task) => task.operationId === result.operationId
                        )?.title ?? "Item"}
                        : {result.error}
                      </li>
                    ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          {view === "access-approvals" ? (
            <section
              className="space-y-4"
              aria-labelledby="annual-approvals-heading"
            >
              <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h1
                      id="annual-approvals-heading"
                      className="text-xl font-black text-gray-950"
                    >
                      Student access approvals
                    </h1>
                    <p className="mt-1 text-sm text-gray-600">
                      Review Student requests and current borrowing approvals.
                    </p>
                  </div>
                  <div className="flex rounded-xl bg-gray-100 p-1 text-sm font-bold">
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedApprovalIds([]);
                        setApprovalView("pending");
                      }}
                      className={`rounded-lg px-3 py-1.5 ${
                        approvalView === "pending"
                          ? "bg-white text-red-800 shadow-sm"
                          : "text-gray-600"
                      }`}
                    >
                      Pending ({annualAccessApprovals.pending.length})
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedApprovalIds([]);
                        setApprovalView("access");
                      }}
                      className={`rounded-lg px-3 py-1.5 ${
                        approvalView === "access"
                          ? "bg-white text-red-800 shadow-sm"
                          : "text-gray-600"
                      }`}
                    >
                      Access ({annualAccessApprovals.access.length})
                    </button>
                  </div>
                </div>
              </div>

              {approvalResult ? (
                <div
                  role="status"
                  className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm font-semibold text-green-900"
                >
                  {actionResult?.intent === "decline-access-bulk"
                    ? `${approvalResult.succeeded ?? 0} access request${
                        approvalResult.succeeded === 1 ? "" : "s"
                      } rejected.${
                        typeof approvalResult.failed === "number" &&
                        approvalResult.failed
                          ? ` ${approvalResult.failed} could not be rejected.`
                          : ""
                      }`
                    : approvalResult.declined
                    ? "Access request declined."
                    : approvalResult.revoked
                    ? "Student access approval revoked."
                    : approvalResult.reapproved
                    ? "Student access restored."
                    : `${approvalResult.approvedCount ?? 0} access request${
                        approvalResult.approvedCount === 1 ? "" : "s"
                      } approved.${
                        approvalResult.failedCount
                          ? ` ${approvalResult.failedCount} could not be approved.`
                          : ""
                      }`}
                  {Array.isArray(approvalResult.failed) &&
                  approvalResult.failed.length ? (
                    <ul className="mt-2 list-disc pl-5 text-xs font-medium">
                      {approvalResult.failed.map((failure) => (
                        <li key={failure.id}>
                          {failure.name}: {failure.reason}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}

              {approvalView === "pending" && visibleApprovals.length ? (
                <div className="space-y-2">
                  <Form
                    method="post"
                    className="flex flex-wrap items-center gap-3 rounded-2xl border border-red-100 bg-red-50 p-4"
                  >
                    <input
                      type="hidden"
                      name="intent"
                      value="approve-access-bulk"
                    />
                    <label className="inline-flex items-center gap-2 text-sm font-semibold text-gray-800">
                      <input
                        ref={selectAllApprovalsRef}
                        type="checkbox"
                        aria-label="Select all visible Student approval requests"
                        checked={allVisibleApprovalsSelected}
                        onChange={(event) =>
                          setSelectedApprovalIds(
                            event.currentTarget.checked
                              ? visiblePendingApprovalIds
                              : []
                          )
                        }
                        className="size-4 rounded border-gray-300 text-red-700 focus:ring-red-700"
                      />
                      Select all
                    </label>
                    {selectedVisibleApprovalIds.map((requestId) => (
                      <input
                        key={requestId}
                        type="hidden"
                        name="requestIds"
                        value={requestId}
                      />
                    ))}
                    <span className="text-sm font-bold text-gray-950">
                      {selectedVisibleApprovalIds.length} selected
                    </span>
                    <button
                      type="submit"
                      disabled={!selectedVisibleApprovalIds.length}
                      className="rounded-xl bg-red-700 px-3 py-2 text-sm font-bold text-white hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Approve selected
                    </button>
                    <button
                      type="button"
                      onClick={() => setSelectedApprovalIds([])}
                      className="rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm font-bold text-gray-700 hover:border-red-300"
                    >
                      Clear
                    </button>
                  </Form>
                  {selectedVisibleApprovalIds.length ? (
                    <Form
                      method="post"
                      className="flex items-center gap-3 rounded-2xl border border-gray-200 bg-white p-3"
                    >
                      <input
                        type="hidden"
                        name="intent"
                        value="decline-access-bulk"
                      />
                      {selectedVisibleApprovalIds.map((requestId) => (
                        <input
                          key={requestId}
                          type="hidden"
                          name="requestIds"
                          value={requestId}
                        />
                      ))}
                      <span className="text-sm font-bold text-gray-950">
                        {selectedVisibleApprovalIds.length} selected
                      </span>
                      <button
                        type="submit"
                        className="rounded-xl border border-red-300 px-3 py-2 text-sm font-bold text-red-800 hover:bg-red-50"
                      >
                        Reject selected
                      </button>
                    </Form>
                  ) : null}
                </div>
              ) : null}

              {visibleApprovals.length ? (
                <div className="space-y-3">
                  {visibleApprovals.map((approval) => (
                    <SelectableRow
                      key={approval.id}
                      selected={selectedApprovalIds.includes(approval.id)}
                      onToggle={
                        approvalView === "pending"
                          ? () =>
                              setSelectedApprovalIds((current) =>
                                toggleSelectionId(current, approval.id)
                              )
                          : undefined
                      }
                    >
                      <div className="flex flex-wrap items-start justify-between gap-4">
                        <div className="flex min-w-0 items-start gap-3">
                          {approvalView === "pending" ? (
                            <input
                              type="checkbox"
                              aria-label={`Select ${displayName(
                                approval.student
                              )}`}
                              checked={selectedApprovalIds.includes(
                                approval.id
                              )}
                              onChange={() =>
                                setSelectedApprovalIds((current) =>
                                  toggleSelectionId(current, approval.id)
                                )
                              }
                              className="mt-1 size-4 rounded border-gray-300 text-red-700"
                            />
                          ) : null}
                          <div>
                            <h2 className="font-bold text-gray-950">
                              {displayName(approval.student)}
                            </h2>
                            <p className="text-sm text-gray-600">
                              {approval.student.email}
                            </p>
                            {approvalView === "pending" ? (
                              <p className="mt-1 text-xs text-gray-500">
                                Requested{" "}
                                {formatApprovalDate(approval.requestedAt)}
                              </p>
                            ) : approval.accessState === "ACTIVE" ? (
                              <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                                <span className="rounded-full bg-green-100 px-2 py-0.5 font-bold text-green-800">
                                  Approved
                                </span>
                                {approval.reviewedAt ? (
                                  <span className="text-gray-500">
                                    {formatApprovalDate(approval.reviewedAt)}
                                  </span>
                                ) : null}
                                {approval.validUntil ? (
                                  <span className="text-gray-500">
                                    · Valid until{" "}
                                    {formatApprovalDate(approval.validUntil)}
                                  </span>
                                ) : null}
                              </p>
                            ) : (
                              <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                                <span className="rounded-full bg-gray-100 px-2 py-0.5 font-bold text-gray-700">
                                  {approval.accessState === "REVOKED"
                                    ? "Revoked"
                                    : "Expired"}
                                </span>
                                <span className="text-gray-500">
                                  {approval.accessState === "REVOKED"
                                    ? approval.reviewedAt
                                      ? formatApprovalDate(approval.reviewedAt)
                                      : ""
                                    : approval.validUntil
                                    ? `Valid until ${formatApprovalDate(
                                        approval.validUntil
                                      )}`
                                    : ""}
                                </span>
                              </p>
                            )}
                          </div>
                        </div>
                        {approvalView === "pending" ? (
                          <div className="flex flex-wrap items-end gap-2">
                            <Form method="post">
                              <input
                                type="hidden"
                                name="intent"
                                value="approve-access"
                              />
                              <input
                                type="hidden"
                                name="requestId"
                                value={approval.id}
                              />
                              <button
                                type="submit"
                                className="rounded-xl bg-red-700 px-3 py-2 text-sm font-bold text-white hover:bg-red-800"
                              >
                                Approve
                              </button>
                            </Form>
                            <Form
                              method="post"
                              className="flex items-center gap-2"
                            >
                              <input
                                type="hidden"
                                name="intent"
                                value="decline-access"
                              />
                              <input
                                type="hidden"
                                name="requestId"
                                value={approval.id}
                              />
                              <input
                                name="staffComment"
                                placeholder="Optional comment"
                                className="w-40 rounded-lg border border-gray-300 p-2 text-xs"
                              />
                              <button
                                type="submit"
                                className="rounded-xl border border-red-300 px-3 py-2 text-sm font-bold text-red-800 hover:bg-red-50"
                              >
                                Decline
                              </button>
                            </Form>
                          </div>
                        ) : approval.accessState === "ACTIVE" ? (
                          <Form method="post">
                            <input
                              type="hidden"
                              name="intent"
                              value="revoke-access"
                            />
                            <input
                              type="hidden"
                              name="requestId"
                              value={approval.id}
                            />
                            <button
                              type="submit"
                              className="rounded-xl border border-red-300 px-3 py-2 text-sm font-bold text-red-800 hover:bg-red-50"
                            >
                              Revoke access
                            </button>
                          </Form>
                        ) : (
                          <Form method="post">
                            <input
                              type="hidden"
                              name="intent"
                              value="reapprove-access"
                            />
                            <input
                              type="hidden"
                              name="requestId"
                              value={approval.id}
                            />
                            <button
                              type="submit"
                              className="rounded-xl bg-red-700 px-3 py-2 text-sm font-bold text-white hover:bg-red-800"
                            >
                              Approve
                            </button>
                          </Form>
                        )}
                      </div>
                    </SelectableRow>
                  ))}
                </div>
              ) : (
                <div className="rounded-2xl border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-600">
                  {approvalView === "pending"
                    ? "No access approval requests need review."
                    : "No access records yet."}
                </div>
              )}
            </section>
          ) : visibleTasks.length ? (
            <>
              {view === "all" && allSelectionEntries.length > 0 ? (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-gray-200 bg-white p-3">
                  <div className="flex min-w-0 flex-wrap items-center gap-3">
                    <label className="flex items-center gap-2 text-sm font-semibold text-gray-800">
                      <input
                        ref={selectAllAllRowsRef}
                        type="checkbox"
                        aria-label="Select all visible Operations rows"
                        checked={allVisibleAllRowsSelected}
                        onChange={(event) =>
                          setSelectedAllRowKeys(
                            event.currentTarget.checked
                              ? visibleAllSelectionKeys
                              : []
                          )
                        }
                        className="size-4 rounded border-gray-300 text-red-700 focus:ring-red-700"
                      />
                      Select all visible
                    </label>
                    {selectedAllEntries.length > 0 ? (
                      <span className="text-sm font-bold text-gray-950">
                        {selectedAllEntries.length} selected
                      </span>
                    ) : null}
                  </div>
                  {selectedAllEntries.length > 0 ? (
                    <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
                      {canResolveSelectedReports ? (
                        <Form method="post">
                          <input
                            type="hidden"
                            name="intent"
                            value="resolve-report-bulk"
                          />
                          {selectedOperationalReportIds.map((reportId) => (
                            <input
                              key={reportId}
                              type="hidden"
                              name="operationIds"
                              value={reportId}
                            />
                          ))}
                          <button
                            type="submit"
                            className="rounded-lg bg-red-700 px-3 py-2 text-sm font-bold text-white hover:bg-red-800"
                          >
                            Resolve selected
                          </button>
                        </Form>
                      ) : null}
                      {compatibleAllFamily === "broken" ? (
                        <>
                          <p className="basis-full text-right text-xs text-gray-500">
                            Resolving a report closes it; units stay out of
                            service until Staff explicitly returns them.
                          </p>
                          <Form method="post">
                            <input
                              type="hidden"
                              name="intent"
                              value="return-to-service-bulk"
                            />
                            {selectedAllEntries.map((entry) => (
                              <input
                                key={entry.key}
                                type="hidden"
                                name="assetIds"
                                value={entry.id}
                              />
                            ))}
                            <button
                              type="submit"
                              className="rounded-lg border border-green-300 bg-green-50 px-3 py-2 text-sm font-bold text-green-900 hover:bg-green-100"
                            >
                              Return to service
                            </button>
                          </Form>
                        </>
                      ) : null}
                      {compatibleAllFamily === "returns" ? (
                        <>
                          <Form method="post">
                            <input
                              type="hidden"
                              name="intent"
                              value="complete-return-bulk"
                            />
                            {selectedAllEntries.map((entry) => (
                              <input
                                key={entry.key}
                                type="hidden"
                                name="operationIds"
                                value={entry.id}
                              />
                            ))}
                            <button
                              type="submit"
                              className="rounded-lg bg-red-700 px-3 py-2 text-sm font-bold text-white hover:bg-red-800"
                            >
                              Mark checked
                            </button>
                          </Form>
                          <button
                            type="button"
                            onClick={() =>
                              setAllConfirmAction("remove-returns")
                            }
                            className="rounded-lg border border-red-300 px-3 py-2 text-sm font-bold text-red-800 hover:bg-red-50"
                          >
                            Remove from service
                          </button>
                        </>
                      ) : null}
                      {compatibleAllFamily === "returned-with-issues" ? (
                        <>
                          <Form method="post">
                            <input
                              type="hidden"
                              name="intent"
                              value="return-issue-to-service-bulk"
                            />
                            {selectedAllEntries.map((entry) => (
                              <Fragment key={entry.key}>
                                <input
                                  type="hidden"
                                  name="operationIds"
                                  value={entry.id}
                                />
                                <input
                                  type="hidden"
                                  name="reportOperationIds"
                                  value={entry.secondaryId}
                                />
                              </Fragment>
                            ))}
                            <button
                              type="submit"
                              className="rounded-lg bg-red-700 px-3 py-2 text-sm font-bold text-white hover:bg-red-800"
                            >
                              Return to service
                            </button>
                          </Form>
                          <button
                            type="button"
                            onClick={() =>
                              setAllConfirmAction("remove-returned-issues")
                            }
                            className="rounded-lg border border-red-300 px-3 py-2 text-sm font-bold text-red-800 hover:bg-red-50"
                          >
                            Remove from service
                          </button>
                        </>
                      ) : null}
                      {compatibleAllFamily === "to-prepare" ? (
                        <>
                          <Form method="post">
                            <input
                              type="hidden"
                              name="intent"
                              value="confirm-prepared-bulk"
                            />
                            {selectedAllEntries.map((entry) => (
                              <input
                                key={entry.key}
                                type="hidden"
                                name="operationIds"
                                value={entry.id}
                              />
                            ))}
                            <button
                              type="submit"
                              className="rounded-lg bg-red-700 px-3 py-2 text-sm font-bold text-white hover:bg-red-800"
                            >
                              Mark prepared
                            </button>
                          </Form>
                          <Form method="post">
                            <input
                              type="hidden"
                              name="intent"
                              value="decline-preparation-bulk"
                            />
                            {selectedAllEntries.map((entry) => (
                              <input
                                key={entry.key}
                                type="hidden"
                                name="operationIds"
                                value={entry.id}
                              />
                            ))}
                            <button
                              type="submit"
                              className="rounded-lg border border-red-300 px-3 py-2 text-sm font-bold text-red-800 hover:bg-red-50"
                            >
                              Decline selected
                            </button>
                          </Form>
                        </>
                      ) : null}
                      {compatibleAllFamily === "cancelled-pickups" ? (
                        <button
                          type="button"
                          onClick={() =>
                            setAllConfirmAction("release-cancelled-pickups")
                          }
                          className="rounded-lg bg-red-700 px-3 py-2 text-sm font-bold text-white hover:bg-red-800"
                        >
                          Release selected units
                        </button>
                      ) : null}
                      {compatibleAllFamily === "access-approvals" ? (
                        <>
                          <Form method="post">
                            <input
                              type="hidden"
                              name="intent"
                              value="approve-access-bulk"
                            />
                            {selectedAllEntries.map((entry) => (
                              <input
                                key={entry.key}
                                type="hidden"
                                name="requestIds"
                                value={entry.id}
                              />
                            ))}
                            <button
                              type="submit"
                              className="rounded-lg bg-red-700 px-3 py-2 text-sm font-bold text-white hover:bg-red-800"
                            >
                              Approve selected
                            </button>
                          </Form>
                          <Form method="post">
                            <input
                              type="hidden"
                              name="intent"
                              value="decline-access-bulk"
                            />
                            {selectedAllEntries.map((entry) => (
                              <input
                                key={entry.key}
                                type="hidden"
                                name="requestIds"
                                value={entry.id}
                              />
                            ))}
                            <button
                              type="submit"
                              className="rounded-lg border border-red-300 px-3 py-2 text-sm font-bold text-red-800 hover:bg-red-50"
                            >
                              Reject selected
                            </button>
                          </Form>
                        </>
                      ) : null}
                      {compatibleAllFamily === "overdue" ? (
                        <span className="text-sm text-gray-600">
                          Open each loan to manage it safely.
                        </span>
                      ) : null}
                      {compatibleAllFamily === "ready-for-pickup" ? (
                        <span className="text-sm text-gray-600">
                          Confirm pickup individually so each unit can be
                          verified.
                        </span>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedAllRowKeys([]);
                          setAllConfirmAction(null);
                        }}
                        className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-semibold text-gray-700 hover:border-red-300"
                      >
                        Clear selection
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}
              {view === "all" && allConfirmAction ? (
                <DialogPortal>
                  <Dialog
                    open
                    onClose={() => setAllConfirmAction(null)}
                    title={
                      <span className="text-base font-semibold text-gray-900">
                        {allConfirmAction === "remove-returns"
                          ? `Remove ${selectedAllEntries.length} returned items from service?`
                          : allConfirmAction === "remove-returned-issues"
                          ? `Remove ${selectedAllEntries.length} reported units from service?`
                          : `Release ${selectedAllEntries.length} cancelled pickups?`}
                      </span>
                    }
                    headerClassName="items-center py-2"
                    className="w-[min(32rem,calc(100vw-2rem))]"
                  >
                    <Form
                      method="post"
                      className="space-y-4 px-6 pb-4 pt-1"
                      onSubmit={() => setAllConfirmAction(null)}
                    >
                      <input
                        type="hidden"
                        name="intent"
                        value={
                          allConfirmAction === "remove-returns"
                            ? "disable-return-bulk"
                            : allConfirmAction === "remove-returned-issues"
                            ? "remove-return-issue-from-service-bulk"
                            : "put-back-cancelled-pickup-bulk"
                        }
                      />
                      {selectedAllEntries.map((entry) => (
                        <Fragment key={entry.key}>
                          <input
                            type="hidden"
                            name="operationIds"
                            value={entry.id}
                          />
                          {entry.secondaryId ? (
                            <input
                              type="hidden"
                              name="reportOperationIds"
                              value={entry.secondaryId}
                            />
                          ) : null}
                        </Fragment>
                      ))}
                      <p className="text-sm text-gray-700">
                        {allConfirmAction === "remove-returns" ||
                        allConfirmAction === "remove-returned-issues"
                          ? "These exact units will remain unavailable until they are returned to service."
                          : "Confirm that these exact items have been collected from the Pickup Zone and returned to their normal storage locations."}
                      </p>
                      <ul className="list-disc space-y-1 pl-5 text-sm font-semibold text-gray-900">
                        {selectedAllEntries.map((entry) => (
                          <li key={entry.key}>{entry.task.title}</li>
                        ))}
                      </ul>
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => setAllConfirmAction(null)}
                          className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-semibold text-gray-700"
                        >
                          Cancel
                        </button>
                        <button
                          type="submit"
                          className="rounded-lg bg-red-700 px-3 py-2 text-sm font-semibold text-white hover:bg-red-800"
                        >
                          {allConfirmAction === "release-cancelled-pickups"
                            ? "Release selected units"
                            : "Remove from service"}
                        </button>
                      </div>
                    </Form>
                  </Dialog>
                </DialogPortal>
              ) : null}
              {view === "returns" ? (
                <Form
                  method="post"
                  className="flex min-h-14 flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-white p-3"
                >
                  <input
                    type="hidden"
                    name="intent"
                    value="complete-return-bulk"
                  />
                  {selectedReturnIds.map((operationId) => (
                    <input
                      key={operationId}
                      type="hidden"
                      name="operationIds"
                      value={operationId}
                    />
                  ))}
                  <label className="flex items-center gap-2 text-sm font-semibold text-gray-800">
                    <input
                      ref={selectAllReturnsRef}
                      type="checkbox"
                      checked={allVisibleReturnsSelected}
                      disabled={visibleReturnIds.length === 0}
                      onChange={toggleAllVisibleReturns}
                      className="size-4 rounded border-gray-300 text-red-700 disabled:cursor-not-allowed disabled:opacity-50"
                    />
                    Select all
                  </label>
                  {selectedReturnIds.length > 0 ? (
                    <>
                      <span className="text-sm font-bold text-gray-950">
                        {selectedReturnIds.length} selected
                      </span>
                      <button
                        type="submit"
                        className="rounded-lg bg-red-700 px-3 py-2 text-sm font-bold text-white hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Mark checked
                      </button>
                      <button
                        type="button"
                        onClick={() => setBulkDisableReturnsOpen(true)}
                        className="rounded-lg border border-red-300 px-3 py-2 text-sm font-bold text-red-800 hover:bg-red-50"
                      >
                        Remove from service
                      </button>
                      <button
                        type="button"
                        onClick={() => setSelectedReturnIds([])}
                        className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-gray-700 hover:border-red-300 hover:text-red-800"
                      >
                        Clear
                      </button>
                    </>
                  ) : null}
                </Form>
              ) : null}
              {(view === "overdue" || view === "ready-for-pickup") &&
              visibleManagementIds.length > 0 ? (
                <div className="flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-white p-3">
                  <label className="flex items-center gap-2 text-sm font-semibold text-gray-800">
                    <input
                      type="checkbox"
                      aria-label="Select all visible loans and pickups"
                      checked={allVisibleManagementSelected}
                      onChange={(event) =>
                        setSelectedManagementIds(
                          event.currentTarget.checked
                            ? visibleManagementIds
                            : []
                        )
                      }
                      className="size-4 rounded border-gray-300 text-red-700"
                    />
                    Select all visible
                  </label>
                  {selectedManagementIds.length > 0 ? (
                    <>
                      <span className="text-sm font-bold text-gray-950">
                        {selectedManagementIds.length} selected
                      </span>
                      <span className="text-xs text-gray-600">
                        {view === "ready-for-pickup"
                          ? "Confirm pickup individually so each unit can be verified."
                          : "Use each loan row to open and manage that loan."}
                      </span>
                      <button
                        type="button"
                        onClick={() => setSelectedManagementIds([])}
                        className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-semibold text-gray-700"
                      >
                        Clear selection
                      </button>
                    </>
                  ) : null}
                </div>
              ) : null}
              {view === "general" && visibleGeneralReportIds.length > 0 ? (
                <Form
                  method="post"
                  className="flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-white p-3"
                >
                  <input
                    type="hidden"
                    name="intent"
                    value="resolve-report-bulk"
                  />
                  {selectedVisibleGeneralReportIds.map((operationId) => (
                    <input
                      key={operationId}
                      type="hidden"
                      name="operationIds"
                      value={operationId}
                    />
                  ))}
                  <label className="flex items-center gap-2 text-sm font-semibold text-gray-800">
                    <input
                      type="checkbox"
                      aria-label="Select all visible general reports"
                      checked={allVisibleGeneralReportsSelected}
                      onChange={(event) =>
                        setSelectedGeneralReportIds(
                          event.currentTarget.checked
                            ? visibleGeneralReportIds
                            : []
                        )
                      }
                      className="size-4 rounded border-gray-300 text-red-700"
                    />
                    Select all
                  </label>
                  {selectedVisibleGeneralReportIds.length ? (
                    <>
                      <span className="text-sm font-bold text-gray-950">
                        {selectedVisibleGeneralReportIds.length} selected
                      </span>
                      <button
                        type="submit"
                        className="rounded-lg bg-red-700 px-3 py-2 text-sm font-bold text-white hover:bg-red-800"
                      >
                        Resolve selected
                      </button>
                      <button
                        type="button"
                        onClick={() => setSelectedGeneralReportIds([])}
                        className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-semibold text-gray-700"
                      >
                        Clear selection
                      </button>
                    </>
                  ) : null}
                </Form>
              ) : null}
              {view === "returned-with-issues" &&
              visibleReturnedIssueIds.length > 0 ? (
                <Form
                  method="post"
                  className="flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-white p-3"
                >
                  <input
                    type="hidden"
                    name="intent"
                    value="return-issue-to-service-bulk"
                  />
                  {selectedVisibleReturnedIssueIds.map((operationId) => (
                    <input
                      key={operationId}
                      type="hidden"
                      name="operationIds"
                      value={operationId}
                    />
                  ))}
                  {selectedVisibleReturnedIssueIds.map((operationId) => {
                    const reportId = visibleTasks.find(
                      (task) => task.operationId === operationId
                    )?.returnIssueOperationId;
                    return reportId ? (
                      <input
                        key={reportId}
                        type="hidden"
                        name="reportOperationIds"
                        value={reportId}
                      />
                    ) : null;
                  })}
                  <label className="flex items-center gap-2 text-sm font-semibold text-gray-800">
                    <input
                      type="checkbox"
                      aria-label="Select all visible returned issues"
                      checked={allVisibleReturnedIssuesSelected}
                      onChange={(event) =>
                        setSelectedReturnedIssueIds(
                          event.currentTarget.checked
                            ? visibleReturnedIssueIds
                            : []
                        )
                      }
                      className="size-4 rounded border-gray-300 text-red-700"
                    />
                    Select all
                  </label>
                  {selectedVisibleReturnedIssueIds.length ? (
                    <>
                      <span className="text-sm font-bold text-gray-950">
                        {selectedVisibleReturnedIssueIds.length} selected
                      </span>
                      <button
                        type="submit"
                        className="rounded-lg bg-red-700 px-3 py-2 text-sm font-bold text-white hover:bg-red-800"
                      >
                        Return to service
                      </button>
                      <button
                        type="button"
                        onClick={() => setBulkRemoveReturnedIssuesOpen(true)}
                        className="rounded-lg border border-red-300 px-3 py-2 text-sm font-bold text-red-800 hover:bg-red-50"
                      >
                        Remove from service
                      </button>
                      <button
                        type="button"
                        onClick={() => setSelectedReturnedIssueIds([])}
                        className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-semibold text-gray-700"
                      >
                        Clear selection
                      </button>
                    </>
                  ) : null}
                </Form>
              ) : null}
              {view === "returned-with-issues" &&
              selectedVisibleReturnedIssueIds.length ? (
                <DialogPortal>
                  <Dialog
                    open={bulkRemoveReturnedIssuesOpen}
                    onClose={() => setBulkRemoveReturnedIssuesOpen(false)}
                    title={
                      <span className="text-base font-semibold text-gray-900">
                        Remove {selectedVisibleReturnedIssueIds.length} returned
                        units from service?
                      </span>
                    }
                    headerClassName="items-center py-2"
                    className="w-[min(32rem,calc(100vw-2rem))]"
                  >
                    <Form method="post" className="space-y-4 px-6 pb-4 pt-1">
                      <input
                        type="hidden"
                        name="intent"
                        value="remove-return-issue-from-service-bulk"
                      />
                      {selectedVisibleReturnedIssueIds.map((operationId) => (
                        <input
                          key={operationId}
                          type="hidden"
                          name="operationIds"
                          value={operationId}
                        />
                      ))}
                      {selectedVisibleReturnedIssueIds.map((operationId) => {
                        const reportId = visibleTasks.find(
                          (task) => task.operationId === operationId
                        )?.returnIssueOperationId;
                        return reportId ? (
                          <input
                            key={reportId}
                            type="hidden"
                            name="reportOperationIds"
                            value={reportId}
                          />
                        ) : null;
                      })}
                      <p className="text-sm text-gray-700">
                        These exact units will remain unavailable until repaired
                        and returned to service.
                      </p>
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => setBulkRemoveReturnedIssuesOpen(false)}
                          className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-semibold text-gray-700"
                        >
                          Cancel
                        </button>
                        <button
                          type="submit"
                          className="rounded-lg bg-red-700 px-3 py-2 text-sm font-semibold text-white hover:bg-red-800"
                        >
                          Remove from service
                        </button>
                      </div>
                    </Form>
                  </Dialog>
                </DialogPortal>
              ) : null}
              {view === "broken" && visibleBrokenAssetIds.length > 0 ? (
                <>
                  <Form
                    method="post"
                    className="flex min-h-14 flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-white p-3"
                  >
                    <input
                      type="hidden"
                      name="intent"
                      value="return-to-service-bulk"
                    />
                    {selectedBrokenAssetIds.map((assetId) => (
                      <input
                        key={assetId}
                        type="hidden"
                        name="assetIds"
                        value={assetId}
                      />
                    ))}
                    <label className="flex items-center gap-2 text-sm font-semibold text-gray-800">
                      <input
                        ref={selectAllBrokenRef}
                        type="checkbox"
                        checked={allVisibleBrokenSelected}
                        onChange={toggleAllVisibleBroken}
                        className="size-4 rounded border-gray-300 text-red-700"
                      />
                      Select all
                    </label>
                    {selectedBrokenAssetIds.length ? (
                      <>
                        <span className="text-sm font-bold text-gray-950">
                          {selectedBrokenAssetIds.length} selected
                        </span>
                        <button
                          type={
                            selectedBrokenAssetIds.length === 1
                              ? "submit"
                              : "button"
                          }
                          onClick={() => {
                            if (selectedBrokenAssetIds.length > 1)
                              setBulkReturnToServiceOpen(true);
                          }}
                          className="rounded-lg border border-green-300 bg-green-50 px-3 py-2 text-sm font-bold text-green-900 hover:bg-green-100"
                        >
                          Return to service
                        </button>
                        <button
                          type="button"
                          onClick={() => setSelectedBrokenAssetIds([])}
                          className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-gray-700 hover:border-red-300"
                        >
                          Clear
                        </button>
                      </>
                    ) : null}
                  </Form>
                  <DialogPortal>
                    <Dialog
                      open={bulkReturnToServiceOpen}
                      onClose={() => setBulkReturnToServiceOpen(false)}
                      title={
                        <span className="text-base font-semibold text-gray-900">
                          Return {selectedBrokenAssetIds.length} items to
                          service?
                        </span>
                      }
                      headerClassName="items-center py-2"
                      className="w-[min(32rem,calc(100vw-2rem))]"
                    >
                      <Form method="post" className="space-y-4 px-6 pb-4 pt-1">
                        <input
                          type="hidden"
                          name="intent"
                          value="return-to-service-bulk"
                        />
                        {selectedBrokenAssetIds.map((assetId) => (
                          <input
                            key={assetId}
                            type="hidden"
                            name="assetIds"
                            value={assetId}
                          />
                        ))}
                        <p className="text-sm text-gray-700">
                          These items will become available for borrowing again.
                        </p>
                        <div className="flex justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => setBulkReturnToServiceOpen(false)}
                            className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-semibold text-gray-700"
                          >
                            Cancel
                          </button>
                          <button
                            type="submit"
                            className="rounded-lg bg-green-700 px-3 py-2 text-sm font-semibold text-white hover:bg-green-800"
                          >
                            Return to service
                          </button>
                        </div>
                      </Form>
                    </Dialog>
                  </DialogPortal>
                </>
              ) : null}
              {view === "returns" && selectedReturnIds.length > 0 ? (
                <DialogPortal>
                  <Dialog
                    open={bulkDisableReturnsOpen}
                    onClose={() => setBulkDisableReturnsOpen(false)}
                    title={
                      <span className="text-base font-semibold text-gray-900">
                        Remove {selectedReturnIds.length} item
                        {selectedReturnIds.length === 1 ? "" : "s"} from
                        service?
                      </span>
                    }
                    headerClassName="items-center py-2"
                    className="w-[min(32rem,calc(100vw-2rem))]"
                  >
                    <Form method="post" className="space-y-4 px-6 pb-4 pt-1">
                      <input
                        type="hidden"
                        name="intent"
                        value="disable-return-bulk"
                      />
                      {selectedReturnIds.map((operationId) => (
                        <input
                          key={operationId}
                          type="hidden"
                          name="operationIds"
                          value={operationId}
                        />
                      ))}
                      <p className="text-sm text-gray-700">
                        These items will move to Broken items and remain
                        unavailable for borrowing until repaired.
                      </p>
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => setBulkDisableReturnsOpen(false)}
                          className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-semibold text-gray-700 hover:border-gray-400"
                        >
                          Cancel
                        </button>
                        <button
                          type="submit"
                          className="rounded-lg bg-red-700 px-3 py-2 text-sm font-semibold text-white hover:bg-red-800"
                        >
                          Remove from service
                        </button>
                      </div>
                    </Form>
                  </Dialog>
                </DialogPortal>
              ) : null}
              {view === "to-prepare" &&
              visibleTasks.some((task) => task.kind === "to-prepare") ? (
                <>
                  <Form
                    method="post"
                    className="flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-white p-3"
                  >
                    <input
                      type="hidden"
                      name="intent"
                      value="confirm-prepared-bulk"
                    />
                    {selectedBulkReadyIds.map((operationId) => (
                      <input
                        key={operationId}
                        type="hidden"
                        name="operationIds"
                        value={operationId}
                      />
                    ))}
                    <label className="flex items-center gap-2 text-sm font-semibold text-gray-800">
                      <input
                        ref={selectAllPreparationsRef}
                        type="checkbox"
                        checked={allVisiblePreparationsSelected}
                        disabled={visibleBulkReadyIds.length === 0}
                        onChange={toggleAllVisiblePreparations}
                        className="size-4 rounded border-gray-300 text-red-700 disabled:cursor-not-allowed disabled:opacity-50"
                      />
                      Select all available for preparation
                    </label>
                    {selectedPreparationIds.length > 0 ? (
                      <>
                        <span className="text-sm font-bold text-gray-950">
                          {selectedPreparationIds.length} selected
                        </span>
                        {selectedBulkReadyIds.length ? (
                          <>
                            {selectedBulkReadyIds.length <
                            selectedPreparationIds.length ? (
                              <span className="text-xs text-gray-600">
                                Unavailable tasks are excluded from bulk
                                preparation.
                              </span>
                            ) : null}
                            <button
                              type="submit"
                              className="rounded-xl bg-red-700 px-3 py-2 text-sm font-bold text-white hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              Mark prepared
                            </button>
                          </>
                        ) : (
                          <span className="text-xs text-gray-600">
                            No selected tasks are available for preparation.
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedPreparationIds([]);
                          }}
                          className="rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm font-bold text-gray-700 hover:border-red-300 hover:text-red-800"
                        >
                          Clear
                        </button>
                      </>
                    ) : null}
                  </Form>
                  {selectedPreparationIds.some((id) =>
                    visiblePreparationIds.includes(id)
                  ) ? (
                    <Form
                      method="post"
                      className="flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-white p-3"
                    >
                      <input
                        type="hidden"
                        name="intent"
                        value="decline-preparation-bulk"
                      />
                      {selectedPreparationIds
                        .filter((id) => visiblePreparationIds.includes(id))
                        .map((operationId) => (
                          <input
                            key={operationId}
                            type="hidden"
                            name="operationIds"
                            value={operationId}
                          />
                        ))}
                      <button
                        type="submit"
                        className="rounded-lg border border-red-300 px-3 py-2 text-sm font-bold text-red-800 hover:bg-red-50"
                      >
                        Decline selected
                      </button>
                    </Form>
                  ) : null}
                </>
              ) : null}
              {view === "cancelled-pickups" &&
              visibleCancelledPickupIds.length ? (
                <>
                  <div className="flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-white p-3">
                    <label className="flex items-center gap-2 text-sm font-semibold text-gray-800">
                      <input
                        ref={selectAllCancelledPickupsRef}
                        type="checkbox"
                        checked={allVisibleCancelledPickupsSelected}
                        onChange={toggleAllVisibleCancelledPickups}
                        className="size-4 rounded border-gray-300 text-red-700"
                      />
                      Select all
                    </label>
                    {selectedCancelledPickupIds.length ? (
                      <>
                        <span className="text-sm font-bold text-gray-950">
                          {selectedCancelledPickupIds.length} selected
                        </span>
                        <button
                          type="button"
                          onClick={() => setBulkPutBackOpen(true)}
                          className="rounded-lg bg-red-700 px-3 py-2 text-sm font-bold text-white hover:bg-red-800"
                        >
                          Put back selected
                        </button>
                        <button
                          type="button"
                          onClick={() => setSelectedCancelledPickupIds([])}
                          className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-gray-700 hover:border-red-300"
                        >
                          Clear
                        </button>
                      </>
                    ) : null}
                  </div>
                  <DialogPortal>
                    <Dialog
                      open={bulkPutBackOpen}
                      onClose={() => setBulkPutBackOpen(false)}
                      title={
                        <span className="text-base font-semibold text-gray-900">
                          Put selected items back?
                        </span>
                      }
                      headerClassName="items-center py-2"
                      className="w-[min(32rem,calc(100vw-2rem))]"
                    >
                      <Form method="post" className="space-y-4 px-6 pb-4 pt-1">
                        <input
                          type="hidden"
                          name="intent"
                          value="put-back-cancelled-pickup-bulk"
                        />
                        {selectedCancelledPickupIds.map((operationId) => (
                          <input
                            key={operationId}
                            type="hidden"
                            name="operationIds"
                            value={operationId}
                          />
                        ))}
                        <p className="text-sm text-gray-700">
                          Confirm that these exact items have been collected
                          from the Pickup Zone and returned to their normal
                          storage locations:
                        </p>
                        <ul className="list-disc space-y-1 pl-5 text-sm font-semibold text-gray-900">
                          {selectedCancelledPickupIds.map((operationId) => (
                            <li key={operationId}>
                              {tasks.find(
                                (task) => task.operationId === operationId
                              )?.title ?? "Prepared item"}
                            </li>
                          ))}
                        </ul>
                        {cancelledPickupBulkResult?.failed ? (
                          <div role="alert" className="text-sm text-amber-900">
                            Some items still need attention. Review the result
                            details after closing this dialog.
                          </div>
                        ) : null}
                        <div className="flex justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => setBulkPutBackOpen(false)}
                            className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-semibold text-gray-700"
                          >
                            Cancel
                          </button>
                          <button
                            type="submit"
                            className="rounded-lg bg-red-700 px-3 py-2 text-sm font-semibold text-white hover:bg-red-800"
                          >
                            Put back selected
                          </button>
                        </div>
                      </Form>
                    </Dialog>
                  </DialogPortal>
                </>
              ) : null}
              <div className="space-y-3">
                {visibleTasks.map((task) => (
                  <SelectableRow
                    key={task.id}
                    selected={
                      view === "all"
                        ? Boolean(
                            getAllSelectionEntry(task) &&
                              selectedAllRowKeys.includes(
                                getAllSelectionEntry(task)!.key
                              )
                          )
                        : Boolean(
                            (task.kind === "broken" &&
                              task.assetId &&
                              selectedBrokenAssetIds.includes(task.assetId)) ||
                              (task.kind === "general" &&
                                view === "general" &&
                                task.operationId &&
                                selectedGeneralReportIds.includes(
                                  task.operationId
                                )) ||
                              (task.operationId &&
                                ((task.kind === "to-prepare" &&
                                  selectedPreparationIds.includes(
                                    task.operationId
                                  )) ||
                                  selectedReturnIds.includes(
                                    task.operationId
                                  ) ||
                                  (task.kind === "returned-with-issues" &&
                                    selectedReturnedIssueIds.includes(
                                      task.operationId
                                    )))) ||
                              ((task.kind === "overdue" ||
                                task.kind === "ready-for-pickup") &&
                                selectedManagementIds.includes(task.id))
                          )
                    }
                    onToggle={
                      view === "all" && getAllSelectionEntry(task)
                        ? () => toggleAllSelection(getAllSelectionEntry(task)!)
                        : view !== "all" &&
                          task.kind === "broken" &&
                          task.assetId &&
                          task.returnToServiceEligible &&
                          task.physicalUnit
                        ? () => toggleBrokenAssetSelection(task.assetId!)
                        : (task.kind === "overdue" ||
                            task.kind === "ready-for-pickup") &&
                          (view === "overdue" || view === "ready-for-pickup")
                        ? () =>
                            setSelectedManagementIds((current) =>
                              toggleSelectionId(current, task.id)
                            )
                        : task.operationId &&
                          ((task.kind === "general" && view === "general") ||
                            (task.kind === "returned-with-issues" &&
                              view === "returned-with-issues") ||
                            task.kind === "to-prepare" ||
                            (task.kind === "returns" &&
                              view === "returns" &&
                              task.returnCheckEligible) ||
                            task.kind === "cancelled-pickups")
                        ? () =>
                            task.kind === "returns"
                              ? toggleReturnSelection(task.operationId!)
                              : task.kind === "general"
                              ? setSelectedGeneralReportIds((current) =>
                                  toggleSelectionId(current, task.operationId!)
                                )
                              : task.kind === "returned-with-issues"
                              ? setSelectedReturnedIssueIds((current) =>
                                  toggleSelectionId(current, task.operationId!)
                                )
                              : task.kind === "cancelled-pickups"
                              ? setSelectedCancelledPickupIds((current) =>
                                  toggleSelectionId(current, task.operationId!)
                                )
                              : togglePreparationSelection(task.operationId!)
                        : undefined
                    }
                    className={
                      view === "all" && task.kind === "ready-for-pickup"
                        ? "flex min-w-0 flex-1 flex-wrap items-center gap-3 p-3"
                        : task.kind === "to-prepare" && task.operationId
                        ? "grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 p-3 md:grid-cols-[auto_minmax(160px,1fr)_minmax(160px,1fr)_auto] md:gap-x-4 xl:grid-cols-[auto_minmax(220px,1.2fr)_minmax(200px,1.1fr)_minmax(140px,0.75fr)_minmax(112px,0.6fr)_auto] xl:gap-x-5 xl:gap-y-0"
                        : task.kind === "ready-for-pickup"
                        ? "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 p-3 md:grid-cols-[minmax(160px,1fr)_minmax(140px,0.85fr)_minmax(160px,1fr)_minmax(220px,1.2fr)_auto] md:gap-x-4"
                        : "flex flex-wrap items-center justify-between gap-3 p-3"
                    }
                  >
                    {task.kind === "cancelled-pickups" && task.operationId ? (
                      <>
                        {view === "all" ? (
                          allViewCheckbox(task)
                        ) : (
                          <input
                            type="checkbox"
                            aria-label={`Select ${task.title} to put back`}
                            checked={selectedCancelledPickupIds.includes(
                              task.operationId
                            )}
                            onChange={() =>
                              setSelectedCancelledPickupIds((current) =>
                                toggleSelectionId(current, task.operationId!)
                              )
                            }
                            className="size-4 shrink-0 rounded border-gray-300 text-red-700"
                          />
                        )}
                        {task.assetImage && task.assetId ? (
                          <Link
                            to={`/assets/${task.assetId}`}
                            aria-label={`Open asset: ${task.title}`}
                            className="size-16 shrink-0 overflow-hidden rounded-lg bg-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700"
                          >
                            <AssetImage
                              asset={task.assetImage}
                              alt=""
                              className="size-full object-cover"
                            />
                          </Link>
                        ) : null}
                        <div className="min-w-0 flex-1">
                          <h2 className="font-bold text-gray-950">
                            {task.assetId ? (
                              <Link
                                to={`/assets/${task.assetId}`}
                                className="hover:text-red-800 hover:underline"
                              >
                                {task.title}
                              </Link>
                            ) : (
                              task.title
                            )}
                          </h2>
                          <p className="mt-0.5 text-sm text-gray-700">
                            {task.detail === "Pickup expired"
                              ? "Pickup expired"
                              : `Cancelled by ${
                                  task.borrowerName ?? "Student"
                                }`}
                          </p>
                          <p className="mt-0.5 flex flex-wrap items-center gap-x-3 text-sm text-gray-600">
                            {task.locationName ? (
                              <span className="inline-flex items-center gap-1">
                                <MapPin
                                  className="size-3.5"
                                  aria-hidden="true"
                                />
                                {task.locationName}
                              </span>
                            ) : null}
                            <span>
                              {task.detail === "Pickup expired"
                                ? "Expired"
                                : "Cancelled"}{" "}
                              {formatOperationsDate(task.cancelledAt)}
                            </span>
                          </p>
                        </div>
                      </>
                    ) : task.kind === "to-prepare" && task.operationId ? (
                      <>
                        {view === "all" ? (
                          allViewCheckbox(task)
                        ) : (
                          <input
                            type="checkbox"
                            aria-label={`Select ${task.title} for bulk ready`}
                            title={
                              task.bulkReadyEligible
                                ? undefined
                                : task.preparationBlockedReason
                            }
                            checked={selectedPreparationIds.includes(
                              task.operationId
                            )}
                            onChange={() =>
                              togglePreparationSelection(task.operationId!)
                            }
                            className="col-start-1 row-start-1 size-4 shrink-0 rounded border-gray-300 text-red-700"
                          />
                        )}
                        <PreparationItemIdentity
                          task={task}
                          className="col-start-2 row-start-1 md:col-start-2 md:row-start-1 xl:col-auto xl:row-auto"
                        />
                        <p
                          className="col-start-2 row-start-2 flex min-w-0 items-center gap-2 text-sm text-gray-800 md:col-start-3 md:row-start-1 xl:col-auto xl:row-auto"
                          title={task.locationName ?? "Location not set"}
                        >
                          <MapPin
                            className="size-4 shrink-0 text-gray-500"
                            aria-hidden="true"
                          />
                          <span className="truncate">
                            {task.locationName ?? "Location not set"}
                          </span>
                        </p>
                        <p
                          className="col-start-2 row-start-3 flex min-w-0 items-center gap-2 text-sm text-gray-700 md:col-start-2 md:row-start-2 xl:col-auto xl:row-auto"
                          title={`Requested by ${
                            task.borrowerName ?? "Shelf user"
                          }`}
                        >
                          <UserRound
                            className="size-4 shrink-0 text-gray-500"
                            aria-hidden="true"
                          />
                          <span className="truncate">
                            {task.borrowerName ?? "Shelf user"}
                          </span>
                        </p>
                        <p
                          className="col-start-2 row-start-4 flex items-center gap-2 text-xs text-gray-600 md:col-start-3 md:row-start-2 xl:col-auto xl:row-auto"
                          aria-label={
                            task.preparationRequest && task.requestedPeriod
                              ? `Requested period: ${task.requestedPeriod}`
                              : `${
                                  task.preparationRequest
                                    ? "Requested"
                                    : "Prepare by"
                                }: ${
                                  task.preparationRequest
                                    ? formatOperationsDate(task.createdAt)
                                    : task.prepareBy ?? "Date unavailable"
                                }`
                          }
                          title={
                            task.preparationRequest && task.requestedPeriod
                              ? `Requested period: ${task.requestedPeriod}`
                              : `${
                                  task.preparationRequest
                                    ? "Requested"
                                    : "Prepare by"
                                }: ${
                                  task.preparationRequest
                                    ? formatOperationsDate(task.createdAt)
                                    : task.prepareBy ?? "Date unavailable"
                                }`
                          }
                        >
                          <CalendarDays
                            className="size-4 shrink-0 text-gray-500"
                            aria-hidden="true"
                          />
                          <span className="min-w-0 break-words">
                            {task.preparationRequest && task.requestedPeriod
                              ? task.requestedPeriod
                              : task.preparationRequest
                              ? formatOperationsDate(task.createdAt)
                              : task.prepareBy ?? "Date unavailable"}
                          </span>
                        </p>
                      </>
                    ) : task.kind === "ready-for-pickup" ? (
                      <>
                        {view === "all" ? (
                          allViewCheckbox(task)
                        ) : view === "ready-for-pickup" ? (
                          <input
                            type="checkbox"
                            aria-label={`Select ${task.title} pickup for management`}
                            checked={selectedManagementIds.includes(task.id)}
                            onChange={() =>
                              setSelectedManagementIds((current) =>
                                toggleSelectionId(current, task.id)
                              )
                            }
                            className="size-4 shrink-0 rounded border-gray-300 text-red-700"
                          />
                        ) : null}
                        <PreparationItemIdentity
                          task={task}
                          className="col-span-2 md:col-span-1"
                        />
                        <p className="col-span-2 flex min-w-0 items-center gap-2 text-sm text-gray-700 md:col-span-1">
                          <UserRound
                            className="size-4 shrink-0 text-gray-500"
                            aria-hidden="true"
                          />
                          <span className="truncate">
                            {task.borrowerName ?? "Student"}
                          </span>
                        </p>
                        <p
                          className="col-span-2 flex min-w-0 items-center gap-2 text-sm text-gray-700 md:col-span-1"
                          title={
                            task.locationName ?? "Pickup location unavailable"
                          }
                        >
                          <MapPin
                            className="size-4 shrink-0 text-gray-500"
                            aria-hidden="true"
                          />
                          <span className="truncate">
                            {task.locationName ?? "Pickup location unavailable"}
                          </span>
                        </p>
                        <p className="col-span-2 flex min-w-0 items-center gap-2 text-xs text-gray-600 md:col-span-1">
                          <CalendarDays
                            className="size-4 shrink-0 text-gray-500"
                            aria-hidden="true"
                          />
                          <span>
                            Ready{" "}
                            {formatOperationsDate(task.createdAt) ??
                              "Date unavailable"}
                            {task.pickupBy
                              ? ` · Pick up by ${formatOperationsDate(
                                  task.pickupBy
                                )}`
                              : " · Pickup deadline unavailable"}
                          </span>
                        </p>
                      </>
                    ) : (
                      <div
                        className={
                          task.kind === "broken" || task.kind === "general"
                            ? "grid min-w-0 flex-1 grid-cols-[auto_3rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2 lg:grid-cols-[auto_3.5rem_minmax(0,1.35fr)_minmax(0,0.9fr)] lg:gap-x-4"
                            : "flex min-w-0 flex-1 items-center gap-3"
                        }
                      >
                        {task.kind === "broken" || task.kind === "general" ? (
                          <>
                            {view === "all" ? (
                              allViewCheckbox(task)
                            ) : task.kind === "broken" &&
                              task.assetId &&
                              task.physicalUnit ? (
                              <input
                                type="checkbox"
                                aria-label={`Select ${task.title} for return to service`}
                                checked={selectedBrokenAssetIds.includes(
                                  task.assetId
                                )}
                                onChange={() =>
                                  toggleBrokenAssetSelection(task.assetId!)
                                }
                                className="size-4 shrink-0 rounded border-gray-300 text-red-700"
                              />
                            ) : task.kind === "general" &&
                              view === "general" &&
                              task.operationId ? (
                              <input
                                type="checkbox"
                                aria-label={`Select ${task.title} general report`}
                                checked={selectedGeneralReportIds.includes(
                                  task.operationId
                                )}
                                onChange={() =>
                                  setSelectedGeneralReportIds((current) =>
                                    toggleSelectionId(
                                      current,
                                      task.operationId!
                                    )
                                  )
                                }
                                className="size-4 shrink-0 rounded border-gray-300 text-red-700"
                              />
                            ) : (
                              <span aria-hidden="true" className="size-4" />
                            )}
                            {task.assetId && task.assetImage ? (
                              <Link
                                to={`/assets/${task.assetId}`}
                                aria-label={`Open unit image: ${task.title}`}
                                className="size-12 shrink-0 overflow-hidden rounded-lg bg-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700 md:size-14"
                              >
                                <AssetImage
                                  asset={task.assetImage}
                                  alt=""
                                  className="size-full object-cover"
                                />
                              </Link>
                            ) : (
                              <span className="size-12 shrink-0 rounded-lg bg-gray-100 md:size-14" />
                            )}
                            <div className="col-span-1 min-w-0 md:col-auto">
                              <h2 className="font-bold leading-snug text-gray-950 sm:text-lg">
                                {task.assetId ? (
                                  <Link
                                    to={`/assets/${task.assetId}`}
                                    className="break-words hover:text-red-800 hover:underline"
                                  >
                                    {task.title}
                                  </Link>
                                ) : (
                                  task.title
                                )}
                              </h2>
                              <p className="mt-1 break-words text-sm font-semibold text-gray-800">
                                {task.reportLabel}
                              </p>
                              {task.reporterName ? (
                                <p className="mt-1 text-sm text-gray-500">
                                  Reported by {task.reporterName}
                                </p>
                              ) : null}
                              {task.reportDescription ? (
                                <p className="mt-2 whitespace-pre-wrap break-words text-sm text-gray-700">
                                  “{task.reportDescription}”
                                </p>
                              ) : null}
                            </div>
                            <div className="col-span-3 flex min-w-0 flex-col gap-1 pl-7 lg:col-span-1 lg:pl-0">
                              {task.kind === "broken" &&
                              task.returnToServiceEligible ? (
                                <span className="w-fit rounded-full bg-red-50 px-2.5 py-1 text-xs font-semibold text-red-800">
                                  Out of service
                                </span>
                              ) : null}
                              {task.reportedLocation ? (
                                <span className="break-words text-sm text-gray-600">
                                  <span className="font-semibold text-gray-700">
                                    Reported location:
                                  </span>
                                  {task.reportedLocation}
                                </span>
                              ) : task.locationName ? (
                                <span className="break-words text-sm text-gray-600">
                                  {task.locationName}
                                </span>
                              ) : null}
                              <BrokenSectionSummary task={task} />
                              {brokenActionResult?.results
                                ?.filter(
                                  (result) =>
                                    result.assetId === task.assetId &&
                                    !result.ok
                                )
                                .map((result) => (
                                  <span
                                    key={result.assetId}
                                    role="alert"
                                    className="text-sm text-red-700"
                                  >
                                    This unit could not be returned to service.
                                  </span>
                                ))}
                            </div>
                          </>
                        ) : (task.kind === "returns" ||
                            task.kind === "returned-with-issues") &&
                          task.operationId ? (
                          <>
                            {view === "all" ? (
                              allViewCheckbox(task)
                            ) : task.kind === "returned-with-issues" &&
                              view === "returned-with-issues" ? (
                              <input
                                type="checkbox"
                                aria-label={`Select ${task.title} returned issue`}
                                checked={selectedReturnedIssueIds.includes(
                                  task.operationId
                                )}
                                onChange={() =>
                                  setSelectedReturnedIssueIds((current) =>
                                    toggleSelectionId(
                                      current,
                                      task.operationId!
                                    )
                                  )
                                }
                                className="size-4 shrink-0 rounded border-gray-300 text-red-700"
                              />
                            ) : null}
                            {view === "returns" &&
                            task.kind === "returns" &&
                            task.returnCheckEligible ? (
                              <input
                                type="checkbox"
                                aria-label={`Select ${task.title} for return check`}
                                checked={selectedReturnIds.includes(
                                  task.operationId
                                )}
                                onChange={() =>
                                  toggleReturnSelection(task.operationId!)
                                }
                                className="size-4 shrink-0 rounded border-gray-300 text-red-700"
                              />
                            ) : null}
                            {task.assetImage && task.assetId ? (
                              <Link
                                to={`/assets/${task.assetId}`}
                                aria-label={`Open asset: ${task.title}`}
                                className="size-12 shrink-0 overflow-hidden rounded-lg bg-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700"
                              >
                                <AssetImage
                                  asset={task.assetImage}
                                  alt=""
                                  className="size-full object-cover"
                                />
                              </Link>
                            ) : (
                              <span
                                aria-hidden="true"
                                className="size-12 shrink-0 rounded-lg bg-gray-100"
                              />
                            )}
                            <div className="min-w-0 flex-1">
                              <h2 className="truncate font-bold text-gray-950">
                                {task.assetId ? (
                                  <Link
                                    to={`/assets/${task.assetId}`}
                                    className="hover:text-red-800 hover:underline"
                                  >
                                    {task.quantity && task.quantity > 1
                                      ? `${task.quantity}x `
                                      : ""}
                                    {task.title}
                                  </Link>
                                ) : (
                                  <>
                                    {task.quantity && task.quantity > 1
                                      ? `${task.quantity}x `
                                      : ""}
                                    {task.title}
                                  </>
                                )}
                              </h2>
                              <p className="mt-0.5 text-sm text-gray-700">
                                {task.borrowerName ?? "Shelf user"}
                              </p>
                              <p className="text-sm text-gray-600">
                                Returned {formatOperationsDate(task.createdAt)}
                                {task.returnLocation
                                  ? ` · ${task.returnLocation}`
                                  : ""}
                              </p>
                              {task.kind === "returned-with-issues" ? (
                                <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm">
                                  <p className="font-bold text-amber-950">
                                    Returned with issue · awaiting TA review
                                  </p>
                                  <p className="mt-1 whitespace-pre-wrap text-amber-950">
                                    “{task.returnIssue}”
                                  </p>
                                </div>
                              ) : null}
                              {task.returnIssue ? (
                                task.kind === "returns" ? (
                                  <p className="mt-1 text-sm font-semibold text-amber-900">
                                    {task.returnIssue}
                                  </p>
                                ) : null
                              ) : null}
                              {returnActionResult?.ok === false &&
                              returnActionResult.operationId ===
                                task.operationId ? (
                                <p
                                  role="alert"
                                  className="mt-1 text-sm text-red-700"
                                >
                                  {returnActionResult.error}
                                </p>
                              ) : null}
                              {returnFailures
                                .filter(
                                  (result) =>
                                    result.operationId === task.operationId
                                )
                                .map((result) => (
                                  <p
                                    key={result.operationId}
                                    role="alert"
                                    className="mt-1 text-sm text-red-700"
                                  >
                                    {result.error}
                                  </p>
                                ))}
                            </div>
                          </>
                        ) : (
                          <>
                            {view === "all" ? (
                              allViewCheckbox(task)
                            ) : task.kind === "overdue" &&
                              view === "overdue" ? (
                              <input
                                type="checkbox"
                                aria-label={`Select ${task.title} loan for management`}
                                checked={selectedManagementIds.includes(
                                  task.id
                                )}
                                onChange={() =>
                                  setSelectedManagementIds((current) =>
                                    toggleSelectionId(current, task.id)
                                  )
                                }
                                className="size-4 shrink-0 rounded border-gray-300 text-red-700"
                              />
                            ) : null}
                            {task.assetImage &&
                            task.assetId &&
                            task.kind !== "returns" &&
                            task.kind !== "returned-with-issues" ? (
                              <Link
                                to={`/assets/${task.assetId}`}
                                aria-label={`Open asset: ${task.title}`}
                                className="size-12 shrink-0 overflow-hidden rounded-lg bg-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700"
                              >
                                <AssetImage
                                  asset={task.assetImage}
                                  alt=""
                                  className="size-full object-cover"
                                />
                              </Link>
                            ) : null}
                            <p className="text-xs font-bold uppercase tracking-wide text-red-700">
                              {VIEW_LABELS[task.kind]}
                            </p>
                            <h2 className="mt-1 truncate font-bold text-gray-950">
                              {task.assetId ? (
                                <Link
                                  to={`/assets/${task.assetId}`}
                                  className="hover:text-red-800 hover:underline"
                                >
                                  {task.title}
                                </Link>
                              ) : (
                                task.title
                              )}
                            </h2>
                            <p className="mt-1 text-sm text-gray-600">
                              {task.detail}
                            </p>
                          </>
                        )}
                      </div>
                    )}
                    {task.kind === "returned-with-issues" &&
                    task.operationId &&
                    task.returnIssueOperationId ? (
                      <ReturnedIssueActions task={task} />
                    ) : task.kind === "cancelled-pickups" &&
                      task.operationId ? (
                      <CancelledPickupActions task={task} />
                    ) : task.kind === "returns" &&
                      task.returnCheckEligible &&
                      task.operationId ? (
                      <ReturnTaskActions task={task} />
                    ) : (task.kind === "returns" ||
                        task.kind === "returned-with-issues") &&
                      task.operationId ? (
                      <div className="flex shrink-0 items-center gap-2">
                        <Link
                          to={task.href}
                          className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-bold text-amber-950 hover:bg-amber-100"
                        >
                          Review return
                        </Link>
                      </div>
                    ) : (task.kind === "broken" || task.kind === "general") &&
                      task.operationId ? (
                      task.kind === "broken" &&
                      task.returnToServiceEligible &&
                      task.assetId ? (
                        <BrokenReportActions task={task} />
                      ) : (
                        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                          <Form method="post">
                            <input
                              type="hidden"
                              name="intent"
                              value="resolve-report"
                            />
                            <input
                              type="hidden"
                              name="operationId"
                              value={task.operationId}
                            />
                            <button
                              type="submit"
                              className="rounded-lg bg-red-700 px-3 py-2 text-sm font-bold text-white hover:bg-red-800"
                            >
                              Resolve report
                            </button>
                          </Form>
                        </div>
                      )
                    ) : task.kind === "to-prepare" && task.operationId ? (
                      <PreparationTaskActions
                        task={task}
                        className="col-start-2 row-start-5 justify-self-end md:col-start-4 md:row-span-2 md:row-start-1 xl:col-start-6 xl:row-span-1 xl:row-start-1"
                      />
                    ) : task.kind === "ready-for-pickup" ? (
                      <ReadyPickupActions task={task} />
                    ) : (
                      <Link
                        to={task.href}
                        className="shrink-0 rounded-xl border border-gray-300 px-3 py-2 text-sm font-bold text-gray-700 hover:border-red-300 hover:text-red-800"
                      >
                        {task.actionLabel}
                      </Link>
                    )}
                  </SelectableRow>
                ))}
              </div>
            </>
          ) : (
            <div className="rounded-2xl border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-600">
              {view === "cancelled-pickups"
                ? "No cancelled pickups need to be put back."
                : view === "ready-for-pickup"
                ? "No items are currently ready for pickup."
                : view === "returned-with-issues"
                ? "No returned items have reported issues."
                : "No items need attention."}
            </div>
          )}
        </div>
      </ListContentWrapper>
    </>
  );
}
