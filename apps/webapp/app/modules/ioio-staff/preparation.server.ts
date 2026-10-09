import { AssetType, BookingStatus } from "@prisma/client";
import { db } from "~/database/db.server";
import { sendEmail } from "~/emails/mail.server";
import {
  getPhysicalUnitNumberFromTitle,
  normalizePhysicalUnitNumber,
} from "~/modules/asset/physical-unit";
import { BOOKING_SCHEDULER_EVENTS_ENUM } from "~/modules/booking/constants";
import {
  createBooking,
  cancelBooking,
  checkoutBooking,
  partialCheckoutBooking,
  deleteBooking,
  reserveBooking,
  updateBookingAssets,
} from "~/modules/booking/service.server";
import { shouldSendOptionalEmail } from "~/modules/email-preferences/service.server";
import { getEmailTemplateDefinition } from "~/modules/email-templates/definitions";
import {
  getResolvedEmailTemplate,
  renderEmailTemplate,
} from "~/modules/email-templates/service.server";
import {
  ensurePickupZone,
  getPickupLocationDisplay,
} from "~/modules/ioio-staff/pickup-zone.server";
import {
  formatPickupHours,
  getPreparationPickupDeadline,
} from "~/modules/ioio-staff/preparation";
import { assertAnnualAccessApproved } from "~/modules/ioio-student/annual-access.server";
import {
  getIoioAvailability,
  IOIO_STAFF_RESERVATION_ACKNOWLEDGEMENT,
} from "~/modules/ioio-student/availability.server";
import { getImmediateBorrowingWindow } from "~/modules/ioio-student/date-range";
import { normalizeQrScanValue } from "~/modules/qr/normalize-scan-value";
import { getWorkingHoursForOrganization } from "~/modules/working-hours/service.server";
import { ShelfError } from "~/utils/error";
import { QueueNames, scheduler } from "~/utils/scheduler.server";
import { resolveUserDisplayName } from "~/utils/user";

export const IOIO_PREPARATION_OPERATION = "IOIO_PREPARATION";
export const PREPARATION_PENDING = "PENDING_PREPARATION";
export const PREPARATION_READY = "READY_FOR_PICKUP";
export const PREPARATION_PICKED_UP = "PICKED_UP";
export const PREPARATION_CANCELLED_PICKUP = "CANCELLED_PICKUP";
function getStoredAssetIds(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((id): id is string => typeof id === "string"))]
    : [];
}

/**
 * Staff assigns available units to a logical preparation request. This is the
 * point where a native Shelf booking is created and reserved; the student's
 * earlier request itself does not reserve an arbitrary physical unit.
 */
