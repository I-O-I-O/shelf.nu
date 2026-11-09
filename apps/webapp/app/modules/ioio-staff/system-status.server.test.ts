import { describe, expect, it, vi } from "vitest";
import {
  getLocalStorageUsedPercent,
  getStaffSystemStatus,
} from "./system-status.server";

function createPathDependencies({
  platform = "darwin",
  environment = {},
  workingDirectory = "/workspace/shelf",
  readSettingsFile = (path: string) => {
    if (path.endsWith("settings-store.json")) {
      return Promise.resolve(
        JSON.stringify({ DataFolder: "/Volumes/External/Docker/DockerDesktop" })
      );
    }
    return Promise.reject(
      Object.assign(new Error("Missing"), { code: "ENOENT" })
    );
  },
}: {
  platform?: string;
  environment?: Record<string, string | undefined>;
  workingDirectory?: string;
  readSettingsFile?: (path: string) => Promise<string>;
} = {}) {
  return {
    platform,
    environment,
    homeDirectory: "/Users/dev",
    workingDirectory,
    readSettingsFile,
  };
}

describe("staff dashboard storage status", () => {
  it("prefers an explicitly configured persistent application path", async () => {
    // why: fake statfs so the path priority can be tested without reading host storage.
    const readFilesystem = vi.fn(() =>
      Promise.resolve({ blocks: 100, bfree: 46, bavail: 46 })
    );

    await expect(
      getLocalStorageUsedPercent({
        readFilesystem,
        pathDependencies: createPathDependencies({
          environment: {
            IOIO_PRIMARY_PERSISTENT_STORAGE_PATH: "/srv/shelf/data",
            PGDATA: "/var/lib/postgresql/data",
          },
        }),
      })
    ).resolves.toBe(54);
    expect(readFilesystem).toHaveBeenCalledWith("/srv/shelf/data");
  });

  it("uses Docker Desktop's configured host data folder on macOS", async () => {
    // why: fake Docker settings and statfs to verify Docker.raw's host filesystem is selected.
    const readFilesystem = vi.fn((path: string) => {
      expect(path).toBe("/Volumes/External/Docker/DockerDesktop");
      return Promise.resolve({ blocks: 100, bfree: 46, bavail: 46 });
    });

    await expect(
      getLocalStorageUsedPercent({
        readFilesystem,
        pathDependencies: createPathDependencies(),
      })
    ).resolves.toBe(54);
    expect(readFilesystem).toHaveBeenCalledOnce();
  });

  it("uses a configured local PostgreSQL data directory before Docker storage", async () => {
    // why: fake statfs so configured database persistence wins over Docker defaults.
    const readFilesystem = vi.fn(() =>
      Promise.resolve({ blocks: 109, bfree: 75, bavail: 70 })
    );

    await expect(
      getLocalStorageUsedPercent({
        readFilesystem,
        pathDependencies: createPathDependencies({
          environment: { PGDATA: "/var/lib/postgresql/data" },
        }),
      })
    ).resolves.toBe(33);
    expect(readFilesystem).toHaveBeenCalledWith("/var/lib/postgresql/data");
  });

  it("returns unavailable when multiple configured roots have no primary", async () => {
    // why: fake statfs to prove ambiguous persistent roots do not fall back to cwd.
    const readFilesystem = vi.fn(() =>
      Promise.resolve({ blocks: 100, bfree: 12, bavail: 12 })
    );

    await expect(
      getLocalStorageUsedPercent({
        readFilesystem,
        pathDependencies: createPathDependencies({
          environment: {
            IOIO_PERSISTENT_STORAGE_PATHS: JSON.stringify([
              "/mnt/database",
              "/mnt/uploads",
            ]),
          },
        }),
      })
    ).resolves.toBeNull();
    expect(readFilesystem).not.toHaveBeenCalled();
  });

  it("uses cwd only as the final fallback when no persistent location is configured", async () => {
    // why: fake statfs to verify the Linux deployment fallback path and percentage.
    const readFilesystem = vi.fn(() =>
      Promise.resolve({ blocks: 109, bfree: 75, bavail: 70 })
    );

    await expect(
      getLocalStorageUsedPercent({
        readFilesystem,
        pathDependencies: createPathDependencies({
          platform: "linux",
          workingDirectory: "/app/current",
        }),
      })
    ).resolves.toBe(33);
    expect(readFilesystem).toHaveBeenCalledWith("/app/current");
  });

  it("returns unavailable instead of falling back when discovered Docker storage cannot be read", async () => {
    // why: simulate unavailable external storage and prevent reporting the source disk instead.
    const readFilesystem = vi.fn(() =>
      Promise.reject(new Error("volume unavailable"))
    );

    await expect(
      getLocalStorageUsedPercent({
        readFilesystem,
        pathDependencies: createPathDependencies(),
      })
    ).resolves.toBeNull();
    expect(readFilesystem).toHaveBeenCalledWith(
      "/Volumes/External/Docker/DockerDesktop"
    );
  });

  it("returns unavailable when filesystem information cannot be read", async () => {
    // why: simulate a statfs failure on the selected persistent path.
    const readFilesystem = vi.fn(() =>
      Promise.reject(new Error("unavailable"))
    );

    await expect(
      getLocalStorageUsedPercent({
        readFilesystem,
        pathDependencies: createPathDependencies({
          platform: "linux",
          workingDirectory: "/app/current",
        }),
      })
    ).resolves.toBeNull();
  });

  it("uses local filesystem status independently of the remote helper", async () => {
    const readStoragePercent = vi.fn(() => Promise.resolve(54));
    const status = await getStaffSystemStatus({
      checkHealth: () => Promise.resolve("healthy"),
      readStoragePercent,
    });

    expect(status).toEqual({
      server: "online",
      storagePercentUsed: 54,
      claude: "unavailable",
    });
    expect(readStoragePercent).toHaveBeenCalledOnce();
  });
});
