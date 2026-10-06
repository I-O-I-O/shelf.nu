import { randomUUID } from "node:crypto";
import type { LoaderFunctionArgs } from "react-router";
import { db } from "~/database/db.server";
import { resolveAssetImagesForPresentation } from "~/modules/asset/service.server";
import { getIoioKitDisplayName } from "~/modules/kit/ioio-kit-presentation";
import { refreshExpiredKitImages } from "~/modules/kit/service.server";
import { createReport } from "~/modules/report-found/service.server";
import { ShelfError } from "~/utils/error";
import { Logger } from "~/utils/logger";
import {
  enforceIoioReportRateLimit,
  IOIO_REPORT_OPERATION,
} from "./rate-limit.server";
import {
  ioioReportTypeSchema,
  reportProposalSchema,
  sanitizeReportText,
  type IoioReportType,
  type ReportProposalDraft,
} from "./report-problem.shared";
import { requireStudentRead, type IoioAuthSnapshot } from "./route.server";
export {
  IOIO_REPORT_TYPES,
  ioioReportTypeSchema,
  reportProposalSchema,
  sanitizeReportText,
} from "./report-problem.shared";
export type {
  IoioReportType,
  ReportProposalDraft,
} from "./report-problem.shared";

export type PreparedReportProposal = {
  confirmationToken: string;
  reportType: IoioReportType;
  description: string;
  asset: { id: string; title: string | null } | null;
  kit: { id: string; name: string | null } | null;
  location: { id: string; name: string | null } | null;
};

export type BorrowedItemProblemContext = {
  bookingId: string;
  bookingAssetId: string;
  assetId: string;
  itemName: string;
  unitLabel: string | null;
  isKit: boolean;
  image: {
    mainImage: string | null;
    thumbnailImage: string | null;
    assetModel: { image: string | null; thumbnailImage: string | null } | null;
    kitImage: string | null;
  };
  quantity: number;
  borrowedAt: Date;
  dueAt: Date | null;
};

type Context = Pick<LoaderFunctionArgs, "context" | "request"> & {
  /** Optional auth snapshot shared by a single multi-step return request. */
  auth?: IoioAuthSnapshot;
};
type OperationStatus =
  | "PREPARED"
  | "PROCESSING"
  | "SUCCEEDED"
  | "RESOLVED"
  | "FAILED"
  | "CANCELLED";
const PROPOSAL_TTL_MS = 10 * 60 * 1000;

function getIoioAuth({ context, request, auth }: Context) {
  return auth ?? requireStudentRead({ context, request });
}

function reportError(
  message: string,
  status: 400 | 403 | 404 | 409 | 429 = 400
) {
  return new ShelfError({
    cause: null,
    message,
    label: "Report",
    status,
    shouldBeCaptured: false,
  });
}

function assertWriteRole(role: string) {
  if (!(["SELF_SERVICE", "ADMIN", "OWNER"] as string[]).includes(role)) {
    throw reportError(
      "Your Shelf role is not allowed to submit IOIO problem reports.",
      403
    );
  }
}

function assertOperationStatus(
  status: string
): asserts status is OperationStatus {
  if (
    !(
      [
        "PREPARED",
        "PROCESSING",
        "SUCCEEDED",
        "RESOLVED",
        "FAILED",
        "CANCELLED",
      ] as string[]
    ).includes(status)
  ) {
    throw reportError("This report operation has an invalid state.", 409);
  }
}

function proposalHasExpired(createdAt: Date) {
  return Date.now() - createdAt.getTime() > PROPOSAL_TTL_MS;
}

/**
 * Validate all references and persist a short-lived proposal. References and
 * the sanitized draft survive a web-process restart; the browser token is only
 * an opaque lookup key and cannot replace them.
 */
