import { AssetType } from "@prisma/client";
import { db } from "~/database/db.server";
import { getAssetAvailability } from "~/modules/asset/availability.server";
import { getIndividualUnitAvailability } from "~/modules/asset/individual-product-quantity.server";
import {
  getIoioArchivedItemIds,
  IOIO_ARCHIVE_ITEM_TYPE,
} from "~/modules/ioio-staff/archive.server";

export const IOIO_STAFF_RESERVATION_DESCRIPTION = "IOIO staff reservation";

export type IoioAvailability = {
  totalActive: number;
  availableCount: number;
  availableUnitIds: string[];
  availableUnitIdsWithoutStaffReservations: string[];
  conflicts: string[];
  staffReservedCount: number;
  staffReservationBookingIds: string[];
  staffReservationFrom: Date | null;
  staffReservationTo: Date | null;
  availableWithoutStaffReservations: number;
};

type AvailabilityAsset = {
  id: string;
  type: AssetType;
  quantity: number | null;
  availableToBook: boolean;
  assetModelId?: string | null;
};

type StaffReservationRow = {
  assetId: string;
  bookingId: string;
  quantity: number;
  booking: {
    from: Date;
    to: Date;
  };
};

type StaffReservationSummary = {
  quantity: number;
  from: Date;
  to: Date;
};

export function calculateMaxStaffReservationSummary(
  rows: StaffReservationRow[],
  assetType: AssetType,
  totalCapacity: number
): StaffReservationSummary | null {
  if (rows.length === 0 || totalCapacity <= 0) return null;

  const boundaries = [
    ...new Set(
      rows.flatMap((row) => [
        row.booking.from.getTime(),
        row.booking.to.getTime(),
      ])
    ),
  ].sort((left, right) => left - right);

  let maximumSummary: StaffReservationSummary | null = null;
  for (const boundary of boundaries) {
    const activeRows = rows.filter(
      (row) =>
        row.booking.from.getTime() <= boundary &&
        row.booking.to.getTime() > boundary
    );
    const reserved =
      assetType === AssetType.INDIVIDUAL
        ? new Set(activeRows.map((row) => row.assetId)).size
        : activeRows.reduce((total, row) => total + row.quantity, 0);
    const nextBoundary = boundaries.find((value) => value > boundary);
    if (
      reserved > (maximumSummary?.quantity ?? 0) &&
      nextBoundary !== undefined
    ) {
      maximumSummary = {
        quantity: Math.min(totalCapacity, reserved),
        from: new Date(boundary),
        to: new Date(nextBoundary),
      };
    }
  }

  return maximumSummary;
}

export function calculateMaxStaffReservedQuantity(
  rows: StaffReservationRow[],
  assetType: AssetType,
  totalCapacity: number
) {
  return (
    calculateMaxStaffReservationSummary(rows, assetType, totalCapacity)
      ?.quantity ?? 0
  );
}

/**
 * Shared IOIO availability facade. Student and Staff flows call this same
 * service while Shelf remains responsible for the underlying calculations.
 */
