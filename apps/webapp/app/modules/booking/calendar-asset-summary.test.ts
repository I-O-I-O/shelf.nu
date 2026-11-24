import { describe, expect, it } from "vitest";
import {
  summarizeBookingAssetsForCalendar,
  type CalendarAssetMembership,
} from "./calendar-asset-summary";

function membership({
  bookingId = "reservation-a",
  assetId,
  modelId = "makey-model",
  modelName = "Makey Kit",
  quantity = 1,
}: {
  bookingId?: string;
  assetId: string;
  modelId?: string | null;
  modelName?: string;
  quantity?: number;
}): CalendarAssetMembership {
  return {
    bookingId,
    quantity,
    asset: {
      id: assetId,
      title: assetId,
      assetModel: modelId ? { id: modelId, name: modelName } : null,
      assetKits: [],
    },
  };
}

describe("summarizeBookingAssetsForCalendar", () => {
  it("folds four physical-unit memberships into one quantity-four product summary", () => {
    const summary = summarizeBookingAssetsForCalendar(
      ["001", "002", "003", "004"].map((unit) =>
        membership({ assetId: `makey-${unit}` })
      )
    );

    expect(summary.get("reservation-a")).toEqual(["Makey Kit ×4"]);
  });

  it("does not add a quantity suffix for one unit", () => {
    const summary = summarizeBookingAssetsForCalendar([
      membership({ assetId: "makey-001" }),
    ]);

    expect(summary.get("reservation-a")).toEqual(["Makey Kit"]);
  });

  it("uses the stored membership quantity for quantity-tracked products", () => {
    const summary = summarizeBookingAssetsForCalendar([
      membership({ assetId: "makey-pool", quantity: 4 }),
    ]);

    expect(summary.get("reservation-a")).toEqual(["Makey Kit ×4"]);
  });

  it("shows different equipment types in one booking summary", () => {
    const summary = summarizeBookingAssetsForCalendar([
      membership({ assetId: "makey-001", quantity: 4 }),
      membership({
        assetId: "motor-pool",
        modelId: "motor-model",
        modelName: "Motor",
        quantity: 2,
      }),
    ]);

    expect(summary.get("reservation-a")).toEqual(["Makey Kit ×4", "Motor ×2"]);
  });

  it("keeps quantities separated by canonical booking ID", () => {
    const summary = summarizeBookingAssetsForCalendar([
      membership({ assetId: "makey-001", bookingId: "reservation-a" }),
      membership({ assetId: "makey-002", bookingId: "reservation-b" }),
    ]);

    expect([...summary.entries()]).toEqual([
      ["reservation-a", ["Makey Kit"]],
      ["reservation-b", ["Makey Kit"]],
    ]);
  });
});
