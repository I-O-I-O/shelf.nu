import { useEffect, useState } from "react";
import { AssetType } from "@prisma/client";
import {
  data,
  Form,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  type MetaFunction,
  useActionData,
  useLoaderData,
} from "react-router";
import { z } from "zod";
import {
  SelectableRow,
  toggleSelectionId,
} from "~/components/ioio-staff/selectable-row";
import { formatStudentDateOnly } from "~/components/ioio-student/student-ui";
import { PageBackLink } from "~/components/shared/page-back-link";
import { db } from "~/database/db.server";
import { getPhysicalUnitNumberFromTitle } from "~/modules/asset/physical-unit";
import {
  createBooking,
  reserveBooking,
  rescheduleCheckinReminderForBooking,
  updateBookingAssets,
} from "~/modules/booking/service.server";
import {
  getIoioAvailability,
  IOIO_STAFF_RESERVATION_DESCRIPTION,
  isIoioExtensionAvailable,
} from "~/modules/ioio-student/availability.server";
import { addCalendarDaysUtcEnd } from "~/modules/ioio-student/date-range";
import { completeSubmittedReturn } from "~/modules/ioio-student/return-item.server";
import { getIoioPhysicalUnitDisplayName } from "~/modules/kit/ioio-kit-presentation";
import { getClientHint } from "~/utils/client-hints";
import { makeShelfError } from "~/utils/error";
import { payload } from "~/utils/http.server";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

export const meta: MetaFunction = () => [{ title: "IOIO review" }];

const requestActionSchema = z.object({
  operationId: z.string().min(1),
  decision: z.enum(["approve", "reject", "complete-return"]),
  comment: z.string().trim().max(1000).optional(),
});

function getDisplayName(
  user:
    | {
        displayName?: string | null;
        firstName?: string | null;
        lastName?: string | null;
      }
    | null
    | undefined,
  fallback = "Shelf user"
) {
  if (!user) return fallback;
  return (
    user.displayName ||
    [user.firstName, user.lastName].filter(Boolean).join(" ") ||
    fallback
  );
}

function getBorrowedItemDisplayName({
  asset,
  sourceKitName,
}: {
  asset: {
    title: string;
    type: AssetType;
    sequentialId: string | null;
    assetModel: { name: string } | null;
  };
  sourceKitName?: string | null;
}) {
  const isPhysicalUnit =
    Boolean(sourceKitName) || asset.type === AssetType.INDIVIDUAL;
  if (!isPhysicalUnit) return asset.title;

  return getIoioPhysicalUnitDisplayName({
    logicalProductName: sourceKitName ?? asset.assetModel?.name ?? asset.title,
    unitNumber:
      getPhysicalUnitNumberFromTitle(asset.title) ?? asset.sequentialId,
    missingUnitLabel: "Unit number missing",
  });
}

async function requireStaff({
  context,
  request,
}: Pick<LoaderFunctionArgs, "context" | "request">) {
  const { userId } = context.getSession();
  const permission = await requirePermission({
    userId,
    request,
    entity: PermissionEntity.booking,
    action: PermissionAction.update,
  });
  if (permission.role !== "ADMIN" && permission.role !== "OWNER") {
    throw new Response("Staff access required", { status: 403 });
  }
  return { ...permission, userId };
}

