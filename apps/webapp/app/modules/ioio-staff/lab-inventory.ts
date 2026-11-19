export const LAB_INVENTORY_ACTIONS = ["disable", "enable", "delete"] as const;
export type LabInventoryAction = (typeof LAB_INVENTORY_ACTIONS)[number];

export type LabInventoryTarget = {
  assetId: string;
  title: string;
  /** A pooled record represents multiple interchangeable units. */
  pooled: boolean;
  disabled: boolean;
};
