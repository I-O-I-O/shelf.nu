import {
  AssetType,
  BookingStatus,
  ConsumptionCategory,
  Prisma,
} from "@prisma/client";
import type { AssetStatus, Organization } from "@prisma/client";
import { db } from "~/database/db.server";
import { getAssetAvailabilityBatch } from "~/modules/asset/availability.server";
import { getIndividualUnitAvailability } from "~/modules/asset/individual-product-quantity.server";
import { resolveAssetImagesForPresentation } from "~/modules/asset/service.server";
import { getActiveCategoriesForOrganization } from "~/modules/category/service.server";
import {
  getIoioArchivedItemIds,
  IOIO_ARCHIVE_ITEM_TYPE,
} from "~/modules/ioio-staff/archive.server";
import { isKitAvailableToBook } from "~/modules/kit/availability";
import { getIoioKitDisplayName } from "~/modules/kit/ioio-kit-presentation";
import { refreshExpiredKitImages } from "~/modules/kit/service.server";
import { ShelfError } from "~/utils/error";
import { Logger } from "~/utils/logger";
import { resolveStorageImageUrl } from "~/utils/storage.server";
import { IOIO_STAFF_RESERVATION_DESCRIPTION } from "./availability.server";
import { resolveFuzzyInventoryCandidates } from "./inventory-search.shared";

const ASSET_SELECT = {
  id: true,
  organizationId: true,
  title: true,
  description: true,
  mainImage: true,
  mainImageExpiration: true,
  thumbnailImage: true,
  mainImageStoragePath: true,
  thumbnailImageStoragePath: true,
  updatedAt: true,
  assetModelId: true,
  assetModel: {
    select: {
      id: true,
      name: true,
      organizationId: true,
      image: true,
      thumbnailImage: true,
      imageStoragePath: true,
      thumbnailImageStoragePath: true,
    },
  },
  status: true,
  type: true,
  quantity: true,
  availableToBook: true,
  maxBorrowDays: true,
  extensionBorrowDays: true,
  requiresBorrowApproval: true,
  requiresStaffPreparation: true,
  sequentialId: true,
  category: {
    select: { id: true, name: true, color: true, organizationId: true },
  },
  assetLocations: {
    select: {
      quantity: true,
      location: {
        select: {
          id: true,
          name: true,
          parentId: true,
          organizationId: true,
        },
      },
    },
  },
  assetKits: {
    select: {
      quantity: true,
      kit: {
        select: {
          id: true,
          name: true,
          image: true,
          imageExpiration: true,
          imageStoragePath: true,
          maxBorrowDays: true,
          extensionBorrowDays: true,
          locationId: true,
          organizationId: true,
        },
      },
    },
  },
  qrCodes: { select: { id: true, organizationId: true } },
} as const;

export type StudentAsset = {
  id: string;
  title: string;
  description: string | null;
  mainImage: string | null;
  mainImageExpiration: Date | null;
  thumbnailImage: string | null;
  assetModel: {
    id: string;
    name: string;
    image: string | null;
    thumbnailImage: string | null;
  } | null;
  status: AssetStatus;
  type: AssetType;
  quantity: number | null;
  updatedAt: Date;
  assetModelId: string | null;
  availableQuantity: number | null;
  availableToBook: boolean;
  maxBorrowDays?: number;
  extensionBorrowDays?: number | null;
  requiresBorrowApproval?: boolean;
  requiresStaffPreparation?: boolean;
  sequentialId: string | null;
  category: { id: string; name: string; color: string } | null;
  locations: Array<{
    id: string;
    name: string;
    quantity: number;
    /** Compact hierarchy path populated for Ask IOIO's product result cards. */
    displayPath?: string;
  }>;
  kits: Array<{
    id: string;
    name: string;
    image?: string | null;
    imageExpiration?: Date | null;
    quantity: number;
    maxBorrowDays?: number;
    extensionBorrowDays?: number | null;
  }>;
  qrIds: string[];
  /** Native Kit cover used when the asset itself has no image. */
  kitImage?: string | null;
};

