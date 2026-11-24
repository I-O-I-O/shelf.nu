import { db } from "~/database/db.server";
import { ASSET_MODEL_IMAGE_SELECT } from "~/modules/asset/image-select";
import { groupStaffInventoryCandidates } from "~/modules/asset/staff-inventory-view";
import type { ArchiveItemType, IoioItemDisposition } from "./archive.server";

const ITEM_TYPE = { ASSET: "ASSET", KIT: "KIT" } as const;

export async function getIoioRecoverableInventoryItems({
  organizationId,
  disposition,
}: {
  organizationId: string;
  disposition: IoioItemDisposition;
}) {
  const rows = await db.ioioArchivedItem.findMany({
    where: {
      organizationId,
      restoredAt: null,
      disposition,
      itemType: { in: [ITEM_TYPE.ASSET, ITEM_TYPE.KIT] },
    },
    orderBy: { archivedAt: "desc" },
  });
  const assetIds = rows
    .filter((row) => row.itemType === ITEM_TYPE.ASSET)
    .map((row) => row.itemId);
  const kitIds = rows
    .filter((row) => row.itemType === ITEM_TYPE.KIT)
    .map((row) => row.itemId);
  const actorIds = [...new Set(rows.map((row) => row.archivedById))];
  const categoryIds = rows
    .map((row) => row.originalCategoryId)
    .filter((id): id is string => Boolean(id));
  const locationIds = rows
    .map((row) => row.originalLocationId)
    .filter((id): id is string => Boolean(id));

  const [assets, kits, actors, categories, locations] = await Promise.all([
    db.asset.findMany({
      where: { organizationId, id: { in: assetIds } },
      select: {
        id: true,
        title: true,
        type: true,
        quantity: true,
        availableToBook: true,
        updatedAt: true,
        mainImage: true,
        thumbnailImage: true,
        ...ASSET_MODEL_IMAGE_SELECT,
        category: { select: { name: true } },
        assetLocations: {
          where: { assetKitId: null },
          orderBy: { createdAt: "asc" },
          take: 1,
          select: { location: { select: { name: true } } },
        },
      },
    }),
    db.kit.findMany({
      where: { organizationId, id: { in: kitIds } },
      select: {
        id: true,
        name: true,
        image: true,
        imageExpiration: true,
        category: { select: { name: true } },
        location: { select: { name: true } },
      },
    }),
    db.user.findMany({
      where: { id: { in: actorIds } },
      select: { id: true, firstName: true, lastName: true, displayName: true },
    }),
    db.category.findMany({
      where: { organizationId, id: { in: categoryIds } },
      select: { id: true },
    }),
    db.location.findMany({
      where: { organizationId, id: { in: locationIds } },
      select: { id: true },
    }),
  ]);

  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const kitById = new Map(kits.map((kit) => [kit.id, kit]));
  const actorById = new Map(actors.map((actor) => [actor.id, actor]));
  const categoryIdsStillPresent = new Set(
    categories.map((category) => category.id)
  );
  const locationIdsStillPresent = new Set(
    locations.map((location) => location.id)
  );

  const candidates = rows.map((row) => {
    const asset =
      row.itemType === ITEM_TYPE.ASSET ? assetById.get(row.itemId) : null;
    const kit = row.itemType === ITEM_TYPE.KIT ? kitById.get(row.itemId) : null;
    const actor = actorById.get(row.archivedById);
    const actorName =
      actor?.displayName ||
      [actor?.firstName, actor?.lastName].filter(Boolean).join(" ") ||
      "Staff member";

    return {
      id: row.id,
      itemId: row.itemId,
      itemType: row.itemType as ArchiveItemType,
      name: asset?.title ?? kit?.name ?? "Inventory item unavailable",
      category:
        asset?.category?.name ??
        kit?.category?.name ??
        row.originalCategoryName ??
        null,
      location:
        asset?.assetLocations[0]?.location.name ??
        kit?.location?.name ??
        row.originalLocationName ??
        null,
      archivedAt: row.archivedAt,
      archivedBy: actorName,
      needsReview:
        (!asset && !kit) ||
        (row.originalCategoryId !== null &&
          !categoryIdsStillPresent.has(row.originalCategoryId)) ||
        (row.originalLocationId !== null &&
          !locationIdsStillPresent.has(row.originalLocationId)),
      assetImage: asset
        ? {
            id: asset.id,
            mainImage: asset.mainImage,
            thumbnailImage: asset.thumbnailImage,
            assetModel: asset.assetModel,
          }
        : null,
      kitImage: kit
        ? {
            kitId: kit.id,
            image: kit.image,
            imageExpiration: kit.imageExpiration,
          }
        : null,
      title: asset?.title ?? kit?.name ?? "Inventory item unavailable",
      type: asset?.type ?? null,
      availableToBook: asset?.availableToBook ?? null,
      assetLocations: asset?.assetLocations ?? null,
      updatedAt: asset?.updatedAt ?? row.archivedAt,
      quantity: asset?.quantity ?? null,
    };
  });

  return groupStaffInventoryCandidates(candidates, {
    shouldGroup: (item) =>
      item.itemType === ITEM_TYPE.ASSET && item.type === "QUANTITY_TRACKED",
  }).map(({ canonical, members }) => ({
    id: canonical.id,
    itemId: canonical.itemId,
    itemType: canonical.itemType,
    name: canonical.name,
    category: canonical.category,
    location: canonical.location,
    archivedAt: canonical.archivedAt,
    archivedBy: canonical.archivedBy,
    needsReview: canonical.needsReview,
    assetImage: canonical.assetImage,
    kitImage: canonical.kitImage,
    quantity: canonical.quantity,
    duplicateRecordCount: members.length,
    lifecycleItems: [
      ...new Map(
        members.map((member) => [
          `${member.itemType}:${member.itemId}`,
          { itemId: member.itemId, itemType: member.itemType },
        ])
      ).values(),
    ],
  }));
}
