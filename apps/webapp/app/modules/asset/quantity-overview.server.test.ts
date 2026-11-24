/**
 * Unit tests for `buildQuantityData` — the mapping from the shared
 * `getAssetAvailability` primitive's immediate borrowing-window result into
 * the `QuantityData` shape the asset overview sidebar renders.
 *
 * This is the regression test for GitHub #2724: the asset overview's
 * headline "Available" figure used to be computed inline in the loader as
 * `total - inKits - operatorCustody - reserved - checkedOut`, where
 * `reserved` was a GLOBAL, un-windowed sum of every active booking
 * reservation (including reservations far in the future that never
 * compete for the SAME physical units). For an asset with total quantity
 * 10 and two non-overlapping standalone reservations of 7 units each
 * (14 total), the old formula reported `Available -4` (and worse in the
 * real production case that inspired #2724, `-11`) even though 10 units
 * were sitting on the shelf, physically untouched, right now.
 *
 * `buildQuantityData` is a pure function (no I/O, no mocks needed): it maps
 * the current-window `bookable` count, capped by `physicalAvailable`, onto the
 * headline `available` field.
 *
 * @see {@link file://./quantity-overview.server.ts}
 * @see {@link file://./availability.server.ts} - Where `physicalAvailable`/`reservedTotal` are computed
 * @see {@link file://./availability.server.test.ts} - Primitive-level coverage of the bb1/bb2 peak-sweep math
 */
import { describe, expect, it } from "vitest";
import type { AssetAvailability } from "./availability.server";
import { buildQuantityData } from "./quantity-overview.server";

/** Builds a full `AssetAvailability` fixture, allowing per-test overrides. */
function makeAvailability(
  overrides: Partial<AssetAvailability> = {}
): AssetAvailability {
  return {
    total: 10,
    inCustody: 0,
    inKits: 0,
    checkedOut: 0,
    reserved: 0,
    reservedTotal: 0,
    reservingBookingCount: 0,
    physicalAvailable: 10,
    bookable: 10,
    ...overrides,
  };
}

describe("buildQuantityData", () => {
  it("uses current-window bookable stock and ignores non-overlapping future reservations", () => {
    // bb1/bb2 fixture: two non-overlapping future reservations total 14,
    // but neither overlaps the immediate borrowing window. The primitive
    // reports bookable 10 for this window while keeping the global reserved
    // figure available for its separate informational row.
    const availability = makeAvailability({
      total: 10,
      inCustody: 0,
      inKits: 0,
      checkedOut: 0,
      reserved: 14,
      reservedTotal: 14,
      reservingBookingCount: 2,
      physicalAvailable: 10,
      bookable: 10,
    });

    const quantityData = buildQuantityData({
      availability,
      inLocations: 0,
      inLocationsManual: 0,
    });

    expect(quantityData.available).toBe(10);
    expect(quantityData.reserved).toBe(14);
    expect(quantityData.reservingBookingCount).toBe(2);
  });

  it("subtracts current Shelf holds from the free-to-borrow count", () => {
    const availability = makeAvailability({
      total: 5,
      physicalAvailable: 5,
      bookable: 3,
      reservedTotal: 2,
      reservingBookingCount: 1,
    });

    const quantityData = buildQuantityData({
      availability,
      inLocations: 5,
      inLocationsManual: 5,
    });

    expect(quantityData.available).toBe(3);
    expect(quantityData.custodyAvailable).toBe(3);
  });

  it("keeps `available` and `custodyAvailable` numerically converged (both source physicalAvailable)", () => {
    const availability = makeAvailability({ physicalAvailable: 7 });

    const quantityData = buildQuantityData({
      availability,
      inLocations: 0,
      inLocationsManual: 0,
    });

    expect(quantityData.available).toBe(7);
    expect(quantityData.custodyAvailable).toBe(7);
  });

  it("passes through total/inCustody/inKits/checkedOut unchanged from the primitive", () => {
    const availability = makeAvailability({
      total: 25,
      inCustody: 3,
      inKits: 4,
      checkedOut: 2,
      physicalAvailable: 16,
    });

    const quantityData = buildQuantityData({
      availability,
      inLocations: 9,
      inLocationsManual: 9,
    });

    expect(quantityData.total).toBe(25);
    expect(quantityData.inCustody).toBe(3);
    expect(quantityData.inKits).toBe(4);
    expect(quantityData.checkedOut).toBe(2);
    // `inLocations` comes from the caller (loader), not the primitive.
    expect(quantityData.inLocations).toBe(9);
  });

  it("reports zero reservations/count when nothing is reserved", () => {
    const availability = makeAvailability();

    const quantityData = buildQuantityData({
      availability,
      inLocations: 0,
      inLocationsManual: 0,
    });

    expect(quantityData.reserved).toBe(0);
    expect(quantityData.reservingBookingCount).toBe(0);
  });
});
