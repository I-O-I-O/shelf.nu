import { db } from "~/database/db.server";
import {
  IOIO_CATEGORY_ARCHIVE_ITEM_TYPE,
  type IoioItemDisposition,
} from "./archive.server";

export async function getIoioRecoverableCategories({
  organizationId,
  disposition,
}: {
  organizationId: string;
  disposition: IoioItemDisposition;
}) {
  const markers = await db.ioioArchivedItem.findMany({
    where: {
      organizationId,
      itemType: IOIO_CATEGORY_ARCHIVE_ITEM_TYPE,
      disposition,
      restoredAt: null,
    },
    orderBy: { archivedAt: "desc" },
    select: {
      id: true,
      itemId: true,
      archivedAt: true,
      archivedById: true,
      originalCategoryName: true,
    },
  });
  if (markers.length === 0) return [];

  const [categories, actors] = await Promise.all([
    db.category.findMany({
      where: {
        organizationId,
        id: { in: markers.map((marker) => marker.itemId) },
      },
      select: { id: true, name: true, description: true, color: true },
    }),
    db.user.findMany({
      where: {
        id: { in: [...new Set(markers.map((marker) => marker.archivedById))] },
      },
      select: { id: true, firstName: true, lastName: true, displayName: true },
    }),
  ]);

  const categoryById = new Map(
    categories.map((category) => [category.id, category])
  );
  const actorById = new Map(actors.map((actor) => [actor.id, actor]));

  return markers.map((marker) => {
    const actor = actorById.get(marker.archivedById);
    return {
      id: marker.id,
      categoryId: marker.itemId,
      name:
        categoryById.get(marker.itemId)?.name ??
        marker.originalCategoryName ??
        "Category unavailable",
      description: categoryById.get(marker.itemId)?.description ?? null,
      color: categoryById.get(marker.itemId)?.color ?? "#6b7280",
      archivedAt: marker.archivedAt,
      archivedBy:
        actor?.displayName ||
        [actor?.firstName, actor?.lastName].filter(Boolean).join(" ") ||
        "Staff member",
      categoryExists: categoryById.has(marker.itemId),
    };
  });
}