export type StudentLocation = {
  id: string;
  name: string;
  parentId: string | null;
  imageUrl: string | null;
  thumbnailUrl: string | null;
  children: StudentLocation[];
  assetCount: number;
};

export type StudentCategory = {
  id: string;
  name: string;
  color: string;
};

type AssetRow = Prisma.AssetGetPayload<{ select: typeof ASSET_SELECT }>;

function buildLocationPath(
  locationId: string,
  locationsById: Map<string, { name: string; parentId: string | null }>
) {
  const path: string[] = [];
  const seen = new Set<string>();
  let currentId: string | null = locationId;

  while (currentId && !seen.has(currentId)) {
    seen.add(currentId);
    const current = locationsById.get(currentId);
    if (!current) break;
    path.unshift(current.name);
    currentId = current.parentId;
  }

  return path.join(" → ");
}

async function shapeAssets(
  rows: Array<AssetRow>,
  organizationId: Organization["id"],
  archivedKitIds: string[]
): Promise<StudentAsset[]> {
  let currentRows = rows;
  try {
    currentRows = await resolveAssetImagesForPresentation(rows);
  } catch (cause) {
    Logger.error(
      new ShelfError({
        cause,
        message: "Failed to refresh student inventory image URLs",
        additionalData: { organizationId, assetCount: rows.length },
        label: "Assets",
      })
    );
  }

  const availability = await getAssetAvailabilityBatch(
    currentRows.map((asset) => asset.id),
    { organizationId, window: null }
  );
  const individualAvailability = new Map(
    await Promise.all(
      currentRows
        .filter((asset) => asset.type === AssetType.INDIVIDUAL)
        .map(
          async (asset) =>
            [
              asset.id,
              await getIndividualUnitAvailability({
                organizationId,
                assetIds: [asset.id],
                window: null,
              }),
            ] as const
        )
    )
  );

  return currentRows.map((asset) => {
    const currentAvailability = availability.get(asset.id);
    const assetModel =
      asset.assetModel?.organizationId === organizationId
        ? asset.assetModel
        : null;
    const primaryKit = asset.assetKits[0]?.kit;
    const refreshedPrimaryKit = primaryKit;
    return {
      id: asset.id,
      title: asset.title,
      description: asset.description,
      mainImage: asset.mainImage,
      mainImageExpiration: asset.mainImageExpiration,
      thumbnailImage: asset.thumbnailImage,
      kitImage: refreshedPrimaryKit?.image ?? null,
      assetModel: assetModel
        ? {
            id: assetModel.id,
            name: assetModel.name,
            image: assetModel.image,
            thumbnailImage: assetModel.thumbnailImage,
          }
        : null,
      status: asset.status,
      type: asset.type,
      quantity: asset.quantity,
      updatedAt: asset.updatedAt,
      // The Asset foreign key is the logical grouping identity even when the
      // related model's display fields are hidden by the organization check.
      // Keep the id for grouping only; do not expose a foreign model's name or
      // image through `assetModel` below.
      assetModelId: asset.assetModelId,
      availableQuantity:
        asset.type === AssetType.QUANTITY_TRACKED
          ? Math.max(
              0,
              currentAvailability?.physicalAvailable ?? asset.quantity ?? 0
            )
          : individualAvailability.get(asset.id)?.available ?? 0,
      availableToBook: asset.availableToBook,
      maxBorrowDays:
        asset.assetKits[0]?.kit.maxBorrowDays ?? asset.maxBorrowDays ?? 45,
      extensionBorrowDays:
        asset.assetKits[0]?.kit.extensionBorrowDays ??
        asset.extensionBorrowDays ??
        asset.assetKits[0]?.kit.maxBorrowDays ??
        asset.maxBorrowDays ??
        45,
      requiresBorrowApproval: asset.requiresBorrowApproval,
      requiresStaffPreparation: asset.requiresStaffPreparation,
      sequentialId: asset.sequentialId,
      category:
        asset.category?.organizationId === organizationId
          ? {
              id: asset.category.id,
              name: asset.category.name,
              color: asset.category.color,
            }
          : null,
      locations: asset.assetLocations
        .filter(({ location }) => location.organizationId === organizationId)
        .map(({ location, quantity }) => ({
          id: location.id,
          name: location.name,
          quantity,
        })),
      kits: asset.assetKits
        .filter(
          ({ kit }) =>
            kit.organizationId === organizationId &&
            !archivedKitIds.includes(kit.id)
        )
        .map(({ kit, quantity }) => ({
          id: kit.id,
          name: kit.name,
          image: kit.image,
          imageExpiration: kit.imageExpiration,
          quantity,
          maxBorrowDays: kit.maxBorrowDays,
          extensionBorrowDays: kit.extensionBorrowDays,
        })),
      qrIds: asset.qrCodes
        .filter((qr) => qr.organizationId === organizationId)
        .map((qr) => qr.id),
    };
  });
}

