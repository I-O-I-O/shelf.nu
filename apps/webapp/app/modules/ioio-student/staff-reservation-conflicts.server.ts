import { AssetType, BookingStatus } from "@prisma/client";
import { db } from "~/database/db.server";
import { sendEmail } from "~/emails/mail.server";
import { SERVER_URL } from "~/utils/env";
import { ShelfError } from "~/utils/error";
import { getIoioAvailability } from "./availability.server";

const ACTIVE_LOAN_STATUSES = [
  BookingStatus.ONGOING,
  BookingStatus.OVERDUE,
] as const;

export type IoioStaffLoanConflict = {
  bookingId: string;
  bookingAssetId: string;
  assetId: string;
  itemName: string;
  borrowerName: string;
  currentReturnDate: string;
  status: BookingStatus;
  quantity: number;
};

function displayUserName(user: {
  displayName: string | null;
  firstName: string | null;
  lastName: string | null;
}) {
  return (
    user.displayName ||
    [user.firstName, user.lastName].filter(Boolean).join(" ") ||
    "Student"
  );
}

function formatDate(date: Date) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(date);
}

export async function getIoioStaffLoanConflicts({
  organizationId,
  assetIds,
  from,
  to,
}: {
  organizationId: string;
  assetIds: string[];
  from: Date;
  to: Date;
}): Promise<IoioStaffLoanConflict[]> {
  if (assetIds.length === 0) return [];

  const rows = await db.bookingAsset.findMany({
    where: {
      assetId: { in: assetIds },
      booking: {
        organizationId,
        status: { in: [...ACTIVE_LOAN_STATUSES] },
        OR: [
          { status: BookingStatus.OVERDUE },
          {
            status: BookingStatus.ONGOING,
            from: { lt: to },
            to: { gt: from },
          },
        ],
      },
    },
    select: {
      id: true,
      assetId: true,
      quantity: true,
      asset: { select: { title: true } },
      booking: {
        select: {
          id: true,
          status: true,
          to: true,
          custodianUser: {
            select: {
              displayName: true,
              firstName: true,
              lastName: true,
            },
          },
        },
      },
    },
    orderBy: [{ booking: { to: "asc" } }, { assetId: "asc" }],
  });

  return rows.map((row) => ({
    bookingId: row.booking.id,
    bookingAssetId: row.id,
    assetId: row.assetId,
    itemName: row.asset.title,
    borrowerName: row.booking.custodianUser
      ? displayUserName(row.booking.custodianUser)
      : "Student",
    currentReturnDate: row.booking.to.toISOString(),
    status: row.booking.status,
    quantity: row.quantity,
  }));
}

export async function getIoioStaffReservationConflictSummary({
  organizationId,
  productId,
  candidateAssetIds,
  quantity,
  from,
  to,
}: {
  organizationId: string;
  productId: string;
  candidateAssetIds?: string[];
  quantity: number;
  from: Date;
  to: Date;
}) {
  const product = await db.asset.findFirst({
    where: { id: productId, organizationId },
    select: { type: true, assetModelId: true },
  });
  const availability = await getIoioAvailability({
    organizationId,
    productId,
    candidateAssetIds,
    from,
    to,
  });
  const conflictAssetIds =
    product?.type === AssetType.INDIVIDUAL
      ? candidateAssetIds?.length
        ? candidateAssetIds
        : product.assetModelId
        ? (
            await db.asset.findMany({
              where: {
                organizationId,
                type: AssetType.INDIVIDUAL,
                assetModelId: product.assetModelId,
              },
              select: { id: true },
            })
          ).map((asset) => asset.id)
        : [productId]
      : [productId];
  const conflicts = await getIoioStaffLoanConflicts({
    organizationId,
    assetIds: conflictAssetIds,
    from,
    to,
  });
  const loanBookingIds = [
    ...new Set(conflicts.map((conflict) => conflict.bookingId)),
  ];
  const softConflictBookingIds = [
    ...new Set([...loanBookingIds, ...availability.staffReservationBookingIds]),
  ];
  const availabilityWithoutSoftConflicts = softConflictBookingIds.length
    ? await getIoioAvailability({
        organizationId,
        productId,
        candidateAssetIds,
        from,
        to,
        excludeBookingIds: softConflictBookingIds,
      })
    : availability;

  const requested = quantity;
  const available = availability.availableCount;
  const shortfall = Math.max(0, requested - available);
  const loanConflictQuantity =
    product?.type === AssetType.INDIVIDUAL
      ? new Set(conflicts.map((conflict) => conflict.assetId)).size
      : conflicts.reduce((sum, conflict) => sum + conflict.quantity, 0);

  return {
    total: availability.totalActive,
    available,
    requested,
    shortfall,
    loanConflictQuantity,
    conflicts,
    staffReservedCount: availability.staffReservedCount,
    staffReservationBookingIds: availability.staffReservationBookingIds,
    availableAfterSoftConflicts:
      availabilityWithoutSoftConflicts.availableCount,
    availableUnitIdsAfterSoftConflicts:
      availabilityWithoutSoftConflicts.availableUnitIds,
    loanBookingIds,
    softConflictBookingIds,
  };
}

