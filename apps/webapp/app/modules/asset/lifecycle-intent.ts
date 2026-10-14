/** Shared Staff Inventory lifecycle intents used by client forms and actions. */
export const ASSET_LIFECYCLE_INTENT = {
  ARCHIVE: "bulk-archive",
  TRASH: "bulk-trash",
} as const;

export type AssetLifecycleIntent =
  (typeof ASSET_LIFECYCLE_INTENT)[keyof typeof ASSET_LIFECYCLE_INTENT];
