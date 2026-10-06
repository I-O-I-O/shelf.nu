import { randomUUID } from "node:crypto";
import {
  AssetType,
  BookingStatus,
  ConsumptionCategory,
  type AssetReturnHandling,
} from "@prisma/client";
import type { LoaderFunctionArgs } from "react-router";
import { db } from "~/database/db.server";
import { partialCheckinBooking } from "~/modules/booking/service.server";
import { getClientHint } from "~/utils/client-hints";
import { isLikeShelfError, ShelfError } from "~/utils/error";
import { Logger } from "~/utils/logger";
import {
  enforceIoioReturnRateLimit,
  IOIO_RETURN_OPERATION,
} from "./rate-limit.server";
import {
  createBorrowedItemProblemReport,
  prepareReportProblem,
  sanitizeReportText,
  type IoioReportType,
  type PreparedReportProposal,
} from "./report-problem.server";
import { requiresStaffReturnCheck } from "./return-destination";
import {
  returnProposalSchema,
  type ReturnProposalDraft,
  getStudentReturnIssueComment,
} from "./return-item.shared";
import { requireStudentRead, type IoioAuthSnapshot } from "./route.server";

type Context = Pick<LoaderFunctionArgs, "context" | "request"> & {
  /** Snapshot the authenticated actor for the whole return request. */
  auth?: IoioAuthSnapshot;
};
type ReturnOperationStatus =
  | "PREPARED"
  | "SUBMITTED"
  | "PROCESSING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED";

const RETURN_PROPOSAL_TTL_MS = 10 * 60 * 1000;

async function getIoioAuth({ context, request, auth }: Context) {
  return auth ?? (await requireStudentRead({ context, request }));
}

export type PreparedReturnProposal = {
  confirmationToken: string;
  operationId: string;
  booking: {
    id: string;
    status: BookingStatus;
  };
  bookingAssetId: string;
  asset: {
    id: string;
    title: string;
    type: AssetType;
  };
  borrowedQuantity: number;
  heldQuantity: number;
  quantity: number;
  remainingQuantity: number;
  custodyState: string;
  returnLocation: string | null;
  restriction: string | null;
};

function returnError(
  message: string,
  status: 400 | 403 | 404 | 409 | 429 = 400
) {
  return new ShelfError({
    cause: null,
    message,
    label: "Booking",
    status,
    shouldBeCaptured: false,
  });
}

function assertReturnRole(role: string) {
  if (!(role === "SELF_SERVICE" || role === "ADMIN" || role === "OWNER")) {
    throw returnError(
      "Your Shelf role is not allowed to return IOIO items.",
      403
    );
  }
}

function assertOperationStatus(
  status: string
): asserts status is ReturnOperationStatus {
  if (
    ![
      "PREPARED",
      "SUBMITTED",
      "PROCESSING",
      "SUCCEEDED",
      "FAILED",
      "CANCELLED",
    ].includes(status)
  ) {
    throw returnError("This return operation has an invalid state.", 409);
  }
}

function operationExpired(createdAt: Date) {
  return Date.now() - createdAt.getTime() > RETURN_PROPOSAL_TTL_MS;
}

function assertConfirmationMatches(
  operation: { quantity: number | null },
  quantity: number
) {
  const parsedQuantity = Number(quantity);
  if (
    !Number.isInteger(parsedQuantity) ||
    parsedQuantity < 1 ||
    operation.quantity !== parsedQuantity
  ) {
    throw returnError(
      "The confirmation no longer matches the reviewed return proposal.",
      409
    );
  }
}

async function studentTeamMemberIds(userId: string, organizationId: string) {
  const members = await db.teamMember.findMany({
    where: { userId, organizationId, deletedAt: null },
    select: { id: true },
  });
  return members.map(({ id }) => id);
}

type ReturnTarget = {
  booking: {
    id: string;
    status: BookingStatus;
    from: Date;
    to: Date;
  };
  bookingAsset: {
    id: string;
    assetId: string;
    quantity: number;
    sourceKitId: string | null;
    checkedOutAt: Date | null;
    checkedInAt: Date | null;
    asset: {
      id: string;
      title: string;
      type: AssetType;
      returnHandling: AssetReturnHandling;
      assetLocations: Array<{ location: { id: string; name: string } }>;
    };
  };
  heldQuantity: number;
  custodyState: string;
};