export async function getIoioAvailability({
  organizationId,
  productId,
  candidateAssetIds,
  from,
  to,
  excludeBookingId,
  excludeBookingIds = [],
}: {
  organizationId: string;
  productId: string;
  candidateAssetIds?: string[];
  from: Date;
  to: Date;
  excludeBookingId?: string;
  excludeBookingIds?: string[];
}): Promise<IoioAvailability> {
  const asset = await db.asset.findFirst({
    where: { id: productId, organizationId },
    select: {
      id: true,
      type: true,
      quantity: true,
      availableToBook: true,
      assetModelId: true,
    },
  });
  if (!asset) {
    return {
      totalActive: 0,
      availableCount: 0,
      availableUnitIds: [],
      availableUnitIdsWithoutStaffReservations: [],
      conflicts: [],
      staffReservedCount: 0,
      staffReservationBookingIds: [],
      staffReservationFrom: null,
      staffReservationTo: null,
      availableWithoutStaffReservations: 0,
    };
  }

  const allProductUnitIds =
    asset.type === AssetType.INDIVIDUAL
      ? await resolveIndividualUnitIds(asset, organizationId)
      : [asset.id];
  const ids =
    asset.type === AssetType.INDIVIDUAL
      ? candidateAssetIds?.length
        ? candidateAssetIds
        : allProductUnitIds
      : [asset.id];
  const staffReservationRows = await getStaffReservationRows({
    organizationId,
    assetIds: allProductUnitIds,
    from,
    to,
    excludeBookingId,
    excludeBookingIds,
  });
  const staffReservationBookingIds = [
    ...new Set(staffReservationRows.map((row) => row.bookingId)),
  ];
  const totalProductAvailability =
    asset.type === AssetType.INDIVIDUAL &&
    candidateAssetIds?.length &&
    allProductUnitIds.some((unitId) => !candidateAssetIds.includes(unitId))
      ? await getIndividualUnitAvailability({
          organizationId,
          assetIds: allProductUnitIds,
          window: { from, to },
          excludeBookingId,
          excludeBookingIds,
        })
      : null;
  const totalCapacity =
    asset.type === AssetType.INDIVIDUAL
      ? totalProductAvailability?.total ?? allProductUnitIds.length
      : Math.max(0, asset.quantity ?? 0);
  const staffReservationSummary = calculateMaxStaffReservationSummary(
    staffReservationRows,
    asset.type,
    totalCapacity
  );
  const staffReservedCount = staffReservationSummary?.quantity ?? 0;

  if (asset.type === AssetType.INDIVIDUAL) {
    const availability = await getIndividualUnitAvailability({
      organizationId,
      assetIds: ids,
      window: { from, to },
      excludeBookingId,
      excludeBookingIds,
    });
    const availabilityWithoutStaffReservations =
      staffReservationBookingIds.length
        ? await getIndividualUnitAvailability({
            organizationId,
            assetIds: ids,
            window: { from, to },
            excludeBookingId,
            excludeBookingIds: [
              ...new Set([...excludeBookingIds, ...staffReservationBookingIds]),
            ],
          })
        : availability;
    const availableUnitIds = availability.availableUnitIds;
    const availableUnitIdsWithoutStaffReservations =
      availabilityWithoutStaffReservations.availableUnitIds;
    return {
      totalActive: totalProductAvailability?.total ?? availability.total,
      availableCount: availableUnitIds.length,
      availableUnitIds,
      availableUnitIdsWithoutStaffReservations,
      conflicts: [],
      staffReservedCount,
      staffReservationBookingIds,
      staffReservationFrom: staffReservationSummary?.from ?? null,
      staffReservationTo: staffReservationSummary?.to ?? null,
      availableWithoutStaffReservations:
        availableUnitIdsWithoutStaffReservations.length,
    };
  }

  if (!asset.availableToBook) {
    return {
      totalActive: asset.quantity ?? 0,
      availableCount: 0,
      availableUnitIds: [],
      availableUnitIdsWithoutStaffReservations: [],
      conflicts: [],
      staffReservedCount,
      staffReservationBookingIds,
      staffReservationFrom: staffReservationSummary?.from ?? null,
      staffReservationTo: staffReservationSummary?.to ?? null,
      availableWithoutStaffReservations: 0,
    };
  }
  const availability = await getAssetAvailability({
    assetId: asset.id,
    organizationId,
    window: { from, to },
    excludeBookingId,
    excludeBookingIds,
  });
  const availabilityWithoutStaffReservations = staffReservationBookingIds.length
    ? await getAssetAvailability({
        assetId: asset.id,
        organizationId,
        window: { from, to },
        excludeBookingId,
        excludeBookingIds: [
          ...new Set([...excludeBookingIds, ...staffReservationBookingIds]),
        ],
      })
    : availability;
  return {
    totalActive: Math.max(0, asset.quantity ?? 0),
    availableCount: Math.max(
      0,
      Math.min(availability.bookable, availability.physicalAvailable)
    ),
    availableUnitIds: [],
    availableUnitIdsWithoutStaffReservations: [],
    conflicts: [],
    staffReservedCount,
    staffReservationBookingIds,
    staffReservationFrom: staffReservationSummary?.from ?? null,
    staffReservationTo: staffReservationSummary?.to ?? null,
    availableWithoutStaffReservations: Math.max(
      0,
      Math.min(
        availabilityWithoutStaffReservations.bookable,
        availabilityWithoutStaffReservations.physicalAvailable
      )
    ),
  };
}

