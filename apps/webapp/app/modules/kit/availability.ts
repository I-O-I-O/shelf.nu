/**
 * Shared presentation rule for Shelf Kit availability. A Kit is available only
 * when it has at least one active member slice and every member asset is
 * bookable. Callers must pass the same lifecycle-filtered slices they display.
 */
export function isKitAvailableToBook(
  assetKits: Array<{ asset: { availableToBook: boolean } }> | null | undefined
): boolean {
  return Boolean(
    assetKits?.length && assetKits.every(({ asset }) => asset.availableToBook)
  );
}
