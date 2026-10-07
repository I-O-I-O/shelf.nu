import { data, type ActionFunctionArgs } from "react-router";
import { db } from "~/database/db.server";
import { updateAsset } from "~/modules/asset/service.server";
import {
  IOIO_ARCHIVE_ITEM_TYPE,
  restoreIoioItems,
} from "~/modules/ioio-staff/archive.server";
import { BulkUndoSchema } from "~/modules/ioio-staff/bulk-undo";
import { makeShelfError, ShelfError } from "~/utils/error";
import { error, payload } from "~/utils/http.server";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

const UNDO_WINDOW_MS = 30_000;

export async function action({ context, request }: ActionFunctionArgs) {
  const userId = context.getSession().userId;

  try {
    if (request.method.toLowerCase() !== "post") {
      throw new ShelfError({
        cause: null,
        message: "Undo is only available as a POST action.",
        label: "Assets",
        status: 405,
        shouldBeCaptured: false,
      });
    }

    const formData = await request.formData();
    const rawUndo = formData.get("undo");
    if (typeof rawUndo !== "string") {
      throw new ShelfError({
        cause: null,
        message: "This undo action is no longer available.",
        label: "Assets",
        status: 400,
        shouldBeCaptured: false,
      });
    }

    let parsedUndo: unknown;
    try {
      parsedUndo = JSON.parse(rawUndo);
    } catch {
      throw new ShelfError({
        cause: null,
        message: "This undo action is invalid.",
        label: "Assets",
        status: 400,
        shouldBeCaptured: false,
      });
    }

    const undo = BulkUndoSchema.parse(parsedUndo);
    if (Date.now() - undo.createdAt > UNDO_WINDOW_MS) {
      throw new ShelfError({
        cause: null,
        message: "This undo action has expired. Refresh Inventory to continue.",
        label: "Assets",
        status: 409,
        shouldBeCaptured: false,
      });
    }

    const requiredAction =
      undo.operation === "archive" || undo.operation === "trash"
        ? PermissionAction.delete
        : PermissionAction.update;
    const { organizationId } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.asset,
      action: requiredAction,
    });

    const assetIds = [...new Set(undo.entries.map((entry) => entry.assetId))];
    const assets = await db.asset.findMany({
      where: { organizationId, id: { in: assetIds } },
      select: {
        id: true,
        categoryId: true,
        assetLocations: {
          where: { assetKitId: null },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take: 1,
          select: { locationId: true },
        },
      },
    });

    if (assets.length !== assetIds.length) {
      throw new ShelfError({
        cause: null,
        message: "Some selected inventory items are no longer available.",
        label: "Assets",
        status: 409,
        shouldBeCaptured: false,
      });
    }

    const assetsById = new Map(assets.map((asset) => [asset.id, asset]));

    if (undo.operation === "archive" || undo.operation === "trash") {
      await restoreIoioItems({
        organizationId,
        items: assetIds.map((itemId) => ({
          itemType: IOIO_ARCHIVE_ITEM_TYPE.ASSET,
          itemId,
        })),
        restoredById: userId,
      });

      return data(payload({ success: true }));
    }

    if (undo.operation === "category") {
      for (const entry of undo.entries) {
        const asset = assetsById.get(entry.assetId);
        if (
          asset?.categoryId !==
          (entry.expectedCategoryId === undefined
            ? null
            : entry.expectedCategoryId)
        ) {
          throw new ShelfError({
            cause: null,
            message:
              "Some items changed after the bulk update, so the action was not undone.",
            label: "Assets",
            status: 409,
            shouldBeCaptured: false,
          });
        }
      }

      await Promise.all(
        undo.entries.map((entry) =>
          updateAsset({
            id: entry.assetId,
            categoryId: entry.previousCategoryId ?? null,
            organizationId,
            request,
            userId,
          })
        )
      );

      return data(payload({ success: true }));
    }

    if (undo.operation === "location") {
      for (const entry of undo.entries) {
        const asset = assetsById.get(entry.assetId);
        const currentLocationId = asset?.assetLocations[0]?.locationId ?? null;
        if (
          currentLocationId !==
          (entry.expectedLocationId === undefined
            ? null
            : entry.expectedLocationId)
        ) {
          throw new ShelfError({
            cause: null,
            message:
              "Some items changed after the bulk update, so the action was not undone.",
            label: "Assets",
            status: 409,
            shouldBeCaptured: false,
          });
        }
      }

      await Promise.all(
        undo.entries.map((entry) =>
          updateAsset({
            id: entry.assetId,
            currentLocationId: entry.expectedLocationId ?? null,
            newLocationId: entry.previousLocationId ?? null,
            organizationId,
            request,
            userId,
          })
        )
      );

      return data(payload({ success: true }));
    }

    return data(payload({ success: true }));
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    return data(error(reason), { status: reason.status });
  }
}