export async function requestIoioEarlierReturn({
  organizationId,
  bookingId,
  bookingAssetId,
  reservationName,
  reservationStart,
  newReturnDate,
}: {
  organizationId: string;
  bookingId: string;
  bookingAssetId: string;
  reservationName: string;
  reservationStart: Date;
  newReturnDate: Date;
}) {
  const conflict = await db.bookingAsset.findFirst({
    where: {
      id: bookingAssetId,
      bookingId,
      booking: {
        organizationId,
        status: { in: [...ACTIVE_LOAN_STATUSES] },
      },
    },
    select: {
      id: true,
      asset: { select: { title: true } },
      booking: {
        select: {
          id: true,
          from: true,
          to: true,
          custodianUser: { select: { email: true } },
        },
      },
    },
  });
  if (!conflict) {
    throw new ShelfError({
      cause: null,
      message: "The active loan could not be found in this workspace.",
      label: "Booking",
      status: 404,
      shouldBeCaptured: false,
    });
  }
  if (!conflict.booking.custodianUser?.email) {
    throw new ShelfError({
      cause: null,
      message: "This loan has no borrower email for an early return request.",
      label: "Booking",
      status: 400,
      shouldBeCaptured: false,
    });
  }

  const now = new Date();
  if (newReturnDate <= now || newReturnDate >= reservationStart) {
    throw new ShelfError({
      cause: null,
      message:
        "Choose a new return date before the reservation starts and not before today.",
      label: "Booking",
      status: 400,
      shouldBeCaptured: false,
    });
  }
  if (
    newReturnDate <= conflict.booking.from ||
    newReturnDate >= conflict.booking.to
  ) {
    throw new ShelfError({
      cause: null,
      message: "The new return date must shorten the current loan period.",
      label: "Booking",
      status: 400,
      shouldBeCaptured: false,
    });
  }

  const updated = await db.booking.updateMany({
    where: {
      id: conflict.booking.id,
      organizationId,
      status: { in: [...ACTIVE_LOAN_STATUSES] },
    },
    data: { to: newReturnDate },
  });
  if (updated.count !== 1) {
    throw new ShelfError({
      cause: null,
      message:
        "This loan changed before the return date could be updated. Refresh and try again.",
      label: "Booking",
      status: 409,
      shouldBeCaptured: false,
    });
  }

  const itemName = conflict.asset.title;
  const text = [
    `${itemName} is needed for ${reservationName} beginning ${formatDate(
      reservationStart
    )}.`,
    `Please return it by ${formatDate(newReturnDate)}.`,
    `Previous return date: ${formatDate(conflict.booking.to)}`,
    `New required return date: ${formatDate(newReturnDate)}`,
    "",
    `View My Loans: ${SERVER_URL}/ioio/loans`,
  ].join("\n");
  sendEmail({
    to: conflict.booking.custodianUser.email,
    subject: `Return requested: ${itemName}`,
    text,
  });

  return {
    bookingId: conflict.booking.id,
    bookingAssetId: conflict.id,
    itemName,
    newReturnDate: newReturnDate.toISOString(),
  };
}

export function getIoioReservationConflictDisplayDate(value: string) {
  return formatDate(new Date(value));
}

export function getIoioStaffConflictQuantity(
  productType: AssetType,
  conflicts: IoioStaffLoanConflict[]
) {
  return productType === AssetType.INDIVIDUAL
    ? new Set(conflicts.map((conflict) => conflict.assetId)).size
    : conflicts.reduce((sum, conflict) => sum + conflict.quantity, 0);
}
