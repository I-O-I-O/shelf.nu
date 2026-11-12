import type { Asset } from "@prisma/client";
import type { db } from "~/database/db.server";
import { ShelfError } from "~/utils/error";

export const NOT_BORROWABLE_MESSAGE =
  "This item is not available for borrowing.";

export function assertAssetBorrowable(asset: Pick<Asset, "availableToBook">) {
  if (asset.availableToBook === false) {
    throw new ShelfError({
      cause: null,
      label: "Assets",
      status: 409,
      shouldBeCaptured: false,
      message: NOT_BORROWABLE_MESSAGE,
    });
  }
}

/** Read inside the canonical write transaction, including kit/member checkouts. */
export async function assertAssetsBorrowable(
  client: Pick<typeof db, "asset">,
  assetIds: string[],
  organizationId: string
) {
  if (!assetIds.length) return;
  const blocked = await client.asset.findFirst({
    where: { organizationId, id: { in: assetIds }, availableToBook: false },
    select: { availableToBook: true },
  });
  if (blocked) assertAssetBorrowable(blocked);
}
