import { BookingStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  getLoanAssetDisplayName,
  getLoanLifecycle,
  getLoanListDateValue,
  getLoanPhysicalUnitNumber,
} from "./loan-presentation";

describe("staff loan asset display names", () => {
  it.each([
    ["Arduino Kit #001", "Arduino Kit #001"],
    ["Makey Makey Kit #003", "Makey Makey Kit #003"],
  ])(
    "keeps the unit suffix from the physical asset title",
    (title, expected) => {
      expect(getLoanAssetDisplayName({ title })).toBe(expected);
    }
  );

  it("uses the logical product name with the physical unit number for kits", () => {
    expect(
      getLoanAssetDisplayName({
        title: "Asset record #003",
        logicalProductName: "Makey Makey Kit",
      })
    ).toBe("Makey Makey Kit #003");
  });

  it("does not duplicate an already-present unit suffix", () => {
    expect(getLoanAssetDisplayName({ title: "Arduino Kit #002 #002" })).toBe(
      "Arduino Kit #002"
    );
  });

  it("does not invent a unit number for pooled assets", () => {
    expect(
      getLoanPhysicalUnitNumber({
        title: "Motor #001",
        type: "QUANTITY_TRACKED",
      })
    ).toBeNull();
    expect(
      getLoanAssetDisplayName({
        title: "Motor #001",
        type: "QUANTITY_TRACKED",
      })
    ).toBe("Motor");
  });
});

describe("staff loan list date values", () => {
  it("keeps the planned calendar day when normalizing a timestamp", () => {
    expect(getLoanListDateValue("2030-01-15T23:59:59.000Z", true)).toBe(
      "2030-01-15"
    );
  });

  it("keeps actual event timestamps as instants", () => {
    const value = new Date("2030-01-15T09:00:00.000Z");
    expect(getLoanListDateValue(value)).toBe(value);
  });
});

describe("staff loan lifecycle presentation", () => {
  it("keeps due date separate from the actual return timestamp", () => {
    const result = getLoanLifecycle({
      status: BookingStatus.COMPLETE,
      to: new Date("2030-01-16T00:00:00.000Z"),
      originalTo: new Date("2030-01-15T17:00:00.000Z"),
      bookingAssets: [
        {
          checkedOutAt: new Date("2030-01-15T09:00:00.000Z"),
          checkedInAt: new Date("2030-01-15T11:00:00.000Z"),
          checkedOutQuantity: 1,
          quantity: 1,
        },
      ],
    });

    expect(result.statusLabel).toBe("Returned");
    expect(result.dueAt).toEqual(new Date("2030-01-15T17:00:00.000Z"));
    expect(result.returnedAt).toEqual(new Date("2030-01-15T11:00:00.000Z"));
    expect(result.borrowedAt).toEqual(new Date("2030-01-15T09:00:00.000Z"));
  });

  it("marks a loan partially returned when only some slices are checked in", () => {
    const result = getLoanLifecycle({
      status: BookingStatus.ONGOING,
      to: new Date("2030-01-20T17:00:00.000Z"),
      bookingAssets: [
        {
          checkedOutAt: new Date("2030-01-15T09:00:00.000Z"),
          checkedInAt: new Date("2030-01-15T11:00:00.000Z"),
          checkedOutQuantity: 1,
          quantity: 1,
        },
        {
          checkedOutAt: new Date("2030-01-15T09:00:00.000Z"),
          checkedInAt: null,
          checkedOutQuantity: 1,
          quantity: 1,
        },
      ],
    });

    expect(result.statusLabel).toBe("Partially returned");
    expect(result.returnedAt).toEqual(new Date("2030-01-15T11:00:00.000Z"));
  });

  it("uses a return log as the only return signal for a quantity partial return", () => {
    const result = getLoanLifecycle({
      status: BookingStatus.ONGOING,
      to: new Date("2030-01-20T17:00:00.000Z"),
      bookingAssets: [
        {
          checkedOutAt: new Date("2030-01-15T09:00:00.000Z"),
          checkedInAt: null,
          checkedOutQuantity: 3,
          quantity: 3,
        },
      ],
      consumptionLogs: [
        {
          category: "RETURN",
          quantity: 1,
          createdAt: new Date("2030-01-15T11:00:00.000Z"),
        },
      ],
    });

    expect(result.statusLabel).toBe("Partially returned");
    expect(result.returnedAt).toEqual(new Date("2030-01-15T11:00:00.000Z"));
  });
});