export async function loader({ context, request }: LoaderFunctionArgs) {
  const auth = await requireStaff({ context, request });
  const operations = await db.ioioWriteOperation.findMany({
    where: {
      organizationId: auth.organizationId,
      operationType: { in: ["BORROW_ITEM", "IOIO_EXTENSION_REQUEST"] },
      status: "PENDING_APPROVAL",
    },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      userId: true,
      assetId: true,
      bookingId: true,
      bookingAssetId: true,
      quantity: true,
      from: true,
      to: true,
      createdAt: true,
      operationType: true,
      status: true,
    },
  });
  const submittedReturnChecks = await db.ioioWriteOperation.findMany({
    where: {
      organizationId: auth.organizationId,
      operationType: "RETURN_ITEM",
      status: "SUBMITTED",
    },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      userId: true,
      assetId: true,
      bookingId: true,
      bookingAssetId: true,
      quantity: true,
      createdAt: true,
      description: true,
      reportType: true,
    },
  });
  const returnBookingAssetIds = submittedReturnChecks
    .map((operation) => operation.bookingAssetId)
    .filter((id): id is string => Boolean(id));
  const returnBookingAssets = returnBookingAssetIds.length
    ? await db.bookingAsset.findMany({
        where: {
          id: { in: returnBookingAssetIds },
          booking: { organizationId: auth.organizationId },
        },
        select: {
          id: true,
          checkedInAt: true,
          asset: { select: { returnHandling: true } },
        },
      })
    : [];
  const returnChecks = submittedReturnChecks.filter((operation) => {
    const bookingAsset = operation.bookingAssetId
      ? returnBookingAssets.find(
          (candidate) => candidate.id === operation.bookingAssetId
        )
      : null;
    if (bookingAsset?.checkedInAt) return false;
    return (
      operation.reportType !== "RETURN_ITEM" ||
      (operation.bookingAssetId
        ? returnBookingAssets.find(
            (bookingAsset) => bookingAsset.id === operation.bookingAssetId
          )?.asset.returnHandling === "RETURN_TO_RETURN_ZONE"
        : false)
    );
  });
  const returnHandlingByBookingAssetId = new Map(
    returnBookingAssets.map((bookingAsset) => [
      bookingAsset.id,
      bookingAsset.asset.returnHandling,
    ])
  );
  const assetIds = [...operations, ...returnChecks]
    .map((operation) => operation.assetId)
    .filter((id): id is string => Boolean(id));
  const assets = assetIds.length
    ? await db.asset.findMany({
        where: { organizationId: auth.organizationId, id: { in: assetIds } },
        select: {
          id: true,
          title: true,
          type: true,
          sequentialId: true,
          maxBorrowDays: true,
          extensionBorrowDays: true,
          assetModel: { select: { name: true } },
        },
      })
    : [];
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));

  const extensionOperations = operations.filter(
    (operation) => operation.operationType === "IOIO_EXTENSION_REQUEST"
  );
  const extensionBookingIds = extensionOperations
    .map((operation) => operation.bookingId)
    .filter((id): id is string => Boolean(id));
  const extensionBookings = extensionBookingIds.length
    ? await db.booking.findMany({
        where: {
          organizationId: auth.organizationId,
          id: { in: extensionBookingIds },
        },
        select: {
          id: true,
          status: true,
          to: true,
          bookingAssets: {
            select: {
              id: true,
              quantity: true,
              sourceKitId: true,
              asset: {
                select: {
                  title: true,
                  type: true,
                  sequentialId: true,
                  maxBorrowDays: true,
                  extensionBorrowDays: true,
                  assetModel: { select: { name: true } },
                },
              },
            },
          },
        },
      })
    : [];
  const extensionBookingById = new Map(
    extensionBookings.map((booking) => [booking.id, booking])
  );
  const borrowerIds = [
    ...new Set(extensionOperations.map((operation) => operation.userId)),
  ];
  const borrowerTeamMembers = borrowerIds.length
    ? await db.teamMember.findMany({
        where: {
          organizationId: auth.organizationId,
          userId: { in: borrowerIds },
          deletedAt: null,
        },
        select: { id: true, userId: true },
      })
    : [];
  const borrowerTeamMemberIds = borrowerTeamMembers.map((member) => member.id);
  const borrowerCurrentBookings = borrowerIds.length
    ? await db.booking.findMany({
        where: {
          organizationId: auth.organizationId,
          status: { in: ["ONGOING", "OVERDUE", "RESERVED"] },
          OR: [
            { custodianUserId: { in: borrowerIds } },
            ...(borrowerTeamMemberIds.length
              ? [{ custodianTeamMemberId: { in: borrowerTeamMemberIds } }]
              : []),
          ],
          AND: [
            {
              OR: [
                { description: { not: IOIO_STAFF_RESERVATION_DESCRIPTION } },
                { description: null },
              ],
            },
          ],
        },
        select: {
          id: true,
          custodianUserId: true,
          custodianTeamMember: { select: { userId: true } },
          status: true,
          to: true,
          bookingAssets: {
            select: {
              id: true,
              quantity: true,
              sourceKitId: true,
              asset: {
                select: {
                  title: true,
                  type: true,
                  sequentialId: true,
                  maxBorrowDays: true,
                  extensionBorrowDays: true,
                  assetModel: { select: { name: true } },
                },
              },
            },
          },
        },
        orderBy: [{ to: "asc" }, { id: "asc" }],
      })
    : [];
  const contextKitIds = [
    ...new Set(
      [...extensionBookings, ...borrowerCurrentBookings].flatMap((booking) =>
        booking.bookingAssets.flatMap((bookingAsset) =>
          bookingAsset.sourceKitId ? [bookingAsset.sourceKitId] : []
        )
      )
    ),
  ];
  const contextKits = contextKitIds.length
    ? await db.kit.findMany({
        where: {
          organizationId: auth.organizationId,
          id: { in: contextKitIds },
        },
        select: {
          id: true,
          name: true,
          extensionBorrowDays: true,
          maxBorrowDays: true,
        },
      })
    : [];
  const contextKitById = new Map(contextKits.map((kit) => [kit.id, kit]));
  const approvedExtensionOperations = extensionBookingIds.length
    ? await db.ioioWriteOperation.findMany({
        where: {
          organizationId: auth.organizationId,
          operationType: "IOIO_EXTENSION_REQUEST",
          status: "APPROVED",
          bookingId: { in: extensionBookingIds },
        },
        select: { bookingId: true },
      })
    : [];
  const approvedExtensionCountByBookingId = new Map<string, number>();
  for (const operation of approvedExtensionOperations) {
    if (!operation.bookingId) continue;
    approvedExtensionCountByBookingId.set(
      operation.bookingId,
      (approvedExtensionCountByBookingId.get(operation.bookingId) ?? 0) + 1
    );
  }
  const currentLoansByBorrowerId = new Map<
    string,
    Array<{
      id: string;
      status: string;
      dueDate: Date;
      items: Array<{ displayName: string; quantity: number }>;
    }>
  >();
  for (const booking of borrowerCurrentBookings) {
    const borrowerId =
      booking.custodianUserId ?? booking.custodianTeamMember?.userId;
    if (!borrowerId || !booking.to) continue;
    const items = booking.bookingAssets.map((bookingAsset) => ({
      displayName: getBorrowedItemDisplayName({
        asset: bookingAsset.asset,
        sourceKitName: bookingAsset.sourceKitId
          ? contextKitById.get(bookingAsset.sourceKitId)?.name
          : null,
      }),
      quantity: bookingAsset.quantity,
    }));
    const borrowerLoans = currentLoansByBorrowerId.get(borrowerId) ?? [];
    borrowerLoans.push({
      id: booking.id,
      status: booking.status,
      dueDate: booking.to,
      items,
    });
    currentLoansByBorrowerId.set(borrowerId, borrowerLoans);
  }
  const getExtensionContext = (
    operation: (typeof extensionOperations)[number]
  ) => {
    const booking = operation.bookingId
      ? extensionBookingById.get(operation.bookingId)
      : null;
    const bookingAsset = booking?.bookingAssets.find(
      (candidate) => candidate.id === operation.bookingAssetId
    );
    const kit = bookingAsset?.sourceKitId
      ? contextKitById.get(bookingAsset.sourceKitId)
      : null;
    const currentDueDate = booking?.to ?? operation.from;
    const extensionDays =
      kit?.extensionBorrowDays ??
      kit?.maxBorrowDays ??
      bookingAsset?.asset.extensionBorrowDays ??
      bookingAsset?.asset.maxBorrowDays ??
      45;
    const approvedExtensionCount = operation.bookingId
      ? approvedExtensionCountByBookingId.get(operation.bookingId) ?? 0
      : 0;
    return {
      displayName: bookingAsset
        ? getBorrowedItemDisplayName({
            asset: bookingAsset.asset,
            sourceKitName: kit?.name,
          })
        : operation.assetId
        ? assetById.get(operation.assetId)?.title ?? "Unknown item"
        : "Unknown item",
      currentDueDate,
      requestedDueDate: operation.to,
      extensionDays,
      approvedExtensionCount,
      currentLoans: currentLoansByBorrowerId.get(operation.userId) ?? [],
    };
  };
  const extensionReservationOverlap = new Map<string, number>();
  await Promise.all(
    operations
      .filter(
        (operation) =>
          operation.operationType === "IOIO_EXTENSION_REQUEST" &&
          operation.assetId &&
          operation.from &&
          operation.to &&
          operation.quantity
      )
      .map(async (operation) => {
        const asset = operation.assetId
          ? assetById.get(operation.assetId)
          : null;
        if (!asset || !operation.from || !operation.to || !operation.quantity) {
          return;
        }
        const availability = await getIoioAvailability({
          organizationId: auth.organizationId,
          productId: asset.id,
          candidateAssetIds:
            asset.type === AssetType.INDIVIDUAL ? [asset.id] : undefined,
          from: operation.from,
          to: operation.to,
          excludeBookingId: operation.bookingId ?? undefined,
        });
        if (availability.staffReservedCount > 0) {
          extensionReservationOverlap.set(
            operation.id,
            availability.staffReservedCount
          );
        }
      })
  );
  const userIds = [...operations, ...returnChecks].map(
    (operation) => operation.userId
  );
  const members = userIds.length
    ? await db.teamMember.findMany({
        where: {
          organizationId: auth.organizationId,
          userId: { in: userIds },
          deletedAt: null,
        },
        select: {
          userId: true,
          name: true,
          user: {
            select: {
              displayName: true,
              firstName: true,
              lastName: true,
              email: true,
            },
          },
        },
      })
    : [];
  const memberByUserId = new Map(
    members.map((member) => [member.userId, member])
  );
  const users = userIds.length
    ? await db.user.findMany({
        where: {
          id: { in: userIds },
          userOrganizations: { some: { organizationId: auth.organizationId } },
        },
        select: {
          id: true,
          displayName: true,
          firstName: true,
          lastName: true,
          email: true,
        },
      })
    : [];
  const userById = new Map(users.map((user) => [user.id, user]));
  return data(
    payload({
      requests: operations.map((operation) => ({
        ...operation,
        ...(operation.operationType === "IOIO_EXTENSION_REQUEST"
          ? getExtensionContext(operation)
          : {
              displayName: operation.assetId
                ? assetById.get(operation.assetId)?.title ?? "Unknown item"
                : "Unknown item",
              currentDueDate: null,
              requestedDueDate: operation.to,
              extensionDays: null,
              approvedExtensionCount: 0,
              currentLoans: [],
            }),
        staffReservationOverlapCount:
          extensionReservationOverlap.get(operation.id) ?? 0,
        asset: operation.assetId
          ? assetById.get(operation.assetId) ?? null
          : null,
        requester:
          userById.get(operation.userId) || memberByUserId.get(operation.userId)
            ? {
                name:
                  memberByUserId.get(operation.userId)?.name ?? "Shelf user",
                displayName: getDisplayName(
                  userById.get(operation.userId) ??
                    memberByUserId.get(operation.userId)?.user,
                  memberByUserId.get(operation.userId)?.name
                ),
                firstName:
                  userById.get(operation.userId)?.firstName ??
                  memberByUserId.get(operation.userId)?.user?.firstName ??
                  null,
                lastName:
                  userById.get(operation.userId)?.lastName ??
                  memberByUserId.get(operation.userId)?.user?.lastName ??
                  null,
                email:
                  userById.get(operation.userId)?.email ??
                  memberByUserId.get(operation.userId)?.user?.email ??
                  null,
              }
            : null,
      })),
      returnChecks: returnChecks.map((operation) => ({
        ...operation,
        returnKind:
          operation.reportType !== "RETURN_ITEM"
            ? ("problem" as const)
            : returnHandlingByBookingAssetId.get(
                operation.bookingAssetId ?? ""
              ) === "RETURN_TO_RETURN_ZONE"
            ? ("return-zone" as const)
            : ("storage" as const),
        asset: operation.assetId
          ? assetById.get(operation.assetId) ?? null
          : null,
        requester:
          userById.get(operation.userId) || memberByUserId.get(operation.userId)
            ? {
                name:
                  memberByUserId.get(operation.userId)?.name ?? "Shelf user",
                displayName: getDisplayName(
                  userById.get(operation.userId) ??
                    memberByUserId.get(operation.userId)?.user
                ),
                email:
                  userById.get(operation.userId)?.email ??
                  memberByUserId.get(operation.userId)?.user?.email ??
                  null,
              }
            : null,
      })),
    })
  );
}

