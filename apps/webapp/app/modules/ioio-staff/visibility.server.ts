import { db } from "~/database/db.server";
import { ShelfError } from "~/utils/error";

async function setIoioAssetHiddenInTransaction(
  tx: Pick<typeof db, "asset" | "assetModel">,
  {
    assetId,
    organizationId,
    hidden,
  }: {
    assetId: string;
    organizationId: string;
    hidden: boolean;
  }
) {
  const asset = await tx.asset.findFirst({
    where: { id: assetId, organizationId },
    select: { id: true, assetModelId: true, ioioHidden: true },
  });
  if (!asset) {
    throw new ShelfError({
      cause: null,
      message: "The selected inventory item could not be found.",
      label: "Assets",
      status: 404,
      shouldBeCaptured: false,
    });
  }

  if (asset.assetModelId) {
    const model = await tx.assetModel.findFirst({
      where: { id: asset.assetModelId, organizationId },
      select: { id: true, ioioHidden: true },
    });
    if (model) {
      if (model.ioioHidden !== hidden) {
        await tx.assetModel.update({
          where: { id: model.id, organizationId },
          data: { ioioHidden: hidden },
        });
      }
      return { scope: "asset-model" as const, id: model.id, hidden };
    }

    // A legacy cross-organization model link cannot be changed safely. Keep
    // the product grouped as Shelf presents it, but apply visibility only to
    // this organization's rows. The filter makes repeated requests no-ops.
    await tx.asset.updateMany({
      where: {
        organizationId,
        assetModelId: asset.assetModelId,
        ioioHidden: { not: hidden },
      },
      data: { ioioHidden: hidden },
    });
    return { scope: "asset-model" as const, id: asset.assetModelId, hidden };
  }

  if (asset.ioioHidden !== hidden) {
    await tx.asset.update({
      where: { id: asset.id, organizationId },
      data: { ioioHidden: hidden },
    });
  }
  return { scope: "asset" as const, id: asset.id, hidden };
}

export async function setIoioAssetHidden({
  assetId,
  organizationId,
  hidden,
}: {
  assetId: string;
  organizationId: string;
  hidden: boolean;
}) {
  return db.$transaction((tx) =>
    setIoioAssetHiddenInTransaction(tx, { assetId, organizationId, hidden })
  );
}

/**
 * Apply the same canonical product-level visibility change to selected assets
 * in one transaction. Repeated physical units of one AssetModel naturally
 * become no-op writes after the first update.
 */
export async function setIoioAssetsHidden({
  assetIds,
  organizationId,
  hidden,
}: {
  assetIds: string[];
  organizationId: string;
  hidden: boolean;
}) {
  const uniqueAssetIds = Array.from(new Set(assetIds));
  if (uniqueAssetIds.length === 0) {
    throw new ShelfError({
      cause: null,
      message: "Select at least one inventory item.",
      label: "Assets",
      status: 400,
      shouldBeCaptured: false,
    });
  }

  return db.$transaction(async (tx) => {
    const results = [];
    for (const assetId of uniqueAssetIds) {
      results.push(
        await setIoioAssetHiddenInTransaction(tx, {
          assetId,
          organizationId,
          hidden,
        })
      );
    }
    return results;
  });
}
