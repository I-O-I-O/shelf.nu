import { db } from "~/database/db.server";
import type { ExtendedPrismaClient } from "~/database/db.server";
import { normalizeInventoryTitle } from "~/modules/asset/staff-inventory-view";
import { ShelfError } from "~/utils/error";

export const IOIO_ARCHIVE_ITEM_TYPE = {
  ASSET: "ASSET",
  KIT: "KIT",
} as const;

export const IOIO_CATEGORY_ARCHIVE_ITEM_TYPE = "CATEGORY" as const;

export type ArchiveItemType =
  (typeof IOIO_ARCHIVE_ITEM_TYPE)[keyof typeof IOIO_ARCHIVE_ITEM_TYPE];

export type IoioLifecycleItemType =
  | ArchiveItemType
  | typeof IOIO_CATEGORY_ARCHIVE_ITEM_TYPE;

export const IOIO_ITEM_DISPOSITION = {
  ARCHIVE: "ARCHIVE",
  TRASH: "TRASH",
} as const;

export type IoioItemDisposition =
  (typeof IOIO_ITEM_DISPOSITION)[keyof typeof IOIO_ITEM_DISPOSITION];

export async function getIoioArchivedItemIds({
  organizationId,
  itemType,
}: {
  organizationId: string;
  itemType: ArchiveItemType;
}) {
  const rows = await db.ioioArchivedItem.findMany({
    where: { organizationId, itemType, restoredAt: null },
    select: { itemId: true },
  });

  const itemIds = rows.map((row) => row.itemId);
  if (itemType !== IOIO_ARCHIVE_ITEM_TYPE.ASSET || itemIds.length === 0) {
    return itemIds;
  }

  const markedAssets = await db.asset.findMany({
    where: { organizationId, id: { in: itemIds } },
    select: { id: true, title: true, type: true },
  });
  const markedQuantityTitles = new Set(
    markedAssets
      .filter((asset) => asset.type === "QUANTITY_TRACKED")
      .map((asset) => normalizeInventoryTitle(asset.title))
  );

  if (markedQuantityTitles.size === 0) return itemIds;

  // Keep the active list on the same logical lifecycle boundary as Archive
  // and Trash if an older partial marker set exists for a quantity pool.
  const quantityAssets = await db.asset.findMany({
    where: { organizationId, type: "QUANTITY_TRACKED" },
    select: { id: true, title: true },
  });
  const allArchivedIds = new Set(itemIds);
  for (const asset of quantityAssets) {
    if (markedQuantityTitles.has(normalizeInventoryTitle(asset.title))) {
      allArchivedIds.add(asset.id);
    }
  }

  return [...allArchivedIds];
}

export async function getIoioArchivedCategoryIds({
  organizationId,
}: {
  organizationId: string;
}) {
  const rows = await db.ioioArchivedItem.findMany({
    where: {
      organizationId,
      itemType: IOIO_CATEGORY_ARCHIVE_ITEM_TYPE,
      restoredAt: null,
    },
    select: { itemId: true },
  });

  return rows.map((row) => row.itemId);
}

export async function moveIoioCategoryToDisposition({
  organizationId,
  categoryId,
  movedById,
  disposition,
}: {
  organizationId: string;
  categoryId: string;
  movedById: string;
  disposition: IoioItemDisposition;
}) {
  try {
    return await db.$transaction(async (tx) => {
      const category = await tx.category.findFirst({
        where: { id: categoryId, organizationId },
        select: { id: true, name: true },
      });
      if (!category) {
        throw new ShelfError({
          cause: null,
          message: "That category could not be found in this workspace.",
          label: "Category",
          status: 404,
          shouldBeCaptured: false,
        });
      }

      const existing = await tx.ioioArchivedItem.findFirst({
        where: {
          organizationId,
          itemType: IOIO_CATEGORY_ARCHIVE_ITEM_TYPE,
          itemId: categoryId,
          restoredAt: null,
        },
        select: { id: true },
      });

      if (existing) {
        return tx.ioioArchivedItem.updateMany({
          where: {
            organizationId,
            itemType: IOIO_CATEGORY_ARCHIVE_ITEM_TYPE,
            itemId: categoryId,
            restoredAt: null,
          },
          data: {
            disposition,
            archivedById: movedById,
            archivedAt: new Date(),
          },
        });
      }

      return tx.ioioArchivedItem.create({
        data: {
          organizationId,
          itemType: IOIO_CATEGORY_ARCHIVE_ITEM_TYPE,
          itemId: category.id,
          disposition,
          archivedById: movedById,
          originalCategoryId: category.id,
          originalCategoryName: category.name,
        },
      });
    });
  } catch (cause) {
    if (cause instanceof ShelfError) throw cause;
    throw new ShelfError({
      cause,
      message:
        disposition === IOIO_ITEM_DISPOSITION.TRASH
          ? "The category could not be moved to Trash."
          : "The category could not be archived.",
      additionalData: { organizationId, categoryId },
      label: "Category",
    });
  }
}

