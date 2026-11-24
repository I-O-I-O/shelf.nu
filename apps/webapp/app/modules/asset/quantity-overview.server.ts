/**
 * Asset Quantity Overview — display mapper
 *
 * Maps the shared `getAssetAvailability` primitive
 * (`~/modules/asset/availability.server`) into the `QuantityData` shape the
 * asset overview sidebar's `<QuantityOverviewCard>` renders.
 *
 * Extracted into its own module (rather than living inline in the asset
 * overview loader) purely for unit-testability: the loader
 * (`routes/_layout+/assets.$assetId.overview.tsx`) has over a dozen
 * unrelated collaborators (auth, custom fields, reminders, QR/scan lookups)
 * that would need mocking just to reach this mapping if it stayed inline.
 *
 * @see {@link file://./availability.server.ts} - The primitive this module maps from
 * @see {@link file://./../../routes/_layout+/assets.$assetId.overview.tsx} - The loader that calls this
 * @see {@link file://./../../components/assets/quantity-overview-card.tsx} - The component this feeds
 * @see superpowers/2026-07-27-qt-availability-unification-plan.md - Task 6/7
 */

import type { AssetAvailability } from "~/modules/asset/availability.server";

/**
 * The quantity breakdown surfaced on the asset overview sidebar's Quantity
 * Overview card, for QUANTITY_TRACKED assets only. Every numeric field maps
 * 1:1 onto a `<QuantityOverviewCard>` prop — see {@link buildQuantityData}.
 */
export type QuantityData = {
  /** `Asset.quantity` — total units owned. */
  total: number;
  /**
   * Operator-only custody — sum of `Custody.quantity` where
   * `kitCustodyId IS NULL`. Kit-allocated custody rows mirror
   * `AssetKit.quantity` and are already counted via `inKits`; including
   * them here would double-count.
   */
  inCustody: number;
  /**
   * Sum of `AssetKit.quantity` across every kit this asset participates
   * in. Surfaced on the sidebar so users can see how many units are
   * earmarked for kit use.
   */
  inKits: number;
  /**
   * Sum of `AssetLocation.quantity` across every location this asset is
   * placed at. Surfaced on the sidebar Quantity Overview so users see the
   * placed / unplaced split at a glance. Does NOT subtract from
   * `available` — placements are orthogonal to custody / bookings.
   */
  inLocations: number;
  /**
   * Sum of MANUAL `AssetLocation.quantity` only (`assetKitId IS NULL`).
   *
   * This is the sum `enforce_asset_location_sum_within_total` actually
   * bounds: since `20260602100000_assetlocation_sum_exclude_kit_driven` the
   * trigger ignores kit-driven rows, which are bounded separately by
   * `enforce_asset_kit_sum_within_total`.
   *
   * Used for the OVER-PLACED figure specifically. "Have placements outrun the
   * total?" can only be asked of the bounded axis — measuring it against
   * {@link inLocations} would report a valid asset (80 manual + 50 kit-driven
   * of 100) as over-allocated. "Unplaced" is a different question ("is
   * anything sitting nowhere?") and correctly spans both axes, so it keeps
   * using {@link inLocations}.
   */
  inLocationsManual: number;
  /**
   * Window-agnostic sum of every active (non-kit-driven) reservation's
   * remaining quantity — `AssetAvailability.reservedTotal`. Surfaced on
   * the "Reserved (bookings)" row alongside an explanatory tooltip. Only
   * reservations that overlap the borrowing window reduce `available` below.
   */
  reserved: number;
  /** Count of distinct bookings contributing to `reserved`, for the tooltip copy. */
  reservingBookingCount: number;
  /**
   * Units actively off the shelf via ONGOING/OVERDUE bookings
   * (`AssetAvailability.checkedOut`).
   */
  checkedOut: number;
  /**
   * Headline "Available" figure: units free for the immediate borrowing
   * window, capped by the quantity physically available.
   */
  available: number;
  /**
   * Cap used for custody assignment / total-quantity adjustments. Now
   * equal to `available` — both source from the current borrowing window — kept as
   * a distinct field only to avoid touching every existing card/dialog
   * call site that reads `custodyAvailable` specifically.
   */
  custodyAvailable: number;
};

/** Arguments for {@link buildQuantityData}. */
type BuildQuantityDataArgs = {
  /** Result of `getAssetAvailability` for this asset's immediate borrowing window. */
  availability: AssetAvailability;
  /** Sum of `AssetLocation.quantity` for this asset — not returned by the primitive, computed separately by the loader. */
  inLocations: number;
  /** Sum of MANUAL (`assetKitId IS NULL`) `AssetLocation.quantity` — the axis the location trigger bounds. */
  inLocationsManual: number;
};

/**
 * Maps the shared {@link AssetAvailability} primitive's current borrowing
 * window result — plus the already-loaded location-placement total —
 * into the {@link QuantityData} shape the asset overview sidebar renders.
 *
 * @param args - See {@link BuildQuantityDataArgs}.
 * @returns The `QuantityData` shape consumed by `<QuantityOverviewCard>`.
 */
export function buildQuantityData({
  availability,
  inLocations,
  inLocationsManual,
}: BuildQuantityDataArgs): QuantityData {
  return {
    total: availability.total,
    inCustody: availability.inCustody,
    inKits: availability.inKits,
    inLocations,
    inLocationsManual,
    reserved: availability.reservedTotal,
    reservingBookingCount: availability.reservingBookingCount,
    checkedOut: availability.checkedOut,
    // Active overlapping holds reduce free stock. Far-future reservations
    // stay visible in the separate Reserved row.
    available: Math.max(
      0,
      Math.min(availability.bookable, availability.physicalAvailable)
    ),
    custodyAvailable: Math.max(
      0,
      Math.min(availability.bookable, availability.physicalAvailable)
    ),
  };
}
