import { randomUUID } from "node:crypto";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import {
  Popover,
  PopoverContent,
  PopoverPortal,
  PopoverTrigger,
} from "@radix-ui/react-popover";
import {
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  Clock3,
  MapPin,
} from "lucide-react";
import {
  Link,
  useActionData,
  useFetcher,
  useLoaderData,
  useLocation,
} from "react-router";
import {
  data,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  type MetaFunction,
} from "react-router";
import { z } from "zod";
import { AssetImage } from "~/components/assets/asset-image";
import type { AssetForThumbnail } from "~/components/assets/asset-image/types";
import {
  formatStudentDateOnly,
  formatStudentLabel,
  SectionHeading,
} from "~/components/ioio-student/student-ui";
import { Dialog, DialogPortal } from "~/components/layout/dialog";
import { CodeScanner } from "~/components/scanner/code-scanner";
import { db } from "~/database/db.server";
import { resolveAssetImagesForPresentation } from "~/modules/asset/service.server";
import { getPickupLocationDisplay } from "~/modules/ioio-staff/pickup-zone.server";
import {
  getPreparationCancellationLabel,
  formatPickupHours,
  getPreparationPickupDeadline,
  IOIO_OPENING_HOURS_GUIDANCE,
  PREPARATION_PICKUP_EXPIRED_COMMENT,
} from "~/modules/ioio-staff/preparation";
import {
  cancelStudentPreparationRequest,
  confirmStudentPreparationPickup,
} from "~/modules/ioio-staff/preparation.server";
import { isIoioExtensionAvailable } from "~/modules/ioio-student/availability.server";
import { addCalendarDaysUtcEnd } from "~/modules/ioio-student/date-range";
import { splitStudentLoanSections } from "~/modules/ioio-student/my-loans";
import {
  cancelReturnItem,
  prepareReturnItem,
  submitReturnItem,
  type PreparedReturnProposal,
} from "~/modules/ioio-student/return-item.server";
import { requireStudentRead } from "~/modules/ioio-student/route.server";
import { getMyStudentLoans } from "~/modules/ioio-student/service.server";
import { getIoioPhysicalUnitDisplayName } from "~/modules/kit/ioio-kit-presentation";
import { getWorkingHoursForOrganization } from "~/modules/working-hours/service.server";
import { getClientHint } from "~/utils/client-hints";
import { makeShelfError } from "~/utils/error";
import { error, payload } from "~/utils/http.server";
import { resolveStorageImageUrl } from "~/utils/storage.server";

const extensionSchema = z.object({
  intent: z.literal("request-extension"),
  bookingId: z.string().min(1),
  bookingAssetId: z.string().min(1),
  message: z.string().trim().max(1000).optional(),
});

const loanActionSchema = z.discriminatedUnion("intent", [
  extensionSchema,
  z.object({
    intent: z.literal("confirm-pickup"),
    operationId: z.string().min(1),
    verificationValue: z.string().trim().optional(),
  }),
  z.object({
    intent: z.literal("cancel-preparation-request"),
    operationId: z.string().min(1),
  }),
  z.object({
    intent: z.literal("prepare-return"),
    bookingId: z.string().min(1),
    bookingAssetId: z.string().min(1),
    assetId: z.string().min(1),
    quantity: z.coerce.number().int().min(1),
  }),
  z.object({
    intent: z.literal("submit-return"),
    confirmationToken: z.string().uuid(),
    quantity: z.coerce.number().int().min(1),
  }),
  z.object({
    intent: z.literal("cancel-return"),
    confirmationToken: z.string().uuid(),
  }),
]);

export const meta: MetaFunction<typeof loader> = () => [{ title: "My loans" }];