export async function restoreIoioCategory({
  organizationId,
  categoryId,
  restoredById,
}: {
  organizationId: string;
  categoryId: string;
  restoredById: string;
}) {
  const marker = await db.ioioArchivedItem.findFirst({
    where: {
      organizationId,
      itemType: IOIO_CATEGORY_ARCHIVE_ITEM_TYPE,
      itemId: categoryId,
      restoredAt: null,
    },
    orderBy: { archivedAt: "desc" },
    select: { id: true },
  });

  if (!marker) {
    throw new ShelfError({
      cause: null,
      message: "That category is not currently archived or in Trash.",
      label: "Category",
      status: 404,
      shouldBeCaptured: false,
    });
  }

  const category = await db.category.findFirst({
    where: { id: categoryId, organizationId },
    select: { id: true },
  });
  if (!category) {
    throw new ShelfError({
      cause: null,
      message: "The original category is no longer available to restore.",
      label: "Category",
      status: 409,
      shouldBeCaptured: false,
    });
  }

  return db.ioioArchivedItem.update({
    // eslint-disable-next-line local-rules/require-org-scope-on-id-queries -- marker was loaded with organizationId above and its cuid is unique
    where: { id: marker.id },
    data: { restoredAt: new Date(), restoredById },
  });
}

export async function permanentlyDeleteIoioCategory({
  organizationId,
  categoryId,
}: {
  organizationId: string;
  categoryId: string;
}) {
  const marker = await db.ioioArchivedItem.findFirst({
    where: {
      organizationId,
      itemType: IOIO_CATEGORY_ARCHIVE_ITEM_TYPE,
      itemId: categoryId,
      restoredAt: null,
      disposition: IOIO_ITEM_DISPOSITION.TRASH,
    },
    select: { id: true },
  });
  if (!marker) {
    throw new ShelfError({
      cause: null,
      message: "That category is not currently in Trash.",
      label: "Category",
      status: 404,
      shouldBeCaptured: false,
    });
  }

  return db.$transaction(async (tx) => {
    await tx.assetModel.updateMany({
      where: { organizationId, defaultCategoryId: categoryId },
      data: { defaultCategoryId: null },
    });
    const [activeCustomFields, deletedCustomFields] = await Promise.all([
      tx.customField.findMany({
        where: {
          organizationId,
          deletedAt: null,
          categories: { some: { id: categoryId } },
        },
        select: { id: true },
      }),
      tx.customField.findMany({
        where: {
          organizationId,
          deletedAt: { not: null },
          categories: { some: { id: categoryId } },
        },
        select: { id: true },
      }),
    ]);
    const customFields = [...activeCustomFields, ...deletedCustomFields];
    for (const customField of customFields) {
      await tx.customField.update({
        // eslint-disable-next-line local-rules/require-org-scope-on-id-queries -- id was loaded from an organization-scoped custom field query above
        where: { id: customField.id },
        data: { categories: { disconnect: { id: categoryId } } },
      });
    }
    await tx.category.deleteMany({
      where: { id: categoryId, organizationId },
    });
    await tx.ioioArchivedItem.deleteMany({
      where: {
        organizationId,
        itemType: IOIO_CATEGORY_ARCHIVE_ITEM_TYPE,
        itemId: categoryId,
      },
    });
  });
}

