import { randomUUID } from "node:crypto";
import { AssetStatus, AssetType, BookingStatus } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import type { LoaderFunctionArgs } from "react-router";
import { db } from "~/database/db.server";
import {
  getPhysicalUnitBaseTitle,
  getPhysicalUnitNumberFromTitle,
  normalizePhysicalUnitNumber,
} from "~/modules/asset/physical-unit";
import {
  checkoutBooking,
  createBooking,
  reserveBooking,
  updateBookingAssets,
} from "~/modules/booking/service.server";
import {
  createPreparationTask,
  IOIO_PREPARATION_OPERATION,
  PREPARATION_PENDING,
  PREPARATION_READY,
} from "~/modules/ioio-staff/preparation.server";
import { getClientHint } from "~/utils/client-hints";
import { ShelfError, isLikeShelfError } from "~/utils/error";
import { Logger } from "~/utils/logger";
import { resolveUserDisplayName } from "~/utils/user";
import { assertAnnualAccessApproved } from "./annual-access.server";
import {
  getIoioAvailability,
  IOIO_STAFF_RESERVATION_ACKNOWLEDGEMENT,
} from "./availability.server";
import {
  borrowProposalSchema,
  type BorrowProposalDraft,
} from "./borrow-item.shared";
import {
  assertConfiguredBorrowingPeriod,
  getImmediateBorrowingWindow,
} from "./date-range";
import {
  enforceIoioBorrowRateLimit,
  IOIO_BORROW_OPERATION,
} from "./rate-limit.server";
import { requireStudentRead } from "./route.server";

type Context = Pick<LoaderFunctionArgs, "context" | "request">;
type BorrowOperationStatus =
  | "PREPARED"
  | "PROCESSING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED"
  | "PENDING_APPROVAL";

const BORROW_PROPOSAL_TTL_MS = 10 * 60 * 1000;
function hasStaffReservationAcknowledgement(
  description: string | null | undefined
) {
  return description?.includes(IOIO_STAFF_RESERVATION_ACKNOWLEDGEMENT) ?? false;
}

function hasAcknowledgedStaffReservation(
  description: string | null | undefined
) {
  return hasStaffReservationAcknowledgement(description);
}

export type PreparedBorrowProposal = {
  confirmationToken: string;
  operationId: string;
  asset: {
    id: string;
    title: string;
    type: AssetType;
    location: string | null;
  };
  kit: null;
  quantity: number;
  selectedPhysicalUnitIds: string[];
  availableQuantity: number;
  from: string;
  to: string;
  restriction: string | null;
  requiresApproval: boolean;
  requiresStaffPreparation: boolean;
  staffReservationWarning: {
    reservedCount: number;
    totalCount: number;
    from: string;
    to: string;
  } | null;
};

