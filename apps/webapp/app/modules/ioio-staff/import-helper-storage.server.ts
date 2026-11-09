import { isAbsolute } from "node:path";
import { realpath, stat, statfs } from "node:fs/promises";

const MAX_CONFIGURED_STORAGE_ROOTS = 32;

type StorageRootReader = {
  realpath(path: string): Promise<string>;
  stat(path: string, options: { bigint: true }): Promise<{ dev: bigint }>;
  statfs(
    path: string,
    options: { bigint: true }
  ): Promise<{
    blocks: bigint;
    bfree: bigint;
    bsize: bigint;
  }>;
};

function getConfiguredStorageRoots(
  value = process.env.IOIO_PERSISTENT_STORAGE_PATHS
) {
  if (!value?.trim()) return null;

  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !Array.isArray(parsed) ||
      parsed.length === 0 ||
      parsed.length > MAX_CONFIGURED_STORAGE_ROOTS ||
      parsed.some(
        (path) =>
          typeof path !== "string" ||
          !path.trim() ||
          !isAbsolute(path) ||
          path.trim() === "/"
      )
    ) {
      return null;
    }
    return [...new Set(parsed.map((path: string) => path.trim()))];
  } catch {
    return null;
  }
}

/**
 * Measures explicitly configured Shelf persistent roots in the helper's
 * environment. Database URLs and Supabase object-storage URLs do not reveal
 * filesystem capacity, so they are excluded and yield unavailable when no
 * measurable roots are configured.
 */
export async function getHelperStorageUsedPercent({
  storageRoots = getConfiguredStorageRoots(),
  reader = { realpath, stat, statfs },
}: {
  storageRoots?: string[] | null;
  reader?: StorageRootReader;
} = {}): Promise<number | null> {
  if (
    !storageRoots?.length ||
    storageRoots.length > MAX_CONFIGURED_STORAGE_ROOTS
  ) {
    return null;
  }

  try {
    const filesystems = new Map<string, string>();
    for (const root of storageRoots) {
      if (!root.trim() || !isAbsolute(root) || root.trim() === "/") {
        return null;
      }
      const resolvedPath = await reader.realpath(root);
      const { dev } = await reader.stat(resolvedPath, { bigint: true });
      if (typeof dev !== "bigint") return null;
      if (!filesystems.has(dev.toString())) {
        filesystems.set(dev.toString(), resolvedPath);
      }
    }

    let totalBytes = 0n;
    let usedBytes = 0n;
    for (const path of filesystems.values()) {
      const { blocks, bfree, bsize } = await reader.statfs(path, {
        bigint: true,
      });
      const filesystemTotalBytes = blocks * bsize;
      const filesystemUsedBytes = (blocks - bfree) * bsize;
      if (
        filesystemTotalBytes <= 0n ||
        filesystemUsedBytes < 0n ||
        filesystemUsedBytes > filesystemTotalBytes
      ) {
        return null;
      }
      totalBytes += filesystemTotalBytes;
      usedBytes += filesystemUsedBytes;
    }

    if (totalBytes <= 0n) return null;
    return Number((usedBytes * 100n + totalBytes / 2n) / totalBytes);
  } catch {
    return null;
  }
}
