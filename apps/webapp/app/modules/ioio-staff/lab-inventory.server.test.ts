import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAsset } from "@factories";

const db = vi.hoisted(() => ({
  $transaction: vi.fn(),
  $queryRaw: vi.fn(),
  asset: { findFirst: vi.fn(), update: vi.fn(), delete: vi.fn() },
  ioioWriteOperation: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    updateMany: vi.fn(),
  },
  ioioArchivedItem: { findFirst: vi.fn() },
  bookingAsset: { findMany: vi.fn(), findFirst: vi.fn() },
  bookingModelRequest: { findFirst: vi.fn() },
  custody: { findFirst: vi.fn(), aggregate: vi.fn(), groupBy: vi.fn() },
  assetKit: { findFirst: vi.fn(), groupBy: vi.fn() },
  assetLocation: { findMany: vi.fn(), update: vi.fn(), aggregate: vi.fn() },
  auditAsset: { findFirst: vi.fn() },
  purchaseItem: { findFirst: vi.fn() },
  consumptionLog: { findFirst: vi.fn(), create: vi.fn() },
  activityEvent: { create: vi.fn() },
  user: { findUnique: vi.fn() },
}));

// why: use in-memory transaction fixtures to keep all inventory writes off the database.
vi.mock("~/database/db.server", () => ({ db }));

// why: notes validate and fetch nested author and organization data outside
// the inventory behavior under test.
vi.mock("~/modules/note/service.server", () => ({ createNote: vi.fn() }));

// why: replace the availability reader's many database queries with its stock
// view; exercise the real quantity writer, reservation guard and audit log.
vi.mock("~/modules/asset/availability.server", () => ({
  getAssetAvailability: vi.fn(),
}));

import { getAssetAvailability } from "~/modules/asset/availability.server";
import { manageLabInventory } from "./lab-inventory.server";

const org = "org-1";
const apply = (action: "disable" | "enable" | "delete", pooled = false) =>
  manageLabInventory({
    action,
    organizationId: org,
    staffUserId: "staff-1",
    targets: [{ reportId: "report-1", pooled }],
  });
const unit = createAsset({
  id: "unit-1",
  organizationId: org,
  title: "Soldering station",
  type: "INDIVIDUAL",
  status: "AVAILABLE",
  availableToBook: true,
});

