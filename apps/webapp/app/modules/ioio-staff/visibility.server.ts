import { db } from "~/database/db.server";
import { ShelfError } from "~/utils/error";

export async function setIoioAssetHidden({
  assetId,
  organizationId,
  hidden,
}: {
  assetId: string;
  organizationId: string;
  hidden: boolean;
}) {
  return db.$transaction(async (tx) => {
    const asset = await tx.asset.findFirst({
      where: { id: assetId, organizationId },
      select: { id: true, assetModelId: true },
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
        select: { id: true },
      });
      if (model) {
        await tx.assetModel.update({
          where: { id: model.id, organizationId },
          data: { ioioHidden: hidden },
        });
        return { scope: "asset-model" as const, id: model.id, hidden };
      }

      // A legacy cross-organization model link cannot be changed safely. Keep
      // the product grouped as Shelf presents it, but apply visibility only to
      // this organization's rows.
      await tx.asset.updateMany({
        where: { organizationId, assetModelId: asset.assetModelId },
        data: { ioioHidden: hidden },
      });
      return { scope: "asset-model" as const, id: asset.assetModelId, hidden };
    }

    await tx.asset.update({
      where: { id: asset.id, organizationId },
      data: { ioioHidden: hidden },
    });
    return { scope: "asset" as const, id: asset.id, hidden };
  });
}
