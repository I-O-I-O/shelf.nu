import {
  AssetStatus,
  AssetType,
  BookingStatus,
  type Prisma,
} from "@prisma/client";
import { db } from "~/database/db.server";
import { buildActiveBookingWhere } from "~/modules/asset/availability-primitives.server";
import {
  getIoioArchivedItemIds,
  IOIO_ARCHIVE_ITEM_TYPE,
} from "~/modules/ioio-staff/archive.server";

export type CanonicalIndividualProductQuantity = {
  total: number;
  available: number;
  unitIds: string[];
};

export type IndividualAvailabilityWindow = {
  from: Date;
  to: Date;
};

export type IndividualUnitAvailabilityCandidate = {
  id: string;
  status: AssetStatus;
  availableToBook: boolean;
};

/**
 * Physical units staged for pickup stay unavailable after a Student cancels
 * or their pickup window expires. The operation state is the lifecycle source
 * of truth until Staff confirms the unit was physically put back.
 */
export async function getPreparedPickupHeldUnitIds({
  organizationId,
  assetIds,
}: {
  organizationId: string;
  assetIds: string[];
}) {
  const uniqueAssetIds = [...new Set(assetIds)];
  if (!uniqueAssetIds.length) return new Set<string>();

  const operations = await db.ioioWriteOperation.findMany({
    where: {
      organizationId,
      operationType: "IOIO_PREPARATION",
      status: { in: ["READY_FOR_PICKUP", "CANCELLED_PICKUP"] },
      assetId: { in: uniqueAssetIds },
      bookingAssetId: { not: null },
    },
    select: { assetId: true },
  });

  return new Set(
    operations
      .map((operation) => operation.assetId)
      .filter((assetId): assetId is string => Boolean(assetId))
  );
}

/**
 * Calculates availability for an already resolved physical-unit group.
 * Individual Assets are the source of truth here: one active AVAILABLE row is
 * one borrowable unit. A booking that overlaps the requested window blocks
 * only the affected physical unit.
 */
export function calculateIndividualUnitAvailability(
  units: IndividualUnitAvailabilityCandidate[],
  reservedUnitIds: Iterable<string>
) {
  const reserved = new Set(reservedUnitIds);
  const borrowableUnits = units.filter(
    (unit) =>
      unit.status === AssetStatus.AVAILABLE &&
      unit.availableToBook &&
      !reserved.has(unit.id)
  );

  return {
    total: units.length,
    available: borrowableUnits.length,
    availableUnitIds: borrowableUnits.map((unit) => unit.id),
  };
}

/**
 * Reads canonical individual-unit availability for a selected product group.
 * The input IDs are supplied by the catalog, but are re-scoped to the current
 * organization and lifecycle so a client cannot add another product's unit.
 */
export async function getIndividualUnitAvailability({
  organizationId,
  assetIds,
  window,
  excludeBookingId,
  excludeBookingIds = [],
}: {
  organizationId: string;
  assetIds: string[];
  window: IndividualAvailabilityWindow | null;
  excludeBookingId?: string;
  excludeBookingIds?: string[];
}) {
  const uniqueAssetIds = [...new Set(assetIds)];
  if (!uniqueAssetIds.length) {
    return { total: 0, available: 0, availableUnitIds: [] as string[] };
  }

  const archivedAssetIds = await getIoioArchivedItemIds({
    organizationId,
    itemType: IOIO_ARCHIVE_ITEM_TYPE.ASSET,
  });
  const units = await db.asset.findMany({
    where: {
      organizationId,
      type: AssetType.INDIVIDUAL,
      id: { in: uniqueAssetIds, notIn: archivedAssetIds },
    },
    select: {
      id: true,
      status: true,
      availableToBook: true,
    },
  });

  const bookingWhere: Prisma.BookingAssetWhereInput = {
    assetId: { in: units.map((unit) => unit.id) },
    booking: window
      ? buildActiveBookingWhere(organizationId, window)
      : {
          organizationId,
          status: { in: [BookingStatus.ONGOING, BookingStatus.OVERDUE] },
        },
  };
  const excludedBookingIds = [
    ...new Set(
      [excludeBookingId, ...excludeBookingIds].filter((id): id is string =>
        Boolean(id)
      )
    ),
  ];
  if (excludedBookingIds.length === 1) {
    bookingWhere.bookingId = { not: excludedBookingIds[0] };
  } else if (excludedBookingIds.length > 1) {
    bookingWhere.bookingId = { notIn: excludedBookingIds };
  }
  const reservations = units.length
    ? await db.bookingAsset.findMany({
        where: bookingWhere,
        select: { assetId: true },
      })
    : [];
  const heldPickupUnitIds = await getPreparedPickupHeldUnitIds({
    organizationId,
    assetIds: units.map((unit) => unit.id),
  });

  return calculateIndividualUnitAvailability(units, [
    ...reservations.map((reservation) => reservation.assetId),
    ...heldPickupUnitIds,
  ]);
}