function normalizeLocationName(name: string) {
  return name
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

async function getReturnLocationId({
  organizationId,
  hasProblem,
}: {
  organizationId: string;
  hasProblem: boolean;
}) {
  const locations = await db.location.findMany({
    where: { organizationId },
    select: { id: true, name: true },
  });
  const acceptedNames = new Set(
    (hasProblem
      ? [
          "Problem / Broken Zone",
          "Broken Zone",
          "Problem / Repair Zone",
          "Problem Zone",
          "Repair Zone",
        ]
      : ["Kit Return Zone", "IOIO Return Zone", "Return Zone"]
    ).map(normalizeLocationName)
  );
  return (
    locations.find(({ name }) => acceptedNames.has(normalizeLocationName(name)))
      ?.id ?? null
  );
}

async function loadReturnTarget({
  organizationId,
  userId,
  bookingId,
  bookingAssetId,
  assetId,
}: {
  organizationId: string;
  userId: string;
  bookingId: string;
  bookingAssetId: string;
  assetId: string;
}): Promise<ReturnTarget> {
  const teamMemberIds = await studentTeamMemberIds(userId, organizationId);
  const booking = await db.booking.findFirst({
    where: {
      id: bookingId,
      organizationId,
      status: { in: [BookingStatus.ONGOING, BookingStatus.OVERDUE] },
      OR: [
        { custodianUserId: userId },
        { custodianTeamMemberId: { in: teamMemberIds } },
      ],
    },
    select: {
      id: true,
      status: true,
      from: true,
      to: true,
      bookingAssets: {
        where: { id: bookingAssetId, assetId },
        select: {
          id: true,
          assetId: true,
          quantity: true,
          sourceKitId: true,
          checkedOutAt: true,
          checkedInAt: true,
          asset: {
            select: {
              id: true,
              title: true,
              type: true,
              returnHandling: true,
              assetLocations: {
                select: { location: { select: { id: true, name: true } } },
                take: 1,
              },
            },
          },
        },
      },
    },
  });

  const bookingAsset = booking?.bookingAssets[0];
  if (!booking || !bookingAsset) {
    if (process.env.NODE_ENV !== "production") {
      const [candidateBooking, candidateBookingAsset] = await Promise.all([
        db.booking.findFirst({
          where: { id: bookingId, organizationId },
          select: {
            status: true,
            custodianUserId: true,
            custodianTeamMemberId: true,
          },
        }),
        db.bookingAsset.findFirst({
          where: { id: bookingAssetId, bookingId },
          select: {
            assetId: true,
            checkedOutAt: true,
            checkedInAt: true,
          },
        }),
      ]);
      const custodianTeamMemberId = candidateBooking?.custodianTeamMemberId;
      console.error("[IOIO RETURN TARGET MISMATCH]", {
        bookingFoundInOrganization: Boolean(candidateBooking),
        bookingStatus: candidateBooking?.status ?? null,
        bookingIsActive: Boolean(
          candidateBooking &&
            [BookingStatus.ONGOING, BookingStatus.OVERDUE].includes(
              candidateBooking.status
            )
        ),
        custodianIsCurrentUser:
          candidateBooking?.custodianUserId === userId,
        custodianIsCurrentTeamMember: Boolean(
          custodianTeamMemberId && teamMemberIds.includes(custodianTeamMemberId)
        ),
        bookingAssetFoundOnBooking: Boolean(candidateBookingAsset),
        assetMatchesSubmittedAsset:
          candidateBookingAsset?.assetId === assetId,
        checkedOut: Boolean(candidateBookingAsset?.checkedOutAt),
        alreadyCheckedIn: Boolean(candidateBookingAsset?.checkedInAt),
      });
    }
    throw returnError(
      "That Shelf booking or asset is not an active loan belonging to you.",
      403
    );
  }
  if (!bookingAsset.checkedOutAt) {
    throw returnError(
      "This Shelf asset was not checked out on that booking.",
      409
    );
  }
  if (bookingAsset.checkedInAt) {
    throw returnError("This Shelf asset has already been fully returned.", 409);
  }

  const logs = await db.consumptionLog.findMany({
    where: {
      bookingId,
      assetId,
      category: {
        in: [
          ConsumptionCategory.RETURN,
          ConsumptionCategory.CONSUME,
          ConsumptionCategory.LOSS,
          ConsumptionCategory.DAMAGE,
        ],
      },
      OR: [{ bookingAssetId }, { bookingAssetId: null }],
    },
    select: { quantity: true, bookingAssetId: true },
  });

  // A NULL-tagged historical log cannot be safely attributed when the same
  // asset has several booking slices. IOIO does not create kit slices, but
  // rejecting an ambiguous record is safer than allowing an over-return.
  const hasAmbiguousLegacyLogs =
    logs.some((log) => log.bookingAssetId === null) &&
    (await db.bookingAsset.count({ where: { bookingId, assetId } })) > 1;
  if (hasAmbiguousLegacyLogs) {
    throw returnError(
      "This Shelf booking has ambiguous quantity history; ask staff to review it.",
      409
    );
  }

  const alreadyReconciled = logs.reduce(
    (total, log) => total + log.quantity,
    0
  );
  const heldQuantity = Math.max(0, bookingAsset.quantity - alreadyReconciled);
  if (heldQuantity < 1) {
    throw returnError("This Shelf asset has already been fully returned.", 409);
  }

  const custody = await db.custody.aggregate({
    where: {
      assetId,
      teamMemberId: { in: teamMemberIds },
      kitCustodyId: null,
    },
    _sum: { quantity: true },
  });
  const custodyQuantity = custody._sum.quantity ?? 0;
  return {
    booking,
    bookingAsset,
    heldQuantity,
    custodyState:
      custodyQuantity > 0
        ? `CHECKED_OUT / CUSTODY ${custodyQuantity}`
        : "CHECKED_OUT",
  };
}

/** Complete a submitted Return Zone request after Staff has checked it. */
export async function completeSubmittedReturn(
  { operationId }: { operationId: string },
  { context, request, auth: providedAuth }: Context
) {
  const auth = await getIoioAuth({ context, request, auth: providedAuth });
  if (auth.role !== "ADMIN" && auth.role !== "OWNER") {
    throw returnError("Only Staff can complete a return check.", 403);
  }
  const operation = await db.ioioWriteOperation.findFirst({
    where: {
      id: operationId,
      organizationId: auth.organizationId,
      operationType: IOIO_RETURN_OPERATION,
      status: "SUBMITTED",
    },
    select: {
      id: true,
      userId: true,
      bookingId: true,
      bookingAssetId: true,
      assetId: true,
      quantity: true,
      reportType: true,
    },
  });
  if (
    !operation ||
    !operation.bookingId ||
    !operation.bookingAssetId ||
    !operation.assetId ||
    !operation.quantity
  ) {
    throw returnError("This return check is no longer available.", 409);
  }

  const target = await loadReturnTarget({
    organizationId: auth.organizationId,
    userId: operation.userId,
    bookingId: operation.bookingId,
    bookingAssetId: operation.bookingAssetId,
    assetId: operation.assetId,
  });
  if (operation.quantity > target.heldQuantity) {
    throw returnError("The requested return quantity is no longer held.", 409);
  }

  const result = await partialCheckinBooking({
    id: target.booking.id,
    organizationId: auth.organizationId,
    assetIds:
      target.bookingAsset.asset.type === AssetType.INDIVIDUAL
        ? [target.bookingAsset.asset.id]
        : undefined,
    checkins:
      target.bookingAsset.asset.type === AssetType.QUANTITY_TRACKED
        ? [
            {
              assetId: target.bookingAsset.asset.id,
              bookingAssetId: target.bookingAsset.id,
              returned: operation.quantity,
            },
          ]
        : undefined,
    userId: auth.userId,
    hints: getClientHint(request),
  });
  await db.ioioWriteOperation.updateMany({
    where: {
      id: operation.id,
      organizationId: auth.organizationId,
      status: "SUBMITTED",
    },
    data: {
      status: "SUCCEEDED",
      completedAt: new Date(),
      bookingId: result.booking.id,
    },
  });
  if (operation.reportType !== IOIO_RETURN_OPERATION) {
    await db.ioioWriteOperation.updateMany({
      where: {
        organizationId: auth.organizationId,
        operationType: "REPORT_PROBLEM",
        source: "IOIO_STUDENT_RETURN",
        bookingAssetId: operation.bookingAssetId,
        status: "SUCCEEDED",
      },
      data: { status: "RESOLVED", completedAt: new Date() },
    });
  }
  return {
    ok: true as const,
    status: "checked" as const,
    bookingId: result.booking.id,
    assetTitle: target.bookingAsset.asset.title,
  };
}

function buildProposal(
  operation: { id: string },
  token: string,
  target: ReturnTarget,
  quantity: number
): PreparedReturnProposal {
  return {
    confirmationToken: token,
    operationId: operation.id,
    booking: {
      id: target.booking.id,
      status: target.booking.status,
    },
    bookingAssetId: target.bookingAsset.id,
    asset: {
      id: target.bookingAsset.asset.id,
      title: target.bookingAsset.asset.title,
      type: target.bookingAsset.asset.type,
    },
    borrowedQuantity: target.bookingAsset.quantity,
    heldQuantity: target.heldQuantity,
    quantity,
    remainingQuantity: Math.max(0, target.heldQuantity - quantity),
    custodyState: target.custodyState,
    returnLocation:
      target.bookingAsset.asset.assetLocations[0]?.location.name ?? null,
    restriction: null,
  };
}

export async function prepareReturnItem(
  draft: ReturnProposalDraft,
  { context, request, auth: providedAuth }: Context,
  intent: {
    issueState?: "ok" | "problem";
    reportType?: string;
    issueComment?: string;
  } = {}
): Promise<PreparedReturnProposal> {
  const auth = await getIoioAuth({ context, request, auth: providedAuth });
  assertReturnRole(auth.role);
  const parsed = returnProposalSchema.parse(draft);
  const target = await loadReturnTarget({
    organizationId: auth.organizationId,
    userId: auth.userId,
    bookingId: parsed.booking_id,
    bookingAssetId: parsed.booking_asset_id,
    assetId: parsed.asset_id,
  });

  if (
    target.bookingAsset.asset.type === AssetType.INDIVIDUAL &&
    parsed.quantity !== 1
  ) {
    throw returnError(
      "An individual Shelf asset can only be returned as 1 unit."
    );
  }
  if (parsed.quantity > target.heldQuantity) {
    throw returnError(
      `You currently hold only ${target.heldQuantity} unit${
        target.heldQuantity === 1 ? "" : "s"
      } of this Shelf asset.`,
      409
    );
  }

  const confirmationToken = randomUUID();
  const hasProblem =
    intent.issueState === "problem" && Boolean(intent.reportType);
  const locationId =
    hasProblem ||
    target.bookingAsset.asset.returnHandling === "RETURN_TO_RETURN_ZONE"
      ? await getReturnLocationId({
          organizationId: auth.organizationId,
          hasProblem,
        })
      : target.bookingAsset.asset.assetLocations[0]?.location.id ?? null;
  const issueComment = intent.issueComment?.trim()
    ? sanitizeReportText(intent.issueComment.trim())
    : "No additional details provided.";
  const operation = await db.ioioWriteOperation.create({
    data: {
      operationType: IOIO_RETURN_OPERATION,
      status: "PREPARED",
      idempotencyKey: confirmationToken,
      userId: auth.userId,
      organizationId: auth.organizationId,
      reportType:
        hasProblem && intent.reportType
          ? intent.reportType
          : IOIO_RETURN_OPERATION,
      description: hasProblem
        ? `Issue reported: ${intent.reportType}. ${issueComment}`
        : `Return proposal for Shelf asset ${parsed.asset_id}`,
      assetId: parsed.asset_id,
      locationId,
      quantity: parsed.quantity,
      bookingId: parsed.booking_id,
      bookingAssetId: parsed.booking_asset_id,
      from: target.booking.from,
      to: target.booking.to,
    },
    select: { id: true },
  });

  return buildProposal(operation, confirmationToken, target, parsed.quantity);
}

/**
 * Finalize a student's confirmed return. Standalone successful returns use
 * the native Shelf check-in immediately; Kit and problem returns are placed
 * in the Staff review queue without changing availability.
 */
export async function submitReturnItem(
  {
    confirmationToken,
    quantity,
    comment,
  }: { confirmationToken: string; quantity: number; comment?: string },
  { context, request, auth: providedAuth }: Context
) {
  const auth = await getIoioAuth({ context, request, auth: providedAuth });
  assertReturnRole(auth.role);
  const operation = await db.ioioWriteOperation.findUnique({
    where: { idempotencyKey: confirmationToken },
    select: {
      id: true,
      userId: true,
      organizationId: true,
      operationType: true,
      reportType: true,
      description: true,
      locationId: true,
      status: true,
      bookingId: true,
      bookingAssetId: true,
      assetId: true,
      quantity: true,
      createdAt: true,
    },
  });
  if (!operation || operation.operationType !== IOIO_RETURN_OPERATION) {
    throw returnError(
      "This return proposal has expired or was cancelled.",
      404
    );
  }
  if (
    operation.userId !== auth.userId ||
    operation.organizationId !== auth.organizationId
  ) {
    throw returnError(
      "This return proposal is not available to this user.",
      403
    );
  }
  assertConfirmationMatches(operation, quantity);
  assertOperationStatus(operation.status);
  if (operation.status === "SUCCEEDED") {
    return {
      ok: true as const,
      status: "completed" as const,
      bookingId: operation.bookingId ?? undefined,
    };
  }
  if (operation.status === "SUBMITTED") {
    if (operation.reportType !== IOIO_RETURN_OPERATION) {
      await ensureReturnProblemReport(operation, auth, { context, request });
    }
    return {
      ok: true as const,
      status: "submitted" as const,
      bookingId: operation.bookingId ?? undefined,
    };
  }
  if (operation.status !== "PREPARED") {
    throw returnError("This return proposal cannot be submitted.", 409);
  }
  if (operationExpired(operation.createdAt)) {
    await db.ioioWriteOperation.updateMany({
      where: {
        id: operation.id,
        organizationId: auth.organizationId,
        status: "PREPARED",
      },
      data: { status: "CANCELLED", completedAt: new Date() },
    });
    throw returnError("This return proposal has expired.", 404);
  }
  if (!operation.bookingId || !operation.bookingAssetId || !operation.assetId) {
    throw returnError(
      "This return proposal has incomplete Shelf references.",
      409
    );
  }
  const target = await loadReturnTarget({
    organizationId: auth.organizationId,
    userId: auth.userId,
    bookingId: operation.bookingId,
    bookingAssetId: operation.bookingAssetId,
    assetId: operation.assetId,
  });
  const requiresStaffCheck = requiresStaffReturnCheck({
    hasProblem: operation.reportType !== IOIO_RETURN_OPERATION,
    returnHandling: target.bookingAsset.asset.returnHandling,
  });
  if (!requiresStaffCheck) {
    const result = await returnItem(
      { confirmationToken, quantity },
      { context, request, auth }
    );
    return {
      ok: true as const,
      status: "completed" as const,
      bookingId: result.bookingId,
    };
  }
  const claimed = await db.ioioWriteOperation.updateMany({
    where: {
      id: operation.id,
      organizationId: auth.organizationId,
      userId: auth.userId,
      operationType: IOIO_RETURN_OPERATION,
      status: "PREPARED",
    },
    data: {
      status: "SUBMITTED",
      description: `Return submitted. ${
        operation.reportType !== IOIO_RETURN_OPERATION
          ? operation.description
          : comment?.trim()
          ? sanitizeReportText(comment)
          : "Waiting for staff check."
      }`,
      locationId: operation.locationId,
    },
  });
  if (!claimed.count) {
    throw returnError(
      "This return proposal changed. Please refresh and try again.",
      409
    );
  }
  if (operation.reportType !== IOIO_RETURN_OPERATION) {
    await ensureReturnProblemReport(operation, auth, { context, request });
  }
  return {
    ok: true as const,
    status: "submitted" as const,
    bookingId: operation.bookingId ?? undefined,
  };
}

async function ensureReturnProblemReport(
  operation: {
    id: string;
    reportType: string;
    description: string;
    bookingId: string | null;
    bookingAssetId: string | null;
    assetId: string | null;
  },
  auth: IoioAuthSnapshot,
  { context, request }: Context
) {
  if (!operation.bookingId || !operation.bookingAssetId || !operation.assetId) {
    throw returnError(
      "This issue return has incomplete Shelf references.",
      409
    );
  }

  const report = await createBorrowedItemProblemReport(
    {
      bookingId: operation.bookingId,
      bookingAssetId: operation.bookingAssetId,
      assetId: operation.assetId,
      reportType: operation.reportType as IoioReportType,
      description:
        getStudentReturnIssueComment(operation.description) ??
        "No additional details provided.",
    },
    { context, request, auth },
    { source: "IOIO_STUDENT_RETURN", auth }
  );

  await db.ioioWriteOperation.updateMany({
    where: {
      id: operation.id,
      organizationId: auth.organizationId,
      operationType: IOIO_RETURN_OPERATION,
      status: "SUBMITTED",
    },
    data: { resultReportId: report.reportId },
  });
}

async function findNativeReturnEffect({
  operation,
  organizationId,
}: {
  operation: {
    bookingId: string | null;
    bookingAssetId: string | null;
    assetId: string | null;
    quantity: number | null;
    createdAt: Date;
  };
  organizationId: string;
}) {
  if (!operation.bookingId || !operation.bookingAssetId || !operation.assetId) {
    return false;
  }
  const bookingAsset = await db.bookingAsset.findFirst({
    where: {
      id: operation.bookingAssetId,
      bookingId: operation.bookingId,
      assetId: operation.assetId,
      booking: { organizationId },
    },
    select: { checkedInAt: true },
  });
  if (!bookingAsset) return false;
  if (bookingAsset.checkedInAt) return true;

  const returned = await db.consumptionLog.aggregate({
    where: {
      bookingId: operation.bookingId,
      bookingAssetId: operation.bookingAssetId,
      assetId: operation.assetId,
      category: ConsumptionCategory.RETURN,
      createdAt: { gte: operation.createdAt },
    },
    _sum: { quantity: true },
  });
  return (returned._sum.quantity ?? 0) >= (operation.quantity ?? 0);
}

async function completeOperation({
  operationId,
  organizationId,
  bookingId,
}: {
  operationId: string;
  organizationId: string;
  bookingId: string;
}) {
  await db.ioioWriteOperation.updateMany({
    where: {
      id: operationId,
      organizationId,
      operationType: IOIO_RETURN_OPERATION,
      status: "PROCESSING",
    },
    data: {
      status: "SUCCEEDED",
      bookingId,
      completedAt: new Date(),
      failureCode: null,
    },
  });
}

export async function cancelReturnItem(
  token: string,
  { context, request, auth: providedAuth }: Context
) {
  const auth = await getIoioAuth({ context, request, auth: providedAuth });
  assertReturnRole(auth.role);
  const operation = await db.ioioWriteOperation.findUnique({
    where: { idempotencyKey: token },
    select: {
      userId: true,
      organizationId: true,
      operationType: true,
      status: true,
      createdAt: true,
      bookingId: true,
    },
  });
  if (!operation || operation.operationType !== IOIO_RETURN_OPERATION) {
    throw returnError("This return proposal has expired.", 404);
  }
  if (
    operation.userId !== auth.userId ||
    operation.organizationId !== auth.organizationId
  ) {
    throw returnError(
      "This return proposal is not available to this user.",
      403
    );
  }
  assertOperationStatus(operation.status);
  if (operation.status === "SUCCEEDED") {
    return {
      ok: true as const,
      status: "duplicate" as const,
      bookingId: operation.bookingId ?? undefined,
    };
  }
  if (operation.status !== "PREPARED") {
    throw returnError("This return operation cannot be cancelled.", 409);
  }
  if (operationExpired(operation.createdAt)) {
    await db.ioioWriteOperation.updateMany({
      where: {
        idempotencyKey: token,
        organizationId: auth.organizationId,
        status: "PREPARED",
      },
      data: { status: "CANCELLED", completedAt: new Date() },
    });
    throw returnError("This return proposal has expired.", 404);
  }
  await db.ioioWriteOperation.updateMany({
    where: {
      idempotencyKey: token,
      organizationId: auth.organizationId,
      status: "PREPARED",
    },
    data: { status: "CANCELLED", completedAt: new Date() },
  });
  return { ok: true as const, status: "cancelled" as const };
}

export async function prepareReturnProblemReport(
  token: string,
  { context, request, auth: providedAuth }: Context
): Promise<PreparedReportProposal> {
  const auth = await getIoioAuth({ context, request, auth: providedAuth });
  assertReturnRole(auth.role);
  const operation = await db.ioioWriteOperation.findUnique({
    where: { idempotencyKey: token },
    select: {
      userId: true,
      organizationId: true,
      operationType: true,
      status: true,
      assetId: true,
      createdAt: true,
    },
  });
  if (
    !operation ||
    operation.operationType !== IOIO_RETURN_OPERATION ||
    operation.status !== "PREPARED"
  ) {
    throw returnError("This return proposal is no longer available.", 409);
  }
  if (operationExpired(operation.createdAt)) {
    throw returnError("This return proposal has expired.", 404);
  }
  if (
    operation.userId !== auth.userId ||
    operation.organizationId !== auth.organizationId
  ) {
    throw returnError(
      "This return proposal is not available to this user.",
      403
    );
  }
  return prepareReportProblem(
    {
      report_type: "OTHER",
      description:
        "I cannot complete this return at the expected location. Staff follow-up is required before the item is marked returned.",
      asset_id: operation.assetId,
      kit_id: null,
      location_id: null,
    },
    { context, request, auth }
  );
}

export async function returnItem(
  {
    confirmationToken,
    quantity,
  }: { confirmationToken: string; quantity: number },
  { context, request, auth: providedAuth }: Context
) {
  const startedAt = Date.now();
  const auth = await getIoioAuth({ context, request, auth: providedAuth });
  assertReturnRole(auth.role);
  const operation = await db.ioioWriteOperation.findUnique({
    where: { idempotencyKey: confirmationToken },
    select: {
      id: true,
      userId: true,
      organizationId: true,
      operationType: true,
      status: true,
      bookingId: true,
      bookingAssetId: true,
      assetId: true,
      quantity: true,
      createdAt: true,
    },
  });
  if (!operation || operation.operationType !== IOIO_RETURN_OPERATION) {
    throw returnError(
      "This return proposal has expired or was cancelled.",
      404
    );
  }
  if (
    operation.userId !== auth.userId ||
    operation.organizationId !== auth.organizationId
  ) {
    Logger.warn({
      event: "ioio_assistant_return_item",
      operationType: IOIO_RETURN_OPERATION,
      operationId: operation.id,
      organizationId: auth.organizationId,
      outcome: "cross_org_or_user_rejected",
      durationMs: Date.now() - startedAt,
    });
    throw returnError(
      "This return proposal is not available to this user.",
      403
    );
  }
  assertConfirmationMatches(operation, quantity);
  assertOperationStatus(operation.status);

  if (operation.status === "SUCCEEDED") {
    return {
      ok: true as const,
      status: "duplicate" as const,
      bookingId: operation.bookingId ?? undefined,
      returnedQuantity: operation.quantity ?? undefined,
    };
  }
  if (
    operation.status === "PREPARED" &&
    operationExpired(operation.createdAt)
  ) {
    await db.ioioWriteOperation.updateMany({
      where: {
        id: operation.id,
        organizationId: auth.organizationId,
        status: "PREPARED",
      },
      data: { status: "CANCELLED", completedAt: new Date() },
    });
    throw returnError(
      "This return proposal has expired or was cancelled.",
      404
    );
  }
  if (operation.status === "CANCELLED" || operation.status === "FAILED") {
    throw returnError(
      "This return operation is not ready for submission.",
      409
    );
  }

  if (operation.status === "PROCESSING") {
    if (
      await findNativeReturnEffect({
        operation,
        organizationId: auth.organizationId,
      })
    ) {
      if (!operation.bookingId)
        throw returnError("Return result is incomplete.", 409);
      await completeOperation({
        operationId: operation.id,
        organizationId: auth.organizationId,
        bookingId: operation.bookingId,
      });
      return {
        ok: true as const,
        status: "duplicate" as const,
        bookingId: operation.bookingId,
        returnedQuantity: operation.quantity ?? undefined,
      };
    }
    throw returnError(
      "This return is still being processed. Please retry shortly.",
      409
    );
  }

  await enforceIoioReturnRateLimit({
    userId: auth.userId,
    organizationId: auth.organizationId,
  });
  const claimed = await db.ioioWriteOperation.updateMany({
    where: {
      id: operation.id,
      idempotencyKey: confirmationToken,
      userId: auth.userId,
      organizationId: auth.organizationId,
      operationType: IOIO_RETURN_OPERATION,
      status: "PREPARED",
      createdAt: { gt: new Date(Date.now() - RETURN_PROPOSAL_TTL_MS) },
    },
    data: { status: "PROCESSING", failureCode: null },
  });
  if (claimed.count === 0) {
    const current = await db.ioioWriteOperation.findUnique({
      where: { idempotencyKey: confirmationToken },
      select: { status: true, bookingId: true, quantity: true },
    });
    if (current?.status === "SUCCEEDED") {
      return {
        ok: true as const,
        status: "duplicate" as const,
        bookingId: current.bookingId ?? undefined,
        returnedQuantity: current.quantity ?? undefined,
      };
    }
    throw returnError("This return operation is already being processed.", 409);
  }

  try {
    if (
      !operation.bookingId ||
      !operation.bookingAssetId ||
      !operation.assetId
    ) {
      throw returnError(
        "The return proposal has incomplete Shelf references.",
        409
      );
    }
    const target = await loadReturnTarget({
      organizationId: auth.organizationId,
      userId: auth.userId,
      bookingId: operation.bookingId,
      bookingAssetId: operation.bookingAssetId,
      assetId: operation.assetId,
    });
    if ((operation.quantity ?? 0) > target.heldQuantity) {
      throw returnError(
        "The requested return quantity is no longer held by your Shelf loan.",
        409
      );
    }

    const result = await partialCheckinBooking({
      id: target.booking.id,
      organizationId: auth.organizationId,
      assetIds:
        target.bookingAsset.asset.type === AssetType.INDIVIDUAL
          ? [target.bookingAsset.asset.id]
          : undefined,
      checkins:
        target.bookingAsset.asset.type === AssetType.QUANTITY_TRACKED
          ? [
              {
                assetId: target.bookingAsset.asset.id,
                bookingAssetId: target.bookingAsset.id,
                returned: operation.quantity ?? 0,
              },
            ]
          : undefined,
      userId: auth.userId,
      hints: getClientHint(request),
    });
    await completeOperation({
      operationId: operation.id,
      organizationId: auth.organizationId,
      bookingId: result.booking.id,
    });
    Logger.info({
      event: "ioio_assistant_return_item",
      operationType: IOIO_RETURN_OPERATION,
      operationId: operation.id,
      organizationId: auth.organizationId,
      bookingId: result.booking.id,
      bookingAssetId: target.bookingAsset.id,
      assetId: target.bookingAsset.asset.id,
      quantity: operation.quantity,
      outcome: "success",
      durationMs: Date.now() - startedAt,
    });
    return {
      ok: true as const,
      status: "submitted" as const,
      bookingId: result.booking.id,
      returnedQuantity: operation.quantity ?? undefined,
      remainingQuantity: Math.max(
        0,
        target.heldQuantity - (operation.quantity ?? 0)
      ),
      assetTitle: target.bookingAsset.asset.title,
      isComplete: result.isComplete,
    };
  } catch (cause) {
    // If the native check-in committed but the operation finalization failed,
    // retain PROCESSING so a retry can observe the authoritative native effect
    // and complete the same operation instead of attempting a second return.
    const nativeEffect = await findNativeReturnEffect({
      operation,
      organizationId: auth.organizationId,
    });
    if (!nativeEffect) {
      await db.ioioWriteOperation.updateMany({
        where: {
          id: operation.id,
          organizationId: auth.organizationId,
          operationType: IOIO_RETURN_OPERATION,
          status: "PROCESSING",
        },
        data: {
          status: "PREPARED",
          failureCode: cause instanceof Error ? cause.name : "RETURN_FAILED",
        },
      });
    }
    Logger.warn({
      event: "ioio_assistant_return_item",
      operationType: IOIO_RETURN_OPERATION,
      operationId: operation.id,
      organizationId: auth.organizationId,
      bookingId: operation.bookingId,
      outcome: "failure",
      durationMs: Date.now() - startedAt,
      error: cause instanceof Error ? cause.name : "UnknownError",
    });
    if (cause instanceof ShelfError || isLikeShelfError(cause)) throw cause;
    throw returnError(
      "Something went wrong while returning the Shelf asset.",
      409
    );
  }
}