describe("Lab status inventory actions", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    db.$transaction.mockImplementation((fn) => fn(db));
    db.$queryRaw.mockResolvedValue([unit]);
    db.asset.findFirst.mockResolvedValue(unit);
    db.asset.delete.mockResolvedValue({ reminders: [] });
    db.ioioWriteOperation.findMany.mockImplementation(({ where }) =>
      Promise.resolve(
        where.operationType === "REPORT_PROBLEM"
          ? [{ id: "report-1", assetId: unit.id, bookingAssetId: null }]
          : []
      )
    );
    db.ioioWriteOperation.updateMany.mockResolvedValue({ count: 1 });
    db.custody.aggregate.mockResolvedValue({ _sum: { quantity: 0 } });
    db.custody.groupBy.mockResolvedValue([]);
    db.assetKit.groupBy.mockResolvedValue([]);
    db.bookingAsset.findMany.mockResolvedValue([]);
    db.assetLocation.findMany.mockResolvedValue([]);
    db.assetLocation.aggregate.mockResolvedValue({ _sum: { quantity: 0 } });
  });

  it.each(["INDIVIDUAL", "QUANTITY_TRACKED"] as const)(
    "deletes only the selected record for a %s single unit",
    async (type) => {
      db.$queryRaw.mockResolvedValue([
        {
          ...unit,
          type,
          quantity: type === "INDIVIDUAL" ? null : 1,
          assetModelId: "shared-model",
        },
      ]);
      await expect(apply("delete")).resolves.toEqual({ count: 1 });
      expect(db.asset.delete).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ where: { id: unit.id, organizationId: org } })
      );
      expect(db.activityEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: "ASSET_DELETED",
            assetId: unit.id,
          }),
        })
      );
      expect(db.ioioWriteOperation.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: "report-1",
            organizationId: org,
          }),
          data: expect.objectContaining({ status: "RESOLVED" }),
        })
      );
    }
  );

  it("removes exactly one stocked unit, adjusts its unique placement and records the loss", async () => {
    let quantity = 5;
    let placed = 5;
    db.$queryRaw.mockImplementation(() => [
      { ...unit, type: "QUANTITY_TRACKED", quantity },
    ]);
    db.assetLocation.findMany.mockImplementation(() => [
      { id: "placement-1", locationId: "shelf-1", quantity: placed },
    ]);
    db.assetLocation.update.mockImplementation(({ data }) => {
      placed = data.quantity;
    });
    db.assetLocation.aggregate.mockImplementation(() => ({
      _sum: { quantity: placed },
    }));
    db.asset.update.mockImplementation(({ data }) => {
      quantity = data.quantity;
    });
    vi.mocked(getAssetAvailability).mockImplementation(() =>
      Promise.resolve({
        total: quantity,
        inCustody: 1,
        inKits: 0,
        checkedOut: 1,
        reserved: 2,
        reservedTotal: 1,
        reservingBookingCount: 1,
        physicalAvailable: quantity - 2,
        bookable: quantity - 3,
      })
    );
    const availability = () =>
      getAssetAvailability({ assetId: "unit-1", organizationId: org });
    const before = await availability();
    await expect(apply("delete", true)).resolves.toEqual({ count: 1 });
    const after = await availability();
    expect(after).toMatchObject({
      total: before.total - 1,
      physicalAvailable: before.physicalAvailable - 1,
      bookable: before.bookable - 1,
      checkedOut: before.checkedOut,
      reserved: before.reserved,
    });
    expect(placed).toBe(4);
    expect(db.asset.delete).not.toHaveBeenCalled();
    expect(db.consumptionLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          category: "LOSS",
          assetId: unit.id,
          quantity: 1,
        }),
      })
    );
  });

  it("rejects a selected pooled unit still on a loan even if the pool has spare stock", async () => {
    db.$queryRaw.mockResolvedValue([
      { ...unit, type: "QUANTITY_TRACKED", quantity: 5 },
    ]);
    db.ioioWriteOperation.findMany.mockResolvedValue([
      { id: "report-1", assetId: unit.id, bookingAssetId: "active-loan-line" },
    ]);
    vi.mocked(getAssetAvailability).mockResolvedValue({
      total: 5,
      inCustody: 0,
      inKits: 0,
      checkedOut: 1,
      reserved: 1,
      reservedTotal: 0,
      reservingBookingCount: 0,
      physicalAvailable: 4,
      bookable: 4,
    });
    db.bookingAsset.findFirst.mockResolvedValue({ id: "active-loan-line" });
    await expect(apply("delete", true)).rejects.toMatchObject({ status: 409 });
    expect(db.asset.update).not.toHaveBeenCalled();
    expect(db.asset.delete).not.toHaveBeenCalled();
  });

  it("refuses to delete a single unit linked to an existing booking", async () => {
    db.bookingAsset.findFirst.mockResolvedValue({ id: "active-loan-line" });
    await expect(apply("delete")).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/loan|reservation/),
    });
    expect(db.asset.delete).not.toHaveBeenCalled();
    expect(db.ioioWriteOperation.updateMany).not.toHaveBeenCalled();
  });

  it("updates only the borrowing flag when disabling a single unit", async () => {
    await expect(apply("disable")).resolves.toEqual({ count: 1 });
    expect(db.asset.update).toHaveBeenCalledExactlyOnceWith({
      where: { id: unit.id, organizationId: org },
      data: { availableToBook: false },
    });
    expect(db.ioioWriteOperation.updateMany).not.toHaveBeenCalled();
  });

  it("restores an eligible disabled unit and resolves the equipment report", async () => {
    const disabled = { ...unit, availableToBook: false };
    db.$queryRaw.mockResolvedValue([disabled]);
    db.asset.findFirst.mockResolvedValue(disabled);
    await expect(apply("enable")).resolves.toEqual({ count: 1 });
    expect(db.asset.update).toHaveBeenCalledWith({
      where: { id: unit.id, organizationId: org },
      data: { availableToBook: true },
    });
    expect(db.ioioWriteOperation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "RESOLVED" }),
      })
    );
  });

  it("does not re-enable a unit when the canonical loan guard rejects it", async () => {
    const disabled = { ...unit, availableToBook: false };
    db.$queryRaw.mockResolvedValue([disabled]);
    db.asset.findFirst.mockResolvedValue(disabled);
    db.bookingAsset.findFirst.mockResolvedValue({ id: "active-loan-line" });
    await expect(apply("enable")).rejects.toMatchObject({ status: 409 });
    expect(db.asset.update).not.toHaveBeenCalled();
  });

  it("does not treat pooled stock as a single record after the count changes", async () => {
    await expect(apply("delete", true)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("stock changed"),
    });
    expect(db.asset.delete).not.toHaveBeenCalled();
  });

  it("processes distinct bulk targets in one transaction and rejects duplicate asset targets", async () => {
    const targets = [
      { reportId: "report-2", pooled: false },
      { reportId: "report-1", pooled: false },
    ];
    const run = () =>
      manageLabInventory({
        action: "disable",
        organizationId: org,
        staffUserId: "staff-1",
        targets,
      });
    db.ioioWriteOperation.findMany.mockResolvedValue([
      { id: "report-2", assetId: "unit-2" },
      { id: "report-1", assetId: "unit-1" },
    ]);
    db.$queryRaw.mockImplementation((_sql, id) => [{ ...unit, id }]);
    await expect(run()).resolves.toEqual({ count: 2 });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.asset.update.mock.calls.map(([args]) => args.where.id)).toEqual([
      "unit-1",
      "unit-2",
    ]);
    db.asset.update.mockClear();
    db.ioioWriteOperation.findMany.mockResolvedValue([
      { id: "report-2", assetId: "unit-1" },
      { id: "report-1", assetId: "unit-1" },
    ]);
    await expect(run()).rejects.toMatchObject({ status: 409 });
    expect(db.asset.update).not.toHaveBeenCalled();
  });
});