/**
 * Resolves the physical quantity for one logical inventory product.
 *
 * A quantity source row can remain in Shelf after conversion to individually
 * tracked units. In that state its stored quantity may be zero even though
 * the active AssetModel group is the product users should see. The resolver
 * selects one matching physical group and deliberately never combines
 * duplicate AssetModels.
 */
export async function getCanonicalIndividualProductQuantity({
  organizationId,
  title,
  assetModelId,
}: {
  organizationId: string;
  title: string;
  assetModelId?: string | null;
}): Promise<CanonicalIndividualProductQuantity | null> {
  const archivedAssetIds = await getIoioArchivedItemIds({
    organizationId,
    itemType: IOIO_ARCHIVE_ITEM_TYPE.ASSET,
  });

  const modelCandidates = assetModelId
    ? [{ id: assetModelId, updatedAt: null as Date | null }]
    : await db.assetModel.findMany({
        where: { organizationId, name: { equals: title, mode: "insensitive" } },
        select: { id: true, updatedAt: true },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      });

  if (modelCandidates.length === 0) return null;

  const units = await db.asset.findMany({
    where: {
      organizationId,
      type: AssetType.INDIVIDUAL,
      assetModelId: { in: modelCandidates.map((model) => model.id) },
      ...(archivedAssetIds.length ? { id: { notIn: archivedAssetIds } } : {}),
    },
    select: {
      id: true,
      assetModelId: true,
      status: true,
      availableToBook: true,
    },
  });

  const unitsByModel = new Map<string, typeof units>();
  for (const unit of units) {
    if (!unit.assetModelId) continue;
    const group = unitsByModel.get(unit.assetModelId) ?? [];
    group.push(unit);
    unitsByModel.set(unit.assetModelId, group);
  }

  const selectedGroup = modelCandidates
    .map((model) => ({
      model,
      units: unitsByModel.get(model.id) ?? [],
    }))
    .filter(({ units: group }) => group.length > 0)
    .sort((left, right) => {
      if (right.units.length !== left.units.length) {
        return right.units.length - left.units.length;
      }

      const rightAvailable = right.units.filter(
        (unit) => unit.status === AssetStatus.AVAILABLE && unit.availableToBook
      ).length;
      const leftAvailable = left.units.filter(
        (unit) => unit.status === AssetStatus.AVAILABLE && unit.availableToBook
      ).length;
      if (rightAvailable !== leftAvailable) {
        return rightAvailable - leftAvailable;
      }

      const rightUpdatedAt = right.model.updatedAt?.getTime() ?? 0;
      const leftUpdatedAt = left.model.updatedAt?.getTime() ?? 0;
      if (rightUpdatedAt !== leftUpdatedAt) {
        return rightUpdatedAt - leftUpdatedAt;
      }

      return right.model.id.localeCompare(left.model.id);
    })[0];

  if (!selectedGroup) return null;

  return {
    total: selectedGroup.units.length,
    available: selectedGroup.units.filter(
      (unit) => unit.status === AssetStatus.AVAILABLE && unit.availableToBook
    ).length,
    unitIds: selectedGroup.units.map((unit) => unit.id),
  };
}