export async function archiveIoioItem({
  organizationId,
  itemType,
  itemId,
  archivedById,
}: {
  organizationId: string;
  itemType: ArchiveItemType;
  itemId: string;
  archivedById: string;
}) {
  const [marker] = await moveIoioItemsToDisposition({
    organizationId,
    items: [{ itemType, itemId }],
    movedById: archivedById,
    disposition: IOIO_ITEM_DISPOSITION.ARCHIVE,
  });
  return marker;
}

export async function archiveIoioItems({
  organizationId,
  itemIds,
  archivedById,
}: {
  organizationId: string;
  itemIds: string[];
  archivedById: string;
}) {
  return moveIoioItemsToDisposition({
    organizationId,
    items: itemIds.map((itemId) => ({
      itemType: IOIO_ARCHIVE_ITEM_TYPE.ASSET,
      itemId,
    })),
    movedById: archivedById,
    disposition: IOIO_ITEM_DISPOSITION.ARCHIVE,
  });
}

export async function trashIoioItem({
  organizationId,
  itemType,
  itemId,
  trashedById,
}: {
  organizationId: string;
  itemType: ArchiveItemType;
  itemId: string;
  trashedById: string;
}) {
  const [marker] = await moveIoioItemsToDisposition({
    organizationId,
    items: [{ itemType, itemId }],
    movedById: trashedById,
    disposition: IOIO_ITEM_DISPOSITION.TRASH,
  });
  return marker;
}

export async function trashIoioItems({
  organizationId,
  items,
  trashedById,
}: {
  organizationId: string;
  items: Array<{ itemType: ArchiveItemType; itemId: string }>;
  trashedById: string;
}) {
  return moveIoioItemsToDisposition({
    organizationId,
    items,
    movedById: trashedById,
    disposition: IOIO_ITEM_DISPOSITION.TRASH,
  });
}

type IoioLifecycleTarget = {
  itemType: ArchiveItemType;
  itemId: string;
};

/**
 * The Staff Inventory list intentionally presents exact-title duplicates as
 * one logical row. For quantity-tracked records, lifecycle actions must use
 * that same logical boundary or a surviving raw duplicate would immediately
 * recreate the row. Individual assets are never expanded by name because
 * same-name physical items must remain independently manageable.
 */
async function expandQuantityTrackedDuplicateGroup({
  tx,
  organizationId,
  itemIds,
}: {
  tx: Pick<ExtendedPrismaClient, "asset">;
  organizationId: string;
  itemIds: string[];
}) {
  if (itemIds.length === 0) return [];

  const selectedAssets = await tx.asset.findMany({
    where: { organizationId, id: { in: itemIds } },
    select: { id: true, title: true, type: true },
  });
  const selectedQuantityTitles = new Set(
    selectedAssets
      .filter((asset) => asset.type === "QUANTITY_TRACKED")
      .map((asset) => normalizeInventoryTitle(asset.title))
  );

  if (selectedQuantityTitles.size === 0) return [...new Set(itemIds)];

  // There is no import-provenance field in Shelf's Asset model. Use the same
  // normalized-title grouping as the Staff presentation, but only for the
  // quantity-tracked records where a duplicate row represents a shared pool.
  const quantityAssets = await tx.asset.findMany({
    where: { organizationId, type: "QUANTITY_TRACKED" },
    select: { id: true, title: true },
  });
  const expandedIds = new Set(itemIds);
  for (const asset of quantityAssets) {
    if (selectedQuantityTitles.has(normalizeInventoryTitle(asset.title))) {
      expandedIds.add(asset.id);
    }
  }

  return [...expandedIds];
}