export async function prepareReportProblem(
  draft: ReportProposalDraft,
  { context, request, auth: providedAuth }: Context
): Promise<PreparedReportProposal> {
  const auth = await getIoioAuth({
    context,
    request,
    auth: providedAuth,
  });
  assertWriteRole(auth.role);
  const parsed = reportProposalSchema.parse(draft);
  const description = sanitizeReportText(parsed.description);
  if (description.length < 3) {
    throw reportError("Please provide a little more detail for staff.");
  }

  const [asset, kit, location] = await Promise.all([
    parsed.asset_id
      ? db.asset.findFirst({
          where: { id: parsed.asset_id, organizationId: auth.organizationId },
          select: { id: true, title: true },
        })
      : null,
    parsed.kit_id
      ? db.kit.findFirst({
          where: { id: parsed.kit_id, organizationId: auth.organizationId },
          select: { id: true, name: true },
        })
      : null,
    parsed.location_id
      ? db.location.findFirst({
          where: {
            id: parsed.location_id,
            organizationId: auth.organizationId,
          },
          select: { id: true, name: true },
        })
      : null,
  ]);

  if (parsed.asset_id && !asset) {
    throw reportError(
      "The selected Shelf asset is not in this workspace.",
      403
    );
  }
  if (parsed.kit_id && !kit) {
    throw reportError("The selected Shelf kit is not in this workspace.", 403);
  }
  if (parsed.location_id && !location) {
    throw reportError(
      "The selected Shelf location is not in this workspace.",
      403
    );
  }

  const token = randomUUID();
  await db.ioioWriteOperation.create({
    data: {
      operationType: IOIO_REPORT_OPERATION,
      status: "PREPARED",
      idempotencyKey: token,
      userId: auth.userId,
      organizationId: auth.organizationId,
      reportType: parsed.report_type,
      description,
      assetId: asset?.id ?? null,
      kitId: kit?.id ?? null,
      locationId: location?.id ?? null,
    },
  });

  return {
    confirmationToken: token,
    reportType: parsed.report_type,
    description,
    asset: asset ? { id: asset.id, title: asset.title } : null,
    kit: kit ? { id: kit.id, name: kit.name } : null,
    location: location ? { id: location.id, name: location.name } : null,
  };
}

type BorrowedItemAuth = {
  userId: string;
  organizationId: string;
  role: string;
};

async function loadBorrowedItem(
  auth: BorrowedItemAuth,
  {
    bookingId,
    bookingAssetId,
    assetId,
  }: { bookingId: string; bookingAssetId: string; assetId: string }
) {
  assertWriteRole(auth.role);
  const teamMembers = await db.teamMember.findMany({
    where: {
      userId: auth.userId,
      organizationId: auth.organizationId,
      deletedAt: null,
    },
    select: { id: true },
  });
  const booking = await db.booking.findFirst({
    where: {
      id: bookingId,
      organizationId: auth.organizationId,
      status: { in: ["ONGOING", "OVERDUE"] },
      OR: [
        { custodianUserId: auth.userId },
        ...(teamMembers.length
          ? [{ custodianTeamMemberId: { in: teamMembers.map(({ id }) => id) } }]
          : []),
      ],
    },
    select: {
      from: true,
      to: true,
      bookingAssets: {
        where: {
          id: bookingAssetId,
          assetId,
          checkedOutAt: { not: null },
          checkedInAt: null,
        },
        select: {
          id: true,
          bookingId: true,
          quantity: true,
          checkedOutAt: true,
          sourceKitId: true,
          asset: {
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
                  image: true,
                  thumbnailImage: true,
                  imageStoragePath: true,
                  thumbnailImageStoragePath: true,
                },
              },
              assetKits: { select: { kitId: true } },
            },
          },
        },
      },
    },
  });
  const bookingAsset = booking?.bookingAssets[0];
  if (!booking || !bookingAsset || !bookingAsset.checkedOutAt) {
    throw reportError("That borrowed item is no longer active.", 409);
  }
  const checkedOutAt = bookingAsset.checkedOutAt;

  const kitId =
    bookingAsset.sourceKitId ??
    (bookingAsset.asset.assetKits.length === 1
      ? bookingAsset.asset.assetKits[0]?.kitId ?? null
      : null);
  const kitRecord = kitId
    ? await db.kit.findFirst({
        where: { id: kitId, organizationId: auth.organizationId },
        select: {
          id: true,
          name: true,
          image: true,
          imageExpiration: true,
          imageStoragePath: true,
          organizationId: true,
        },
      })
    : null;
  const kit = kitRecord
    ? (await refreshExpiredKitImages([kitRecord]))[0] ?? null
    : null;

  return { booking, bookingAsset: { ...bookingAsset, checkedOutAt }, kit };
}

