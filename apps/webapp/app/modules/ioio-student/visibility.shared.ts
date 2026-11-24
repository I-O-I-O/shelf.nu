type IoioVisibilityAsset = {
  ioioHidden?: boolean | null;
  assetModel?: {
    ioioHidden?: boolean | null;
    organizationId?: string | null;
  } | null;
};

/**
 * Student visibility is independent from Shelf availability. A hidden model
 * hides its linked product units; standalone assets use their own flag.
 */
export function isIoioAssetHidden(
  asset: IoioVisibilityAsset,
  organizationId?: string
) {
  if (asset.ioioHidden) return true;
  if (organizationId && asset.assetModel?.organizationId !== organizationId) {
    return false;
  }
  return Boolean(asset.assetModel?.ioioHidden);
}