async function moveIoioItemsToDisposition({
  organizationId,
  items,
  movedById,
  disposition,
}: {
  organizationId: string;
  items: IoioLifecycleTarget[];
  movedById: string;
  disposition: IoioItemDisposition;
}) {
  const uniqueTargets = Array.from(
    new Map(
      items.map((item) => [`${item.itemType}:${item.itemId}`, item])
    ).values()
  );
  if (uniqueTargets.length === 0) return [];

  try {
    return await db.$transaction(async (tx) => {
      const assetIds = uniqueTargets
        .filter((item) => item.itemType === IOIO_ARCHIVE_ITEM_TYPE.ASSET)
        .map((item) => item.itemId);
      const kitIds = uniqueTargets
        .filter((item) => item.itemType === IOIO_ARCHIVE_ITEM_TYPE.KIT)
        .map((item) => item.itemId);
      const expandedAssetIds = await expandQuantityTrackedDuplicateGroup({
        tx,
        organizationId,
        itemIds: assetIds,
      });
      const resolvedTargets: IoioLifecycleTarget[] = [
        ...expandedAssetIds.map((itemId) => ({
          itemType: IOIO_ARCHIVE_ITEM_TYPE.ASSET,
          itemId,
        })),
        ...kitIds.map((itemId) => ({
          itemType: IOIO_ARCHIVE_ITEM_TYPE.KIT,
          itemId,
        })),
      ];

      const [assets, kits] = await Promise.all([
        expandedAssetIds.length > 0
          ? tx.asset.findMany({
              where: { organizationId, id: { in: expandedAssetIds } },
              select: {
                id: true,
                categoryId: true,
                category: { select: { name: true } },
                assetLocations: {
                  where: { assetKitId: null },
                  orderBy: { createdAt: "asc" },
                  take: 1,
                  select: {
                    location: { select: { id: true, name: true } },
                  },
                },
              },
            })
          : Promise.resolve([]),
        kitIds.length > 0
          ? tx.kit.findMany({
              where: { organizationId, id: { in: kitIds } },
              select: {
                id: true,
                categoryId: true,
                category: { select: { name: true } },
                location: { select: { id: true, name: true } },
              },
            })
          : Promise.resolve([]),
      ]);

      if (
        assets.length !== expandedAssetIds.length ||
        kits.length !== kitIds.length
      ) {
        throw new ShelfError({
          cause: null,
          message:
            "One or more selected inventory items could not be found in this workspace.",
          label: "Assets",
          status: 404,
          shouldBeCaptured: false,
        });
      }

      const existing = await tx.ioioArchivedItem.findMany({
        where: {
          organizationId,
          restoredAt: null,
          OR: resolvedTargets.map((target) => ({
            itemType: target.itemType,
            itemId: target.itemId,
          })),
        },
        select: { id: true, itemType: true, itemId: true },
      });

      const movedAt = new Date();
      for (const marker of existing) {
        await tx.ioioArchivedItem.updateMany({
          where: {
            id: marker.id,
            organizationId,
            restoredAt: null,
          },
          data: {
            disposition,
            archivedById: movedById,
            archivedAt: movedAt,
          },
        });
      }

      const existingKeys = new Set(
        existing.map((row) => `${row.itemType}:${row.itemId}`)
      );
      const assetById = new Map(assets.map((asset) => [asset.id, asset]));
      const kitById = new Map(kits.map((kit) => [kit.id, kit]));
      const recordsToCreate = resolvedTargets.filter(
        (target) => !existingKeys.has(`${target.itemType}:${target.itemId}`)
      );

      await tx.ioioArchivedItem.createMany({
        data: recordsToCreate.map((target) => {
          const asset =
            target.itemType === IOIO_ARCHIVE_ITEM_TYPE.ASSET
              ? assetById.get(target.itemId)
              : null;
          const kit =
            target.itemType === IOIO_ARCHIVE_ITEM_TYPE.KIT
              ? kitById.get(target.itemId)
              : null;
          const location = asset?.assetLocations[0]?.location ?? kit?.location;

          return {
            organizationId,
            itemType: target.itemType,
            itemId: target.itemId,
            archivedById: movedById,
            disposition,
            originalCategoryId: asset?.categoryId ?? kit?.categoryId ?? null,
            originalCategoryName:
              asset?.category?.name ?? kit?.category?.name ?? null,
            // A Shelf asset or kit is valid without a physical location.
            originalLocationId: location?.id ?? null,
            originalLocationName: location?.name ?? null,
          };
        }),
      });

      const activeMarkers = await tx.ioioArchivedItem.findMany({
        where: {
          organizationId,
          restoredAt: null,
          OR: resolvedTargets.map((target) => ({
            itemType: target.itemType,
            itemId: target.itemId,
          })),
        },
        select: { id: true, itemType: true, itemId: true },
      });

      const activeMarkerKeys = new Set(
        activeMarkers.map((row) => `${row.itemType}:${row.itemId}`)
      );
      if (activeMarkerKeys.size !== resolvedTargets.length) {
        throw new ShelfError({
          cause: null,
          message:
            disposition === IOIO_ITEM_DISPOSITION.TRASH
              ? "The selected inventory items could not be moved to Trash."
              : "The selected inventory items could not be archived.",
          label: "Assets",
          status: 409,
          shouldBeCaptured: false,
        });
      }

      return activeMarkers;
    });
  } catch (cause) {
    if (cause instanceof ShelfError) throw cause;
    throw new ShelfError({
      cause,
      message:
        disposition === IOIO_ITEM_DISPOSITION.TRASH
          ? "The selected inventory items could not be moved to Trash."
          : "The selected inventory items could not be archived.",
      additionalData: { organizationId, items: uniqueTargets },
      label: "Assets",
    });
  }
}

