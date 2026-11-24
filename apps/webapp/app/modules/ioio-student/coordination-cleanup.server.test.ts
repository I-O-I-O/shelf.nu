import { describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  ioioWriteOperation: { deleteMany: vi.fn() },
  ioioRateLimitBucket: { deleteMany: vi.fn() },
  $transaction: vi.fn(),
}));

vi.mock("~/database/db.server", () => ({ db: dbMock }));

import { cleanupIoioCoordinationRecords } from "./coordination-cleanup.server";

describe("IOIO coordination retention", () => {
  it("deletes only expired transient state and stale buckets", async () => {
    dbMock.ioioWriteOperation.deleteMany
      .mockResolvedValueOnce({ count: 2 })
      .mockResolvedValueOnce({ count: 1 });
    dbMock.ioioRateLimitBucket.deleteMany.mockResolvedValueOnce({ count: 3 });
    dbMock.$transaction.mockImplementation((callback) => callback(dbMock));

    await expect(
      cleanupIoioCoordinationRecords(new Date("2030-01-01T00:00:00.000Z"))
    ).resolves.toEqual({ expiredPrepared: 2, oldTerminal: 1, oldBuckets: 3 });
    expect(dbMock.ioioWriteOperation.deleteMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ["PREPARED", "CANCELLED", "FAILED"] },
        }),
      })
    );
    expect(dbMock.ioioWriteOperation.deleteMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ["SUCCEEDED", "RESOLVED"] },
        }),
      })
    );
    expect(dbMock.ioioRateLimitBucket.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          operationType: "REPORT_PROBLEM",
        }),
      })
    );
  });
});
