export const MAX_ORGANIZE_SELECTED_MODELS = 100;

/** Resolve selected asset rows to distinct AssetModels without dropping unmodeled rows. */
export function getSelectedAssetModelIds(
  items: readonly object[]
): string[] | null {
  if (items.length === 0) return [];
  const modelIds = items.map(
    (item) => (item as { assetModelId?: string | null }).assetModelId
  );
  if (modelIds.some((modelId) => !modelId)) return null;
  return [...new Set(modelIds as string[])];
}