function borrowError(
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

function assertBorrowRole(role: string) {
  if (!(role === "SELF_SERVICE" || role === "ADMIN" || role === "OWNER")) {
    throw borrowError(
      "Your Shelf role is not allowed to borrow IOIO items.",
      403
    );
  }
}

function assertOperationStatus(
  status: string
): asserts status is BorrowOperationStatus {
  if (
    ![
      "PREPARED",
      "PROCESSING",
      "SUCCEEDED",
      "FAILED",
      "CANCELLED",
      "PENDING_APPROVAL",
    ].includes(status)
  ) {
    throw borrowError("This borrow operation has an invalid state.", 409);
  }
}

function assertInitialBorrowingPeriod(
  from: Date,
  to: Date,
  maxBorrowDays: number | null
) {
  const effectiveMaxBorrowDays = maxBorrowDays ?? 45;
  try {
    assertConfiguredBorrowingPeriod(from, to, effectiveMaxBorrowDays);
  } catch {
    throw borrowError(
      `This item can be borrowed for up to ${effectiveMaxBorrowDays} days.`
    );
  }
}

function getEffectiveMaxBorrowDays(
  asset: Awaited<ReturnType<typeof loadBorrowAsset>>
) {
  return asset?.assetKits[0]?.kit.maxBorrowDays ?? asset?.maxBorrowDays ?? 45;
}

type BorrowPhysicalUnit = {
  id: string;
  title: string;
  status: AssetStatus;
  availableToBook: boolean;
  assetModelId: string | null;
  assetKits: Array<{ kitId: string }>;
  qrCodes: Array<{ id: string }>;
};

function getPhysicalUnitUnavailableMessage(unit: BorrowPhysicalUnit) {
  if (unit.status === AssetStatus.AVAILABLE && !unit.availableToBook) {
    return `${unit.title} is temporarily unavailable and cannot be borrowed. Ask a TA if you think this kit should be available.`;
  }
  return `${unit.title} is no longer available.`;
}

function getStoredSelectedAssetIds(value: Prisma.JsonValue | null) {
  if (!Array.isArray(value)) return [];
  return value.filter((id): id is string => typeof id === "string");
}

function normalizeSelectedPhysicalAssetIds(ids: string[]) {
  return [...new Set(ids)].sort();
}

async function loadBorrowPhysicalUnitCandidates({
  requestedAsset,
  candidateAssetIds,
  organizationId,
}: {
  requestedAsset: NonNullable<Awaited<ReturnType<typeof loadBorrowAsset>>>;
  candidateAssetIds?: string[];
  organizationId: string;
}): Promise<BorrowPhysicalUnit[]> {
  const candidateIds = [...new Set(candidateAssetIds ?? [])];
  const kitIds = requestedAsset.assetKits.map(({ kitId }) => kitId);
  const productRelations: Prisma.AssetWhereInput[] = [];
  if (requestedAsset.assetModelId) {
    productRelations.push({ assetModelId: requestedAsset.assetModelId });
  }
  if (kitIds.length) {
    productRelations.push({
      assetKits: {
        some: { kitId: { in: kitIds }, organizationId },
      },
    });
  }

  return db.asset.findMany({
    where: {
      organizationId,
      type: AssetType.INDIVIDUAL,
      ...(candidateIds.length ? { id: { in: candidateIds } } : {}),
      ...(productRelations.length ? { OR: productRelations } : {}),
    },
    select: {
      id: true,
      title: true,
      status: true,
      availableToBook: true,
      assetModelId: true,
      assetKits: { select: { kitId: true } },
      qrCodes: {
        where: { organizationId },
        select: { id: true },
      },
    },
  });
}

async function assertPhysicalUnitsNotArchived(
  unitIds: string[],
  organizationId: string
) {
  if (!unitIds.length) return;
  const archived = await db.ioioArchivedItem.findMany({
    where: {
      organizationId,
      itemType: "ASSET",
      itemId: { in: unitIds },
      restoredAt: null,
    },
    select: { itemId: true, disposition: true },
  });
  if (archived.length) {
    const item = archived[0];
    const label = item.disposition === "TRASH" ? "in the Trash" : "archived";
    throw borrowError(`That physical unit is ${label}.`, 409);
  }
}

export async function resolvePhysicalUnitNumber(
  {
    assetId,
    candidateAssetIds,
    unitNumber,
  }: {
    assetId: string;
    candidateAssetIds?: string[];
    unitNumber: string;
  },
  { context, request }: Context
) {
  const auth = await requireStudentRead({ context, request });
  assertBorrowRole(auth.role);
  const requestedAsset = await loadBorrowAsset(assetId, auth.organizationId);
  if (!requestedAsset) {
    throw borrowError(
      "The selected Shelf asset is not in this workspace.",
      403
    );
  }
  const normalizedUnitNumber = normalizePhysicalUnitNumber(unitNumber);
  if (!normalizedUnitNumber) {
    throw borrowError("Enter a physical unit number such as 001.", 400);
  }

  const candidates = await loadBorrowPhysicalUnitCandidates({
    requestedAsset,
    candidateAssetIds,
    organizationId: auth.organizationId,
  });
  const matches = candidates.filter(
    (candidate) =>
      getPhysicalUnitNumberFromTitle(candidate.title) === normalizedUnitNumber
  );
  if (matches.length === 0) {
    throw borrowError(
      `Unit #${normalizedUnitNumber} does not belong to ${requestedAsset.title}.`,
      404
    );
  }
  if (matches.length > 1) {
    throw borrowError(
      `Unit #${normalizedUnitNumber} is ambiguous for ${requestedAsset.title}.`,
      409
    );
  }

  const unit = matches[0];
  await assertPhysicalUnitsNotArchived([unit.id], auth.organizationId);
  if (unit.status !== AssetStatus.AVAILABLE || !unit.availableToBook) {
    throw borrowError(getPhysicalUnitUnavailableMessage(unit), 409);
  }
  const { from, to } = getImmediateBorrowingWindow(
    getEffectiveMaxBorrowDays(requestedAsset)
  );
  const availability = await getIoioAvailability({
    organizationId: auth.organizationId,
    productId: requestedAsset.id,
    candidateAssetIds: [unit.id],
    from,
    to,
  });
  if (
    !availability.availableUnitIdsWithoutStaffReservations.includes(unit.id)
  ) {
    throw borrowError(
      `Unit #${normalizedUnitNumber} is currently borrowed.`,
      409
    );
  }
  const qrId = unit.qrCodes[0]?.id;
  if (!qrId) {
    throw borrowError(
      `${requestedAsset.title} #${normalizedUnitNumber} has no QR identity.`,
      409
    );
  }
  const displayUnitNumber = `#${normalizedUnitNumber}`;

  return {
    physicalAssetId: unit.id,
    logicalProductId: requestedAsset.id,
    unitNumber: normalizedUnitNumber,
    displayUnitNumber,
    qrId,
    available: true as const,
    title: `${getPhysicalUnitBaseTitle(
      requestedAsset.title
    )} ${displayUnitNumber}`,
  };
}

async function loadBorrowAsset(assetId: string, organizationId: string) {
  return db.asset.findFirst({
    where: { id: assetId, organizationId },
    select: {
      id: true,
      title: true,
      type: true,
      quantity: true,
      assetModelId: true,
      status: true,
      availableToBook: true,
      requiresBorrowApproval: true,
      requiresStaffPreparation: true,
      maxBorrowDays: true,
      assetKits: {
        select: { kitId: true, kit: { select: { maxBorrowDays: true } } },
      },
      assetLocations: {
        select: { location: { select: { id: true, name: true } } },
        take: 1,
      },
    },
  });
}

async function resolveAvailableQuantity({
  asset,
  organizationId,
  from,
  to,
  candidateAssetIds,
  allowStaffReservationOverlap = false,
}: {
  asset: NonNullable<Awaited<ReturnType<typeof loadBorrowAsset>>>;
  organizationId: string;
  from: Date;
  to: Date;
  candidateAssetIds?: string[];
  allowStaffReservationOverlap?: boolean;
}) {
  const availability = await getIoioAvailability({
    organizationId,
    productId: asset.id,
    candidateAssetIds,
    from,
    to,
  });
  if (
    availability.staffReservationBookingIds.length > 0 &&
    !allowStaffReservationOverlap
  ) {
    throw borrowError(
      "A course reservation overlaps these dates. Confirm that you have permission before continuing.",
      409
    );
  }
  return allowStaffReservationOverlap
    ? {
        availableQuantity: availability.availableWithoutStaffReservations,
        ignoreBookingIds: availability.staffReservationBookingIds,
      }
    : {
        availableQuantity: availability.availableCount,
        ignoreBookingIds: [],
      };
}

export async function getBorrowItemAvailability(
  {
    assetId,
    candidateAssetIds,
    from,
    to,
  }: {
    assetId: string;
    candidateAssetIds?: string[];
    from?: string;
    to?: string;
  },
  { context, request }: Context
) {
  const auth = await requireStudentRead({ context, request });
  assertBorrowRole(auth.role);
  const parsedFrom = from ? new Date(from) : null;
  const parsedTo = to ? new Date(to) : null;
  if (
    (parsedFrom && !Number.isFinite(parsedFrom.getTime())) ||
    (parsedTo && !Number.isFinite(parsedTo.getTime())) ||
    (parsedFrom && parsedTo && parsedTo <= parsedFrom)
  ) {
    throw borrowError("Borrow dates are invalid.");
  }
  const asset = await loadBorrowAsset(assetId, auth.organizationId);
  if (!asset) {
    throw borrowError(
      "The selected Shelf asset is not in this workspace.",
      403
    );
  }
  const window =
    parsedFrom && parsedTo
      ? { from: parsedFrom, to: parsedTo }
      : getImmediateBorrowingWindow(getEffectiveMaxBorrowDays(asset));
  assertInitialBorrowingPeriod(
    window.from,
    window.to,
    getEffectiveMaxBorrowDays(asset)
  );

  const availability = await getIoioAvailability({
    organizationId: auth.organizationId,
    productId: asset.id,
    candidateAssetIds,
    from: window.from,
    to: window.to,
  });

  return {
    total: availability.totalActive,
    available: availability.availableCount,
    availableUnitIds: availability.availableUnitIds,
    staffReservedCount: availability.staffReservedCount,
    availableWithoutStaffReservations:
      availability.availableWithoutStaffReservations,
    staffReservationFrom:
      availability.staffReservationFrom?.toISOString() ?? null,
    staffReservationTo: availability.staffReservationTo?.toISOString() ?? null,
    availableUnitIdsWithoutStaffReservations:
      availability.availableUnitIdsWithoutStaffReservations,
  };
}

async function resolveStudentTeamMember({
  userId,
  organizationId,
  role,
}: {
  userId: string;
  organizationId: string;
  role: string;
}) {
  const teamMember = await db.teamMember.findFirst({
    where: { userId, organizationId, deletedAt: null },
    select: { id: true },
  });
  if (teamMember) return teamMember.id;

  // Some Staff accounts were created before Shelf linked every authenticated
  // user to a TeamMember row. Staff borrowing still uses the canonical
  // custodian relation required by Shelf bookings, so provision that missing
  // workspace-scoped mapping on first Staff borrow. Students retain the
  // existing strict mapping requirement.
  if (role === "ADMIN" || role === "OWNER") {
    const user = await db.user.findFirst({
      where: {
        id: userId,
        userOrganizations: { some: { organizationId } },
      },
      select: { displayName: true, firstName: true, lastName: true },
    });
    const created = await db.teamMember.create({
      data: {
        name: resolveUserDisplayName(user) || "Staff",
        organization: { connect: { id: organizationId } },
        user: { connect: { id: userId } },
      },
      select: { id: true },
    });
    return created.id;
  }

  throw borrowError(
    "Your Shelf account has no active team-member mapping for borrowing.",
    409
  );
}

function operationExpired(createdAt: Date) {
  return Date.now() - createdAt.getTime() > BORROW_PROPOSAL_TTL_MS;
}

function assertConfirmationMatches(
  operation: {
    quantity: number | null;
    from: Date | null;
    to: Date | null;
    selectedAssetIds: Prisma.JsonValue | null;
  },
  confirmation: { quantity: number; selectedPhysicalUnitIds?: string[] }
) {
  const parsedQuantity = Number(confirmation.quantity);
  if (
    !Number.isInteger(parsedQuantity) ||
    parsedQuantity < 1 ||
    operation.quantity !== parsedQuantity
  ) {
    throw borrowError(
      "The confirmation no longer matches the reviewed borrow proposal.",
      409
    );
  }
  const expectedAssetIds = getStoredSelectedAssetIds(
    operation.selectedAssetIds
  );
  if (expectedAssetIds.length) {
    const actualAssetIds = confirmation.selectedPhysicalUnitIds ?? [];
    const normalizedExpectedAssetIds =
      normalizeSelectedPhysicalAssetIds(expectedAssetIds);
    const normalizedActualAssetIds =
      normalizeSelectedPhysicalAssetIds(actualAssetIds);
    if (
      actualAssetIds.length !== expectedAssetIds.length ||
      normalizedActualAssetIds.length !== normalizedExpectedAssetIds.length ||
      normalizedActualAssetIds.some(
        (id, index) => id !== normalizedExpectedAssetIds[index]
      )
    ) {
      throw borrowError(
        "The selected physical units no longer match the reviewed borrow proposal.",
        409
      );
    }
  }
}

async function findMarkedBooking({
  organizationId,
  operationId,
  bookingId,
}: {
  organizationId: string;
  operationId: string;
  bookingId: string | null;
}) {
  const marker = `IOIO_BORROW_OPERATION:${operationId}`;
  return db.booking.findFirst({
    where: bookingId
      ? { id: bookingId, organizationId }
      : { organizationId, description: { contains: marker } },
    select: {
      id: true,
      status: true,
      bookingAssets: {
        select: { id: true, assetId: true, quantity: true },
      },
    },
  });
}

export async function prepareBorrowItem(
  draft: BorrowProposalDraft,
  { context, request }: Context
): Promise<PreparedBorrowProposal> {
  const auth = await requireStudentRead({ context, request });
  assertBorrowRole(auth.role);
  await assertAnnualAccessApproved({
    organizationId: auth.organizationId,
    userId: auth.userId,
    role: auth.role,
  });
  const parsed = borrowProposalSchema.parse(draft);

  if (parsed.kit_id) {
    throw borrowError(
      "Kit borrowing is deferred until the native kit checkout flow is validated.",
      409
    );
  }
  if (!parsed.asset_id) throw borrowError("A Shelf asset is required.");

  const requestedAsset = await loadBorrowAsset(
    parsed.asset_id,
    auth.organizationId
  );
  if (!requestedAsset) {
    throw borrowError(
      "The selected Shelf asset is not in this workspace.",
      403
    );
  }
  const requiresPhysicalUnit = requestedAsset.type === AssetType.INDIVIDUAL;
  const { from, to } = getImmediateBorrowingWindow(
    getEffectiveMaxBorrowDays(requestedAsset)
  );
  assertInitialBorrowingPeriod(
    from,
    to,
    getEffectiveMaxBorrowDays(requestedAsset)
  );
  let asset = requestedAsset;
  let selectedPhysicalUnitIds: string[] = [];
  if (requiresPhysicalUnit) {
    const multiAssetIds = parsed.scanned_asset_ids ?? [];
    const multiQrIds = parsed.scanned_qr_ids ?? [];
    if (multiAssetIds.length || multiQrIds.length) {
      if (
        multiAssetIds.length !== parsed.quantity ||
        multiQrIds.length !== parsed.quantity ||
        new Set(multiAssetIds).size !== multiAssetIds.length ||
        new Set(multiQrIds).size !== multiQrIds.length
      ) {
        throw borrowError(
          `Select ${parsed.quantity} different physical unit${
            parsed.quantity === 1 ? "" : "s"
          } before confirming this borrowing.`,
          409
        );
      }
      const candidates = await loadBorrowPhysicalUnitCandidates({
        requestedAsset,
        candidateAssetIds: parsed.candidate_asset_ids,
        organizationId: auth.organizationId,
      });
      for (let index = 0; index < multiAssetIds.length; index += 1) {
        const unit = candidates.find(
          (candidate) => candidate.id === multiAssetIds[index]
        );
        if (!unit) {
          throw borrowError(
            `The selected physical unit does not belong to ${requestedAsset.title}.`,
            409
          );
        }
        const qr = await db.qr.findFirst({
          where: {
            id: multiQrIds[index],
            organizationId: auth.organizationId,
            assetId: unit.id,
          },
          select: { assetId: true },
        });
        if (!qr) {
          throw borrowError(
            `The QR identity for ${unit.title} could not be verified.`,
            409
          );
        }
      }
      selectedPhysicalUnitIds = multiAssetIds;
      await assertPhysicalUnitsNotArchived(
        selectedPhysicalUnitIds,
        auth.organizationId
      );
      const selectedAsset = await db.asset.findFirst({
        where: {
          id: selectedPhysicalUnitIds[0],
          organizationId: auth.organizationId,
        },
        select: {
          id: true,
          title: true,
          type: true,
          quantity: true,
          assetModelId: true,
          status: true,
          availableToBook: true,
          requiresBorrowApproval: true,
          requiresStaffPreparation: true,
          maxBorrowDays: true,
          assetKits: {
            select: { kitId: true, kit: { select: { maxBorrowDays: true } } },
          },
          assetLocations: {
            select: { location: { select: { id: true, name: true } } },
            take: 1,
          },
        },
      });
      if (!selectedAsset) {
        throw borrowError(
          "The selected physical unit is no longer available.",
          409
        );
      }
      asset = selectedAsset;
    } else {
      if (!parsed.scanned_asset_id || !parsed.scanned_qr_id) {
        throw borrowError(
          "Scan or enter the physical unit QR before confirming this borrowing.",
          409
        );
      }
      const scannedQr = await db.qr.findFirst({
        where: {
          id: parsed.scanned_qr_id,
          organizationId: auth.organizationId,
          assetId: parsed.scanned_asset_id,
        },
        select: { assetId: true },
      });
      const scannedAsset = await db.asset.findFirst({
        where: {
          id: parsed.scanned_asset_id,
          organizationId: auth.organizationId,
          type: AssetType.INDIVIDUAL,
        },
        select: {
          id: true,
          title: true,
          type: true,
          quantity: true,
          assetModelId: true,
          status: true,
          availableToBook: true,
          requiresBorrowApproval: true,
          requiresStaffPreparation: true,
          maxBorrowDays: true,
          assetKits: {
            select: { kitId: true, kit: { select: { maxBorrowDays: true } } },
          },
          assetLocations: {
            select: { location: { select: { id: true, name: true } } },
            take: 1,
          },
        },
      });
      const belongsToProduct = Boolean(
        scannedAsset &&
          ((requestedAsset.assetModelId &&
            scannedAsset.assetModelId === requestedAsset.assetModelId) ||
            scannedAsset.assetKits.some((candidate) =>
              requestedAsset.assetKits.some(
                (kit) => kit.kitId === candidate.kitId
              )
            ))
      );
      if (!scannedQr || !scannedAsset || !belongsToProduct) {
        throw borrowError(
          `This QR does not belong to ${requestedAsset.title}. Scan a matching physical unit.`,
          409
        );
      }
      await assertPhysicalUnitsNotArchived(
        [scannedAsset.id],
        auth.organizationId
      );
      asset = scannedAsset;
      selectedPhysicalUnitIds = [scannedAsset.id];
    }
  }
  const availability = await getIoioAvailability({
    organizationId: auth.organizationId,
    productId: requestedAsset.id,
    candidateAssetIds:
      requestedAsset.type === AssetType.INDIVIDUAL
        ? selectedPhysicalUnitIds
        : undefined,
    from,
    to,
  });
  const availableUnitIds =
    parsed.quantity > availability.availableCount
      ? availability.availableUnitIdsWithoutStaffReservations
      : availability.availableUnitIds;
  if (
    requestedAsset.type === AssetType.INDIVIDUAL &&
    selectedPhysicalUnitIds.some((unitId) => !availableUnitIds.includes(unitId))
  ) {
    throw borrowError(
      "One or more selected physical units are no longer available.",
      409
    );
  }
  const availableQuantity = availability.availableCount;
  const canUseSoftStaffReservation =
    parsed.quantity <= availability.availableWithoutStaffReservations;
  if (parsed.quantity > availableQuantity && !canUseSoftStaffReservation) {
    throw borrowError(
      `Only ${availability.availableWithoutStaffReservations} unit${
        availability.availableWithoutStaffReservations === 1 ? "" : "s"
      } are available for these dates.`,
      409
    );
  }
  if (
    asset.type === AssetType.INDIVIDUAL &&
    parsed.quantity !== selectedPhysicalUnitIds.length
  ) {
    throw borrowError(
      "Select one physical unit for each individual item you want to borrow."
    );
  }
  await resolveStudentTeamMember({
    userId: auth.userId,
    organizationId: auth.organizationId,
    role: auth.role,
  });

  const confirmationToken = randomUUID();
  const operation = await db.ioioWriteOperation.create({
    data: {
      operationType: IOIO_BORROW_OPERATION,
      status: "PREPARED",
      source:
        parsed.borrow_mode === "I_HAVE_ITEM"
          ? "IOIO_HAVE_ITEM"
          : "IOIO_ASSISTANT",
      idempotencyKey: confirmationToken,
      userId: auth.userId,
      organizationId: auth.organizationId,
      reportType: IOIO_BORROW_OPERATION,
      description: `Borrow proposal for Shelf asset ${requestedAsset.id}`,
      assetId: requestedAsset.id,
      selectedAssetIds:
        requestedAsset.type === AssetType.INDIVIDUAL
          ? selectedPhysicalUnitIds
          : undefined,
      quantity: parsed.quantity,
      from,
      to,
    },
    select: { id: true },
  });

  return {
    confirmationToken,
    operationId: operation.id,
    asset: {
      id: asset.id,
      title: asset.title,
      type: asset.type,
      location: asset.assetLocations[0]?.location.name ?? null,
    },
    kit: null,
    quantity: parsed.quantity,
    selectedPhysicalUnitIds,
    availableQuantity,
    from: from.toISOString(),
    to: to.toISOString(),
    restriction: null,
    // SELF_SERVICE borrowers must wait for staff approval. Staff and owners
    // are already authorized operators, so they can borrow directly through
    // the same canonical booking flow without approving their own request.
    requiresApproval:
      auth.role === "SELF_SERVICE" && asset.requiresBorrowApproval,
    requiresStaffPreparation: Boolean(
      asset.requiresStaffPreparation && parsed.borrow_mode !== "I_HAVE_ITEM"
    ),
    staffReservationWarning:
      availability.staffReservedCount > 0 &&
      availability.staffReservationFrom &&
      availability.staffReservationTo
        ? {
            reservedCount: availability.staffReservedCount,
            totalCount: availability.totalActive,
            from: availability.staffReservationFrom.toISOString(),
            to: availability.staffReservationTo.toISOString(),
          }
        : null,
  };
}

/** Persist the Student's acknowledgement against their server-created proposal. */
export async function acknowledgeBorrowItemStaffReservation(
  confirmationToken: string,
  { context, request }: Context
) {
  const auth = await requireStudentRead({ context, request });
  assertBorrowRole(auth.role);
  const operation = await db.ioioWriteOperation.findUnique({
    where: { idempotencyKey: confirmationToken },
    select: {
      id: true,
      userId: true,
      organizationId: true,
      operationType: true,
      status: true,
      assetId: true,
      selectedAssetIds: true,
      quantity: true,
      from: true,
      to: true,
      description: true,
    },
  });
  if (
    !operation ||
    operation.operationType !== IOIO_BORROW_OPERATION ||
    operation.userId !== auth.userId ||
    operation.organizationId !== auth.organizationId
  ) {
    throw borrowError("This borrowing request is no longer available.", 403);
  }
  if (
    operation.status !== "PREPARED" ||
    !operation.assetId ||
    !operation.quantity ||
    !operation.from ||
    !operation.to
  ) {
    throw borrowError(
      "This borrowing request is no longer ready to confirm.",
      409
    );
  }
  if (hasStaffReservationAcknowledgement(operation.description)) {
    return { ok: true as const, acknowledged: true as const };
  }

  const asset = await loadBorrowAsset(operation.assetId, auth.organizationId);
  if (!asset)
    throw borrowError("The requested item is no longer available.", 404);
  const selectedIds = getStoredSelectedAssetIds(operation.selectedAssetIds);
  const availability = await getIoioAvailability({
    organizationId: auth.organizationId,
    productId: asset.id,
    candidateAssetIds:
      asset.type === AssetType.INDIVIDUAL ? selectedIds : undefined,
    from: operation.from,
    to: operation.to,
  });
  if (!availability.staffReservationBookingIds.length) {
    throw borrowError(
      "There is no overlapping course reservation to confirm.",
      409
    );
  }
  const physicallyAvailable =
    asset.type === AssetType.INDIVIDUAL
      ? selectedIds.length === operation.quantity &&
        selectedIds.every((id) =>
          availability.availableUnitIdsWithoutStaffReservations.includes(id)
        )
      : operation.quantity <= availability.availableWithoutStaffReservations;
  if (!physicallyAvailable) {
    throw borrowError(
      "Some equipment is unavailable for these dates. Choose another unit or quantity.",
      409
    );
  }
  const acknowledged = await db.ioioWriteOperation.updateMany({
    where: {
      id: operation.id,
      userId: auth.userId,
      organizationId: auth.organizationId,
      operationType: IOIO_BORROW_OPERATION,
      status: "PREPARED",
    },
    data: {
      description: `${
        operation.description ?? ""
      } ${IOIO_STAFF_RESERVATION_ACKNOWLEDGEMENT}`.trim(),
    },
  });
  if (acknowledged.count !== 1) {
    throw borrowError(
      "This borrowing request changed before your permission was saved. Review it again.",
      409
    );
  }
  return { ok: true as const, acknowledged: true as const };
}

/**
 * Persist a logical preparation request without assigning a physical unit or
 * creating a native booking. Staff assigns and checks the actual unit later;
 * assignment then creates the authoritative Shelf booking.
 */
export async function requestPreparationForItem(
  {
    assetId,
    candidateAssetIds,
    quantity,
    acknowledgeStaffReservationOverlap = false,
  }: {
    assetId: string;
    candidateAssetIds?: string[];
    quantity: number;
    acknowledgeStaffReservationOverlap?: boolean;
  },
  { context, request }: Context
) {
  const auth = await requireStudentRead({ context, request });
  assertBorrowRole(auth.role);
  await assertAnnualAccessApproved({
    organizationId: auth.organizationId,
    userId: auth.userId,
    role: auth.role,
  });
  const asset = await loadBorrowAsset(assetId, auth.organizationId);
  if (!asset) {
    throw borrowError("The selected Shelf item is not in this workspace.", 403);
  }
  if (!asset.requiresStaffPreparation) {
    throw borrowError(
      "This item can be borrowed directly without preparation.",
      409
    );
  }
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000) {
    throw borrowError("Choose a valid quantity.");
  }
  const { from, to } = getImmediateBorrowingWindow(
    getEffectiveMaxBorrowDays(asset)
  );
  assertInitialBorrowingPeriod(from, to, getEffectiveMaxBorrowDays(asset));

  let logicalCandidateIds: string[];
  if (asset.type === AssetType.INDIVIDUAL) {
    const candidateIds = [...new Set(candidateAssetIds ?? [])];
    const candidates = await loadBorrowPhysicalUnitCandidates({
      requestedAsset: asset,
      candidateAssetIds: candidateIds,
      organizationId: auth.organizationId,
    });
    if (!candidateIds.length || candidates.length !== candidateIds.length) {
      throw borrowError("The requested Kit units could not be verified.", 409);
    }
    logicalCandidateIds = candidates.map((candidate) => candidate.id);
    await assertPhysicalUnitsNotArchived(
      logicalCandidateIds,
      auth.organizationId
    );
  } else {
    logicalCandidateIds = [asset.id];
  }

  const pendingRequest = await db.ioioWriteOperation.findFirst({
    where: {
      organizationId: auth.organizationId,
      userId: auth.userId,
      assetId: asset.id,
      operationType: IOIO_PREPARATION_OPERATION,
      source: "IOIO_PREPARATION_REQUEST",
      status: { in: [PREPARATION_PENDING, "ASSIGNING"] },
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      quantity: true,
      selectedAssetIds: true,
      description: true,
    },
  });
  const assignedRequests = pendingRequest
    ? []
    : await db.ioioWriteOperation.findMany({
        where: {
          organizationId: auth.organizationId,
          userId: auth.userId,
          assetId: asset.id,
          operationType: IOIO_PREPARATION_OPERATION,
          source: "IOIO_PREPARATION_REQUEST",
          status: "ASSIGNED",
        },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          bookingId: true,
          quantity: true,
          selectedAssetIds: true,
        },
      });
  let activeRequest = pendingRequest;
  for (const assigned of assignedRequests) {
    if (!assigned.bookingId) continue;
    const [booking, activeTask] = await Promise.all([
      db.booking.findFirst({
        where: {
          id: assigned.bookingId,
          organizationId: auth.organizationId,
          status: BookingStatus.RESERVED,
        },
        select: { id: true },
      }),
      db.ioioWriteOperation.findFirst({
        where: {
          organizationId: auth.organizationId,
          userId: auth.userId,
          bookingId: assigned.bookingId,
          operationType: IOIO_PREPARATION_OPERATION,
          source: { not: "IOIO_PREPARATION_REQUEST" },
          status: { in: [PREPARATION_PENDING, PREPARATION_READY] },
        },
        select: { id: true },
      }),
    ]);
    if (booking && activeTask) {
      activeRequest = assigned;
      break;
    }
  }
  if (activeRequest) {
    const existingUnitIds = Array.isArray(activeRequest.selectedAssetIds)
      ? activeRequest.selectedAssetIds.filter(
          (id): id is string => typeof id === "string"
        )
      : [];
    const sameUnits =
      [...existingUnitIds].sort().join(",") ===
      [...logicalCandidateIds].sort().join(",");
    if (activeRequest.quantity !== quantity || !sameUnits) {
      throw borrowError(
        "You already have a preparation request for this item. Staff will update it in My Loans.",
        409
      );
    }
    if (
      acknowledgeStaffReservationOverlap &&
      activeRequest.id === pendingRequest?.id &&
      !hasAcknowledgedStaffReservation(pendingRequest.description)
    ) {
      const activeAvailability = await getIoioAvailability({
        organizationId: auth.organizationId,
        productId: asset.id,
        candidateAssetIds:
          asset.type === AssetType.INDIVIDUAL ? logicalCandidateIds : undefined,
        from,
        to,
      });
      if (
        !activeAvailability.staffReservationBookingIds.length ||
        quantity > activeAvailability.availableWithoutStaffReservations
      ) {
        throw borrowError(
          "The request can only continue when the course reservation is the only conflict.",
          409
        );
      }
      const update = await db.ioioWriteOperation.updateMany({
        where: {
          id: activeRequest.id,
          userId: auth.userId,
          organizationId: auth.organizationId,
          status: PREPARATION_PENDING,
        },
        data: {
          description: `${
            pendingRequest.description ??
            "Student requested equipment preparation."
          } ${IOIO_STAFF_RESERVATION_ACKNOWLEDGEMENT}`,
        },
      });
      if (update.count !== 1) {
        throw borrowError(
          "This preparation request changed before your permission was saved. Review it again.",
          409
        );
      }
    }
    return {
      ok: true as const,
      status: "requested" as const,
      requestId: activeRequest.id,
      duplicate: true as const,
    };
  }

  const availability = await getIoioAvailability({
    organizationId: auth.organizationId,
    productId: asset.id,
    candidateAssetIds:
      asset.type === AssetType.INDIVIDUAL ? logicalCandidateIds : undefined,
    from,
    to,
  });
  const hasSoftReservationOverlap =
    availability.staffReservationBookingIds.length > 0;
  if (acknowledgeStaffReservationOverlap && !hasSoftReservationOverlap) {
    throw borrowError(
      "There is no overlapping course reservation to confirm.",
      409
    );
  }
  if (hasSoftReservationOverlap && !acknowledgeStaffReservationOverlap) {
    throw borrowError(
      "A course reservation overlaps these dates. Confirm that you have permission before continuing.",
      409
    );
  }
  if (
    quantity >
    (acknowledgeStaffReservationOverlap
      ? availability.availableWithoutStaffReservations
      : availability.availableCount)
  ) {
    throw borrowError(
      `Only ${
        acknowledgeStaffReservationOverlap
          ? availability.availableWithoutStaffReservations
          : availability.availableCount
      } unit${
        (acknowledgeStaffReservationOverlap
          ? availability.availableWithoutStaffReservations
          : availability.availableCount) === 1
          ? ""
          : "s"
      } are available for preparation.`,
      409
    );
  }

  await enforceIoioBorrowRateLimit({
    userId: auth.userId,
    organizationId: auth.organizationId,
  });
  await resolveStudentTeamMember({
    userId: auth.userId,
    organizationId: auth.organizationId,
    role: auth.role,
  });

  const operation = await db.ioioWriteOperation.create({
    data: {
      operationType: IOIO_PREPARATION_OPERATION,
      source: "IOIO_PREPARATION_REQUEST",
      status: PREPARATION_PENDING,
      idempotencyKey: `IOIO_PREPARATION_REQUEST:${randomUUID()}`,
      userId: auth.userId,
      organizationId: auth.organizationId,
      reportType: IOIO_PREPARATION_OPERATION,
      description: acknowledgeStaffReservationOverlap
        ? `Student requested equipment preparation. ${IOIO_STAFF_RESERVATION_ACKNOWLEDGEMENT}`
        : "Student requested equipment preparation.",
      assetId: asset.id,
      selectedAssetIds: logicalCandidateIds,
      quantity,
      from,
      to,
    },
  });

  const visibleRequest = await db.ioioWriteOperation.findFirst({
    where: {
      id: operation.id,
      organizationId: auth.organizationId,
      userId: auth.userId,
      operationType: IOIO_PREPARATION_OPERATION,
      source: "IOIO_PREPARATION_REQUEST",
      status: PREPARATION_PENDING,
    },
    select: { id: true },
  });
  if (!visibleRequest) {
    throw new Error("The preparation request could not be verified.");
  }

  return {
    ok: true as const,
    status: "requested" as const,
    requestId: operation.id,
  };
}