export async function getStudentAssets({
  organizationId,
  query,
  categoryId,
  locationId,
}: {
  organizationId: Organization["id"];
  query?: string | null;
  categoryId?: string | null;
  locationId?: string | null;
}) {
  const normalizedQuery = normalizeInventoryDiscoveryQuery(query);
  const [archivedAssetIds, archivedKitIds] = await Promise.all([
    getIoioArchivedItemIds({
      organizationId,
      itemType: IOIO_ARCHIVE_ITEM_TYPE.ASSET,
    }),
    getIoioArchivedItemIds({
      organizationId,
      itemType: IOIO_ARCHIVE_ITEM_TYPE.KIT,
    }),
  ]);
  let locationIds: string[] | undefined;
  if (locationId) {
    const allLocations = await db.location.findMany({
      where: { organizationId },
      select: { id: true, parentId: true },
    });
    const descendants = new Set([locationId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const location of allLocations) {
        if (
          location.parentId &&
          descendants.has(location.parentId) &&
          !descendants.has(location.id)
        ) {
          descendants.add(location.id);
          changed = true;
        }
      }
    }
    locationIds = [...descendants];
  }
  const rows = await db.asset.findMany({
    where: {
      organizationId,
      ...(archivedAssetIds.length ? { id: { notIn: archivedAssetIds } } : {}),
      ...(categoryId ? { categoryId } : {}),
      ...(locationIds
        ? { assetLocations: { some: { locationId: { in: locationIds } } } }
        : {}),
      ...(normalizedQuery
        ? {
            OR: [
              { title: { contains: normalizedQuery, mode: "insensitive" } },
              {
                sequentialId: {
                  contains: normalizedQuery,
                  mode: "insensitive",
                },
              },
              {
                description: {
                  contains: normalizedQuery,
                  mode: "insensitive",
                },
              },
              {
                assetModel: {
                  is: {
                    organizationId,
                    name: { contains: normalizedQuery, mode: "insensitive" },
                  },
                },
              },
              {
                category: {
                  name: { contains: normalizedQuery, mode: "insensitive" },
                },
              },
            ],
          }
        : {}),
    },
    select: ASSET_SELECT,
    orderBy: [{ title: "asc" }, { id: "asc" }],
  });

  return shapeAssets(rows, organizationId, archivedKitIds);
}

/** Normalize only the discovery query; Shelf records are never changed. */
export function normalizeInventoryDiscoveryQuery(
  query: string | null | undefined
) {
  return query?.trim();
}

export type StudentAssetFuzzyMatch = {
  productId: string;
  name: string;
  score: number;
  assetIds: string[];
};

/** Confidence-gated PostgreSQL trigram suggestions. The query returns only
 * organization-scoped candidate identities; callers hydrate any selected
 * product through the canonical Student asset service. */