export async function loader({ context, request }: LoaderFunctionArgs) {
  const { userId, organizationId } = await requireStudentRead({
    context,
    request,
  });
  try {
    const loans = await getMyStudentLoans({
      organizationId,
      userId,
      includePast: true,
    });
    const [
      extensionRequests,
      pendingReturnOperations,
      pendingProblemReports,
      preparationOperations,
    ] = await Promise.all([
      db.ioioWriteOperation.findMany({
        where: {
          organizationId,
          userId,
          operationType: "IOIO_EXTENSION_REQUEST",
          status: { in: ["PENDING_APPROVAL", "APPROVED", "REJECTED"] },
        },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          bookingId: true,
          bookingAssetId: true,
          to: true,
          status: true,
          reviewComment: true,
          reviewedByUserId: true,
        },
      }),
      db.ioioWriteOperation.findMany({
        where: {
          organizationId,
          userId,
          operationType: "RETURN_ITEM",
          status: "SUBMITTED",
        },
        select: {
          bookingId: true,
          bookingAssetId: true,
          assetId: true,
          quantity: true,
          reportType: true,
        },
      }),
      db.ioioWriteOperation.findMany({
        where: {
          organizationId,
          userId,
          operationType: "REPORT_PROBLEM",
          source: "IOIO_STUDENT_RETURN",
          status: "SUCCEEDED",
        },
        select: { bookingAssetId: true },
      }),
      db.ioioWriteOperation.findMany({
        where: {
          organizationId,
          userId,
          operationType: "IOIO_PREPARATION",
          status: {
            in: [
              "PENDING_PREPARATION",
              "READY_FOR_PICKUP",
              "CANCELLED",
              "CANCELLED_PICKUP",
            ],
          },
          OR: [
            { status: { in: ["PENDING_PREPARATION", "READY_FOR_PICKUP"] } },
            { reviewComment: { startsWith: "Cancelled by Student." } },
            {
              reviewComment: { startsWith: PREPARATION_PICKUP_EXPIRED_COMMENT },
            },
          ],
        },
        select: {
          id: true,
          source: true,
          assetId: true,
          quantity: true,
          createdAt: true,
          from: true,
          to: true,
          bookingId: true,
          bookingAssetId: true,
          status: true,
          locationId: true,
          reviewComment: true,
          reviewedAt: true,
        },
      }),
    ]);
    const workingHours = await getWorkingHoursForOrganization(organizationId);
    const preparationRequestAssets = await db.asset.findMany({
      where: {
        organizationId,
        id: {
          in: preparationOperations
            .filter(
              (operation) =>
                operation.source === "IOIO_PREPARATION_REQUEST" ||
                operation.status === "CANCELLED_PICKUP" ||
                operation.reviewComment?.includes("Staff confirmed put back.")
            )
            .map((operation) => operation.assetId)
            .filter((id): id is string => Boolean(id)),
        },
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
          select: {
            kit: {
              select: {
                name: true,
                image: true,
                imageExpiration: true,
                imageStoragePath: true,
              },
            },
          },
          take: 1,
        },
      },
    });
    const resolvedPreparationRequestAssets =
      await resolveAssetImagesForPresentation(preparationRequestAssets);
    const preparationRequestAssetById = new Map(
      resolvedPreparationRequestAssets.map((asset) => [asset.id, asset])
    );
    const preparationRequests = preparationOperations
      .filter(
        (operation) =>
          operation.source === "IOIO_PREPARATION_REQUEST" &&
          operation.status === "PENDING_PREPARATION"
      )
      .map((operation) => {
        const asset = preparationRequestAssetById.get(operation.assetId ?? "");
        return {
          id: operation.id,
          title:
            asset?.assetModel?.name ??
            asset?.assetKits[0]?.kit.name ??
            asset?.title ??
            "Equipment",
          asset: asset
            ? {
                id: asset.id,
                mainImage: asset.mainImage,
                thumbnailImage: asset.thumbnailImage,
                assetModel: asset.assetModel,
                kitImage: asset.assetKits[0]?.kit.image ?? null,
                kitThumbnailImage: null,
              }
            : null,
          quantity: operation.quantity ?? 1,
          createdAt: operation.createdAt,
          pickupHours: formatPickupHours(workingHours),
        };
      });
    const preparationWithPickup = await Promise.all(
      preparationOperations
        .filter((operation) =>
          ["PENDING_PREPARATION", "READY_FOR_PICKUP"].includes(operation.status)
        )
        .map(async (operation) => {
          const pickupLocation = operation.locationId
            ? await getPickupLocationDisplay({
                organizationId,
                locationId: operation.locationId,
              })
            : null;
          return {
            ...operation,
            pickupLocation: pickupLocation?.label ?? null,
            pickupRoomName: pickupLocation?.roomName ?? null,
            pickupZoneName: pickupLocation?.zoneName ?? null,
            pickupHours: formatPickupHours(workingHours),
          };
        })
    );
    const physicalCancellationOperations = preparationOperations.filter(
      (operation) =>
        operation.status === "CANCELLED_PICKUP" ||
        operation.reviewComment?.includes("Staff confirmed put back.")
    );
    const physicalCancellationBookingIds = new Set(
      physicalCancellationOperations
        .map((operation) => operation.bookingId)
        .filter((id): id is string => Boolean(id))
    );
    const cancelledPreparationHistoryOperations = preparationOperations.filter(
      (operation) => {
        if (
          operation.status !== "CANCELLED" &&
          operation.status !== "CANCELLED_PICKUP"
        ) {
          return false;
        }
        const wasStudentCancelled = operation.reviewComment?.startsWith(
          "Cancelled by Student."
        );
        const pickupExpired = operation.reviewComment?.startsWith(
          PREPARATION_PICKUP_EXPIRED_COMMENT
        );
        if (!wasStudentCancelled && !pickupExpired) {
          return false;
        }
        if (
          operation.source === "IOIO_PREPARATION_REQUEST" &&
          operation.bookingId &&
          physicalCancellationBookingIds.has(operation.bookingId)
        ) {
          return false;
        }
        if (
          operation.source !== "IOIO_PREPARATION_REQUEST" &&
          operation.bookingId &&
          !physicalCancellationOperations.some(
            (physical) => physical.id === operation.id
          )
        ) {
          return false;
        }
        return true;
      }
    );
    const cancelledPreparationHistory =
      cancelledPreparationHistoryOperations.map((operation) => {
        const asset = preparationRequestAssetById.get(operation.assetId ?? "");
        const displayName = asset
          ? getIoioPhysicalUnitDisplayName({
              logicalProductName:
                asset.assetModel?.name ??
                asset.assetKits[0]?.kit.name ??
                (asset.type === "INDIVIDUAL"
                  ? asset.title.replace(/\s+#\d+\s*$/u, "")
                  : asset.title),
              unitNumber:
                asset.type === "INDIVIDUAL"
                  ? asset.title.match(/(?:^|\s)(#\d+)\s*$/u)?.[1] ??
                    asset.sequentialId
                  : null,
              missingUnitLabel: "Unit number missing",
            })
          : "Equipment";
        return {
          id: operation.id,
          title: displayName,
          cancelledAt: operation.reviewedAt ?? operation.createdAt,
          status: operation.status,
          statusLabel: getPreparationCancellationLabel(operation.reviewComment),
          pickupLocation: operation.locationId
            ? getPickupLocationDisplay({
                organizationId,
                locationId: operation.locationId,
              })
            : Promise.resolve(null),
          asset: asset
            ? {
                id: asset.id,
                mainImage: asset.mainImage,
                thumbnailImage: asset.thumbnailImage,
                assetModel: asset.assetModel,
                kitImage: asset.assetKits[0]?.kit.image ?? null,
              }
            : null,
        };
      });
    const resolvedCancelledPreparationHistory = await Promise.all(
      cancelledPreparationHistory.map(async (entry) => ({
        ...entry,
        pickupLocation: (await entry.pickupLocation)?.label ?? null,
      }))
    );
    const returnZoneRecord = await db.location.findFirst({
      where: {
        organizationId,
        name: { in: ["Kit Return Zone", "IOIO Return Zone", "Return Zone"] },
      },
      select: {
        id: true,
        imageUrl: true,
        thumbnailUrl: true,
        imageStoragePath: true,
        thumbnailImageStoragePath: true,
      },
    });
    const returnZone = returnZoneRecord
      ? {
          ...(await getPickupLocationDisplay({
            organizationId,
            locationId: returnZoneRecord.id,
          })),
          image: await resolveStorageImageUrl({
            bucketName: "files",
            objectPath:
              returnZoneRecord.thumbnailImageStoragePath ??
              returnZoneRecord.imageStoragePath,
            legacyUrl:
              returnZoneRecord.thumbnailUrl ?? returnZoneRecord.imageUrl,
            isPublic: true,
          }),
        }
      : null;
    const reviewerIds = extensionRequests
      .map((request) => request.reviewedByUserId)
      .filter((id): id is string => Boolean(id));
    const reviewers = reviewerIds.length
      ? await db.user.findMany({
          where: { id: { in: reviewerIds } },
          select: {
            id: true,
            displayName: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        })
      : [];
    const reviewerById = new Map(
      reviewers.map((reviewer) => [reviewer.id, reviewer])
    );
    const pendingExtensions = extensionRequests.map((request) => ({
      ...request,
      reviewer: request.reviewedByUserId
        ? reviewerById.get(request.reviewedByUserId) ?? null
        : null,
    }));
    const pendingReturnBookingAssetIds = pendingReturnOperations
      .map((operation) => operation.bookingAssetId)
      .filter((id): id is string => Boolean(id));
    const pendingReturnBookingAssets = pendingReturnBookingAssetIds.length
      ? await db.bookingAsset.findMany({
          where: {
            id: { in: pendingReturnBookingAssetIds },
            booking: { organizationId },
          },
          select: {
            id: true,
            checkedInAt: true,
            asset: { select: { returnHandling: true } },
          },
        })
      : [];
    const pendingReturnBookingAssetById = new Map(
      pendingReturnBookingAssets.map((bookingAsset) => [
        bookingAsset.id,
        bookingAsset,
      ])
    );
    const pendingReturns = pendingReturnOperations.filter((operation) => {
      const bookingAsset = operation.bookingAssetId
        ? pendingReturnBookingAssetById.get(operation.bookingAssetId)
        : null;
      if (bookingAsset?.checkedInAt) return false;
      return (
        operation.reportType !== "RETURN_ITEM" ||
        bookingAsset?.asset.returnHandling === "RETURN_TO_RETURN_ZONE"
      );
    });
    const cancelledPickupBookingAssetIds = new Set(
      preparationOperations
        .filter((operation) => operation.status === "CANCELLED_PICKUP")
        .map((operation) => operation.bookingAssetId)
        .filter((id): id is string => Boolean(id))
    );
    const studentVisibleLoans = loans
      .map((loan) => ({
        ...loan,
        bookingAssets: loan.bookingAssets.filter(
          (bookingAsset) => !cancelledPickupBookingAssetIds.has(bookingAsset.id)
        ),
      }))
      .filter((loan) => loan.bookingAssets.length > 0);
    return data(
      payload({
        loans: studentVisibleLoans,
        pendingExtensions,
        pendingReturns,
        pendingProblemReports,
        preparationOperations: preparationWithPickup,
        preparationRequests,
        cancelledPreparationHistory: resolvedCancelledPreparationHistory,
        returnZone,
        reportSubmitted:
          new URL(request.url).searchParams.get("report") === "submitted",
      })
    );
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    throw data(error(reason), { status: reason.status });
  }
}

export async function action({ context, request }: ActionFunctionArgs) {
  const auth = await requireStudentRead({ context, request });
  const { userId } = auth;
  try {
    const parsed = loanActionSchema.parse(
      Object.fromEntries(await request.formData())
    );
    if (parsed.intent === "confirm-pickup") {
      let pickup;
      try {
        pickup = await confirmStudentPreparationPickup({
          organizationId: auth.organizationId,
          operationId: parsed.operationId,
          borrowerUserId: userId,
          hints: getClientHint(request),
          verificationValue: parsed.verificationValue,
        });
      } catch (cause) {
        const reason = makeShelfError(cause, { userId });
        const status = reason.status;
        if (status !== undefined && status >= 400 && status < 500) {
          return data(
            { ok: false as const, error: reason.message },
            { status }
          );
        }
        throw cause;
      }
      return data({
        ok: true as const,
        intent: "pickup-confirmed" as const,
        result: pickup,
      });
    }
    if (parsed.intent === "cancel-preparation-request") {
      const result = await cancelStudentPreparationRequest({
        organizationId: auth.organizationId,
        operationId: parsed.operationId,
        borrowerUserId: userId,
        hints: getClientHint(request),
      });
      return data({
        ok: true as const,
        intent: "preparation-cancelled" as const,
        result,
      });
    }
    if (parsed.intent === "prepare-return") {
      return data({
        ok: true as const,
        intent: "return-prepared" as const,
        proposal: await prepareReturnItem(
          {
            booking_id: parsed.bookingId,
            booking_asset_id: parsed.bookingAssetId,
            asset_id: parsed.assetId,
            quantity: parsed.quantity,
          },
          { context, request, auth }
        ),
      });
    }
    if (parsed.intent === "submit-return") {
      return data({
        ok: true as const,
        intent: "return-submitted" as const,
        result: await submitReturnItem(parsed, { context, request, auth }),
      });
    }
    if (parsed.intent === "cancel-return") {
      return data({
        ok: true as const,
        intent: "return-cancelled" as const,
        result: await cancelReturnItem(parsed.confirmationToken, {
          context,
          request,
          auth,
        }),
      });
    }
    const teamMembers = await db.teamMember.findMany({
      where: { organizationId: auth.organizationId, userId, deletedAt: null },
      select: { id: true },
    });
    const booking = await db.booking.findFirst({
      where: {
        id: parsed.bookingId,
        organizationId: auth.organizationId,
        status: { in: ["ONGOING", "OVERDUE"] },
        OR: [
          { custodianUserId: userId },
          ...(teamMembers.length
            ? [
                {
                  custodianTeamMemberId: {
                    in: teamMembers.map((member) => member.id),
                  },
                },
              ]
            : []),
        ],
      },
      select: {
        id: true,
        from: true,
        to: true,
        bookingAssets: {
          where: { id: parsed.bookingAssetId },
          select: {
            id: true,
            assetId: true,
            quantity: true,
            sourceKitId: true,
            asset: {
              select: {
                type: true,
                maxBorrowDays: true,
                extensionBorrowDays: true,
              },
            },
          },
        },
      },
    });
    const bookingAsset = booking?.bookingAssets[0];
    if (!booking || !booking.to || !bookingAsset) {
      throw new Error("This loan is no longer available for extension.");
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
      bookingAsset.asset.extensionBorrowDays ??
      bookingAsset.asset.maxBorrowDays ??
      45;
    const requestedTo = addCalendarDaysUtcEnd(booking.to, extensionDays);
    const extensionIsAvailable = await isIoioExtensionAvailable({
      organizationId: auth.organizationId,
      assetId: bookingAsset.assetId,
      assetType: bookingAsset.asset.type,
      quantity: bookingAsset.quantity,
      from: booking.to,
      to: requestedTo,
      excludeBookingId: booking.id,
    });
    if (!extensionIsAvailable) {
      throw new Error(
        "This item is no longer available for the requested extension."
      );
    }
    const existing = await db.ioioWriteOperation.findFirst({
      where: {
        organizationId: auth.organizationId,
        userId,
        bookingId: booking.id,
        operationType: "IOIO_EXTENSION_REQUEST",
        status: "PENDING_APPROVAL",
      },
      select: { id: true },
    });
    if (existing)
      throw new Error(
        "You already have an extension request waiting for TA review."
      );
    const message = parsed.message?.trim();
    await db.ioioWriteOperation.create({
      data: {
        operationType: "IOIO_EXTENSION_REQUEST",
        status: "PENDING_APPROVAL",
        idempotencyKey: randomUUID(),
        userId,
        organizationId: auth.organizationId,
        reportType: "IOIO_EXTENSION_REQUEST",
        description: message || "Extension request",
        assetId: bookingAsset.assetId,
        quantity: bookingAsset.quantity,
        bookingId: booking.id,
        bookingAssetId: bookingAsset.id,
        from: booking.to,
        to: requestedTo,
      },
    });
    return data({ ok: true as const });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    return data(
      { ok: false as const, error: reason.message },
      { status: reason.status }
    );
  }
}

type ReturnActionData =
  | {
      ok: true;
      intent: "return-prepared";
      proposal: PreparedReturnProposal;
    }
  | {
      ok: true;
      intent: "return-submitted" | "return-cancelled";
      result?: unknown;
    }
  | { ok: true; intent: "pickup-confirmed"; result: unknown }
  | { ok: false; error: string };

export default function IoioLoans() {
  const {
    loans,
    pendingExtensions,
    pendingReturns,
    pendingProblemReports,
    preparationOperations,
    preparationRequests,
    cancelledPreparationHistory,
    returnZone,
    reportSubmitted,
  } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const isProblemReturn = (bookingAssetId: string) =>
    pendingReturns.some(
      (returnRequest) =>
        returnRequest.bookingAssetId === bookingAssetId &&
        returnRequest.reportType !== "RETURN_ITEM"
    ) ||
    pendingProblemReports.some(
      (report) => report.bookingAssetId === bookingAssetId
    );
  const { activeLoans, pendingLoanGroups, pastLoans } =
    splitStudentLoanSections(loans, pendingReturns);
  const location = useLocation();
  const view =
    new URLSearchParams(location.search).get("view") === "past"
      ? "past"
      : "current";
  const [openPickupOperationId, setOpenPickupOperationId] = useState<
    string | null
  >(() => new URLSearchParams(location.search).get("pickup"));
  useEffect(() => {
    if (!openPickupOperationId) return;
    document
      .getElementById(`pickup-panel-${openPickupOperationId}`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [openPickupOperationId]);
  const [selectedBookingAssetIds, setSelectedBookingAssetIds] = useState<
    string[]
  >([]);
  const [returnReviewOpen, setReturnReviewOpen] = useState(false);
  const [cancelRequest, setCancelRequest] = useState<{
    id: string;
    title: string;
    isReadyForPickup: boolean;
  } | null>(null);
  const [cancelSubmitted, setCancelSubmitted] = useState(false);
  const cancelFetcher = useFetcher<typeof action>();
  useEffect(() => {
    if (
      cancelFetcher.data?.ok &&
      "intent" in cancelFetcher.data &&
      cancelFetcher.data.intent === "preparation-cancelled"
    ) {
      setCancelRequest(null);
    }
  }, [cancelFetcher.data]);
  const preparationByBookingAssetId = new Map(
    preparationOperations
      .filter((operation) => operation.bookingAssetId)
      .map((operation) => [operation.bookingAssetId, operation])
  );
  const selectAllRef = useRef<HTMLInputElement>(null);
  const selectableAssets = activeLoans.flatMap((loan) =>
    loan.status === "ONGOING" || loan.status === "OVERDUE"
      ? loan.bookingAssets
          .filter(
            (item) =>
              item.outstandingQuantity > 0 &&
              !preparationByBookingAssetId.has(item.id) &&
              !isProblemReturn(item.id)
          )
          .map((item) => ({ loan, item }))
      : []
  );
  const selectableIds = selectableAssets.map(({ item }) => item.id);
  const selectableIdKey = selectableIds.join("|");
  const selectedAssets = selectableAssets.filter(({ item }) =>
    selectedBookingAssetIds.includes(item.id)
  );
  const allSelectableSelected =
    selectableIds.length > 0 &&
    selectableIds.every((id) => selectedBookingAssetIds.includes(id));
  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate =
        selectedAssets.length > 0 && !allSelectableSelected;
    }
  }, [selectedAssets.length, allSelectableSelected]);
  useEffect(() => {
    setSelectedBookingAssetIds((current) =>
      current.filter((id) => selectableIds.includes(id))
    );
  }, [selectableIdKey]);
  useEffect(() => {
    setSelectedBookingAssetIds([]);
    setReturnReviewOpen(false);
  }, [view]);
  const toggleLoanAsset = (id: string) =>
    setSelectedBookingAssetIds((current) =>
      current.includes(id)
        ? current.filter((selectedId) => selectedId !== id)
        : [...current, id]
    );
  return (
    <div>
      <SectionHeading
        title="My loans"
        text="Only bookings assigned to your own Shelf account are shown here."
      />
      <nav
        aria-label="Loan history"
        className="mb-6 flex gap-2 border-b border-gray-200"
      >
        <Link
          to="/ioio/loans?view=current"
          className={`border-b-2 px-3 py-2 text-sm font-bold ${
            view === "current"
              ? "border-red-700 text-red-800"
              : "border-transparent text-gray-500 hover:text-gray-900"
          }`}
          aria-current={view === "current" ? "page" : undefined}
        >
          Current
        </Link>
        <Link
          to="/ioio/loans?view=past"
          className={`border-b-2 px-3 py-2 text-sm font-bold ${
            view === "past"
              ? "border-red-700 text-red-800"
              : "border-transparent text-gray-500 hover:text-gray-900"
          }`}
          aria-current={view === "past" ? "page" : undefined}
        >
          Past
        </Link>
      </nav>
      {reportSubmitted ? (
        <div
          className="mb-4 rounded-xl bg-green-100 p-4 text-sm font-medium text-green-800"
          role="status"
        >
          Problem reported. The TAs have been notified.
        </div>
      ) : null}
      {result && !result.ok ? (
        <p
          role="alert"
          className="mb-4 rounded-xl bg-red-50 p-3 text-sm font-semibold text-red-800"
        >
          {result.error}
        </p>
      ) : null}
      {view === "current" ? (
        <section aria-labelledby="active-loans-heading">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <h2
              id="active-loans-heading"
              className="text-xl font-black text-gray-950"
            >
              Active loans
            </h2>
            {selectableIds.length ? (
              <label className="inline-flex items-center gap-2 text-sm font-medium text-gray-700">
                <input
                  ref={selectAllRef}
                  type="checkbox"
                  checked={allSelectableSelected}
                  onChange={(event) =>
                    setSelectedBookingAssetIds(
                      event.target.checked ? selectableIds : []
                    )
                  }
                  className="size-4 rounded border-gray-300 accent-red-700"
                />
                Select all
              </label>
            ) : null}
          </div>
          {selectedBookingAssetIds.length ? (
            <div className="mb-3 flex items-center gap-3 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm">
              <span className="font-semibold text-gray-800">
                {selectedAssets.length} selected
              </span>
              <button
                type="button"
                className="font-semibold text-red-800 underline-offset-2 hover:underline"
                onClick={() => setReturnReviewOpen(true)}
              >
                Review returns
              </button>
              <button
                type="button"
                className="ml-auto text-gray-600 underline-offset-2 hover:underline"
                onClick={() => setSelectedBookingAssetIds([])}
              >
                Clear
              </button>
            </div>
          ) : null}
          {activeLoans.length ? (
            <div className="space-y-3">
              {activeLoans.map((loan) => (
                <article key={loan.id} className="space-y-2">
                  <ul className="space-y-2 text-sm text-gray-700">
                    {loan.bookingAssets.map((item) => {
                      const preparation = preparationByBookingAssetId.get(
                        item.id
                      );
                      const displayName = getIoioPhysicalUnitDisplayName({
                        logicalProductName: item.kitName ?? item.asset.title,
                        unitNumber: item.unitLabel,
                        ...(item.isKit || item.asset.type === "INDIVIDUAL"
                          ? { missingUnitLabel: "Unit number missing" }
                          : {}),
                      });
                      const returnBy = preparation?.to ?? loan.to;
                      return (
                        <li
                          key={`${loan.id}-${item.id}`}
                          className="rounded-xl border border-gray-200 bg-white p-3 shadow-sm"
                        >
                          <div className="flex flex-wrap items-center gap-3">
                            {selectableIds.includes(item.id) ? (
                              <input
                                type="checkbox"
                                aria-label={`Select ${formatStudentLabel(
                                  displayName
                                )} for return`}
                                checked={selectedBookingAssetIds.includes(
                                  item.id
                                )}
                                onChange={() => toggleLoanAsset(item.id)}
                                className="size-4 shrink-0 rounded border-gray-300 accent-red-700"
                              />
                            ) : null}
                            <Link
                              to={`/ioio/browse/${item.asset.id}`}
                              aria-label={`View ${formatStudentLabel(
                                displayName
                              )}`}
                              className="size-14 shrink-0 overflow-hidden rounded-lg bg-gray-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700"
                            >
                              <AssetImage
                                asset={{
                                  id: item.asset.id,
                                  mainImage: item.asset.mainImage,
                                  thumbnailImage: item.asset.thumbnailImage,
                                  assetModel: item.asset.assetModel,
                                  kitImage: item.asset.kitImage,
                                }}
                                alt={`Image of ${formatStudentLabel(
                                  displayName
                                )}`}
                                useThumbnail={false}
                                className="size-full"
                              />
                            </Link>
                            <div className="min-w-0 flex-1">
                              <Link
                                to={`/ioio/browse/${item.asset.id}`}
                                className="font-semibold text-gray-950 hover:text-red-800 hover:underline"
                              >
                                {formatStudentLabel(displayName)}
                              </Link>
                              {item.asset.type === "QUANTITY_TRACKED" ? (
                                <span className="ml-2 text-xs text-gray-600">
                                  {item.borrowedQuantity} borrowed
                                </span>
                              ) : null}
                              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                                <span
                                  className={`rounded-full px-2 py-0.5 font-semibold ${
                                    preparation
                                      ? "bg-amber-100 text-amber-900"
                                      : loan.status === "OVERDUE"
                                      ? "bg-red-100 text-red-800"
                                      : "bg-blue-100 text-blue-800"
                                  }`}
                                >
                                  {preparation?.status === "READY_FOR_PICKUP"
                                    ? "Ready for pickup"
                                    : preparation?.status ===
                                      "PENDING_PREPARATION"
                                    ? "Waiting for preparation"
                                    : loan.status === "OVERDUE"
                                    ? "Overdue"
                                    : loan.status === "ONGOING"
                                    ? "Borrowed"
                                    : loan.status.replaceAll("_", " ")}
                                </span>
                                {preparation?.status === "READY_FOR_PICKUP" ? (
                                  <span className="font-semibold text-gray-800">
                                    Unit{" "}
                                    {formatStudentLabel(
                                      item.unitLabel ?? "number missing"
                                    )}
                                  </span>
                                ) : null}
                                {!preparation ? (
                                  <span className="text-gray-600">
                                    Return by{" "}
                                    {loan.to
                                      ? formatStudentDateOnly(loan.to)
                                      : "date not set"}
                                  </span>
                                ) : preparation.status ===
                                  "READY_FOR_PICKUP" ? (
                                  <span className="text-gray-600">
                                    Pickup:{" "}
                                    {preparation.pickupLocation ??
                                      "see details"}
                                  </span>
                                ) : null}
                                {preparation?.status === "READY_FOR_PICKUP" &&
                                preparation.reviewedAt ? (
                                  <span className="font-semibold text-gray-900">
                                    Pick up by{" "}
                                    {formatStudentDateOnly(
                                      getPreparationPickupDeadline(
                                        preparation.reviewedAt
                                      )
                                    )}
                                  </span>
                                ) : null}
                              </div>
                            </div>
                            {preparation?.status === "READY_FOR_PICKUP" ? (
                              <button
                                type="button"
                                aria-expanded={
                                  openPickupOperationId === preparation.id
                                }
                                aria-controls={`pickup-panel-${preparation.id}`}
                                onClick={() =>
                                  setOpenPickupOperationId(preparation.id)
                                }
                                className="inline-flex min-h-10 shrink-0 items-center justify-center rounded-lg bg-red-700 px-3 py-2 text-xs font-bold text-white hover:bg-red-800 focus:outline-none focus:ring-2 focus:ring-red-700 focus:ring-offset-2"
                              >
                                Pick up item
                              </button>
                            ) : !preparation && item.outstandingQuantity > 0 ? (
                              <Link
                                to={`/ioio/return?bookingId=${encodeURIComponent(
                                  loan.id
                                )}&bookingAssetId=${encodeURIComponent(
                                  item.id
                                )}&assetId=${encodeURIComponent(
                                  item.asset.id
                                )}`}
                                className="shrink-0 rounded-lg bg-red-700 px-3 py-2 text-xs font-bold text-white hover:bg-red-800"
                              >
                                Return item
                              </Link>
                            ) : null}
                            {preparation ? (
                              <button
                                type="button"
                                className="shrink-0 rounded-lg border border-red-200 px-3 py-2 text-xs font-bold text-red-700 hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-600"
                                onClick={() => {
                                  setCancelSubmitted(false);
                                  setCancelRequest({
                                    id: preparation.id,
                                    title: displayName,
                                    isReadyForPickup:
                                      preparation.status === "READY_FOR_PICKUP",
                                  });
                                }}
                              >
                                Cancel request
                              </button>
                            ) : null}
                          </div>
                          {preparation?.status === "READY_FOR_PICKUP" &&
                          openPickupOperationId === preparation.id ? (
                            <section
                              id={`pickup-panel-${preparation.id}`}
                              aria-label={`Pick up ${formatStudentLabel(
                                displayName
                              )}`}
                              className="mt-4 border-t border-gray-100 pt-4"
                            >
                              <div className="hidden">
                                <div className="space-y-4">
                                  <div className="flex aspect-[4/3] max-h-52 items-center justify-center overflow-hidden rounded-xl bg-gray-50 p-2">
                                    <AssetImage
                                      asset={{
                                        id: item.asset.id,
                                        mainImage: item.asset.mainImage,
                                        thumbnailImage:
                                          item.asset.thumbnailImage,
                                        assetModel: item.asset.assetModel,
                                        kitImage: item.asset.kitImage,
                                      }}
                                      alt={`Image of ${formatStudentLabel(
                                        displayName
                                      )}`}
                                      useThumbnail={false}
                                      className="size-full"
                                    />
                                  </div>
                                  <div>
                                    <h3 className="text-lg font-black text-gray-950">
                                      {formatStudentLabel(
                                        item.kitName ?? item.asset.title
                                      )}
                                    </h3>
                                    <p className="mt-1 inline-flex rounded-lg bg-red-50 px-2.5 py-1 text-sm font-bold text-red-900">
                                      Assigned unit:{" "}
                                      {formatStudentLabel(displayName)}
                                    </p>
                                  </div>
                                  <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-1">
                                    <PickupInfoBlock
                                      icon={MapPin}
                                      label="Pickup location"
                                    >
                                      <span className="block font-semibold text-gray-950">
                                        {preparation.pickupRoomName
                                          ? formatStudentLabel(
                                              preparation.pickupRoomName
                                            )
                                          : formatStudentLabel(
                                              preparation.pickupLocation ??
                                                "Location not set"
                                            )}
                                      </span>
                                      {preparation.pickupRoomName &&
                                      preparation.pickupZoneName ? (
                                        <span className="block text-gray-700">
                                          {formatStudentLabel(
                                            preparation.pickupZoneName
                                          )}
                                        </span>
                                      ) : null}
                                    </PickupInfoBlock>
                                    <PickupInfoBlock
                                      icon={Clock3}
                                      label="Opening hours"
                                    >
                                      <span className="font-semibold text-gray-950">
                                        {preparation.pickupHours}
                                      </span>
                                      <OpeningHoursHelp />
                                    </PickupInfoBlock>
                                    <PickupInfoBlock
                                      icon={CalendarDays}
                                      label="Loan dates"
                                    >
                                      {preparation.from ? (
                                        <span className="block">
                                          Loan starts{" "}
                                          {formatStudentDateOnly(
                                            preparation.from
                                          )}
                                        </span>
                                      ) : null}
                                      <span className="block font-semibold text-gray-950">
                                        Return by{" "}
                                        {returnBy
                                          ? formatStudentDateOnly(returnBy)
                                          : "Date not set"}
                                      </span>
                                    </PickupInfoBlock>
                                  </div>
                                </div>
                                <div className="space-y-4">
                                  <div>
                                    <h3 className="text-base font-black text-gray-950">
                                      How to pick it up
                                    </h3>
                                    <ol className="mt-3 grid gap-2 sm:grid-cols-3 md:grid-cols-1 lg:grid-cols-3">
                                      {[
                                        "Go to the Pickup Zone.",
                                        `Find and verify ${formatStudentLabel(
                                          displayName
                                        )}.`,
                                        "Confirm pickup using the control below.",
                                      ].map((step, index) => (
                                        <li
                                          key={step}
                                          className="flex items-start gap-2 rounded-lg bg-gray-50 p-2.5 text-xs leading-5 text-gray-700"
                                        >
                                          <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-red-100 text-[11px] font-black text-red-800">
                                            {index + 1}
                                          </span>
                                          <span>{step}</span>
                                        </li>
                                      ))}
                                    </ol>
                                  </div>
                                  <div className="rounded-xl border border-gray-200 bg-white p-3">
                                    <h3 className="font-bold text-gray-950">
                                      Confirm your kit
                                    </h3>
                                    <StudentPickupForm
                                      operationId={preparation.id}
                                      needsUnitVerification={
                                        item.asset.type === "INDIVIDUAL"
                                      }
                                    />
                                  </div>
                                </div>
                              </div>
                              <StudentPickupForm
                                operationId={preparation.id}
                                needsUnitVerification={
                                  item.asset.type === "INDIVIDUAL"
                                }
                              />
                              <div className="mt-4 border-t border-gray-200">
                                <PickupDisclosure
                                  icon={CheckCircle2}
                                  title="How pickup works"
                                >
                                  <ol className="space-y-2">
                                    {[
                                      "Go to the Pickup Zone shown above.",
                                      `Find the assigned unit ${formatStudentLabel(
                                        displayName
                                      )}.`,
                                      "Check the unit number on its label or scan its QR code.",
                                      "Enter or scan that unit number in the confirmation field above.",
                                      "Confirm pickup only after the unit matches your assignment.",
                                    ].map((step, index) => (
                                      <li
                                        key={step}
                                        className="flex items-start gap-2"
                                      >
                                        <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-red-100 text-[11px] font-black text-red-800">
                                          {index + 1}
                                        </span>
                                        <span>{step}</span>
                                      </li>
                                    ))}
                                  </ol>
                                </PickupDisclosure>
                                <PickupDisclosure
                                  icon={Clock3}
                                  title="Opening hours & TA availability"
                                >
                                  <p className="font-semibold text-gray-950">
                                    {preparation.pickupHours}
                                  </p>
                                  <p className="mt-2">
                                    Most browsing, borrowing, pickups and
                                    returns should happen during IOIO Lab
                                    opening hours. TAs are normally available
                                    during these hours.
                                  </p>
                                  <p className="mt-2">
                                    If something is urgent, you can try to get
                                    help outside opening hours, but a TA may not
                                    be available.
                                  </p>
                                </PickupDisclosure>
                                <PickupDisclosure
                                  icon={CalendarDays}
                                  title="Pickup details"
                                >
                                  <dl className="grid gap-x-5 gap-y-2 sm:grid-cols-2">
                                    <div>
                                      <dt className="font-semibold text-gray-950">
                                        Pick up by
                                      </dt>
                                      <dd>
                                        {preparation.reviewedAt
                                          ? formatStudentDateOnly(
                                              getPreparationPickupDeadline(
                                                preparation.reviewedAt
                                              )
                                            )
                                          : "Date not set"}
                                      </dd>
                                    </div>
                                    {preparation.from ? (
                                      <div>
                                        <dt className="font-semibold text-gray-950">
                                          Loan starts
                                        </dt>
                                        <dd>
                                          {formatStudentDateOnly(
                                            preparation.from
                                          )}
                                        </dd>
                                      </div>
                                    ) : null}
                                    <div>
                                      <dt className="font-semibold text-gray-950">
                                        Return by
                                      </dt>
                                      <dd>
                                        {returnBy
                                          ? formatStudentDateOnly(returnBy)
                                          : "Date not set"}
                                      </dd>
                                    </div>
                                  </dl>
                                </PickupDisclosure>
                                <PickupDisclosure
                                  icon={CircleHelp}
                                  title="Need help?"
                                >
                                  <p>
                                    If the assigned unit is missing or its
                                    number does not match, ask a TA during
                                    opening hours. Do not confirm a different
                                    unit.
                                  </p>
                                  <p className="mt-2">
                                    After pickup, use the return instructions in
                                    My Loans and return the equipment by the
                                    date shown there.
                                  </p>
                                </PickupDisclosure>
                              </div>
                            </section>
                          ) : null}
                          {!preparation ? (
                            <details className="mt-2 border-t border-gray-100 pt-2">
                              <summary className="flex cursor-pointer list-none items-center gap-1 text-xs font-semibold text-gray-600">
                                <ChevronDown
                                  className="size-3"
                                  aria-hidden="true"
                                />
                                Expand details
                              </summary>
                              <div className="mt-3">
                                <dl className="grid gap-x-4 gap-y-2 text-sm text-gray-700 sm:grid-cols-2">
                                  <div>
                                    <dt className="font-medium">Borrowed</dt>
                                    <dd>{formatStudentDateOnly(loan.from)}</dd>
                                  </div>
                                  <div>
                                    <dt className="font-medium">
                                      Maximum borrowing period
                                    </dt>
                                    <dd>{item.maxBorrowDays ?? 45} days</dd>
                                  </div>
                                </dl>
                                {item.asset.returnHandling ===
                                  "RETURN_TO_RETURN_ZONE" && returnZone ? (
                                  <p className="mt-3 text-sm text-gray-700">
                                    <span className="font-medium">
                                      Return to
                                    </span>{" "}
                                    {returnZone.label}
                                  </p>
                                ) : null}
                              </div>
                              <div className="mt-3 flex flex-wrap items-center gap-3">
                                {loan.to ? (
                                  <ExtensionRequest
                                    bookingId={loan.id}
                                    bookingAssetId={item.id}
                                    currentDue={loan.to}
                                    request={pendingExtensions.find(
                                      (request) =>
                                        request.bookingAssetId === item.id
                                    )}
                                    extensionDays={
                                      item.extensionBorrowDays ??
                                      item.maxBorrowDays ??
                                      45
                                    }
                                  />
                                ) : null}
                                <Link
                                  to={`/ioio/report?assetId=${encodeURIComponent(
                                    item.asset.id
                                  )}&bookingId=${encodeURIComponent(
                                    loan.id
                                  )}&bookingAssetId=${encodeURIComponent(
                                    item.id
                                  )}`}
                                  className="text-sm font-semibold text-red-800 underline-offset-4 hover:underline"
                                >
                                  Report an issue
                                </Link>
                              </div>
                            </details>
                          ) : null}
                          {item.returnedQuantity > 0 ? (
                            <p className="mt-2 text-xs font-medium uppercase tracking-wide text-red-800">
                              Partial return
                            </p>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                </article>
              ))}
            </div>
          ) : (
            <div className="rounded-2xl border border-dashed border-gray-300 bg-white p-6 text-sm text-gray-600">
              No active loans.
            </div>
          )}
          <DialogPortal>
            <Dialog
              title="Review selected returns"
              open={returnReviewOpen}
              onClose={() => setReturnReviewOpen(false)}
              className="w-full max-w-xl"
            >
              <div className="space-y-3 p-6">
                <p className="text-sm text-gray-700">
                  Each item opens its own return confirmation and destination
                  steps. Nothing is marked returned until you confirm it there.
                </p>
                {selectedAssets.map(({ loan, item }) => {
                  const name = getIoioPhysicalUnitDisplayName({
                    logicalProductName: item.kitName ?? item.asset.title,
                    unitNumber: item.unitLabel,
                    ...(item.isKit || item.asset.type === "INDIVIDUAL"
                      ? { missingUnitLabel: "Unit number missing" }
                      : {}),
                  });
                  return (
                    <div
                      key={item.id}
                      className="flex items-center justify-between gap-3 rounded-lg border border-gray-200 p-3"
                    >
                      <span className="min-w-0 truncate text-sm font-semibold text-gray-900">
                        {formatStudentLabel(name)}
                      </span>
                      <Link
                        to={`/ioio/return?bookingId=${encodeURIComponent(
                          loan.id
                        )}&bookingAssetId=${encodeURIComponent(
                          item.id
                        )}&assetId=${encodeURIComponent(item.asset.id)}`}
                        className="shrink-0 rounded-lg bg-red-700 px-3 py-2 text-sm font-semibold text-white hover:bg-red-800"
                      >
                        Continue return
                      </Link>
                    </div>
                  );
                })}
              </div>
            </Dialog>
          </DialogPortal>
          {preparationRequests.length ? (
            <section
              className="mt-6 space-y-3"
              aria-labelledby="preparation-requests-heading"
            >
              <div>
                <h2
                  id="preparation-requests-heading"
                  className="text-xl font-black text-gray-950"
                >
                  Preparation requested
                </h2>
                <p className="mt-1 text-sm text-gray-600">
                  A TA will choose and check the exact equipment for you.
                </p>
              </div>
              {preparationRequests.map((request) => (
                <article
                  key={request.id}
                  className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm"
                >
                  <div className="flex items-start gap-3">
                    {request.asset ? (
                      <Link
                        to={`/ioio/browse/${request.asset.id}`}
                        aria-label={`View ${formatStudentLabel(request.title)}`}
                        className="size-16 shrink-0 overflow-hidden rounded-xl bg-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700"
                      >
                        <AssetImage
                          asset={request.asset}
                          alt={`Image of ${formatStudentLabel(request.title)}`}
                          useThumbnail={false}
                          className="size-full"
                        />
                      </Link>
                    ) : null}
                    <div className="min-w-0 flex-1">
                      <h3 className="font-bold text-gray-950">
                        {request.asset ? (
                          <Link
                            to={`/ioio/browse/${request.asset.id}`}
                            className="hover:text-red-800 hover:underline"
                          >
                            {request.title}
                          </Link>
                        ) : (
                          request.title
                        )}
                      </h3>
                      <p className="mt-1 flex items-center gap-1.5 text-sm font-semibold text-amber-800">
                        Preparation requested
                        <PreparationRequestHelp
                          pickupHours={request.pickupHours}
                        />
                      </p>
                      <p className="text-sm text-gray-700">
                        {request.quantity}{" "}
                        {request.quantity === 1 ? "item" : "items"} · Requested{" "}
                        {formatStudentDateOnly(request.createdAt)}
                      </p>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                    <p className="text-sm text-gray-600">
                      We&apos;ll notify you when it&apos;s ready.
                    </p>
                    <button
                      type="button"
                      className="rounded-md border border-red-200 px-3 py-1.5 text-sm font-semibold text-red-700 hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-600"
                      onClick={() => {
                        setCancelSubmitted(false);
                        setCancelRequest({
                          id: request.id,
                          title: request.title,
                          isReadyForPickup: false,
                        });
                      }}
                    >
                      Cancel request
                    </button>
                  </div>
                </article>
              ))}
            </section>
          ) : null}
          <DialogPortal>
            <Dialog
              title="Cancel preparation request?"
              open={Boolean(cancelRequest)}
              onClose={() => {
                if (cancelFetcher.state === "idle") setCancelRequest(null);
              }}
              className="md:max-w-md"
            >
              {cancelRequest ? (
                <cancelFetcher.Form
                  method="post"
                  className="space-y-4 p-6"
                  onSubmit={() => setCancelSubmitted(true)}
                >
                  <input
                    type="hidden"
                    name="intent"
                    value="cancel-preparation-request"
                  />
                  <input
                    type="hidden"
                    name="operationId"
                    value={cancelRequest.id}
                  />
                  <p className="text-sm text-gray-700">
                    {cancelRequest.isReadyForPickup ? (
                      <>
                        <span className="block font-semibold text-gray-900">
                          {cancelRequest.title} has already been prepared for
                          you.
                        </span>
                        <span className="mt-2 block">
                          A TA will need to return it to inventory.
                        </span>
                      </>
                    ) : (
                      <>
                        {cancelRequest.title} will no longer be prepared for
                        you. Its reservation will be released.
                      </>
                    )}
                  </p>
                  {cancelSubmitted &&
                  cancelFetcher.data &&
                  !cancelFetcher.data.ok ? (
                    <p
                      role="alert"
                      className="text-sm font-medium text-red-700"
                    >
                      {cancelFetcher.data.error}
                    </p>
                  ) : null}
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      className="rounded-md border border-gray-300 px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                      disabled={cancelFetcher.state !== "idle"}
                      onClick={() => setCancelRequest(null)}
                    >
                      Keep request
                    </button>
                    <button
                      type="submit"
                      className="rounded-md bg-red-700 px-3 py-2 text-sm font-semibold text-white hover:bg-red-800 disabled:opacity-50"
                      disabled={cancelFetcher.state !== "idle"}
                    >
                      {cancelFetcher.state === "idle"
                        ? "Cancel request"
                        : "Cancelling…"}
                    </button>
                  </div>
                </cancelFetcher.Form>
              ) : null}
            </Dialog>
          </DialogPortal>
          {pendingLoanGroups.length ? (
            <section
              className="mt-8 space-y-3"
              aria-labelledby="pending-returns-heading"
            >
              <div>
                <h2
                  id="pending-returns-heading"
                  className="text-xl font-black text-gray-950"
                >
                  Pending returns
                </h2>
                <p className="mt-1 text-sm text-gray-600">
                  A TA will check these items before they become available
                  again.
                </p>
              </div>
              {pendingLoanGroups.map((loan) =>
                loan.bookingAssets.map((item) => {
                  const displayName = getIoioPhysicalUnitDisplayName({
                    logicalProductName: item.kitName ?? item.asset.title,
                    unitNumber: item.unitLabel,
                    ...(item.isKit || item.asset.type === "INDIVIDUAL"
                      ? { missingUnitLabel: "Unit number missing" }
                      : {}),
                  });
                  return (
                    <article
                      key={`${loan.id}-${item.id}`}
                      className="rounded-2xl border border-blue-200 bg-blue-50 p-4"
                    >
                      <div className="flex gap-3">
                        <Link
                          to={`/ioio/browse/${item.asset.id}`}
                          aria-label={`View ${formatStudentLabel(displayName)}`}
                          className="size-16 shrink-0 overflow-hidden rounded-xl bg-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700"
                        >
                          <AssetImage
                            asset={{
                              id: item.asset.id,
                              mainImage: item.asset.mainImage,
                              thumbnailImage: item.asset.thumbnailImage,
                              assetModel: item.asset.assetModel,
                              kitImage: item.asset.kitImage,
                            }}
                            alt={`Image of ${formatStudentLabel(displayName)}`}
                            useThumbnail={false}
                            className="size-full"
                          />
                        </Link>
                        <div>
                          <p className="font-bold text-gray-950">
                            <Link
                              to={`/ioio/browse/${item.asset.id}`}
                              className="hover:text-red-800 hover:underline"
                            >
                              {formatStudentLabel(displayName)}
                            </Link>
                          </p>
                          {isProblemReturn(item.id) ? (
                            <p className="mt-1 text-sm font-semibold text-blue-900">
                              Returned · Issue reported · Awaiting TA review
                            </p>
                          ) : (
                            <p className="mt-1 text-sm font-semibold text-blue-900">
                              Returned · Awaiting TA check
                            </p>
                          )}
                        </div>
                      </div>
                    </article>
                  );
                })
              )}
            </section>
          ) : null}
        </section>
      ) : (
        <PastLoansSection
          loans={pastLoans}
          cancelledPreparations={cancelledPreparationHistory}
        />
      )}
    </div>
  );
}

function StudentPickupForm({
  operationId,
  needsUnitVerification,
}: {
  operationId: string;
  needsUnitVerification: boolean;
}) {
  const fetcher = useFetcher<typeof action>();
  const [verificationValue, setVerificationValue] = useState("");
  const [scanOpen, setScanOpen] = useState(false);
  const [scanPaused, setScanPaused] = useState(false);
  const errorMessage =
    fetcher.data && !fetcher.data.ok ? fetcher.data.error : null;
  return (
    <fetcher.Form method="post" className="mt-3 space-y-2">
      <input type="hidden" name="intent" value="confirm-pickup" />
      <input type="hidden" name="operationId" value={operationId} />
      {needsUnitVerification ? (
        <>
          <label className="block text-xs font-semibold text-gray-800">
            Scan the assigned unit QR or enter its unit number
            <input
              name="verificationValue"
              value={verificationValue}
              onChange={(event) => setVerificationValue(event.target.value)}
              required
              autoComplete="off"
              placeholder="Scan QR or enter #001"
              className="mt-1 min-h-10 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm font-normal"
            />
          </label>
          <button
            type="button"
            onClick={() => {
              setScanOpen((open) => !open);
              setScanPaused(false);
            }}
            className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs font-bold text-gray-700 hover:border-red-300 hover:text-red-800"
          >
            {scanOpen ? "Close scanner" : "Scan QR"}
          </button>
          {scanOpen ? (
            <div className="mx-auto aspect-video w-full max-w-2xl overflow-hidden rounded-lg border border-gray-200 bg-slate-900">
              <CodeScanner
                className="!h-full !min-h-0 w-full"
                overlayPosition="centered"
                forceMode="camera"
                allowNonShelfCodes
                hideBackButtonText
                paused={scanPaused}
                setPaused={setScanPaused}
                onCodeDetectionSuccess={({ value }) => {
                  setVerificationValue(value);
                  setScanPaused(true);
                  setScanOpen(false);
                }}
              />
            </div>
          ) : null}
        </>
      ) : null}
      {errorMessage ? (
        <p role="alert" className="text-xs font-semibold text-red-800">
          {errorMessage}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={
          fetcher.state !== "idle" ||
          (needsUnitVerification && !verificationValue.trim())
        }
        className="rounded-xl bg-red-700 px-4 py-2 text-sm font-bold text-white hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {fetcher.state === "submitting" ? "Confirming…" : "Confirm pickup"}
      </button>
    </fetcher.Form>
  );
}

function PastLoansSection({
  loans,
  cancelledPreparations,
}: {
  loans: Awaited<ReturnType<typeof getMyStudentLoans>>;
  cancelledPreparations: Array<{
    id: string;
    title: string;
    cancelledAt: Date;
    status: string;
    statusLabel: string;
    pickupLocation: string | null;
    asset: AssetForThumbnail | null;
  }>;
}) {
  return (
    <section aria-labelledby="past-loans-heading">
      <h2
        id="past-loans-heading"
        className="mb-3 text-xl font-black text-gray-950"
      >
        Past loans
      </h2>
      {loans.length ? (
        <div className="space-y-3">
          {loans.map((loan) => (
            <article
              key={loan.id}
              className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <h3 className="font-semibold text-gray-950">
                  {getStudentLoanHeading(loan)}
                </h3>
                <span className="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-semibold text-gray-700">
                  {loan.status === "COMPLETE" ? "Returned" : "Completed"}
                </span>
              </div>
              <dl className="mt-3 grid gap-x-4 gap-y-1 text-sm text-gray-700 sm:grid-cols-3">
                <div>
                  <dt className="font-medium">Borrowed</dt>
                  <dd>{formatStudentDateOnly(loan.from)}</dd>
                </div>
                <div>
                  <dt className="font-medium">Returned</dt>
                  <dd>
                    {getLoanReturnedAt(loan)
                      ? formatStudentDateOnly(getLoanReturnedAt(loan)!)
                      : "Not recorded"}
                  </dd>
                </div>
                <div>
                  <dt className="font-medium">Status</dt>
                  <dd>
                    {loan.status === "COMPLETE" ? "Returned" : "Completed"}
                  </dd>
                </div>
              </dl>
              <ul className="mt-3 space-y-2 text-sm text-gray-700">
                {loan.bookingAssets.map((item) => {
                  const displayName = getIoioPhysicalUnitDisplayName({
                    logicalProductName: item.kitName ?? item.asset.title,
                    unitNumber: item.unitLabel,
                    ...(item.isKit || item.asset.type === "INDIVIDUAL"
                      ? { missingUnitLabel: "Unit number missing" }
                      : {}),
                  });
                  return (
                    <li
                      key={`${loan.id}-${item.id}`}
                      className="flex items-center gap-3 rounded-xl border border-gray-200 bg-gray-50 p-3"
                    >
                      <Link
                        to={`/ioio/browse/${item.asset.id}`}
                        aria-label={`View ${formatStudentLabel(displayName)}`}
                        className="size-16 shrink-0 overflow-hidden rounded-xl bg-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700"
                      >
                        <AssetImage
                          asset={{
                            id: item.asset.id,
                            mainImage: item.asset.mainImage,
                            thumbnailImage: item.asset.thumbnailImage,
                            assetModel: item.asset.assetModel,
                            kitImage: item.asset.kitImage,
                          }}
                          alt={`Image of ${formatStudentLabel(displayName)}`}
                          useThumbnail={false}
                          className="size-full"
                        />
                      </Link>
                      <div className="min-w-0 flex-1">
                        <p className="font-medium text-gray-950">
                          <Link
                            to={`/ioio/browse/${item.asset.id}`}
                            className="hover:text-red-800 hover:underline"
                          >
                            {formatStudentLabel(displayName)}
                          </Link>
                        </p>
                        <p className="mt-1 text-xs text-gray-600">
                          Quantity: {item.borrowedQuantity}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </article>
          ))}
        </div>
      ) : cancelledPreparations.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-gray-300 bg-white p-6 text-sm text-gray-600">
          No past loans yet.
        </div>
      ) : null}
      {cancelledPreparations.length ? (
        <div className="mt-4 space-y-2" aria-label="Cancelled requests">
          {cancelledPreparations.map((request) => (
            <article
              key={request.id}
              className="flex items-center gap-3 rounded-xl border border-gray-200 bg-white p-3"
            >
              {request.asset ? (
                <Link
                  to={`/ioio/browse/${request.asset.id}`}
                  aria-label={`View ${formatStudentLabel(request.title)}`}
                  className="size-12 shrink-0 overflow-hidden rounded-lg bg-gray-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700"
                >
                  <AssetImage
                    asset={request.asset}
                    alt={`Image of ${formatStudentLabel(request.title)}`}
                    useThumbnail={false}
                    className="size-full"
                  />
                </Link>
              ) : null}
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-gray-950">
                  {request.asset ? (
                    <Link
                      to={`/ioio/browse/${request.asset.id}`}
                      className="hover:text-red-800 hover:underline"
                    >
                      {formatStudentLabel(request.title)}
                    </Link>
                  ) : (
                    formatStudentLabel(request.title)
                  )}
                </p>
                {request.pickupLocation ? (
                  <p className="text-xs text-gray-600">
                    {formatStudentLabel(request.pickupLocation)}
                  </p>
                ) : null}
                <p className="text-xs text-gray-500">
                  {request.statusLabel} ·{" "}
                  {formatStudentDateOnly(request.cancelledAt)}
                </p>
              </div>
              <span className="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-semibold text-gray-700">
                {request.statusLabel}
              </span>
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function getStudentLoanHeading(
  loan: Awaited<ReturnType<typeof getMyStudentLoans>>[number]
) {
  const names = Array.from(
    new Set(
      loan.bookingAssets.map((item) =>
        formatStudentLabel(
          getIoioPhysicalUnitDisplayName({
            logicalProductName: item.kitName ?? item.asset.title,
            unitNumber: item.unitLabel,
            ...(item.isKit || item.asset.type === "INDIVIDUAL"
              ? { missingUnitLabel: "Unit number missing" }
              : {}),
          })
        )
      )
    )
  );
  if (names.length === 1) return names[0];
  if (names.length > 1) return `${names[0]} + ${names.length - 1} more`;
  return formatStudentLabel(loan.name);
}

function PickupDisclosure({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof CircleHelp;
  title: string;
  children: ReactNode;
}) {
  return (
    <details className="group border-b border-gray-200 last:border-b-0">
      <summary className="flex min-h-12 cursor-pointer list-none items-center gap-2.5 py-2 text-sm font-semibold text-gray-800 marker:hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-red-700 [&::-webkit-details-marker]:hidden">
        <Icon className="size-4 shrink-0 text-gray-500" aria-hidden="true" />
        <span className="min-w-0 flex-1">{title}</span>
        <ChevronDown
          className="size-4 shrink-0 text-gray-500 transition-transform group-open:rotate-180"
          aria-hidden="true"
        />
      </summary>
      <div className="pb-3 pl-6 text-sm leading-5 text-gray-700">
        {children}
      </div>
    </details>
  );
}

function getLoanReturnedAt(
  loan: Awaited<ReturnType<typeof getMyStudentLoans>>[number]
) {
  return (
    loan.bookingAssets
      .map((item) => item.returnedAt)
      .filter((date): date is Date => Boolean(date))
      .sort(
        (left, right) => new Date(right).getTime() - new Date(left).getTime()
      )[0] ?? null
  );
}

function ExtensionRequest({
  bookingId,
  bookingAssetId,
  currentDue,
  request,
  extensionDays,
}: {
  bookingId: string;
  bookingAssetId: string;
  currentDue: Date | string;
  request?: {
    status: string;
    to: Date | null;
    reviewComment: string | null;
    reviewer: {
      displayName: string | null;
      firstName: string | null;
      lastName: string | null;
      email: string;
    } | null;
  };
  extensionDays: number;
}) {
  const fetcher = useFetcher<typeof action>();
  const [open, setOpen] = useState(false);
  const due = new Date(currentDue);
  const hasDueDate = !Number.isNaN(due.getTime());
  const requestedDue = hasDueDate
    ? addCalendarDaysUtcEnd(due, extensionDays)
    : null;
  const reviewerName = request?.reviewer
    ? request.reviewer.displayName ||
      [request.reviewer.firstName, request.reviewer.lastName]
        .filter(Boolean)
        .join(" ") ||
      "TA"
    : null;
  useEffect(() => {
    if (fetcher.data?.ok) setOpen(false);
  }, [fetcher.data]);
  if (request?.status === "PENDING_APPROVAL") {
    return (
      <p className="text-sm font-medium text-blue-800">
        Extension request waiting for a TA
      </p>
    );
  }
  if (!requestedDue) {
    return null;
  }
  return (
    <>
      {request?.status === "APPROVED" ? (
        <p className="text-xs font-medium text-green-800">
          Extension approved
          {request.to ? ` · ${formatStudentDateOnly(request.to)}` : ""}
        </p>
      ) : request?.status === "REJECTED" ? (
        <p className="text-xs font-medium text-amber-800">
          Extension declined
          {reviewerName ? ` · Reviewed by ${reviewerName}` : ""}
        </p>
      ) : null}
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-sm font-semibold text-red-800 underline-offset-2 hover:underline"
      >
        Request extension
      </button>
      <DialogPortal>
        <Dialog
          title="Request extension"
          open={open}
          onClose={() => setOpen(false)}
          className="w-full max-w-lg"
        >
          <fetcher.Form method="post" className="space-y-4 p-6">
            <input type="hidden" name="intent" value="request-extension" />
            <input type="hidden" name="bookingId" value={bookingId} />
            <input type="hidden" name="bookingAssetId" value={bookingAssetId} />
            {request?.status === "REJECTED" &&
            (request.reviewComment || request.reviewer?.email) ? (
              <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-950">
                {request.reviewComment ? <p>{request.reviewComment}</p> : null}
                {request.reviewer?.email ? (
                  <a
                    className="mt-1 inline-block font-semibold underline"
                    href={`mailto:${request.reviewer.email}`}
                  >
                    Contact a TA
                  </a>
                ) : null}
              </div>
            ) : null}
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="font-medium text-gray-600">
                  Current return date
                </dt>
                <dd className="font-semibold text-gray-950">
                  {formatStudentDateOnly(currentDue)}
                </dd>
              </div>
              <div>
                <dt className="font-medium text-gray-600">New return date</dt>
                <dd className="font-semibold text-gray-950">
                  {formatStudentDateOnly(requestedDue)}
                </dd>
              </div>
            </dl>
            <p className="text-sm text-gray-600">
              This {extensionDays}-day extension requires TA approval.
            </p>
            <label className="block text-sm font-semibold text-gray-800">
              Message to a TA <span className="font-normal">(optional)</span>
              <textarea
                name="message"
                rows={3}
                maxLength={1000}
                className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-normal text-gray-950"
                placeholder="Add context for a TA"
              />
            </label>
            {fetcher.data && !fetcher.data.ok ? (
              <p role="alert" className="text-sm font-semibold text-red-800">
                {fetcher.data.error}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={fetcher.state !== "idle"}
                className="rounded-lg bg-red-700 px-4 py-2 text-sm font-semibold text-white hover:bg-red-800 disabled:opacity-50"
              >
                {fetcher.state === "submitting"
                  ? "Requesting…"
                  : "Request extension"}
              </button>
            </div>
          </fetcher.Form>
        </Dialog>
      </DialogPortal>
    </>
  );
}

function _ReturnLoanAction({
  bookingId,
  bookingAssetId,
  assetId,
  quantity,
  pending,
}: {
  bookingId: string;
  bookingAssetId: string;
  assetId: string;
  quantity: number;
  pending: boolean;
}) {
  const fetcher = useFetcher<ReturnActionData>();
  const [proposal, setProposal] = useState<PreparedReturnProposal | null>(null);
  const [submitted, setSubmitted] = useState(pending);

  useEffect(() => {
    const result = fetcher.data;
    if (!result || !result.ok) return;
    if (result.intent === "return-prepared") setProposal(result.proposal);
    if (result.intent === "return-submitted") {
      setProposal(null);
      setSubmitted(true);
    }
    if (result.intent === "return-cancelled") setProposal(null);
  }, [fetcher.data]);

  if (submitted) {
    return (
      <p className="mt-3 rounded-lg bg-blue-50 p-3 text-sm font-semibold text-blue-900">
        Return submitted. Place the item in the IOIO Return Zone. A TA will
        check it before it becomes available again.
      </p>
    );
  }

  if (proposal) {
    return (
      <div className="mt-3 rounded-xl border border-green-200 bg-green-50 p-3">
        <p className="text-sm font-semibold text-gray-950">
          Return {proposal.asset.title}
        </p>
        <p className="mt-1 text-sm text-gray-700">
          Confirm the exact physical item, then place it in the IOIO Return
          Zone.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="submit-return" />
            <input
              type="hidden"
              name="confirmationToken"
              value={proposal.confirmationToken}
            />
            <input type="hidden" name="quantity" value={proposal.quantity} />
            <button
              type="submit"
              disabled={fetcher.state !== "idle"}
              className="rounded-xl bg-red-700 px-4 py-2 text-sm font-bold text-white hover:bg-red-800 disabled:opacity-50"
            >
              I&apos;ve placed it in the Return Zone
            </button>
          </fetcher.Form>
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="cancel-return" />
            <input
              type="hidden"
              name="confirmationToken"
              value={proposal.confirmationToken}
            />
            <button
              type="submit"
              disabled={fetcher.state !== "idle"}
              className="rounded-xl border border-gray-300 px-4 py-2 text-sm font-bold text-gray-700 hover:border-red-200 hover:text-red-800 disabled:opacity-50"
            >
              Cancel
            </button>
          </fetcher.Form>
        </div>
      </div>
    );
  }

  return quantity > 0 ? (
    <div className="mt-3 flex flex-wrap items-center gap-3">
      <fetcher.Form method="post">
        <input type="hidden" name="intent" value="prepare-return" />
        <input type="hidden" name="bookingId" value={bookingId} />
        <input type="hidden" name="bookingAssetId" value={bookingAssetId} />
        <input type="hidden" name="assetId" value={assetId} />
        <input type="hidden" name="quantity" value={quantity} />
        <button
          type="submit"
          disabled={fetcher.state !== "idle"}
          className="rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm font-bold text-red-800 hover:border-red-400 hover:bg-red-100 disabled:opacity-50"
        >
          Return item
        </button>
      </fetcher.Form>
      <Link
        to={`/ioio/report?assetId=${encodeURIComponent(
          assetId
        )}&bookingId=${encodeURIComponent(
          bookingId
        )}&bookingAssetId=${encodeURIComponent(bookingAssetId)}`}
        className="text-sm font-semibold text-red-800 underline-offset-4 hover:underline"
      >
        Report an issue
      </Link>
    </div>
  ) : null;
}

function PreparationRequestHelp({ pickupHours }: { pickupHours: string }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="About preparation and pickup"
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-full text-gray-500 hover:bg-amber-50 hover:text-amber-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-700"
        >
          <CircleHelp className="size-4" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverPortal>
        <PopoverContent
          side="bottom"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          className="z-50 w-[calc(100vw-2rem)] max-w-sm rounded-lg border border-gray-200 bg-white p-4 text-left text-sm shadow-lg outline-none"
        >
          <h3 className="font-semibold text-gray-900">Preparation requested</h3>
          <div className="mt-2 space-y-2 text-gray-700">
            <p>A TA will prepare this equipment for you.</p>
            <p>
              You&apos;ll receive a notification when it is ready, and My Loans
              will show where to collect it.
            </p>
            <p>
              Preparation and pickup follow the current IOIO Lab opening hours:
              <br />
              <span className="font-medium text-gray-900">{pickupHours}</span>
            </p>
            <p className="text-xs text-gray-500">
              A TA may not be available outside these hours.
            </p>
          </div>
        </PopoverContent>
      </PopoverPortal>
    </Popover>
  );
}

function PickupInfoBlock({
  icon: Icon,
  label,
  children,
}: {
  icon: typeof MapPin;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white px-3 py-2.5">
      <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-gray-500">
        <Icon className="size-3.5 text-gray-600" aria-hidden="true" />
        {label}
      </p>
      <div className="mt-1 text-sm leading-5 text-gray-800">{children}</div>
    </div>
  );
}

function OpeningHoursHelp() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Why opening hours?"
          className="ml-1 inline-flex size-6 shrink-0 items-center justify-center rounded-full text-gray-500 hover:bg-gray-100 hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-700"
        >
          <CircleHelp className="size-4" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverPortal>
        <PopoverContent
          side="bottom"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          className="z-50 w-[calc(100vw-2rem)] max-w-sm rounded-xl border border-gray-200 bg-white p-4 text-sm text-gray-700 shadow-lg outline-none"
        >
          <h3 className="font-semibold text-gray-950">Why opening hours?</h3>
          <p className="mt-2 leading-5">{IOIO_OPENING_HOURS_GUIDANCE}</p>
        </PopoverContent>
      </PopoverPortal>
    </Popover>
  );
}
