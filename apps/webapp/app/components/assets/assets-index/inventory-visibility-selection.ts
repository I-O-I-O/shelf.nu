export type InventoryVisibilityItem = {
  id: string;
  ioioHidden?: boolean;
  assetModel?: { ioioHidden?: boolean } | null;
};

/** Keep mixed visibility selections explicit: each action targets only items
 * currently in the opposite state. */
export function partitionInventoryVisibilitySelection<
  T extends InventoryVisibilityItem,
>(items: T[]) {
  const visibleItems: T[] = [];
  const hiddenItems: T[] = [];

  for (const item of items) {
    if (item.ioioHidden || item.assetModel?.ioioHidden) {
      hiddenItems.push(item);
    } else {
      visibleItems.push(item);
    }
  }

  return { visibleItems, hiddenItems };
}