async function completeOperation({
  operationId,
  bookingId,
  organizationId,
}: {
  operationId: string;
  bookingId: string;
  organizationId: string;
}) {
  await db.ioioWriteOperation.updateMany({
    where: { id: operationId, organizationId },
    data: {
      status: "SUCCEEDED",
      bookingId,
      completedAt: new Date(),
      failureCode: null,
    },
  });
}

export async function cancelBorrowItem(
  token: string,
  { context, request }: Context
) {
  const auth = await requireStudentRead({ context, request });
  assertBorrowRole(auth.role);
  const operation = await db.ioioWriteOperation.findUnique({
    where: { idempotencyKey: token },
    select: {
      userId: true,
      organizationId: true,
      operationType: true,
      source: true,
      status: true,
      createdAt: true,
      bookingId: true,
    },
  });
  if (!operation || operation.operationType !== IOIO_BORROW_OPERATION) {
    throw borrowError("This borrow proposal has expired.", 404);
  }
  if (
    operation.userId !== auth.userId ||
    operation.organizationId !== auth.organizationId
  ) {
    throw borrowError(
      "This borrow proposal is not available to this user.",
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
    throw borrowError("This borrow operation cannot be cancelled.", 409);
  }
  if (operationExpired(operation.createdAt)) {
    await db.ioioWriteOperation.updateMany({
      where: { idempotencyKey: token, status: "PREPARED" },
      data: { status: "CANCELLED", completedAt: new Date() },
    });
    throw borrowError("This borrow proposal has expired.", 404);
  }
  await db.ioioWriteOperation.update({
    where: { idempotencyKey: token },
    data: { status: "CANCELLED", completedAt: new Date() },
  });
  return { ok: true as const, status: "cancelled" as const };
}

export async function borrowItem(
  {
    confirmationToken,
    quantity,
    from: _from,
    to: _to,
    selectedPhysicalUnitIds,
    allowStaffReservationOverlap = false,
  }: {
    confirmationToken: string;
    quantity: number;
    from?: string;
    to?: string;
    selectedPhysicalUnitIds?: string[];
    allowStaffReservationOverlap?: boolean;
  },
  { context, request }: Context
) {
  const startedAt = Date.now();
  const auth = await requireStudentRead({ context, request });
  assertBorrowRole(auth.role);
  const operation = await db.ioioWriteOperation.findUnique({
    where: { idempotencyKey: confirmationToken },
    select: {
      id: true,
      userId: true,
      organizationId: true,
      operationType: true,
      status: true,
      assetId: true,
      kitId: true,
      quantity: true,
      selectedAssetIds: true,
      from: true,
      to: true,
      source: true,
      bookingId: true,
      createdAt: true,
      failureCode: true,
      description: true,
    },
  });
  if (!operation || operation.operationType !== IOIO_BORROW_OPERATION) {
    throw borrowError(
      "This borrow proposal has expired or was cancelled.",
      404
    );
  }
  if (
    operation.userId !== auth.userId ||
    operation.organizationId !== auth.organizationId
  ) {
    Logger.warn({
      event: "ioio_assistant_borrow_item",
      operationType: IOIO_BORROW_OPERATION,
      organizationId: auth.organizationId,
      operationId: operation.id,
      outcome: "cross_org_or_user_rejected",
      durationMs: Date.now() - startedAt,
    });
    throw borrowError(
      "This borrow proposal is not available to this user.",
      403
    );
  }
  if (
    allowStaffReservationOverlap &&
    !hasStaffReservationAcknowledgement(operation.description)
  ) {
    throw borrowError(
      "Confirm that you have permission to borrow during the course reservation before continuing.",
      409
    );
  }
  assertConfirmationMatches(operation, { quantity, selectedPhysicalUnitIds });
  assertOperationStatus(operation.status);
  if (operation.status === "SUCCEEDED") {
    Logger.info({
      event: "ioio_assistant_borrow_item",
      operationType: IOIO_BORROW_OPERATION,
      operationId: operation.id,
      organizationId: auth.organizationId,
      outcome: "duplicate_replay",
      bookingId: operation.bookingId,
      durationMs: Date.now() - startedAt,
    });
    return {
      ok: true as const,
      status: "duplicate" as const,
      bookingId: operation.bookingId ?? undefined,
    };
  }
  await assertAnnualAccessApproved({
    organizationId: auth.organizationId,
    userId: auth.userId,
    role: auth.role,
  });
  if (operation.status === "PENDING_APPROVAL") {
    return {
      ok: true as const,
      status: "pending_approval" as const,
      operationId: operation.id,
    };
  }
  if (
    operation.status === "PREPARED" &&
    operationExpired(operation.createdAt)
  ) {
    await db.ioioWriteOperation.updateMany({
      where: { idempotencyKey: confirmationToken, status: "PREPARED" },
      data: { status: "CANCELLED", completedAt: new Date() },
    });
    throw borrowError(
      "This borrow proposal has expired or was cancelled.",
      404
    );
  }
  if (operation.status === "CANCELLED" || operation.status === "FAILED") {
    Logger.warn({
      event: "ioio_borrow_proposal_not_ready",
      operationType: operation.operationType,
      operationId: operation.id,
      assetId: operation.assetId,
      source: operation.source,
      status: operation.status,
      quantity: operation.quantity,
      ageMs: Math.max(0, Date.now() - operation.createdAt.getTime()),
      expiredByProposalTtl: operationExpired(operation.createdAt),
      hasBooking: Boolean(operation.bookingId),
      failureCode: operation.failureCode,
    });
    throw borrowError(
      "This borrow operation is not ready for submission.",
      409
    );
  }

  const parsedQuantity = Number(quantity);
  if (!operation.assetId || operation.kitId) {
    throw borrowError(
      "Only an exact Shelf asset borrow is enabled in this pilot.",
      409
    );
  }

  const existingMarkedBooking = await findMarkedBooking({
    organizationId: auth.organizationId,
    operationId: operation.id,
    bookingId: operation.bookingId,
  });
  const canResumeProcessing = operation.status === "PROCESSING";
  if (canResumeProcessing && !existingMarkedBooking) {
    throw borrowError(
      "This borrow is still being processed. Please retry shortly.",
      409
    );
  }

  if (!canResumeProcessing) {
    try {
      await enforceIoioBorrowRateLimit({
        userId: auth.userId,
        organizationId: auth.organizationId,
      });
    } catch (cause) {
      Logger.warn({
        event: "ioio_assistant_borrow_item",
        operationType: IOIO_BORROW_OPERATION,
        operationId: operation.id,
        organizationId: auth.organizationId,
        outcome: "rate_limited",
        durationMs: Date.now() - startedAt,
      });
      throw cause;
    }
    const claimed = await db.ioioWriteOperation.updateMany({
      where: {
        id: operation.id,
        idempotencyKey: confirmationToken,
        userId: auth.userId,
        organizationId: auth.organizationId,
        operationType: IOIO_BORROW_OPERATION,
        status: "PREPARED",
        createdAt: { gt: new Date(Date.now() - BORROW_PROPOSAL_TTL_MS) },
      },
      data: { status: "PROCESSING", failureCode: null },
    });
    if (claimed.count === 0) {
      const finished = await db.ioioWriteOperation.findUnique({
        where: { idempotencyKey: confirmationToken },
        select: { status: true, bookingId: true },
      });
      if (finished?.status === "SUCCEEDED") {
        return {
          ok: true as const,
          status: "duplicate" as const,
          bookingId: finished.bookingId ?? undefined,
        };
      }
      throw borrowError(
        "This borrow operation is already being processed.",
        409
      );
    }
  }

  let bookingId = existingMarkedBooking?.id ?? operation.bookingId ?? null;
  try {
    const asset = await loadBorrowAsset(operation.assetId, auth.organizationId);
    if (!asset)
      throw borrowError("The referenced Shelf asset no longer exists.", 404);
    const selectedPhysicalAssetIds =
      asset.type === AssetType.INDIVIDUAL
        ? getStoredSelectedAssetIds(operation.selectedAssetIds).length
          ? getStoredSelectedAssetIds(operation.selectedAssetIds)
          : [asset.id]
        : [];
    if (
      asset.type === AssetType.INDIVIDUAL &&
      selectedPhysicalAssetIds.length !== parsedQuantity
    ) {
      throw borrowError(
        "The selected physical units no longer match the reviewed borrow proposal.",
        409
      );
    }
    if (asset.type === AssetType.INDIVIDUAL) {
      const physicalUnits = await loadBorrowPhysicalUnitCandidates({
        requestedAsset: asset,
        candidateAssetIds: selectedPhysicalAssetIds,
        organizationId: auth.organizationId,
      });
      if (physicalUnits.length !== selectedPhysicalAssetIds.length) {
        throw borrowError(
          "One or more selected physical units no longer belong to this item.",
          409
        );
      }
      await assertPhysicalUnitsNotArchived(
        selectedPhysicalAssetIds,
        auth.organizationId
      );
      const unavailablePhysicalUnits = physicalUnits.filter(
        (unit) => unit.status !== AssetStatus.AVAILABLE || !unit.availableToBook
      );
      if (unavailablePhysicalUnits.length) {
        const temporarilyUnavailable = unavailablePhysicalUnits.filter(
          (unit) =>
            unit.status === AssetStatus.AVAILABLE && !unit.availableToBook
        );
        if (temporarilyUnavailable.length) {
          throw borrowError(
            temporarilyUnavailable
              .map(getPhysicalUnitUnavailableMessage)
              .join(" "),
            409
          );
        }
        throw borrowError(
          unavailablePhysicalUnits.length === 1
            ? getPhysicalUnitUnavailableMessage(unavailablePhysicalUnits[0])
            : `${unavailablePhysicalUnits
                .map((unit) => unit.title)
                .join(", ")} are no longer available.`,
          409
        );
      }
    }
    const borrowingWindow =
      canResumeProcessing && operation.from && operation.to
        ? { from: operation.from, to: operation.to }
        : getImmediateBorrowingWindow(getEffectiveMaxBorrowDays(asset));
    const parsedFrom = borrowingWindow.from;
    const parsedTo = borrowingWindow.to;
    assertInitialBorrowingPeriod(
      parsedFrom,
      parsedTo,
      getEffectiveMaxBorrowDays(asset)
    );
    if (!canResumeProcessing) {
      await db.ioioWriteOperation.updateMany({
        where: {
          id: operation.id,
          organizationId: auth.organizationId,
          status: "PROCESSING",
        },
        data: { from: parsedFrom, to: parsedTo },
      });
    }
    const teamMemberId = await resolveStudentTeamMember({
      userId: auth.userId,
      organizationId: auth.organizationId,
      role: auth.role,
    });

    // Do not put an ADMIN/OWNER borrower into the approval queue for their own
    // borrow. The normal student approval path remains unchanged.
    if (
      auth.role === "SELF_SERVICE" &&
      asset.requiresBorrowApproval &&
      !bookingId
    ) {
      await db.ioioWriteOperation.updateMany({
        where: {
          id: operation.id,
          organizationId: auth.organizationId,
          status: "PROCESSING",
        },
        data: { status: "PENDING_APPROVAL", completedAt: null },
      });
      return {
        ok: true as const,
        status: "pending_approval" as const,
        operationId: operation.id,
      };
    }

    let ignoreBookingIds: string[] = [];
    const marker = `IOIO_BORROW_OPERATION:${operation.id}`;
    const requiresStaffPreparation =
      asset.requiresStaffPreparation && operation.source !== "IOIO_HAVE_ITEM";
    if (!bookingId) {
      const availabilityResult = await resolveAvailableQuantity({
        asset,
        organizationId: auth.organizationId,
        from: parsedFrom,
        to: parsedTo,
        candidateAssetIds:
          asset.type === AssetType.INDIVIDUAL
            ? selectedPhysicalAssetIds
            : undefined,
        allowStaffReservationOverlap: hasStaffReservationAcknowledgement(
          operation.description
        ),
      });
      const { availableQuantity } = availabilityResult;
      ignoreBookingIds = availabilityResult.ignoreBookingIds;
      if (parsedQuantity > availableQuantity) {
        throw borrowError(
          "The requested quantity is no longer available.",
          409
        );
      }
      if (
        asset.type === AssetType.INDIVIDUAL &&
        (parsedQuantity !== selectedPhysicalAssetIds.length ||
          asset.status !== AssetStatus.AVAILABLE)
      ) {
        throw borrowError(
          "This individual Shelf asset is no longer available.",
          409
        );
      }
      const booking = await createBooking({
        booking: {
          name: `IOIO borrow — ${asset.title}`,
          description: marker,
          creatorId: auth.userId,
          custodianUserId: auth.userId,
          custodianTeamMemberId: teamMemberId,
          organizationId: auth.organizationId,
          from: parsedFrom,
          to: parsedTo,
          tags: [],
        },
        assetIds:
          asset.type === AssetType.INDIVIDUAL
            ? selectedPhysicalAssetIds
            : [asset.id],
        hints: getClientHint(request),
      });
      bookingId = booking.id;
      await db.ioioWriteOperation.updateMany({
        where: { id: operation.id, organizationId: auth.organizationId },
        data: { bookingId },
      });
    }

    const markedBooking = await findMarkedBooking({
      organizationId: auth.organizationId,
      operationId: operation.id,
      bookingId,
    });
    if (
      !markedBooking ||
      (asset.type === AssetType.INDIVIDUAL
        ? !selectedPhysicalAssetIds.every((assetId) =>
            markedBooking.bookingAssets.some((item) => item.assetId === assetId)
          )
        : !markedBooking.bookingAssets.some(
            (item) => item.assetId === asset.id
          ))
    ) {
      throw borrowError("The native Shelf booking could not be verified.", 409);
    }
    if (asset.type === AssetType.QUANTITY_TRACKED) {
      await updateBookingAssets({
        id: markedBooking.id,
        organizationId: auth.organizationId,
        assetIds: [asset.id],
        quantities: { [asset.id]: parsedQuantity },
        userId: auth.userId,
      });
    }
    if (requiresStaffPreparation) {
      if (markedBooking.status === BookingStatus.DRAFT) {
        await reserveBooking({
          id: markedBooking.id,
          organizationId: auth.organizationId,
          name: `IOIO borrow - ${asset.title}`,
          description: marker,
          custodianUserId: auth.userId,
          custodianTeamMemberId: teamMemberId,
          from: parsedFrom,
          to: parsedTo,
          hints: getClientHint(request),
          isSelfServiceOrBase: auth.role === "SELF_SERVICE",
          tags: [],
          userId: auth.userId,
          ignoreBookingIds,
          allowImmediateStart: true,
        });
      } else if (markedBooking.status !== BookingStatus.RESERVED) {
        throw borrowError(
          "This preparation request is no longer waiting for Staff.",
          409
        );
      }
    } else if (
      markedBooking.status === BookingStatus.DRAFT ||
      markedBooking.status === BookingStatus.RESERVED
    ) {
      await checkoutBooking({
        id: markedBooking.id,
        organizationId: auth.organizationId,
        userId: auth.userId,
        hints: getClientHint(request),
        ignoreBookingIds,
      });
    } else if (
      markedBooking.status !== BookingStatus.ONGOING &&
      markedBooking.status !== BookingStatus.OVERDUE
    ) {
      throw borrowError(
        "The native Shelf booking is no longer borrowable.",
        409
      );
    }

    await completeOperation({
      operationId: operation.id,
      bookingId: markedBooking.id,
      organizationId: auth.organizationId,
    });
    if (requiresStaffPreparation) {
      const preparationAssets = markedBooking.bookingAssets.filter(
        (candidate) =>
          asset.type === AssetType.INDIVIDUAL
            ? selectedPhysicalAssetIds.includes(candidate.assetId)
            : candidate.assetId === asset.id
      );
      for (const bookingAsset of preparationAssets) {
        await createPreparationTask({
          organizationId: auth.organizationId,
          borrowerUserId: auth.userId,
          bookingId: markedBooking.id,
          bookingAssetId: bookingAsset.id,
          assetId: bookingAsset.assetId,
          quantity: bookingAsset.quantity,
          from: parsedFrom,
          to: parsedTo,
          locationId: asset.assetLocations[0]?.location.id ?? null,
        });
      }
    }
    Logger.info({
      event: "ioio_assistant_borrow_item",
      operationType: IOIO_BORROW_OPERATION,
      operationId: operation.id,
      organizationId: auth.organizationId,
      bookingId: markedBooking.id,
      bookingAssetIds: markedBooking.bookingAssets.map((item) => item.id),
      assetId:
        asset.type === AssetType.INDIVIDUAL
          ? selectedPhysicalAssetIds[0]
          : asset.id,
      physicalAssetIds:
        asset.type === AssetType.INDIVIDUAL
          ? selectedPhysicalAssetIds
          : undefined,
      quantity: parsedQuantity,
      outcome: "success",
      durationMs: Date.now() - startedAt,
    });
    return {
      ok: true as const,
      status: "submitted" as const,
      bookingId: markedBooking.id,
      dueDate: parsedTo.toISOString(),
      requiresStaffPreparation,
    };
  } catch (cause) {
    if (!bookingId) {
      await db.ioioWriteOperation.updateMany({
        where: {
          id: operation.id,
          organizationId: auth.organizationId,
          status: "PROCESSING",
          bookingId: null,
        },
        data: {
          status: "PREPARED",
          failureCode: cause instanceof Error ? cause.name : "BORROW_FAILED",
        },
      });
    }
    Logger.warn({
      event: "ioio_assistant_borrow_item",
      operationType: IOIO_BORROW_OPERATION,
      operationId: operation.id,
      organizationId: auth.organizationId,
      bookingId,
      outcome: "failure",
      durationMs: Date.now() - startedAt,
      error: cause instanceof Error ? cause.name : "UnknownError",
    });
    if (cause instanceof ShelfError || isLikeShelfError(cause)) throw cause;
    throw borrowError(
      "Something went wrong while borrowing the Shelf asset.",
      409
    );
  }
}