export async function action({ context, request }: ActionFunctionArgs) {
  try {
    const auth = await requireStaff({ context, request });
    const formData = await request.formData();
    if (formData.get("decision") === "complete-return-bulk") {
      const operationIds = z
        .array(z.string().min(1))
        .min(1)
        .parse(formData.getAll("operationIds").map(String));
      const uniqueOperationIds = [...new Set(operationIds)];
      const availableReturns = await db.ioioWriteOperation.findMany({
        where: {
          id: { in: uniqueOperationIds },
          organizationId: auth.organizationId,
          operationType: "RETURN_ITEM",
          status: "SUBMITTED",
        },
        select: { id: true },
      });
      if (availableReturns.length !== uniqueOperationIds.length) {
        throw new Error(
          "One or more selected returns are no longer waiting for a check."
        );
      }

      const results: Array<{ ok: true } | { ok: false; message: string }> = [];
      for (const operationId of uniqueOperationIds) {
        try {
          await completeSubmittedReturn({ operationId }, { context, request });
          results.push({ ok: true });
        } catch (cause) {
          const reason = makeShelfError(cause);
          results.push({ ok: false, message: reason.message });
        }
      }
      return data({
        ok: true as const,
        decision: "complete-return-bulk" as const,
        succeeded: results.filter((result) => result.ok).length,
        failed: results.filter((result) => !result.ok).length,
      });
    }
    const parsed = requestActionSchema.parse(Object.fromEntries(formData));
    const operation = await db.ioioWriteOperation.findFirst({
      where: {
        id: parsed.operationId,
        organizationId: auth.organizationId,
        operationType: {
          in: ["BORROW_ITEM", "IOIO_EXTENSION_REQUEST", "RETURN_ITEM"],
        },
        status:
          parsed.decision === "complete-return"
            ? "SUBMITTED"
            : "PENDING_APPROVAL",
      },
      select: {
        id: true,
        userId: true,
        assetId: true,
        bookingId: true,
        bookingAssetId: true,
        quantity: true,
        from: true,
        to: true,
        status: true,
        operationType: true,
      },
    });
    if (!operation)
      throw new Error("This request is no longer awaiting review.");
    if (parsed.decision === "complete-return") {
      const result = await completeSubmittedReturn(
        { operationId: operation.id },
        { context, request }
      );
      return data({
        ok: true as const,
        decision: "complete-return" as const,
        bookingId: result.bookingId,
      });
    }
    const reviewData = {
      reviewComment: parsed.comment || null,
      reviewedByUserId: auth.userId,
      reviewedAt: new Date(),
    };
    if (parsed.decision === "reject") {
      await db.ioioWriteOperation.updateMany({
        where: {
          id: operation.id,
          organizationId: auth.organizationId,
          status: "PENDING_APPROVAL",
        },
        data: {
          status: "REJECTED",
          completedAt: new Date(),
          ...reviewData,
        },
      });
      return data({ ok: true as const, decision: "reject" as const });
    }
    if (!operation.assetId || !operation.quantity) {
      throw new Error("This request is missing its booking details.");
    }
    const asset = await db.asset.findFirst({
      where: { id: operation.assetId, organizationId: auth.organizationId },
      select: {
        title: true,
        type: true,
        maxBorrowDays: true,
        extensionBorrowDays: true,
      },
    });
    if (!asset) throw new Error("The requested item no longer exists.");
    let availabilityFrom = operation.from;
    let availabilityTo = operation.to;
    let approvedDueDate = operation.to;
    let bookingBeforeExtension: {
      id: string;
      to: Date;
      activeSchedulerReference: string | null;
      description: string | null;
    } | null = null;

    if (operation.operationType === "IOIO_EXTENSION_REQUEST") {
      if (!operation.bookingId || !operation.bookingAssetId) {
        throw new Error("This extension request is missing its loan details.");
      }
      bookingBeforeExtension = await db.booking.findFirst({
        where: {
          id: operation.bookingId,
          organizationId: auth.organizationId,
          status: { in: ["ONGOING", "OVERDUE"] },
        },
        select: {
          id: true,
          to: true,
          activeSchedulerReference: true,
          description: true,
        },
      });
      if (!bookingBeforeExtension) {
        throw new Error("This loan is no longer active.");
      }
      const bookingAsset = await db.bookingAsset.findFirst({
        where: {
          id: operation.bookingAssetId,
          bookingId: bookingBeforeExtension.id,
          assetId: operation.assetId,
        },
        select: { sourceKitId: true },
      });
      if (!bookingAsset) {
        throw new Error("This extension request is missing its loan item.");
      }
      const sourceKit = bookingAsset.sourceKitId
        ? await db.kit.findFirst({
            where: {
              id: bookingAsset.sourceKitId,
              organizationId: auth.organizationId,
            },
            select: { maxBorrowDays: true, extensionBorrowDays: true },
          })
        : null;
      const extensionDays =
        sourceKit?.extensionBorrowDays ??
        sourceKit?.maxBorrowDays ??
        asset.extensionBorrowDays ??
        asset.maxBorrowDays ??
        45;
      availabilityFrom = bookingBeforeExtension.to;
      approvedDueDate = addCalendarDaysUtcEnd(
        bookingBeforeExtension.to,
        extensionDays
      );
      availabilityTo = approvedDueDate;
    }
    if (!availabilityFrom || !availabilityTo) {
      throw new Error("This request is missing its booking dates.");
    }
    const extensionIsAvailable = await isIoioExtensionAvailable({
      organizationId: auth.organizationId,
      assetId: operation.assetId,
      assetType: asset.type,
      quantity: operation.quantity,
      from: availabilityFrom,
      to: availabilityTo,
      excludeBookingId:
        operation.operationType === "IOIO_EXTENSION_REQUEST"
          ? operation.bookingId ?? undefined
          : undefined,
    });
    if (!extensionIsAvailable) {
      throw new Error(
        "This item is no longer available for the requested dates."
      );
    }
    if (operation.operationType === "IOIO_EXTENSION_REQUEST") {
      if (!bookingBeforeExtension || !operation.bookingId || !approvedDueDate) {
        throw new Error("This extension request is missing its loan details.");
      }
      const updated = await db.booking.updateMany({
        where: {
          id: operation.bookingId,
          organizationId: auth.organizationId,
          status: { in: ["ONGOING", "OVERDUE"] },
        },
        data: { to: approvedDueDate },
      });
      if (updated.count !== 1)
        throw new Error("This loan is no longer active.");
      await rescheduleCheckinReminderForBooking(
        {
          ...bookingBeforeExtension,
          to: approvedDueDate,
        },
        getClientHint(request),
        auth.organizationId
      );
      await db.ioioWriteOperation.updateMany({
        where: {
          id: operation.id,
          organizationId: auth.organizationId,
          status: "PENDING_APPROVAL",
        },
        data: {
          status: "APPROVED",
          completedAt: new Date(),
          to: approvedDueDate,
          ...reviewData,
        },
      });
      return data({
        ok: true as const,
        decision: "approve" as const,
        bookingId: operation.bookingId,
      });
    }
    if (!operation.from || !operation.to) {
      throw new Error("This request is missing its booking dates.");
    }
    const borrowFrom = operation.from;
    const borrowTo = operation.to;
    const studentMember = await db.teamMember.findFirst({
      where: {
        organizationId: auth.organizationId,
        userId: operation.userId,
        deletedAt: null,
      },
      select: { id: true },
    });
    if (!studentMember)
      throw new Error("The requester no longer has an active Shelf account.");
    const booking = await createBooking({
      booking: {
        name: `IOIO borrow: ${asset.title}`,
        description: "Approved IOIO student borrowing request",
        creatorId: auth.userId,
        custodianUserId: operation.userId,
        custodianTeamMemberId: studentMember.id,
        organizationId: auth.organizationId,
        from: borrowFrom,
        to: borrowTo,
        tags: [],
      },
      assetIds: [operation.assetId],
      hints: getClientHint(request),
    });
    if (asset.type === AssetType.QUANTITY_TRACKED) {
      await updateBookingAssets({
        id: booking.id,
        organizationId: auth.organizationId,
        assetIds: [operation.assetId],
        quantities: { [operation.assetId]: operation.quantity },
        userId: auth.userId,
      });
    }
    await reserveBooking({
      id: booking.id,
      organizationId: auth.organizationId,
      name: booking.name,
      from: borrowFrom,
      to: borrowTo,
      custodianUserId: operation.userId,
      custodianTeamMemberId: studentMember.id,
      description: "Approved IOIO student borrowing request",
      hints: getClientHint(request),
      isSelfServiceOrBase: false,
      tags: [],
      userId: auth.userId,
    });
    await db.ioioWriteOperation.updateMany({
      where: {
        id: operation.id,
        organizationId: auth.organizationId,
        status: "PENDING_APPROVAL",
      },
      data: {
        status: "APPROVED",
        bookingId: booking.id,
        completedAt: new Date(),
        ...reviewData,
      },
    });
    return data({
      ok: true as const,
      decision: "approve" as const,
      bookingId: booking.id,
    });
  } catch (cause) {
    const reason = makeShelfError(cause);
    return data(
      { ok: false as const, error: reason.message },
      { status: reason.status }
    );
  }
}