export async function restoreIoioItem({
  organizationId,
  itemType,
  itemId,
  restoredById,
}: {
  organizationId: string;
  itemType: ArchiveItemType;
  itemId: string;
  restoredById: string;
}) {
  const archive = await db.ioioArchivedItem.findFirst({
    where: { organizationId, itemType, itemId, restoredAt: null },
    orderBy: { archivedAt: "desc" },
    select: { id: true },
  });

  if (!archive) {
    throw new ShelfError({
      cause: null,
      message: "That inventory item is not currently archived or in Trash.",
      label: "Assets",
      status: 404,
      shouldBeCaptured: false,
    });
  }

  const exists =
    itemType === IOIO_ARCHIVE_ITEM_TYPE.ASSET
      ? await db.asset.findFirst({
          where: { id: itemId, organizationId },
          select: { id: true },
        })
      : await db.kit.findFirst({
          where: { id: itemId, organizationId },
          select: { id: true },
        });

  if (!exists) {
    throw new ShelfError({
      cause: null,
      message: "The original Shelf record is no longer available to restore.",
      label: "Assets",
      status: 409,
      shouldBeCaptured: false,
    });
  }

  try {
    return await db.ioioArchivedItem.update({
      // eslint-disable-next-line local-rules/require-org-scope-on-id-queries -- idor-safe: archive was loaded with organizationId above and its cuid is unique
      where: { id: archive.id },
      data: { restoredAt: new Date(), restoredById },
    });
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "The inventory item could not be restored.",
      additionalData: { organizationId, itemType, itemId },
      label: "Assets",
    });
  }
}

export async function restoreIoioItems({
  organizationId,
  items,
  restoredById,
}: {
  organizationId: string;
  items: Array<{ itemType: ArchiveItemType; itemId: string }>;
  restoredById: string;
}) {
  return Promise.all(
    items.map((item) =>
      restoreIoioItem({
        organizationId,
        itemType: item.itemType,
        itemId: item.itemId,
        restoredById,
      })
    )
  );
}

export async function removeIoioRecoveryMarker({
  organizationId,
  itemType,
  itemId,
}: {
  organizationId: string;
  itemType: ArchiveItemType;
  itemId: string;
}) {
  await db.ioioArchivedItem.deleteMany({
    where: {
      organizationId,
      itemType,
      itemId,
      restoredAt: null,
    },
  });
}

export async function getIoioArchivedItems({
  organizationId,
}: {
  organizationId: string;
}) {
  return db.ioioArchivedItem.findMany({
    where: {
      organizationId,
      restoredAt: null,
      disposition: IOIO_ITEM_DISPOSITION.ARCHIVE,
    },
    orderBy: { archivedAt: "desc" },
  });
}

export async function getIoioTrashItems({
  organizationId,
}: {
  organizationId: string;
}) {
  return db.ioioArchivedItem.findMany({
    where: {
      organizationId,
      restoredAt: null,
      disposition: IOIO_ITEM_DISPOSITION.TRASH,
    },
    orderBy: { archivedAt: "desc" },
  });
}
