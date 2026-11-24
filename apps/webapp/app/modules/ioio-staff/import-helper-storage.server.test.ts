import { describe, expect, it, vi } from "vitest";
import { getHelperStorageUsedPercent } from "./import-helper-storage.server";

function makeReader(
  filesystems: Record<string, { total: bigint; used: bigint }>
) {
  const rootDevices: Record<string, bigint> = {
    "/uploads": 1n,
    "/database": 1n,
    "/objects": 2n,
    "/objects-alias": 2n,
  };
  const realpath = vi.fn((path: string) => Promise.resolve(path));
  const stat = vi.fn((path: string) => {
    const device = rootDevices[path];
    if (device === undefined) return Promise.reject(new Error("Unknown root"));
    return Promise.resolve({ dev: device });
  });
  const statfs = vi.fn((path: string) => {
    const filesystem = filesystems[path];
    if (!filesystem) return Promise.reject(new Error("Unknown filesystem"));
    return Promise.resolve({
      blocks: filesystem.total,
      bfree: filesystem.total - filesystem.used,
      bsize: 1n,
    });
  });
  return { reader: { realpath, stat, statfs }, realpath, stat, statfs };
}

describe("helper storage capacity", () => {
  it("counts a single filesystem once when all persistent roots use it", async () => {
    // why: fake filesystem metadata to prove duplicate roots do not multiply capacity.
    const { reader, statfs } = makeReader({
      "/uploads": { total: 100n, used: 50n },
    });

    const percent = await getHelperStorageUsedPercent({
      storageRoots: ["/uploads", "/database"],
      reader,
    });

    expect(percent).toBe(50);
    expect(statfs).toHaveBeenCalledTimes(1);
  });

  it("combines separate filesystems by their byte totals", async () => {
    // why: fake two mount devices with unequal capacities to test weighted aggregation.
    const { reader, statfs } = makeReader({
      "/uploads": { total: 100n, used: 50n },
      "/objects": { total: 400n, used: 100n },
    });

    const percent = await getHelperStorageUsedPercent({
      storageRoots: ["/uploads", "/objects"],
      reader,
    });

    expect(percent).toBe(30);
    expect(statfs).toHaveBeenCalledTimes(2);
  });

  it("deduplicates different paths on the same backing filesystem", async () => {
    // why: fake distinct paths sharing one device ID to verify device-based deduplication.
    const { reader, statfs } = makeReader({
      "/objects": { total: 300n, used: 90n },
    });

    const percent = await getHelperStorageUsedPercent({
      storageRoots: ["/objects", "/objects-alias"],
      reader,
    });

    expect(percent).toBe(30);
    expect(statfs).toHaveBeenCalledTimes(1);
  });

  it("returns unavailable if roots cannot be resolved or measured", async () => {
    // why: fake an inaccessible persistent root and verify no unrelated fallback is measured.
    const { reader, statfs } = makeReader({});

    const percent = await getHelperStorageUsedPercent({
      storageRoots: ["/missing"],
      reader,
    });

    expect(percent).toBeNull();
    expect(statfs).not.toHaveBeenCalled();
  });

  it("returns unavailable when no persistent roots are configured", async () => {
    expect(
      await getHelperStorageUsedPercent({ storageRoots: null })
    ).toBeNull();
  });

  it("refuses the process root as a persistent storage root", async () => {
    // why: prevent accidentally restoring a statfs('/') fallback.
    const { reader, statfs } = makeReader({});

    const percent = await getHelperStorageUsedPercent({
      storageRoots: ["/"],
      reader,
    });

    expect(percent).toBeNull();
    expect(statfs).not.toHaveBeenCalled();
  });
});