export async function assignPreparationRequest({
  organizationId,
  operationId,
  staffUserId,
  assignedAssetIds,
  hints,
}: {
  organizationId: string;
  operationId: string;
  staffUserId: string;
  assignedAssetIds: string[];
  hints: Parameters<typeof reserveBooking>[0]["hints"];
}) {
  const operation = await db.ioioWriteOperation.findFirst({
    where: {
      id: operationId,
      organizationId,
      operationType: IOIO_PREPARATION_OPERATION,
      source: "IOIO_PREPARATION_REQUEST",
      status: { in: [PREPARATION_PENDING, "ASSIGNING"] },
    },
    select: {
      id: true,
      userId: true,
      assetId: true,
      selectedAssetIds: true,
      quantity: true,
      from: true,
      to: true,
      bookingId: true,
      description: true,
    },
  });
  if (
    !operation?.assetId ||
    !operation.quantity ||
    !operation.from ||
    !operation.to
  ) {
    throw new Error(
      "That preparation request is incomplete or no longer open."
    );
  }

  const product = await db.asset.findFirst({
    where: { id: operation.assetId, organizationId },
    select: {
      id: true,
      title: true,
      type: true,
      quantity: true,
      maxBorrowDays: true,
      assetModel: { select: { name: true } },
      assetLocations: { select: { locationId: true }, take: 1 },
      assetKits: {
        select: { kit: { select: { maxBorrowDays: true } } },
        take: 1,
      },
    },
  });
  if (!product) throw new Error("The requested Shelf item no longer exists.");

  const candidateIds = getStoredAssetIds(operation.selectedAssetIds);
  const acknowledgedStaffReservation =
    operation.description?.includes(IOIO_STAFF_RESERVATION_ACKNOWLEDGEMENT) ??
    false;
  const requestedIds = [...new Set(assignedAssetIds.filter(Boolean))];
  const existingBooking = operation.bookingId
    ? await db.booking.findFirst({
        where: { id: operation.bookingId, organizationId },
        select: {
          id: true,
          status: true,
          bookingAssets: { select: { assetId: true, quantity: true } },
        },
      })
    : null;
  if (operation.bookingId && !existingBooking) {
    throw new Error("The assigned Shelf booking could not be found.");
  }
  const assignmentIsCommitted =
    existingBooking?.status === BookingStatus.RESERVED;
  if (
    existingBooking &&
    existingBooking.status !== BookingStatus.DRAFT &&
    !assignmentIsCommitted
  ) {
    throw new Error(
      "The preparation request's Shelf booking is no longer reservable."
    );
  }
  let selectedIds =
    product.type === AssetType.INDIVIDUAL &&
    existingBooking?.bookingAssets.length
      ? existingBooking.bookingAssets.map(({ assetId }) => assetId)
      : requestedIds;
  if (product.type !== AssetType.INDIVIDUAL && selectedIds.length) {
    throw new Error(
      "Quantity-pool items do not use individual unit assignments."
    );
  }
  if (assignmentIsCommitted) {
    const bookingAssets = existingBooking?.bookingAssets ?? [];
    const assignmentMatchesRequest =
      product.type === AssetType.INDIVIDUAL
        ? bookingAssets.length === operation.quantity &&
          bookingAssets.every(({ assetId }) => candidateIds.includes(assetId))
        : bookingAssets.length === 1 &&
          bookingAssets[0]?.assetId === product.id &&
          bookingAssets[0]?.quantity === operation.quantity;
    if (!assignmentMatchesRequest) {
      throw new Error(
        "The reserved Shelf booking does not match the preparation request."
      );
    }
  }

  const borrowerTeamMember = await db.teamMember.findFirst({
    where: { userId: operation.userId, organizationId, deletedAt: null },
    select: { id: true },
  });
  if (!borrowerTeamMember) {
    throw new Error("The borrower has no active IOIO team-member record.");
  }
  await assertAnnualAccessApproved({
    organizationId,
    userId: operation.userId,
    role: "SELF_SERVICE",
  });

  let reservationIgnoreBookingIds: string[] = [];
  if (!assignmentIsCommitted) {
    const availability = await getIoioAvailability({
      organizationId,
      productId: product.id,
      candidateAssetIds:
        product.type === AssetType.INDIVIDUAL ? candidateIds : undefined,
      from: operation.from,
      to: operation.to,
      excludeBookingId: operation.bookingId ?? undefined,
    });
    reservationIgnoreBookingIds = acknowledgedStaffReservation
      ? availability.staffReservationBookingIds
      : [];
    if (product.type === AssetType.INDIVIDUAL) {
      // Only the explicitly acknowledged IOIO course reservations are soft.
      // The inclusive set still excludes physical, loan, and other booking
      // conflicts.
      const availableIds = new Set(
        acknowledgedStaffReservation
          ? availability.availableUnitIdsWithoutStaffReservations
          : availability.availableUnitIds
      );
      const attachedAssignmentIsAvailable =
        selectedIds.length === operation.quantity &&
        selectedIds.every(
          (id) => candidateIds.includes(id) && availableIds.has(id)
        );
      if (!assignmentIsCommitted && !attachedAssignmentIsAvailable) {
        selectedIds = candidateIds
          .filter((id) => availableIds.has(id))
          .sort()
          .slice(0, operation.quantity);
      }
      if (selectedIds.length !== operation.quantity) {
        const productName =
          product.assetModel?.name ?? product.title.replace(/\s+#\d+\s*$/u, "");
        if (selectedIds.length === 0) {
          throw new Error(
            `No ${productName} units are available for this booking period.`
          );
        }
        throw new Error(
          `Only ${selectedIds.length} of ${operation.quantity} ${productName} units are available for this booking period.`
        );
      }
      if (selectedIds.some((id) => !candidateIds.includes(id))) {
        throw new Error("The assigned unit is not part of this request.");
      }
      const unavailable = selectedIds.filter((id) => !availableIds.has(id));
      if (unavailable.length) {
        const unavailableUnits = await db.asset.findMany({
          where: { id: { in: unavailable }, organizationId },
          select: { title: true },
        });
        throw new Error(
          `${
            unavailableUnits.map((unit) => unit.title).join(", ") ||
            "A selected unit"
          } is no longer available. Choose another unit.`
        );
      }
    } else if (
      operation.quantity >
      (acknowledgedStaffReservation
        ? availability.availableWithoutStaffReservations
        : availability.availableCount)
    ) {
      throw new Error("The requested quantity is no longer available.");
    }
  }

  let bookingId = operation.bookingId;
  let claimAcquired = false;
  try {
    const claimed = await db.ioioWriteOperation.updateMany({
      where: {
        id: operation.id,
        organizationId,
        source: "IOIO_PREPARATION_REQUEST",
        status: PREPARATION_PENDING,
      },
      data: { status: "ASSIGNING" },
    });
    if (claimed.count !== 1)
      throw new Error("That request is already being assigned.");
    claimAcquired = true;

    if (!bookingId) {
      const marker = `IOIO_PREPARATION_REQUEST:${operation.id}`;
      let booking = await db.booking.findFirst({
        where: {
          organizationId,
          description: marker,
          status: { in: [BookingStatus.DRAFT, BookingStatus.RESERVED] },
        },
        select: { id: true },
      });
      if (!booking) {
        booking = await createBooking({
          booking: {
            name: `IOIO borrow — ${product.title}`,
            description: marker,
            creatorId: operation.userId,
            custodianUserId: operation.userId,
            custodianTeamMemberId: borrowerTeamMember.id,
            organizationId,
            from: operation.from,
            to: operation.to,
            tags: [],
          },
          assetIds:
            product.type === AssetType.INDIVIDUAL ? selectedIds : [product.id],
          hints,
        });
      }
      bookingId = booking.id;
      await db.ioioWriteOperation.update({
        where: { id: operation.id, organizationId },
        data: { bookingId },
      });
    }

    const booking = await db.booking.findFirst({
      where: { id: bookingId, organizationId },
      select: {
        id: true,
        status: true,
        bookingAssets: { select: { id: true, assetId: true, quantity: true } },
      },
    });
    if (!booking) throw new Error("The Shelf booking could not be found.");
    if (booking.status === BookingStatus.DRAFT) {
      await updateBookingAssets({
        id: booking.id,
        organizationId,
        assetIds:
          product.type === AssetType.INDIVIDUAL ? selectedIds : [product.id],
        quantities:
          product.type === AssetType.QUANTITY_TRACKED
            ? { [product.id]: operation.quantity }
            : undefined,
        userId: staffUserId,
      });
    }
    if (booking.status === BookingStatus.DRAFT) {
      await reserveBooking({
        id: booking.id,
        organizationId,
        name: `IOIO borrow — ${product.title}`,
        description: `IOIO_PREPARATION_REQUEST:${operation.id}`,
        custodianUserId: operation.userId,
        custodianTeamMemberId: borrowerTeamMember.id,
        from: operation.from,
        to: operation.to,
        hints,
        isSelfServiceOrBase: true,
        tags: [],
        userId: staffUserId,
        ignoreBookingIds: reservationIgnoreBookingIds,
        allowImmediateStart: true,
      });
    } else if (booking.status !== BookingStatus.RESERVED) {
      throw new Error(
        "The preparation request's Shelf booking is no longer reservable."
      );
    }

    const assignedBookingAssets = await db.bookingAsset.findMany({
      where: { bookingId: booking.id, booking: { organizationId } },
      select: {
        id: true,
        assetId: true,
        quantity: true,
        asset: {
          select: { assetLocations: { select: { locationId: true }, take: 1 } },
        },
      },
    });
    const preparationOperationIds: string[] = [];
    for (const bookingAsset of assignedBookingAssets) {
      const preparationTask = await createPreparationTask({
        organizationId,
        borrowerUserId: operation.userId,
        bookingId: booking.id,
        bookingAssetId: bookingAsset.id,
        assetId: bookingAsset.assetId,
        quantity: bookingAsset.quantity,
        from: operation.from,
        to: operation.to,
        locationId:
          bookingAsset.asset.assetLocations[0]?.locationId ??
          product.assetLocations[0]?.locationId ??
          null,
      });
      preparationOperationIds.push(preparationTask.id);
    }
    await db.ioioWriteOperation.updateMany({
      where: { id: operation.id, organizationId, bookingId: booking.id },
      data: { status: "ASSIGNED" },
    });
    return {
      operationId: operation.id,
      bookingId: booking.id,
      assigned: assignedBookingAssets.length,
      preparationOperationIds,
    };
  } catch (cause) {
    // Keep failed assignments visible and retryable. If a draft booking was
    // already linked, the next attempt reuses it rather than creating a
    // duplicate; a reserved booking is likewise completed idempotently.
    if (claimAcquired) {
      await db.ioioWriteOperation.updateMany({
        where: {
          id: operation.id,
          organizationId,
          source: "IOIO_PREPARATION_REQUEST",
          status: "ASSIGNING",
        },
        data: { status: PREPARATION_PENDING },
      });
    }
    throw cause;
  }
}

/**
 * Confirms a preparation card as ready. Logical requests are assigned through
 * Shelf's booking services first; already-created per-unit preparation tasks
 * then pass through the same pickup-zone, audit and notification flow.
 */
export async function confirmPreparationReady({
  organizationId,
  operationId,
  staffUserId,
  staffComment,
  hints,
}: {
  organizationId: string;
  operationId: string;
  staffUserId: string;
  staffComment?: string;
  hints: Parameters<typeof reserveBooking>[0]["hints"];
}) {
  const operation = await db.ioioWriteOperation.findFirst({
    where: {
      id: operationId,
      organizationId,
      operationType: IOIO_PREPARATION_OPERATION,
      status: PREPARATION_PENDING,
    },
    select: { id: true, source: true, bookingAssetId: true },
  });
  if (!operation)
    throw new Error("That preparation request is no longer open.");

  if (operation.source !== "IOIO_PREPARATION_REQUEST") {
    return markPreparationReady({
      organizationId,
      operationId,
      staffUserId,
      staffComment,
      hints,
      checklist: {
        itemPresent: true,
        itemChecked: true,
        partsIncluded: true,
      },
    });
  }

  const assignment = await assignPreparationRequest({
    organizationId,
    operationId,
    staffUserId,
    assignedAssetIds: [],
    hints,
  });
  if (!assignment.preparationOperationIds.length) {
    throw new Error("No assigned items were available to prepare.");
  }

  const preparationTasks = await db.ioioWriteOperation.findMany({
    where: {
      organizationId,
      id: { in: assignment.preparationOperationIds },
    },
    select: { id: true, status: true },
  });
  let markedReady = 0;
  for (const task of preparationTasks) {
    if (task.status === PREPARATION_READY) continue;
    await markPreparationReady({
      organizationId,
      operationId: task.id,
      staffUserId,
      staffComment,
      hints,
      checklist: {
        itemPresent: true,
        itemChecked: true,
        partsIncluded: true,
      },
    });
    markedReady += 1;
  }

  return {
    operationId,
    bookingId: assignment.bookingId,
    assigned: assignment.assigned,
    markedReady,
  };
}

export async function createPreparationTask({
  organizationId,
  borrowerUserId,
  bookingId,
  bookingAssetId,
  assetId,
  quantity,
  from,
  to,
  locationId,
}: {
  organizationId: string;
  borrowerUserId: string;
  bookingId: string;
  bookingAssetId: string;
  assetId: string;
  quantity: number;
  from: Date;
  to: Date;
  locationId: string | null;
}) {
  return db.ioioWriteOperation.upsert({
    where: { idempotencyKey: `IOIO_PREPARATION:${bookingAssetId}` },
    update: {},
    create: {
      operationType: IOIO_PREPARATION_OPERATION,
      status: PREPARATION_PENDING,
      idempotencyKey: `IOIO_PREPARATION:${bookingAssetId}`,
      userId: borrowerUserId,
      organizationId,
      reportType: IOIO_PREPARATION_OPERATION,
      description: "Staff preparation required before pickup.",
      assetId,
      bookingId,
      bookingAssetId,
      quantity,
      from,
      to,
      locationId,
    },
  });
}

export async function markPreparationReady({
  organizationId,
  operationId,
  staffUserId,
  staffComment,
  hints,
  checklist,
}: {
  organizationId: string;
  operationId: string;
  staffUserId: string;
  staffComment?: string;
  hints: Parameters<typeof reserveBooking>[0]["hints"];
  checklist: {
    itemPresent: boolean;
    itemChecked: boolean;
    partsIncluded: boolean;
  };
}) {
  if (
    !checklist.itemPresent ||
    !checklist.itemChecked ||
    !checklist.partsIncluded
  ) {
    throw new Error(
      "Complete the preparation checklist before marking this item ready."
    );
  }
  const operation = await db.ioioWriteOperation.findFirst({
    where: {
      id: operationId,
      organizationId,
      operationType: IOIO_PREPARATION_OPERATION,
      status: PREPARATION_PENDING,
    },
    select: {
      id: true,
      assetId: true,
      bookingAssetId: true,
      bookingId: true,
      userId: true,
      quantity: true,
      from: true,
      to: true,
      locationId: true,
    },
  });
  if (!operation) throw new Error("That preparation task is no longer open.");
  if (!operation.bookingAssetId || !operation.bookingId) {
    throw new Error("Assign the requested equipment before marking it ready.");
  }

  const [bookingAsset, asset, borrower, workingHours] = await Promise.all([
    operation.bookingAssetId
      ? db.bookingAsset.findFirst({
          where: {
            id: operation.bookingAssetId,
            bookingId: operation.bookingId ?? undefined,
            booking: { organizationId },
          },
          select: {
            booking: { select: { status: true } },
            asset: { select: { title: true } },
          },
        })
      : null,
    operation.assetId
      ? db.asset.findFirst({
          where: { id: operation.assetId, organizationId },
          select: { title: true },
        })
      : null,
    db.user.findFirst({
      where: {
        id: operation.userId,
        userOrganizations: { some: { organizationId } },
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        displayName: true,
      },
    }),
    getWorkingHoursForOrganization(organizationId),
  ]);
  if (!bookingAsset || bookingAsset.booking.status !== BookingStatus.RESERVED) {
    throw new Error(
      "The assigned Shelf booking must be reserved before preparation can be marked ready."
    );
  }

  const pickupZone = await ensurePickupZone({
    organizationId,
    originalLocationId: operation.locationId,
    actorUserId: staffUserId,
  });
  const pickupLocation = await getPickupLocationDisplay({
    organizationId,
    locationId: pickupZone.id,
  });

  const readyAt = new Date();
  const pickupDeadline = getPreparationPickupDeadline(readyAt);
  await scheduler.sendAfter(
    QueueNames.bookingQueue,
    {
      id: operation.id,
      organizationId,
      readyAt: readyAt.toISOString(),
      hints,
      eventType: BOOKING_SCHEDULER_EVENTS_ENUM.preparationPickupExpiryHandler,
    },
    {
      singletonKey: `ioio-preparation-pickup-expiry:${
        operation.id
      }:${readyAt.getTime()}`,
    },
    pickupDeadline
  );

  const updated = await db.ioioWriteOperation.updateMany({
    where: {
      id: operation.id,
      organizationId,
      status: PREPARATION_PENDING,
    },
    data: {
      status: PREPARATION_READY,
      reviewComment: [
        "Checklist complete: item present, item checked/tested, required parts included.",
        staffComment?.trim() ? `Staff note: ${staffComment.trim()}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
      reviewedByUserId: staffUserId,
      reviewedAt: readyAt,
      completedAt: null,
      locationId: pickupZone.id,
    },
  });
  if (updated.count !== 1)
    throw new Error("That preparation task is no longer open.");

  const itemName = bookingAsset.asset.title ?? asset?.title ?? "Equipment";
  const unitNumber = itemName.match(/(?:^|\s)(#\d+)\s*$/u)?.[1] ?? "";
  const displayItem = unitNumber
    ? itemName.replace(/\s+#\d+\s*$/u, "")
    : itemName;
  const pickupHours = formatPickupHours(workingHours);
  const displayName = borrower ? resolveUserDisplayName(borrower) : "there";
  const comment = staffComment?.trim();

  if (
    borrower?.email &&
    (await shouldSendOptionalEmail(borrower.id, "READY_FOR_PICKUP"))
  ) {
    const configuredTemplate = await getResolvedEmailTemplate(
      organizationId,
      "ready_for_pickup"
    );
    if (configuredTemplate?.enabled !== false) {
      const template =
        configuredTemplate ?? getEmailTemplateDefinition("ready_for_pickup");
      if (!template)
        throw new Error("Ready for pickup template is unavailable.");
      const rendered = renderEmailTemplate(template, {
        displayName,
        itemName: displayItem,
        unitNumber: unitNumber ? ` ${unitNumber}` : "",
        pickupLocation: pickupLocation.label,
        pickupHours,
        staffComment: comment ? `\nStaff note: ${comment}` : "",
      });
      sendEmail({
        to: borrower.email,
        subject: rendered.subject,
        text: rendered.body,
      });
    }
  }

  return {
    operationId: operation.id,
    itemName: displayItem,
    unitNumber,
    pickupLocation: pickupLocation.label,
    pickupHours,
  };
}

export async function declinePreparation({
  organizationId,
  operationId,
  staffUserId,
  hints,
  staffComment,
}: {
  organizationId: string;
  operationId: string;
  staffUserId: string;
  hints: Parameters<typeof cancelBooking>[0]["hints"];
  staffComment?: string;
}) {
  const operation = await db.ioioWriteOperation.findFirst({
    where: {
      id: operationId,
      organizationId,
      operationType: IOIO_PREPARATION_OPERATION,
      status: PREPARATION_PENDING,
    },
    select: { id: true, bookingId: true, source: true },
  });
  if (!operation) throw new Error("That preparation task is no longer open.");
  const reason = staffComment?.trim();
  const cancellationReason = reason || "Preparation request declined.";

  if (operation.bookingId) {
    const booking = await db.booking.findFirst({
      where: { id: operation.bookingId, organizationId },
      select: { id: true, status: true },
    });
    if (!booking)
      throw new Error("The preparation request's booking was not found.");
    if (booking.status === BookingStatus.DRAFT) {
      await deleteBooking(
        { id: booking.id, organizationId },
        hints,
        staffUserId
      );
    } else if (booking.status === BookingStatus.RESERVED) {
      await cancelBooking({
        id: booking.id,
        organizationId,
        userId: staffUserId,
        hints,
        expectedStatus: BookingStatus.RESERVED,
        cancellationReason,
      });
    } else {
      throw new Error("The preparation request's booking is no longer active.");
    }
  }

  const now = new Date();
  const updated = await db.ioioWriteOperation.updateMany({
    where: operation.bookingId
      ? {
          organizationId,
          operationType: IOIO_PREPARATION_OPERATION,
          OR: [
            {
              id: operation.id,
              status: PREPARATION_PENDING,
            },
            {
              bookingId: operation.bookingId,
              status: { in: [PREPARATION_PENDING, "ASSIGNED"] },
            },
          ],
        }
      : {
          id: operation.id,
          organizationId,
          operationType: IOIO_PREPARATION_OPERATION,
          status: PREPARATION_PENDING,
        },
    data: {
      status: "DECLINED",
      completedAt: now,
      reviewedByUserId: staffUserId,
      reviewedAt: now,
      reviewComment: reason || null,
    },
  });
  if (updated.count === 0) {
    throw new Error("That preparation task is no longer open.");
  }

  return { operationId: operation.id, bookingId: operation.bookingId };
}

/**
 * Lets the requesting Student cancel preparation only before pickup. The
 * logical request stays in history, while an assigned RESERVED booking is
 * cancelled through Shelf's audited booking service and its preparation tasks
 * are closed so they leave Staff's active queue.
 */
export async function cancelStudentPreparationRequest({
  organizationId,
  operationId,
  borrowerUserId,
  hints,
}: {
  organizationId: string;
  operationId: string;
  borrowerUserId: string;
  hints: Parameters<typeof cancelBooking>[0]["hints"];
}) {
  const operation = await db.ioioWriteOperation.findFirst({
    where: {
      id: operationId,
      organizationId,
      userId: borrowerUserId,
      operationType: IOIO_PREPARATION_OPERATION,
    },
    select: { id: true, source: true, status: true, bookingId: true },
  });
  if (!operation) throw new Error("That preparation request was not found.");

  const activeStatuses = [
    PREPARATION_PENDING,
    "ASSIGNING",
    "ASSIGNED",
    PREPARATION_READY,
  ];
  const isLogicalRequest = operation.source === "IOIO_PREPARATION_REQUEST";
  const canCancelUnassigned =
    isLogicalRequest && operation.status === PREPARATION_PENDING;
  const canCancelAssignedRequest =
    isLogicalRequest && operation.status === "ASSIGNED";
  const canCancelPreparationTask =
    !isLogicalRequest &&
    [PREPARATION_PENDING, PREPARATION_READY].includes(operation.status);

  if (
    !canCancelUnassigned &&
    !canCancelAssignedRequest &&
    !canCancelPreparationTask
  ) {
    throw new Error(
      operation.status === PREPARATION_PICKED_UP
        ? "This equipment has already been picked up. Use the return flow instead."
        : "That preparation request can no longer be cancelled."
    );
  }

  // A failed or interrupted assignment can leave a native DRAFT booking
  // linked to this still-pending request. Drafts are not cancellable through
  // cancelBooking (which intentionally only handles active reservations),
  // so find the request's idempotency-marker draft and delete it through the
  // booking service. This also removes stale BookingAsset rows such as #001.
  const requestBooking = operation.bookingId
    ? await db.booking.findFirst({
        where: { id: operation.bookingId, organizationId },
        select: { id: true, status: true },
      })
    : isLogicalRequest
    ? await db.booking.findFirst({
        where: {
          organizationId,
          description: `IOIO_PREPARATION_REQUEST:${operation.id}`,
          status: { in: [BookingStatus.DRAFT, BookingStatus.RESERVED] },
        },
        select: { id: true, status: true },
      })
    : null;
  const bookingId = requestBooking?.id ?? operation.bookingId;

  if (operation.bookingId && !requestBooking) {
    throw new Error("The preparation request's booking could not be found.");
  }

  if (!bookingId) {
    const updated = await db.ioioWriteOperation.updateMany({
      where: {
        id: operation.id,
        organizationId,
        userId: borrowerUserId,
        status: PREPARATION_PENDING,
        source: "IOIO_PREPARATION_REQUEST",
      },
      data: {
        status: "CANCELLED",
        completedAt: new Date(),
        reviewComment: "Cancelled by Student.",
      },
    });
    if (updated.count !== 1) {
      throw new Error("That preparation request is already changing.");
    }
    return { operationId: operation.id, bookingId: null };
  }

  const relatedOperations = await db.ioioWriteOperation.findMany({
    where: {
      organizationId,
      OR: [{ id: operation.id }, { bookingId }],
      operationType: IOIO_PREPARATION_OPERATION,
      status: { in: activeStatuses },
    },
    select: { id: true, status: true, source: true, bookingAssetId: true },
  });
  const preparedUnits = relatedOperations.filter(
    (item) => item.status === PREPARATION_READY && Boolean(item.bookingAssetId)
  );
  const cancelledAt = new Date();
  const cancellationReview = "Cancelled by Student.";

  if (preparedUnits.length) {
    // Keep the reserved Shelf booking in place while any physical unit remains
    // in the Pickup Zone. That booking is the existing availability hold; the
    // dedicated operation status below gives Staff an actionable cleanup task.
    const preparedIds = preparedUnits.map((item) => item.id);
    await db.ioioWriteOperation.updateMany({
      where: {
        organizationId,
        id: { in: preparedIds },
        status: PREPARATION_READY,
      },
      data: {
        status: PREPARATION_CANCELLED_PICKUP,
        completedAt: null,
        reviewedAt: cancelledAt,
        reviewComment: cancellationReview,
      },
    });

    const unpreparedIds = relatedOperations
      .filter((item) => !preparedIds.includes(item.id))
      .map((item) => item.id);
    if (unpreparedIds.length) {
      await db.ioioWriteOperation.updateMany({
        where: {
          organizationId,
          id: { in: unpreparedIds },
          status: { in: activeStatuses },
        },
        data: {
          status: "CANCELLED",
          completedAt: cancelledAt,
          reviewedAt: cancelledAt,
          reviewComment: cancellationReview,
        },
      });
    }

    return {
      operationId: operation.id,
      bookingId,
      needsPutBack: true,
    };
  }

  if (requestBooking?.status === BookingStatus.DRAFT) {
    await deleteBooking(
      { id: requestBooking.id, organizationId },
      hints,
      borrowerUserId
    );
  } else if (requestBooking?.status === BookingStatus.RESERVED) {
    await cancelBooking({
      id: requestBooking.id,
      organizationId,
      userId: borrowerUserId,
      hints,
      expectedStatus: BookingStatus.RESERVED,
      cancellationReason: "Student cancelled the preparation request.",
    });
  } else {
    throw new Error(
      "This preparation request can no longer be cancelled because its booking is no longer active."
    );
  }

  await db.ioioWriteOperation.updateMany({
    where: {
      organizationId,
      operationType: IOIO_PREPARATION_OPERATION,
      OR: [{ id: operation.id }, { bookingId }],
      status: { in: activeStatuses },
    },
    data: {
      status: "CANCELLED",
      completedAt: cancelledAt,
      reviewedAt: cancelledAt,
      reviewComment: cancellationReview,
    },
  });

  return { operationId: operation.id, bookingId };
}

/**
 * Resolves a Student-cancelled prepared pickup only after Staff has physically
 * returned the unit from the Pickup Zone. The existing reserved booking is
 * kept until the last unit in the cancelled request is put back, preventing a
 * still-staged unit from appearing available to a new borrower.
 */
export async function putBackCancelledPreparationPickup({
  organizationId,
  operationId,
  staffUserId,
  hints,
}: {
  organizationId: string;
  operationId: string;
  staffUserId: string;
  hints: Parameters<typeof cancelBooking>[0]["hints"];
}) {
  const operation = await db.ioioWriteOperation.findFirst({
    where: {
      id: operationId,
      organizationId,
      operationType: IOIO_PREPARATION_OPERATION,
      status: PREPARATION_CANCELLED_PICKUP,
    },
    select: { id: true, bookingId: true, bookingAssetId: true, assetId: true },
  });
  if (
    !operation?.bookingId ||
    !operation.bookingAssetId ||
    !operation.assetId
  ) {
    throw new Error(
      "This cancelled pickup no longer has a verifiable assigned unit."
    );
  }

  const [booking, asset] = await Promise.all([
    db.booking.findFirst({
      where: { id: operation.bookingId, organizationId },
      select: {
        id: true,
        status: true,
        bookingAssets: { select: { id: true, assetId: true } },
      },
    }),
    db.asset.findFirst({
      where: { id: operation.assetId, organizationId },
      select: { id: true, title: true },
    }),
  ]);
  if (
    !booking ||
    (booking.status !== BookingStatus.RESERVED &&
      booking.status !== BookingStatus.CANCELLED)
  ) {
    throw new Error("The reserved pickup hold is no longer active.");
  }
  if (
    !asset ||
    !booking.bookingAssets.some(
      (bookingAsset) =>
        bookingAsset.id === operation.bookingAssetId &&
        bookingAsset.assetId === asset.id
    )
  ) {
    throw new Error("The assigned physical unit could not be verified.");
  }

  const remainingPickups = await db.ioioWriteOperation.count({
    where: {
      organizationId,
      bookingId: operation.bookingId,
      operationType: IOIO_PREPARATION_OPERATION,
      status: PREPARATION_CANCELLED_PICKUP,
      id: { not: operation.id },
    },
  });
  if (remainingPickups === 0 && booking.status === BookingStatus.RESERVED) {
    await cancelBooking({
      id: booking.id,
      organizationId,
      userId: staffUserId,
      hints,
      expectedStatus: BookingStatus.RESERVED,
      cancellationReason: "Cancelled pickup returned to inventory by Staff.",
    });
  }

  const updated = await db.ioioWriteOperation.updateMany({
    where: {
      id: operation.id,
      organizationId,
      status: PREPARATION_CANCELLED_PICKUP,
    },
    data: {
      status: "CANCELLED",
      completedAt: new Date(),
      reviewedByUserId: staffUserId,
      reviewedAt: new Date(),
      reviewComment: "Cancelled by Student. Staff confirmed put back.",
    },
  });
  if (updated.count !== 1) {
    throw new Error("This cancelled pickup was already resolved.");
  }

  return {
    operationId: operation.id,
    assetId: asset.id,
    bookingId: booking.id,
  };
}

async function loadStudentPreparationPickup({
  organizationId,
  operationId,
  borrowerUserId,
}: {
  organizationId: string;
  operationId: string;
  borrowerUserId: string;
}) {
  const operation = await db.ioioWriteOperation.findFirst({
    where: {
      id: operationId,
      organizationId,
      userId: borrowerUserId,
      operationType: IOIO_PREPARATION_OPERATION,
      status: PREPARATION_READY,
    },
    select: {
      id: true,
      bookingId: true,
      assetId: true,
      bookingAssetId: true,
      reviewedAt: true,
      to: true,
    },
  });
  if (!operation?.bookingId) {
    throw new Error("That pickup is no longer ready for collection.");
  }
  if (!operation.reviewedAt) {
    throw new Error(
      "The pickup deadline could not be verified. Ask a TA for help."
    );
  }
  if (new Date() >= getPreparationPickupDeadline(operation.reviewedAt)) {
    await expireReadyPreparationPickup({
      organizationId,
      operationId,
      readyAt: operation.reviewedAt,
    });
    throw new Error(
      "This pickup has expired. A TA must return the unit to inventory."
    );
  }

  const booking = await db.booking.findFirst({
    where: {
      id: operation.bookingId,
      organizationId,
      custodianUserId: borrowerUserId,
      status: {
        in: [
          BookingStatus.RESERVED,
          BookingStatus.ONGOING,
          BookingStatus.OVERDUE,
        ],
      },
    },
    select: {
      status: true,
      bookingAssets: {
        ...(operation.bookingAssetId
          ? { where: { id: operation.bookingAssetId } }
          : {}),
        select: {
          id: true,
          assetId: true,
          checkedOutAt: true,
          checkedInAt: true,
          asset: {
            select: {
              id: true,
              title: true,
              type: true,
              assetModelId: true,
              sequentialId: true,
              assetModel: { select: { name: true } },
              maxBorrowDays: true,
              qrCodes: { select: { id: true } },
              barcodes: { select: { value: true } },
              organizationId: true,
              assetKits: {
                select: { kit: { select: { maxBorrowDays: true } } },
              },
            },
          },
        },
      },
    },
  });
  if (!booking) {
    throw new Error("That pickup booking no longer exists.");
  }
  const assignedSlice = operation.bookingAssetId
    ? booking.bookingAssets.find(
        (slice) => slice.id === operation.bookingAssetId
      )
    : booking.bookingAssets.find(
        (slice) => slice.assetId === operation.assetId
      );
  const pickupAsset = assignedSlice?.asset;
  if (
    !assignedSlice ||
    assignedSlice.assetId !== operation.assetId ||
    !pickupAsset ||
    pickupAsset.id !== operation.assetId
  ) {
    throw new Error("The pickup item could not be verified.");
  }
  return { operation, booking, assignedSlice, pickupAsset };
}

type PickupVerification = {
  valid: boolean;
  status: "valid" | "wrong-unit" | "wrong-item" | "unresolved";
  assignedUnitLabel: string;
  scannedUnitLabel?: string;
  error?: string;
};

async function verifyAssignedPickupUnit({
  organizationId,
  pickupAsset,
  verificationValue,
}: {
  organizationId: string;
  pickupAsset: {
    id: string;
    title: string;
    type: AssetType;
    assetModelId: string | null;
    sequentialId: string | null;
    assetModel: { name: string } | null;
    qrCodes: Array<{ id: string }>;
    barcodes: Array<{ value: string }>;
    assetKits: Array<{ kit: { maxBorrowDays: number } }>;
  };
  verificationValue?: string;
}): Promise<PickupVerification> {
  const unitNumber = getPhysicalUnitNumberFromTitle(pickupAsset.title);
  const assignedUnitLabel = unitNumber
    ? `${
        pickupAsset.assetModel?.name ??
        pickupAsset.title.replace(/\s+#\d+\s*$/u, "")
      } #${unitNumber}`
    : pickupAsset.title;
  const entered = verificationValue?.trim() ?? "";
  const normalizedInput = normalizeQrScanValue(entered);
  const normalizedUnit = normalizePhysicalUnitNumber(normalizedInput);

  if (!normalizedInput) {
    return {
      valid: false,
      status: "unresolved",
      assignedUnitLabel,
    };
  }

  if (pickupAsset.type !== AssetType.INDIVIDUAL) {
    return { valid: true, status: "valid", assignedUnitLabel };
  }

  // First resolve QR IDs through the QR table to their linked physical Asset.
  // This handles full URLs and relative /qr/{token} paths without comparing
  // the URL itself to an Asset ID or unit number.
  const qr = await db.qr.findFirst({
    where: { id: normalizedInput, organizationId },
    select: { id: true, assetId: true, kitId: true },
  });
  let scannedAsset: {
    id: string;
    title: string;
    assetModelId: string | null;
    type: AssetType;
  } | null = qr?.assetId
    ? await db.asset.findFirst({
        where: {
          id: qr.assetId,
          organizationId,
        },
        select: { id: true, title: true, assetModelId: true, type: true },
      })
    : null;

  if (!scannedAsset && !qr) {
    const barcode = await db.barcode.findFirst({
      where: { organizationId, value: entered },
      select: { assetId: true },
    });
    if (barcode?.assetId) {
      scannedAsset = await db.asset.findFirst({
        where: {
          id: barcode.assetId,
          organizationId,
        },
        select: { id: true, title: true, assetModelId: true, type: true },
      });
    }
  }

  if (scannedAsset) {
    if (scannedAsset.id === pickupAsset.id) {
      return {
        valid: true,
        status: "valid",
        assignedUnitLabel,
        scannedUnitLabel: scannedAsset.title,
      };
    }
    const sameEquipment = Boolean(
      pickupAsset.assetModelId &&
        scannedAsset.assetModelId === pickupAsset.assetModelId &&
        scannedAsset.type === pickupAsset.type
    );
    return {
      valid: false,
      status: sameEquipment ? "wrong-unit" : "wrong-item",
      assignedUnitLabel,
      scannedUnitLabel: scannedAsset.title,
      error: sameEquipment
        ? `Wrong unit. This request is assigned to ${assignedUnitLabel}.`
        : `Wrong equipment. This request is assigned to ${assignedUnitLabel}.`,
    };
  }

  const enteredDigits = normalizedInput.replace(/^#/u, "");
  if (enteredDigits.length >= 3 && normalizedUnit) {
    if (unitNumber && normalizedUnit === unitNumber) {
      return { valid: true, status: "valid", assignedUnitLabel };
    }
    const numberedAsset = await db.asset.findFirst({
      where: {
        organizationId,
        type: AssetType.INDIVIDUAL,
        OR: [
          { title: { endsWith: `#${normalizedUnit}` } },
          { sequentialId: normalizedUnit },
        ],
      },
      select: {
        id: true,
        title: true,
        assetModelId: true,
        type: true,
      },
    });
    if (numberedAsset) {
      const sameEquipment = Boolean(
        pickupAsset.assetModelId &&
          numberedAsset.assetModelId === pickupAsset.assetModelId
      );
      return {
        valid: false,
        status: sameEquipment ? "wrong-unit" : "wrong-item",
        assignedUnitLabel,
        scannedUnitLabel: numberedAsset.title,
        error: sameEquipment
          ? `Wrong unit. This request is assigned to ${assignedUnitLabel}.`
          : `Wrong equipment. This request is assigned to ${assignedUnitLabel}.`,
      };
    }
  }

  if (qr?.kitId) {
    const kit = await db.kit.findFirst({
      where: { id: qr.kitId, organizationId },
      select: { name: true },
    });
    return {
      valid: false,
      status: "wrong-item",
      assignedUnitLabel,
      scannedUnitLabel: kit?.name,
      error: `Wrong equipment. This request is assigned to ${assignedUnitLabel}.`,
    };
  }

  return {
    valid: false,
    status: "unresolved",
    assignedUnitLabel,
    error:
      "We couldn't find that unit. Scan its QR code or enter its unit number.",
  };
}

export async function validateStudentPreparationPickup({
  organizationId,
  operationId,
  borrowerUserId,
  verificationValue,
}: {
  organizationId: string;
  operationId: string;
  borrowerUserId: string;
  verificationValue?: string;
}): Promise<PickupVerification> {
  const { pickupAsset } = await loadStudentPreparationPickup({
    organizationId,
    operationId,
    borrowerUserId,
  });
  return verifyAssignedPickupUnit({
    organizationId,
    pickupAsset,
    verificationValue,
  });
}

export async function confirmStudentPreparationPickup({
  organizationId,
  operationId,
  borrowerUserId,
  hints,
  verificationValue,
}: {
  organizationId: string;
  operationId: string;
  borrowerUserId: string;
  hints: Parameters<typeof checkoutBooking>[0]["hints"];
  verificationValue?: string;
}) {
  const { operation, booking, assignedSlice, pickupAsset } =
    await loadStudentPreparationPickup({
      organizationId,
      operationId,
      borrowerUserId,
    });
  if (pickupAsset.type === AssetType.INDIVIDUAL) {
    const verification = await verifyAssignedPickupUnit({
      organizationId,
      pickupAsset,
      verificationValue,
    });
    if (!verification.valid) {
      throw new ShelfError({
        cause: null,
        status: 400,
        label: "Booking",
        message:
          verification.error ?? "That isn't the unit assigned to your request.",
        shouldBeCaptured: false,
      });
    }
  }
  const maxBorrowDays =
    pickupAsset.assetKits[0]?.kit.maxBorrowDays ??
    pickupAsset.maxBorrowDays ??
    45;
  const activeWindow = getImmediateBorrowingWindow(maxBorrowDays);
  if (assignedSlice.checkedInAt) {
    throw new Error(
      "This assigned unit has already been returned. Ask a TA to review the pickup status."
    );
  }
  if (!assignedSlice.checkedOutAt) {
    if (booking.status === BookingStatus.RESERVED) {
      await checkoutBooking({
        id: operation.bookingId,
        organizationId,
        userId: borrowerUserId,
        hints,
        activeWindow,
      });
    } else {
      // A sibling unit may already have started this booking. Check out only
      // this verified physical unit; never replay the whole booking checkout.
      await partialCheckoutBooking({
        id: operation.bookingId,
        organizationId,
        assetIds: [pickupAsset.id],
        userId: borrowerUserId,
        hints,
      });
    }
  }

  const updated = await db.ioioWriteOperation.updateMany({
    where: {
      id: operation.id,
      organizationId,
      operationType: IOIO_PREPARATION_OPERATION,
      status: PREPARATION_READY,
    },
    data: {
      status: PREPARATION_PICKED_UP,
      completedAt: new Date(),
    },
  });
  if (updated.count !== 1) {
    throw new Error("That pickup is no longer ready for collection.");
  }

  return { operationId: operation.id, bookingId: operation.bookingId };
}

/**
 * Expires a ready pickup only when its persisted ready timestamp still matches
 * the scheduled job. Stale jobs therefore cannot expire a pickup that was
 * collected, cancelled, or made ready again later.
 */
export async function expireReadyPreparationPickup({
  organizationId,
  operationId,
  readyAt,
  now = new Date(),
}: {
  organizationId: string;
  operationId: string;
  readyAt: Date;
  now?: Date;
}) {
  const deadline = getPreparationPickupDeadline(readyAt);
  if (now < deadline) return false;

  const updated = await db.ioioWriteOperation.updateMany({
    where: {
      id: operationId,
      organizationId,
      operationType: IOIO_PREPARATION_OPERATION,
      status: PREPARATION_READY,
      reviewedAt: readyAt,
    },
    data: {
      status: PREPARATION_CANCELLED_PICKUP,
      completedAt: null,
      reviewedAt: now,
      reviewComment: "Pickup expired after 7 days.",
    },
  });
  return updated.count === 1;
}

export async function markPreparationReadyBulk({
  organizationId,
  operationIds,
  staffUserId,
  staffComment,
  hints,
  checklist,
}: {
  organizationId: string;
  operationIds: string[];
  staffUserId: string;
  staffComment?: string;
  hints: Parameters<typeof reserveBooking>[0]["hints"];
  checklist: {
    itemPresent: boolean;
    itemChecked: boolean;
    partsIncluded: boolean;
  };
}) {
  const results = await Promise.all(
    operationIds.map(async (operationId) => {
      try {
        const result = await markPreparationReady({
          organizationId,
          operationId,
          staffUserId,
          staffComment,
          hints,
          checklist,
        });
        return { operationId, ok: true as const, result };
      } catch (cause) {
        return {
          operationId,
          ok: false as const,
          error:
            cause instanceof Error ? cause.message : "Could not mark ready.",
        };
      }
    })
  );
  return {
    results,
    succeeded: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
  };
}
