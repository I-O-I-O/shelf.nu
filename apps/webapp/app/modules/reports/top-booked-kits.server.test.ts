import { beforeEach, describe, expect, it, vi } from "vitest";

// why: Keep this query/aggregation test isolated from the local database.
vi.mock("~/database/db.server", () => ({
  db: {
    booking: { findMany: vi.fn() },
    assetKit: { findMany: vi.fn() },
    kit: { findMany: vi.fn(), update: vi.fn() },
  },
}));

import { db } from "~/database/db.server";

import { topBookedKitsReport } from "./helpers.server";
import type { ResolvedTimeframe } from "./types";

const timeframe: ResolvedTimeframe = {
  preset: "last_30d",
  label: "Last 30 days",
  from: new Date("2026-04-01T00:00:00Z"),
  to: new Date("2026-04-30T23:59:59Z"),
};

const kit = (id: string, name: string) => ({
  id,
  organizationId: "org-1",
  name,
  image: null,
  imageExpiration: null,
  category: null,
  location: null,
});

const checkoutSlice = (kitId: string) => ({
  sourceKitId: kitId,
  assetKitId: null,
  checkedOutAt: new Date("2026-04-10T12:00:00Z"),
});

describe("topBookedKitsReport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.booking.findMany).mockResolvedValue([] as any);
    vi.mocked(db.assetKit.findMany).mockResolvedValue([] as any);
    vi.mocked(db.kit.findMany).mockResolvedValue([] as any);
  });

  it("counts a real kit checkout once per loan and ranks kits by loan count", async () => {
    vi.mocked(db.booking.findMany).mockResolvedValue([
      { bookingAssets: [checkoutSlice("kit-1"), checkoutSlice("kit-1")] },
      { bookingAssets: [checkoutSlice("kit-1"), checkoutSlice("kit-2")] },
    ] as any);
    vi.mocked(db.kit.findMany).mockResolvedValue([
      kit("kit-1", "Camera Kit"),
      kit("kit-2", "Lighting Kit"),
    ] as any);

    const result = await topBookedKitsReport({
      organizationId: "org-1",
      timeframe,
    });

    expect(result.rows.map((row) => [row.kitId, row.bookingCount])).toEqual([
      ["kit-1", 2],
      ["kit-2", 1],
    ]);
  });

  it("limits counts to checked-out kit slices in the selected period", async () => {
    await topBookedKitsReport({ organizationId: "org-1", timeframe });

    const args = vi.mocked(db.booking.findMany).mock.calls[0][0] as any;
    expect(args.where.status).toEqual({ notIn: ["DRAFT", "CANCELLED"] });
    expect(args.select.bookingAssets.where).toMatchObject({
      checkedOutAt: { gte: timeframe.from, lte: timeframe.to },
      OR: [{ sourceKitId: { not: null } }, { assetKitId: { not: null } }],
    });
  });

  it("does not return a kit ranking when the period has no checkouts", async () => {
    const result = await topBookedKitsReport({
      organizationId: "org-1",
      timeframe,
    });
    expect(result.rows).toEqual([]);
    expect(result.totalRows).toBe(0);
    expect(result.topBookedKit).toBeNull();
  });
});