export async function getBorrowedItemProblemContext(
  {
    bookingId,
    bookingAssetId,
    assetId,
  }: { bookingId: string; bookingAssetId: string; assetId: string },
  { context, request }: Context
): Promise<BorrowedItemProblemContext> {
  const auth = await requireStudentRead({ context, request });
  const { booking, bookingAsset, kit } = await loadBorrowedItem(auth, {
    bookingId,
    bookingAssetId,
    assetId,
  });
  const unitLabel =
    bookingAsset.sourceKitId || bookingAsset.asset.type === "INDIVIDUAL"
      ? bookingAsset.asset.title.match(/(?:^|\s)(#\d+)\s*$/u)?.[1] ??
        bookingAsset.asset.sequentialId ??
        null
      : null;
  const [resolvedAsset] = await resolveAssetImagesForPresentation([
    bookingAsset.asset,
  ]);
  return {
    bookingId: bookingAsset.bookingId,
    bookingAssetId: bookingAsset.id,
    assetId: bookingAsset.asset.id,
    itemName: kit ? getIoioKitDisplayName(kit) : bookingAsset.asset.title,
    unitLabel,
    isKit: Boolean(kit),
    image: {
      mainImage: resolvedAsset.mainImage,
      thumbnailImage: resolvedAsset.thumbnailImage,
      assetModel: resolvedAsset.assetModel,
      kitImage: kit?.image ?? null,
    },
    quantity: bookingAsset.quantity,
    borrowedAt: bookingAsset.checkedOutAt,
    dueAt: booking.to,
  };
}

/**
 * Create a problem report from an active loan or the guided return flow. The
 * active booking reference is revalidated server-side so the report cannot
 * attach to a different student's loan or a different physical unit.
 */
export async function createBorrowedItemProblemReport(
  {
    bookingId,
    bookingAssetId,
    assetId,
    reportType,
    description,
  }: {
    bookingId: string;
    bookingAssetId: string;
    assetId: string;
    reportType: IoioReportType;
    description: string;
  },
  { context, request }: Context,
  options: {
    source?: "IOIO_STUDENT_RETURN" | "IOIO_STUDENT_REPORT";
    auth?: IoioAuthSnapshot;
  } = {}
) {
  const auth = await getIoioAuth({ context, request, auth: options.auth });
  const source = options.source ?? "IOIO_STUDENT_RETURN";
  if (source === "IOIO_STUDENT_RETURN") {
    const existing = await db.ioioWriteOperation.findFirst({
      where: {
        organizationId: auth.organizationId,
        operationType: IOIO_REPORT_OPERATION,
        source,
        bookingAssetId,
        status: "SUCCEEDED",
      },
      select: { resultReportId: true },
    });
    if (existing?.resultReportId) {
      return { ok: true as const, reportId: existing.resultReportId };
    }
  }
  const { bookingAsset, kit } = await loadBorrowedItem(auth, {
    bookingId,
    bookingAssetId,
    assetId,
  });
  const safeDescription = sanitizeReportText(description);
  if (safeDescription.length < (source === "IOIO_STUDENT_RETURN" ? 1 : 3)) {
    throw reportError("Please provide a little more detail for staff.");
  }
  const user = await db.user.findUniqueOrThrow({
    where: { id: auth.userId },
    select: { email: true },
  });
  const content = `[IOIO student report]\nIssue: ${reportType}\nDescription: ${safeDescription}`;

  return db.$transaction(async (tx) => {
    const report = await createReport({
      email: user.email,
      content,
      assetId: bookingAsset.asset.id,
      kitId: kit?.id,
      client: tx,
    });
    await tx.ioioWriteOperation.create({
      data: {
        operationType: IOIO_REPORT_OPERATION,
        source,
        status: "SUCCEEDED",
        idempotencyKey: randomUUID(),
        userId: auth.userId,
        organizationId: auth.organizationId,
        reportType,
        description: safeDescription,
        assetId: bookingAsset.asset.id,
        kitId: kit?.id ?? null,
        bookingId: bookingAsset.bookingId,
        bookingAssetId: bookingAsset.id,
        resultReportId: report.id,
        completedAt: new Date(),
      },
    });
    return { ok: true as const, reportId: report.id };
  });
}

export async function cancelReportProblem(
  token: string,
  { context, request }: Context
) {
  const auth = await requireStudentRead({ context, request });
  assertWriteRole(auth.role);
  const operation = await db.ioioWriteOperation.findUnique({
    where: { idempotencyKey: token },
    select: {
      userId: true,
      organizationId: true,
      status: true,
      resultReportId: true,
      createdAt: true,
    },
  });
  if (!operation) throw reportError("This report proposal has expired.", 404);
  if (
    operation.userId !== auth.userId ||
    operation.organizationId !== auth.organizationId
  ) {
    throw reportError(
      "This report proposal is not available to this user.",
      403
    );
  }
  assertOperationStatus(operation.status);
  if (
    operation.status === "PREPARED" &&
    proposalHasExpired(operation.createdAt)
  ) {
    await db.ioioWriteOperation.updateMany({
      where: { idempotencyKey: token, status: "PREPARED" },
      data: { status: "CANCELLED", completedAt: new Date() },
    });
    throw reportError("This report proposal has expired.", 404);
  }
  if (operation.status === "SUCCEEDED") {
    return {
      ok: true as const,
      status: "duplicate" as const,
      reportId: operation.resultReportId ?? undefined,
    };
  }
  if (operation.status !== "PREPARED") {
    throw reportError("This report operation cannot be cancelled.", 409);
  }
  await db.ioioWriteOperation.update({
    where: { idempotencyKey: token },
    data: { status: "CANCELLED", completedAt: new Date() },
  });
  return { ok: true as const, status: "cancelled" as const };
}

/**
 * The only AI-assisted Shelf write. The operation row and native ReportFound
 * row are committed in one transaction, so a retry after a process restart or
 * ambiguous network response observes the same result instead of creating a
 * second report.
 */
export async function reportProblem(
  {
    confirmationToken,
    reportType,
    description,
  }: {
    confirmationToken: string;
    reportType: string;
    description: string;
  },
  { context, request }: Context
) {
  const startedAt = Date.now();
  const auth = await requireStudentRead({ context, request });
  try {
    assertWriteRole(auth.role);
  } catch (cause) {
    Logger.warn({
      event: "ioio_assistant_report_problem",
      operationType: IOIO_REPORT_OPERATION,
      organizationId: auth.organizationId,
      outcome: "permission_rejected",
      durationMs: Date.now() - startedAt,
    });
    throw cause;
  }

  const operation = await db.ioioWriteOperation.findUnique({
    where: { idempotencyKey: confirmationToken },
    select: {
      id: true,
      userId: true,
      organizationId: true,
      status: true,
      resultReportId: true,
      createdAt: true,
    },
  });
  if (!operation) {
    throw reportError(
      "This report proposal has expired or was cancelled.",
      404
    );
  }
  if (
    operation.userId !== auth.userId ||
    operation.organizationId !== auth.organizationId
  ) {
    Logger.warn({
      event: "ioio_assistant_report_problem",
      operationType: IOIO_REPORT_OPERATION,
      organizationId: auth.organizationId,
      outcome: "cross_org_or_user_rejected",
      durationMs: Date.now() - startedAt,
    });
    throw reportError(
      "This report proposal is not available to this user.",
      403
    );
  }
  assertOperationStatus(operation.status);
  if (
    operation.status === "PREPARED" &&
    proposalHasExpired(operation.createdAt)
  ) {
    await db.ioioWriteOperation.updateMany({
      where: { idempotencyKey: confirmationToken, status: "PREPARED" },
      data: { status: "CANCELLED", completedAt: new Date() },
    });
    throw reportError(
      "This report proposal has expired or was cancelled.",
      404
    );
  }
  if (operation.status === "SUCCEEDED") {
    Logger.info({
      event: "ioio_assistant_report_problem",
      operationType: IOIO_REPORT_OPERATION,
      organizationId: auth.organizationId,
      operationId: operation.id,
      outcome: "duplicate_replay",
      durationMs: Date.now() - startedAt,
      reportId: operation.resultReportId,
    });
    return {
      ok: true as const,
      status: "duplicate" as const,
      reportId: operation.resultReportId ?? undefined,
    };
  }
  if (operation.status !== "PREPARED") {
    throw reportError(
      "This report operation is not ready for submission.",
      409
    );
  }

  const parsedType = ioioReportTypeSchema.safeParse(reportType);
  const safeDescription = sanitizeReportText(description);
  if (!parsedType.success || safeDescription.length < 3) {
    throw reportError(
      "Review the report type and description before submitting."
    );
  }

  // Completed-operation retries return above and do not consume quota.
  try {
    await enforceIoioReportRateLimit({
      userId: auth.userId,
      organizationId: auth.organizationId,
    });
  } catch (cause) {
    Logger.warn({
      event: "ioio_assistant_report_problem",
      operationType: IOIO_REPORT_OPERATION,
      organizationId: auth.organizationId,
      operationId: operation.id,
      outcome: "rate_limited",
      durationMs: Date.now() - startedAt,
    });
    throw cause;
  }

  try {
    return await db.$transaction(async (tx) => {
      // The conditional update is the cross-process claim. A second request
      // waits on the unique row, observes count=0 after the first transaction
      // commits, and returns its result instead of creating another report.
      const claimed = await tx.ioioWriteOperation.updateMany({
        where: {
          id: operation.id,
          idempotencyKey: confirmationToken,
          userId: auth.userId,
          organizationId: auth.organizationId,
          status: "PREPARED",
          createdAt: { gt: new Date(Date.now() - PROPOSAL_TTL_MS) },
        },
        data: {
          status: "PROCESSING",
          reportType: parsedType.data,
          description: safeDescription,
          failureCode: null,
        },
      });
      if (claimed.count === 0) {
        const finished = await tx.ioioWriteOperation.findUnique({
          where: { idempotencyKey: confirmationToken },
          select: {
            userId: true,
            organizationId: true,
            status: true,
            resultReportId: true,
            createdAt: true,
          },
        });
        if (
          !finished ||
          finished.userId !== auth.userId ||
          finished.organizationId !== auth.organizationId
        ) {
          throw reportError(
            "This report proposal is not available to this user.",
            403
          );
        }
        assertOperationStatus(finished.status);
        if (
          finished.status === "PREPARED" &&
          proposalHasExpired(finished.createdAt)
        ) {
          throw reportError("This report proposal has expired.", 404);
        }
        if (finished.status === "SUCCEEDED") {
          Logger.info({
            event: "ioio_assistant_report_problem",
            operationType: IOIO_REPORT_OPERATION,
            organizationId: auth.organizationId,
            operationId: operation.id,
            outcome: "duplicate_replay",
            durationMs: Date.now() - startedAt,
            reportId: finished.resultReportId,
          });
          return {
            ok: true as const,
            status: "duplicate" as const,
            reportId: finished.resultReportId ?? undefined,
          };
        }
        throw reportError(
          "This report operation is already being processed.",
          409
        );
      }

      const current = await tx.ioioWriteOperation.findUnique({
        where: { idempotencyKey: confirmationToken },
        select: {
          id: true,
          userId: true,
          organizationId: true,
          status: true,
          resultReportId: true,
          assetId: true,
          kitId: true,
          locationId: true,
        },
      });
      if (!current) throw reportError("This report proposal has expired.", 404);
      if (current.status !== "PROCESSING") {
        throw reportError(
          "This report operation is not ready for submission.",
          409
        );
      }

      const [asset, kit, location] = await Promise.all([
        current.assetId
          ? tx.asset.findFirst({
              where: {
                id: current.assetId,
                organizationId: auth.organizationId,
              },
              select: { id: true },
            })
          : null,
        current.kitId
          ? tx.kit.findFirst({
              where: {
                id: current.kitId,
                organizationId: auth.organizationId,
              },
              select: { id: true },
            })
          : null,
        current.locationId
          ? tx.location.findFirst({
              where: {
                id: current.locationId,
                organizationId: auth.organizationId,
              },
              select: { id: true },
            })
          : null,
      ]);
      if (current.assetId && !asset) {
        throw reportError("The referenced Shelf asset no longer exists.", 404);
      }
      if (current.kitId && !kit) {
        throw reportError("The referenced Shelf kit no longer exists.", 404);
      }
      if (current.locationId && !location) {
        throw reportError(
          "The referenced Shelf location no longer exists.",
          404
        );
      }

      const user = await tx.user.findUniqueOrThrow({
        where: { id: auth.userId },
        select: { email: true },
      });
      const auditMetadata = JSON.stringify({
        source: "IOIO_ASSISTANT",
        operationType: IOIO_REPORT_OPERATION,
        operationId: current.id,
        reportType: parsedType.data,
        assetId: current.assetId,
        kitId: current.kitId,
        locationId: current.locationId,
        userId: auth.userId,
        organizationId: auth.organizationId,
      });

      const report = await createReport({
        email: user.email,
        content: `${auditMetadata}\n${safeDescription}`,
        assetId: current.assetId ?? undefined,
        kitId: current.kitId ?? undefined,
        client: tx,
      });
      await tx.ioioWriteOperation.update({
        where: { id: current.id, organizationId: auth.organizationId },
        data: {
          reportType: parsedType.data,
          description: safeDescription,
          status: "SUCCEEDED",
          resultReportId: report.id,
          failureCode: null,
          completedAt: new Date(),
        },
      });

      Logger.info({
        event: "ioio_assistant_report_problem",
        source: "IOIO_ASSISTANT",
        operationType: IOIO_REPORT_OPERATION,
        operationId: current.id,
        organizationId: auth.organizationId,
        reportType: parsedType.data,
        assetId: current.assetId,
        kitId: current.kitId,
        locationId: current.locationId,
        reportId: report.id,
        outcome: "success",
        durationMs: Date.now() - startedAt,
        success: true,
      });
      return {
        ok: true as const,
        status: "submitted" as const,
        reportId: report.id,
      };
    });
  } catch (cause) {
    Logger.warn({
      event: "ioio_assistant_report_problem",
      source: "IOIO_ASSISTANT",
      operationType: IOIO_REPORT_OPERATION,
      operationId: operation.id,
      organizationId: auth.organizationId,
      outcome: "failure",
      durationMs: Date.now() - startedAt,
      success: false,
      error: cause instanceof Error ? cause.name : "UnknownError",
    });
    throw cause;
  }
}