export async function findStudentAssetFuzzyMatches({
  organizationId,
  query,
}: {
  organizationId: Organization["id"];
  query: string;
}): Promise<{
  kind: "none" | "unique" | "ambiguous";
  matches: StudentAssetFuzzyMatch[];
}> {
  const normalizedQuery = query.trim().slice(0, 120);
  if (normalizedQuery.length < 4) return { kind: "none", matches: [] };

  const archivedAssetIds = await getIoioArchivedItemIds({
    organizationId,
    itemType: IOIO_ARCHIVE_ITEM_TYPE.ASSET,
  });
  const archiveFilter = archivedAssetIds.length
    ? Prisma.sql`AND a."id" NOT IN (${Prisma.join(archivedAssetIds)})`
    : Prisma.empty;
  const rows = await db.$queryRaw<
    Array<{
      productId: string;
      productName: string;
      score: number;
      assetIds: string[];
    }>
  >(Prisma.sql`
    SELECT
      COALESCE(am."id", a."id") AS "productId",
      COALESCE(am."name", a."title") AS "productName",
      MAX(GREATEST(
        similarity(a."title", ${normalizedQuery}),
        word_similarity(${normalizedQuery}, a."title"),
        COALESCE(similarity(am."name", ${normalizedQuery}), 0),
        COALESCE(word_similarity(${normalizedQuery}, am."name"), 0),
        COALESCE(similarity(c."name", ${normalizedQuery}), 0)
      )) AS "score",
      array_agg(a."id") AS "assetIds"
    FROM "Asset" AS a
    LEFT JOIN "AssetModel" AS am
      ON am."id" = a."assetModelId"
      AND am."organizationId" = a."organizationId"
    LEFT JOIN "Category" AS c
      ON c."id" = a."categoryId"
      AND c."organizationId" = a."organizationId"
    WHERE a."organizationId" = ${organizationId}
      ${archiveFilter}
      AND (
        a."title" % ${normalizedQuery}
        OR word_similarity(${normalizedQuery}, a."title") >= 0.35
        OR am."name" % ${normalizedQuery}
        OR word_similarity(${normalizedQuery}, am."name") >= 0.35
        OR c."name" % ${normalizedQuery}
      )
    GROUP BY "productId", "productName"
    ORDER BY "score" DESC, "productName" ASC
    LIMIT 20
  `);

  return resolveFuzzyInventoryCandidates(
    rows.map((row) => ({
      productId: row.productId,
      name: row.productName,
      score: row.score,
      assetIds: row.assetIds,
    }))
  );
}

export async function getStudentAsset({
  organizationId,
  assetId,
}: {
  organizationId: Organization["id"];
  assetId: string;
}) {
  const [archivedAssetIds, archivedKitIds] = await Promise.all([
    getIoioArchivedItemIds({
      organizationId,
      itemType: IOIO_ARCHIVE_ITEM_TYPE.ASSET,
    }),
    getIoioArchivedItemIds({
      organizationId,
      itemType: IOIO_ARCHIVE_ITEM_TYPE.KIT,
    }),
  ]);
  if (archivedAssetIds.includes(assetId)) return null;
  const asset = await db.asset.findFirst({
    where: {
      id: assetId,
      organizationId,
    },
    select: ASSET_SELECT,
  });
  if (!asset) return null;
  const [shaped] = await shapeAssets([asset], organizationId, archivedKitIds);
  return shaped ?? null;
}

export async function getStudentCategories({
  organizationId,
}: {
  organizationId: Organization["id"];
}): Promise<StudentCategory[]> {
  return getActiveCategoriesForOrganization({ organizationId });
}