/**
 * Check an extension window without treating the unit's current checked-out
 * state as a conflict. The current booking is excluded explicitly; only a
 * different active booking for the same physical unit can block an extension.
 */
export async function isIoioExtensionAvailable({
  organizationId,
  assetId,
  assetType,
  quantity,
  from,
  to,
  excludeBookingId,
}: {
  organizationId: string;
  assetId: string;
  assetType: AssetType;
  quantity: number;
  from: Date;
  to: Date;
  excludeBookingId?: string;
}) {
  if (assetType === AssetType.INDIVIDUAL) {
    const conflictingBookingAsset = await db.bookingAsset.findFirst({
      where: {
        assetId,
        ...(excludeBookingId ? { bookingId: { not: excludeBookingId } } : {}),
        booking: {
          organizationId,
          status: { in: ["RESERVED", "ONGOING", "OVERDUE"] },
          AND: [
            {
              OR: [
                { description: { not: IOIO_STAFF_RESERVATION_DESCRIPTION } },
                { description: null },
              ],
            },
            {
              OR: [
                { status: "OVERDUE" },
                { from: { lt: to }, to: { gt: from } },
              ],
            },
          ],
        },
      },
      select: { id: true },
    });
    return !conflictingBookingAsset;
  }

  const availability = await getIoioAvailability({
    organizationId,
    productId: assetId,
    from,
    to,
    excludeBookingId,
  });
  return availability.availableWithoutStaffReservations >= quantity;
}

async function getStaffReservationRows({
  organizationId,
  assetIds,
  from,
  to,
  excludeBookingId,
  excludeBookingIds = [],
}: {
  organizationId: string;
  assetIds: string[];
  from: Date;
  to: Date;
  excludeBookingId?: string;
  excludeBookingIds?: string[];
}) {
  if (!assetIds.length) return [];
  return db.bookingAsset.findMany({
    where: {
      assetId: { in: assetIds },
      assetKitId: null,
      booking: {
        organizationId,
        description: IOIO_STAFF_RESERVATION_DESCRIPTION,
        status: "RESERVED",
        ...(excludeBookingId || excludeBookingIds.length
          ? {
              id:
                [excludeBookingId, ...excludeBookingIds].filter(Boolean)
                  .length === 1
                  ? { not: excludeBookingId ?? excludeBookingIds[0] }
                  : {
                      notIn: [excludeBookingId, ...excludeBookingIds].filter(
                        (id): id is string => Boolean(id)
                      ),
                    },
            }
          : {}),
        from: { lt: to },
        to: { gt: from },
      },
    },
    select: {
      assetId: true,
      bookingId: true,
      quantity: true,
      booking: { select: { from: true, to: true } },
    },
  });
}

async function resolveIndividualUnitIds(
  asset: AvailabilityAsset,
  organizationId: string
) {
  const archivedAssetIds = await getIoioArchivedItemIds({
    organizationId,
    itemType: IOIO_ARCHIVE_ITEM_TYPE.ASSET,
  });
  const units = await db.asset.findMany({
    where: {
      organizationId,
      type: AssetType.INDIVIDUAL,
      id: {
        ...(asset.assetModelId ? {} : { equals: asset.id }),
        ...(archivedAssetIds.length ? { notIn: archivedAssetIds } : {}),
      },
      ...(asset.assetModelId ? { assetModelId: asset.assetModelId } : {}),
    },
    select: { id: true, status: true, availableToBook: true },
    orderBy: [{ sequentialId: "asc" }, { id: "asc" }],
  });
  return units.map((unit) => unit.id);
}