export default function IoioRequests() {
  const { requests, returnChecks } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const [selectedReturnIds, setSelectedReturnIds] = useState<string[]>([]);
  useEffect(() => {
    const visibleIds = new Set(returnChecks.map(({ id }) => id));
    setSelectedReturnIds((current) =>
      current.filter((id) => visibleIds.has(id))
    );
  }, [returnChecks]);
  useEffect(() => {
    if (result?.ok && result.decision === "complete-return-bulk") {
      setSelectedReturnIds([]);
    }
  }, [result]);
  return (
    <div className="mx-auto max-w-3xl">
      <PageBackLink to="/calendar" className="mb-5">
        Back to Calendar
      </PageBackLink>
      <div className="mb-5 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-black tracking-tight text-gray-950">
            IOIO review
          </h1>
          <p className="mt-2 text-gray-600">
            Review borrowing approvals and items waiting for a return check.
          </p>
        </div>
      </div>
      {result && !result.ok ? (
        <p
          role="alert"
          className="mb-4 rounded-xl bg-red-50 p-3 text-sm font-semibold text-red-800"
        >
          {result.error}
        </p>
      ) : null}
      {result?.ok && result.decision === "complete-return-bulk" ? (
        <p
          role={result.failed ? "alert" : "status"}
          className={`mb-4 rounded-xl p-3 text-sm font-semibold ${
            result.failed
              ? "bg-amber-50 text-amber-950"
              : "bg-green-50 text-green-900"
          }`}
        >
          {result.succeeded} return
          {result.succeeded === 1 ? " was" : "s were"} checked and made
          available.
          {result.failed
            ? ` ${result.failed} could not be completed; review the remaining items.`
            : ""}
        </p>
      ) : null}
      {returnChecks.length ? (
        <section className="mb-6 space-y-3">
          <h2 className="text-xl font-black text-gray-950">
            Returns to process ({returnChecks.length})
          </h2>
          <Form
            method="post"
            className="flex flex-wrap items-center gap-3 rounded-xl border border-red-100 bg-red-50 p-3"
          >
            <input type="hidden" name="decision" value="complete-return-bulk" />
            {selectedReturnIds.map((operationId) => (
              <input
                key={operationId}
                type="hidden"
                name="operationIds"
                value={operationId}
              />
            ))}
            <span className="mr-auto text-sm font-semibold text-gray-800">
              {selectedReturnIds.length} selected
            </span>
            <button
              type="button"
              onClick={() => setSelectedReturnIds([])}
              disabled={!selectedReturnIds.length}
              className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-gray-700 hover:border-red-300 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Clear
            </button>
            <button
              type="submit"
              disabled={!selectedReturnIds.length}
              className="rounded-lg bg-red-700 px-3 py-2 text-sm font-bold text-white hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Checked - make available
            </button>
          </Form>
          {returnChecks.map((returnCheck) => (
            <SelectableRow
              key={returnCheck.id}
              selected={selectedReturnIds.includes(returnCheck.id)}
              onToggle={() =>
                setSelectedReturnIds((current) =>
                  toggleSelectionId(current, returnCheck.id)
                )
              }
              className="border-blue-200 bg-blue-50/60 p-5"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-3">
                  <input
                    type="checkbox"
                    checked={selectedReturnIds.includes(returnCheck.id)}
                    onChange={() =>
                      setSelectedReturnIds((current) =>
                        toggleSelectionId(current, returnCheck.id)
                      )
                    }
                    aria-label={`Select ${
                      returnCheck.asset?.title ?? "returned item"
                    }`}
                    className="mt-1 size-4 shrink-0 rounded border-gray-300 text-red-700 focus:ring-red-700"
                  />
                  <div>
                    <h3 className="font-bold text-gray-950">
                      {returnCheck.asset?.title ?? "Unknown item"}
                    </h3>
                    <p className="mt-1 text-sm text-gray-700">
                      {returnCheck.returnKind === "problem"
                        ? "Issue reported · Waiting for staff check"
                        : returnCheck.returnKind === "return-zone"
                        ? "Return Zone · Waiting for staff check"
                        : "Return submitted · Waiting for staff check"}
                    </p>
                    <p className="mt-1 text-sm text-gray-600">
                      Returned by:{" "}
                      {returnCheck.requester?.displayName ||
                        returnCheck.requester?.name ||
                        "Shelf user"}
                    </p>
                    {returnCheck.description ? (
                      <p className="mt-2 text-sm text-gray-700">
                        {returnCheck.description}
                      </p>
                    ) : null}
                  </div>
                </div>
                <div className="text-right text-sm text-gray-600">
                  <p>{returnCheck.createdAt.toLocaleDateString()}</p>
                </div>
              </div>
              <Form method="post" className="mt-4">
                <input
                  type="hidden"
                  name="operationId"
                  value={returnCheck.id}
                />
                <input type="hidden" name="decision" value="complete-return" />
                <button
                  type="submit"
                  className="rounded-xl bg-red-700 px-4 py-2 text-sm font-bold text-white hover:bg-red-800"
                >
                  {returnCheck.returnKind === "problem"
                    ? "Mark repaired and available"
                    : "Mark checked and available"}
                </button>
              </Form>
            </SelectableRow>
          ))}
        </section>
      ) : null}

      {requests.length ? (
        <section className="space-y-3">
          <h2 className="text-xl font-black text-gray-950">
            Borrowing approvals
          </h2>
          {requests.map((request) => (
            <article
              key={request.id}
              className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="font-bold text-gray-950">
                    {request.operationType === "IOIO_EXTENSION_REQUEST"
                      ? request.displayName
                      : request.asset?.title ?? "Unknown item"}
                  </h2>
                  <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                    {request.operationType === "IOIO_EXTENSION_REQUEST"
                      ? "Extension approval"
                      : "Borrowing approval"}
                  </p>
                  {request.operationType === "IOIO_EXTENSION_REQUEST" ? (
                    <div className="mt-2 space-y-2 text-sm text-gray-600">
                      <p>
                        <span className="font-semibold text-gray-900">
                          Borrower
                        </span>{" "}
                        {request.requester?.displayName || "Shelf user"}
                      </p>
                      <p>
                        Current due date:{" "}
                        {request.currentDueDate
                          ? formatStudentDateOnly(request.currentDueDate)
                          : "Unknown"}
                      </p>
                      <p>
                        Requested due date:{" "}
                        {request.requestedDueDate
                          ? formatStudentDateOnly(request.requestedDueDate)
                          : "Unknown"}
                      </p>
                      {request.extensionDays ? (
                        <p>Extension: +{request.extensionDays} days</p>
                      ) : null}
                      <div className="rounded-lg bg-gray-50 p-3">
                        <p className="font-semibold text-gray-900">
                          Extension history
                        </p>
                        <p>
                          {request.approvedExtensionCount === 0
                            ? "No previous extensions"
                            : request.approvedExtensionCount +
                              " previous extension" +
                              (request.approvedExtensionCount === 1 ? "" : "s")}
                        </p>
                        <p className="mt-1 text-xs text-gray-500">
                          This would be extension #
                          {request.approvedExtensionCount + 1}
                        </p>
                      </div>
                      {request.currentLoans.length ? (
                        <div className="rounded-lg border border-gray-200 bg-white p-3">
                          <p className="font-semibold text-gray-900">
                            Currently borrowed by{" "}
                            {request.requester?.displayName || "this borrower"}
                          </p>
                          <div className="mt-2 space-y-2">
                            {request.currentLoans.flatMap((loan) =>
                              loan.items.map((item) => {
                                const isOverdue = loan.status === "OVERDUE";
                                return (
                                  <div
                                    key={[loan.id, item.displayName].join("-")}
                                    className="flex items-start justify-between gap-3 text-xs"
                                  >
                                    <span className="font-semibold text-gray-800">
                                      {item.displayName}
                                      {item.quantity > 1
                                        ? " · Quantity: " + item.quantity
                                        : ""}
                                    </span>
                                    <span
                                      className={
                                        isOverdue
                                          ? "font-semibold text-red-700"
                                          : "text-gray-600"
                                      }
                                    >
                                      {isOverdue
                                        ? "Overdue by " +
                                          Math.max(
                                            1,
                                            Math.ceil(
                                              (Date.now() -
                                                new Date(
                                                  loan.dueDate
                                                ).getTime()) /
                                                86_400_000
                                            )
                                          ) +
                                          " days"
                                        : "Due " +
                                          formatStudentDateOnly(loan.dueDate)}
                                    </span>
                                  </div>
                                );
                              })
                            )}
                          </div>
                        </div>
                      ) : null}
                      {request.staffReservationOverlapCount > 0 ? (
                        <p className="rounded-lg bg-amber-50 p-2 text-xs font-semibold text-amber-950">
                          Course reservation overlap:{" "}
                          {request.staffReservationOverlapCount} reserved unit
                          {request.staffReservationOverlapCount === 1
                            ? ""
                            : "s"}
                          .
                        </p>
                      ) : null}
                    </div>
                  ) : (
                    <p className="mt-1 text-sm text-gray-600">
                      {request.quantity ?? 0} unit
                      {request.quantity === 1 ? "" : "s"} ·{" "}
                      {request.from
                        ? formatStudentDateOnly(request.from)
                        : "Unknown"}{" "}
                      to{" "}
                      {request.to
                        ? formatStudentDateOnly(request.to)
                        : "Unknown"}
                    </p>
                  )}
                </div>
                {request.operationType !== "IOIO_EXTENSION_REQUEST" ? (
                  <div className="text-right text-sm text-gray-600">
                    <p className="font-semibold text-gray-900">
                      {request.requester?.displayName ||
                        request.requester?.name ||
                        "Shelf user"}
                    </p>
                    {request.requester?.email ? (
                      <p>{request.requester.email}</p>
                    ) : null}
                  </div>
                ) : null}
              </div>
              <Form method="post" className="mt-4 w-full">
                <input type="hidden" name="operationId" value={request.id} />
                <label className="mb-2 block w-full text-sm font-semibold text-gray-700">
                  {request.operationType === "IOIO_EXTENSION_REQUEST"
                    ? "Comment to borrower (optional)"
                    : "Staff comment (optional)"}
                  <textarea
                    name="comment"
                    rows={2}
                    className="mt-1 w-full rounded-xl border border-gray-300 px-3 py-2 text-sm font-normal"
                    placeholder="Add context for the student"
                  />
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="submit"
                    name="decision"
                    value="approve"
                    className="rounded-xl bg-red-700 px-4 py-2 text-sm font-bold text-white hover:bg-red-800"
                  >
                    {request.operationType === "IOIO_EXTENSION_REQUEST"
                      ? "Approve extension"
                      : "Approve"}
                  </button>
                  <button
                    type="submit"
                    name="decision"
                    value="reject"
                    className="rounded-xl border border-gray-300 px-4 py-2 text-sm font-bold text-gray-700 hover:border-red-300 hover:text-red-800"
                  >
                    Decline
                  </button>
                </div>
              </Form>
            </article>
          ))}
        </section>
      ) : returnChecks.length ? null : (
        <div className="rounded-2xl border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-600">
          No borrowing approvals or return checks need review.
        </div>
      )}
    </div>
  );
}