export async function getStudentLocations({
  organizationId,
}: {
  organizationId: Organization["id"];
}): Promise<StudentLocation[]> {
  const [locations, archivedAssetIds] = await Promise.all([
    db.location.findMany({
      where: { organizationId },
      select: {
        id: true,
        name: true,
        parentId: true,
        imageUrl: true,
        thumbnailUrl: true,
        imageStoragePath: true,
        thumbnailImageStoragePath: true,
      },
      orderBy: [{ name: "asc" }, { id: "asc" }],
    }),
    getIoioArchivedItemIds({
      organizationId,
      itemType: IOIO_ARCHIVE_ITEM_TYPE.ASSET,
    }),
  ]);
  const activeAssetPlacements = await db.asset.findMany({
    where: {
      organizationId,
      ...(archivedAssetIds.length ? { id: { notIn: archivedAssetIds } } : {}),
    },
    select: { assetLocations: { select: { locationId: true } } },
  });
  const assetCounts = new Map<string, number>();
  for (const asset of activeAssetPlacements) {
    for (const placement of asset.assetLocations) {
      assetCounts.set(
        placement.locationId,
        (assetCounts.get(placement.locationId) ?? 0) + 1
      );
    }
  }
  const nodes = new Map(
    await Promise.all(
      locations.map(
        async (location) =>
          [
            location.id,
            {
              id: location.id,
              name: location.name,
              parentId: location.parentId,
              imageUrl: await resolveStorageImageUrl({
                bucketName: "files",
                objectPath: location.imageStoragePath,
                legacyUrl: location.imageUrl,
                isPublic: true,
              }),
              thumbnailUrl: await resolveStorageImageUrl({
                bucketName: "files",
                objectPath: location.thumbnailImageStoragePath,
                legacyUrl: location.thumbnailUrl,
                isPublic: true,
              }),
              children: [] as StudentLocation[],
              assetCount: assetCounts.get(location.id) ?? 0,
            },
          ] as const
      )
    )
  );
  const roots: StudentLocation[] = [];
  for (const location of locations) {
    const node = nodes.get(location.id);
    if (!node) continue;
    const parent = location.parentId ? nodes.get(location.parentId) : null;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

export async function getStudentKits({
  organizationId,
}: {
  organizationId: Organization["id"];
}) {
  const [archivedKitIds, archivedAssetIds] = await Promise.all([
    getIoioArchivedItemIds({
      organizationId,
      itemType: IOIO_ARCHIVE_ITEM_TYPE.KIT,
    }),
    getIoioArchivedItemIds({
      organizationId,
      itemType: IOIO_ARCHIVE_ITEM_TYPE.ASSET,
    }),
  ]);
  const kits = await db.kit.findMany({
    where: {
      organizationId,
      ...(archivedKitIds.length ? { id: { notIn: archivedKitIds } } : {}),
    },
    select: {
      id: true,
      organizationId: true,
      name: true,
      maxBorrowDays: true,
      status: true,
      image: true,
      imageExpiration: true,
      imageStoragePath: true,
      location: {
        select: { id: true, name: true, organizationId: true },
      },
      qrCodes: { select: { id: true, organizationId: true } },
      assetKits: {
        select: {
          quantity: true,
          asset: {
            select: {
              id: true,
              organizationId: true,
              title: true,
              type: true,
              quantity: true,
              availableToBook: true,
            },
          },
        },
      },
    },
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });

  const refreshedKits = await refreshExpiredKitImages(kits);
  return refreshedKits.map((kit) => {
    const assetKits = kit.assetKits.filter(
      ({ asset }) =>
        asset.organizationId === organizationId &&
        !archivedAssetIds.includes(asset.id)
    );
    const safeAssetKits = assetKits.map(({ quantity, asset }) => ({
      quantity,
      asset: {
        id: asset.id,
        title: asset.title,
        type: asset.type,
        quantity: asset.quantity,
        availableToBook: asset.availableToBook,
      },
    }));
    return {
      id: kit.id,
      name: getIoioKitDisplayName(kit),
      status: kit.status,
      image: kit.image,
      imageExpiration: kit.imageExpiration,
      location:
        kit.location?.organizationId === organizationId
          ? { id: kit.location.id, name: kit.location.name }
          : null,
      qrCodes: kit.qrCodes
        .filter((qr) => qr.organizationId === organizationId)
        .map(({ id }) => ({ id })),
      assetKits: safeAssetKits,
      availableToBook: isKitAvailableToBook(safeAssetKits),
    };
  });
}

export async function getMyStudentLoans({
  organizationId,
  userId,
  includePast = false,
}: {
  organizationId: Organization["id"];
  userId: string;
  includePast?: boolean;
}) {
  const teamMembers = await db.teamMember.findMany({
    where: { organizationId, userId, deletedAt: null },
    select: { id: true },
  });
  const bookings = await db.booking.findMany({
    where: {
      organizationId,
      description: { not: IOIO_STAFF_RESERVATION_DESCRIPTION },
      AND: [
        {
          OR: [
            {
              status: {
                in: includePast
                  ? [
                      BookingStatus.ONGOING,
                      BookingStatus.OVERDUE,
                      BookingStatus.COMPLETE,
                    ]
                  : [BookingStatus.ONGOING, BookingStatus.OVERDUE],
              },
            },
            {
              status: BookingStatus.RESERVED,
              OR: [
                { description: { contains: "IOIO_BORROW_OPERATION:" } },
                { description: { contains: "IOIO_PREPARATION_REQUEST:" } },
              ],
            },
          ],
        },
        {
          OR: [
            { custodianUserId: userId },
            ...(teamMembers.length
              ? [
                  {
                    custodianTeamMemberId: {
                      in: teamMembers.map((tm) => tm.id),
                    },
                  },
                ]
              : []),
          ],
        },
      ],
    },
    select: {
      id: true,
      name: true,
      status: true,
      from: true,
      to: true,
      bookingAssets: {
        select: {
          id: true,
          quantity: true,
          checkedOutAt: true,
          checkedInAt: true,
          sourceKitId: true,
          asset: {
            select: {
              id: true,
              title: true,
              type: true,
              sequentialId: true,
              maxBorrowDays: true,
              extensionBorrowDays: true,
              returnHandling: true,
              mainImage: true,
              thumbnailImage: true,
              mainImageStoragePath: true,
              thumbnailImageStoragePath: true,
              assetModel: {
                select: {
                  id: true,
                  image: true,
                  thumbnailImage: true,
                  imageStoragePath: true,
                  thumbnailImageStoragePath: true,
                },
              },
              assetLocations: {
                select: {
                  location: {
                    select: { id: true, name: true, parentId: true },
                  },
                },
                take: 1,
              },
            },
          },
        },
      },
      consumptionLogs: {
        where: {
          category: {
            in: [
              ConsumptionCategory.RETURN,
              ConsumptionCategory.CONSUME,
              ConsumptionCategory.LOSS,
              ConsumptionCategory.DAMAGE,
            ],
          },
        },
        select: {
          assetId: true,
          bookingAssetId: true,
          quantity: true,
          createdAt: true,
        },
      },
    },
    orderBy: [{ from: "desc" }, { id: "desc" }],
  });

  const sourceKitIds = [
    ...new Set(
      bookings.flatMap((booking) =>
        booking.bookingAssets.flatMap((bookingAsset) =>
          bookingAsset.sourceKitId ? [bookingAsset.sourceKitId] : []
        )
      )
    ),
  ];
  const kits = sourceKitIds.length
    ? await refreshExpiredKitImages(
        await db.kit.findMany({
          where: { organizationId, id: { in: sourceKitIds } },
          select: {
            id: true,
            organizationId: true,
            name: true,
            maxBorrowDays: true,
            extensionBorrowDays: true,
            image: true,
            imageExpiration: true,
            imageStoragePath: true,
          },
        })
      )
    : [];
  const kitNamesById = new Map(
    kits.map((kit) => [kit.id, getIoioKitDisplayName(kit)])
  );
  const bookingAssetEntries = bookings.flatMap((booking) =>
    booking.bookingAssets.map((bookingAsset) => {
      const sourceKit = bookingAsset.sourceKitId
        ? kits.find((kit) => kit.id === bookingAsset.sourceKitId)
        : undefined;
      return {
        bookingAssetId: bookingAsset.id,
        asset: {
          ...bookingAsset.asset,
          kitImage: sourceKit?.image ?? null,
          kitImageStoragePath: sourceKit?.imageStoragePath ?? null,
        },
      };
    })
  );
  const resolvedLoanAssets = await resolveAssetImagesForPresentation(
    bookingAssetEntries.map(({ asset }) => asset)
  );
  const resolvedLoanAssetsById = new Map(
    bookingAssetEntries.map(({ bookingAssetId }, index) => [
      bookingAssetId,
      resolvedLoanAssets[index],
    ])
  );

  return bookings
    .map(({ consumptionLogs, ...booking }) => {
      const bookingAssets = booking.bookingAssets.map((bookingAsset) => {
        const sourceKit = bookingAsset.sourceKitId
          ? kits.find((kit) => kit.id === bookingAsset.sourceKitId)
          : undefined;
        const returned = consumptionLogs
          .filter(
            (log) =>
              log.assetId === bookingAsset.asset.id &&
              (log.bookingAssetId === bookingAsset.id ||
                (log.bookingAssetId === null &&
                  booking.bookingAssets.filter(
                    (candidate) => candidate.asset.id === bookingAsset.asset.id
                  ).length === 1))
          )
          .reduce((total, log) => total + log.quantity, 0);
        const quantity =
          bookingAsset.asset.type === AssetType.INDIVIDUAL &&
          bookingAsset.checkedInAt
            ? 0
            : Math.max(0, bookingAsset.quantity - returned);
        const returnedAt =
          [
            ...(bookingAsset.checkedInAt ? [bookingAsset.checkedInAt] : []),
            ...consumptionLogs
              .filter(
                (log) =>
                  log.assetId === bookingAsset.asset.id &&
                  (log.bookingAssetId === bookingAsset.id ||
                    (log.bookingAssetId === null &&
                      booking.bookingAssets.filter(
                        (candidate) =>
                          candidate.asset.id === bookingAsset.asset.id
                      ).length === 1))
              )
              .map((log) => log.createdAt),
          ].sort((left, right) => right.getTime() - left.getTime())[0] ?? null;
        return {
          ...bookingAsset,
          asset: {
            ...bookingAsset.asset,
            ...resolvedLoanAssetsById.get(bookingAsset.id),
            kitImage: sourceKit?.image ?? null,
          },
          isKit: Boolean(
            bookingAsset.sourceKitId &&
              kitNamesById.has(bookingAsset.sourceKitId)
          ),
          kitName: bookingAsset.sourceKitId
            ? kitNamesById.get(bookingAsset.sourceKitId) ?? null
            : null,
          unitLabel: bookingAsset.sourceKitId
            ? bookingAsset.asset.title.match(/(?:^|\s)(#\d+)\s*$/u)?.[1] ?? null
            : bookingAsset.asset.type === AssetType.INDIVIDUAL
            ? bookingAsset.asset.title.match(/(?:^|\s)(#\d+)\s*$/u)?.[1] ??
              bookingAsset.asset.sequentialId ??
              null
            : null,
          maxBorrowDays: bookingAsset.sourceKitId
            ? kits.find((kit) => kit.id === bookingAsset.sourceKitId)
                ?.maxBorrowDays ?? null
            : null,
          extensionBorrowDays: bookingAsset.sourceKitId
            ? kits.find((kit) => kit.id === bookingAsset.sourceKitId)
                ?.extensionBorrowDays ?? null
            : bookingAsset.asset.extensionBorrowDays,
          quantity,
          borrowedQuantity: bookingAsset.quantity,
          returnedQuantity: Math.min(bookingAsset.quantity, returned),
          outstandingQuantity: quantity,
          returnedAt,
        };
      });

      // A booking can contain more than one slice for the same asset after a
      // native edit. Present one row per asset so students do not have to
      // reconcile duplicate loan lines themselves.
      const bookingAssetsByAssetId = new Map<
        string,
        (typeof bookingAssets)[number]
      >();
      for (const bookingAsset of bookingAssets) {
        const key =
          bookingAsset.asset.type === AssetType.INDIVIDUAL
            ? `${bookingAsset.asset.id}:${bookingAsset.id}`
            : bookingAsset.asset.id;
        const existing = bookingAssetsByAssetId.get(key);
        if (!existing) {
          bookingAssetsByAssetId.set(key, bookingAsset);
          continue;
        }
        bookingAssetsByAssetId.set(key, {
          ...existing,
          quantity: existing.quantity + bookingAsset.quantity,
          borrowedQuantity:
            existing.borrowedQuantity + bookingAsset.borrowedQuantity,
          returnedQuantity:
            existing.returnedQuantity + bookingAsset.returnedQuantity,
          outstandingQuantity:
            existing.outstandingQuantity + bookingAsset.outstandingQuantity,
          returnedAt:
            existing.returnedAt && bookingAsset.returnedAt
              ? new Date(existing.returnedAt).getTime() >=
                new Date(bookingAsset.returnedAt).getTime()
                ? existing.returnedAt
                : bookingAsset.returnedAt
              : existing.returnedAt ?? bookingAsset.returnedAt,
        });
      }

      return {
        ...booking,
        bookingAssets: [...bookingAssetsByAssetId.values()].filter(
          (bookingAsset) =>
            bookingAsset.quantity > 0 ||
            (includePast && booking.status === BookingStatus.COMPLETE)
        ),
      };
    })
    .filter((booking) => booking.bookingAssets.length > 0);
}

export async function answerStudentQuestion({
  organizationId,
  question,
}: {
  organizationId: Organization["id"];
  question: string;
}) {
  const directAssets = await getStudentAssets({
    organizationId,
    query: question,
  });
  const extractedQuery = question
    .replace(
      /\b(where is|where are|do we have|is there|what is in|what's in|show me|find|locate|what can i use|what do i use)\b/gi,
      " "
    )
    .replace(/\bthat i can borrow|\bthat can be borrowed\b/gi, " ")
    .replace(/[?!.]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:the|a|an)\s+/i, "");
  const assets =
    directAssets.length || extractedQuery === question
      ? directAssets
      : await getStudentAssets({ organizationId, query: extractedQuery });
  const locations = await getStudentLocations({ organizationId });
  const locationText = locations.flatMap(function flatten(location): string[] {
    return [location.name, ...location.children.flatMap(flatten)];
  });
  const matchingLocations = locationText.filter((name) =>
    question.toLowerCase().includes(name.toLowerCase())
  );
  const locationMatches = matchingLocations.length
    ? await getStudentAssets({
        organizationId,
        locationId: locations
          .flatMap(function flattenIds(location): StudentLocation[] {
            return [location, ...location.children.flatMap(flattenIds)];
          })
          .find((location) => matchingLocations.includes(location.name))?.id,
      })
    : [];
  const result = [...assets, ...locationMatches].filter(
    (asset, index, all) =>
      all.findIndex((candidate) => candidate.id === asset.id) === index
  );

  return {
    kind: matchingLocations.length ? "location" : "asset",
    matchedLocations: matchingLocations,
    assets: result.slice(0, 20),
  };
}

export function formatStudentLocationPath(
  locationId: string,
  locations: Array<{ id: string; name: string; parentId: string | null }>
) {
  return buildLocationPath(
    locationId,
    new Map(locations.map((location) => [location.id, location]))
  );
}
