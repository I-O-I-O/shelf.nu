import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IMPORT_HELPER_HEALTH_TIMEOUT_MS } from "./import-helper-client.server";
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
      checkHelperHealth: () =>
        Promise.resolve({ status: "unavailable", storageUsedPercent: null }),
    });

    expect(status).toEqual({
      server: "online",
      storagePercentUsed: 54,
      claude: "unavailable",
    });
    expect(readStoragePercent).toHaveBeenCalledOnce();
  });
});

describe("staff dashboard persistent Claude helper status", () => {
  const endpoint = "http://127.0.0.1:18787";
  const token = "test-helper-token";
  const dashboardStatus = () =>
    getStaffSystemStatus({
      checkHealth: () => Promise.resolve("healthy"),
      readStoragePercent: () => Promise.resolve(34),
    });

  beforeEach(() => {
    vi.stubEnv("IOIO_IMPORT_HELPER_URL", endpoint);
    vi.stubEnv("IOIO_IMPORT_HELPER_AUTH_TOKEN", token);
    vi.stubEnv("IOIO_IMPORT_HELPER_TIMEOUT_MS", "90000");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("reports Claude Online when helper health is 200/status ok, without storage metrics", async () => {
    // why: the helper HTTP endpoint is external; no Claude process should run in tests.
    const fetchMock = vi.fn(() =>
      Promise.resolve(Response.json({ status: "ok" }))
    );
    vi.stubGlobal("fetch", fetchMock);
    const status = await dashboardStatus();
    expect(status).toEqual({
      server: "online",
      storagePercentUsed: 34,
      claude: "online",
    });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      new URL("/health", endpoint),
      expect.objectContaining({
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
        redirect: "error",
        cache: "no-store",
        signal: expect.any(AbortSignal),
      })
    );
    expect(JSON.stringify(status)).not.toContain(endpoint);
    expect(JSON.stringify(status)).not.toContain(token);
  });

  it("reports Claude Unavailable on connection refusal", async () => {
    // why: simulate an unreachable external helper without making a real request.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("ECONNREFUSED")))
    );
    expect((await dashboardStatus()).claude).toBe("unavailable");
  });

  it("times out the dashboard probe after 1.2 seconds instead of the 90-second import timeout", async () => {
    vi.useFakeTimers();
    // why: simulate a stalled external request that respects the abort signal.
    const fetchMock = vi.fn(
      (_url: URL, options: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          options.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Timed out", "AbortError")),
            { once: true }
          );
        })
    );
    vi.stubGlobal("fetch", fetchMock);
    const pending = dashboardStatus();
    await vi.advanceTimersByTimeAsync(IMPORT_HELPER_HEALTH_TIMEOUT_MS);
    expect((await pending).claude).toBe("unavailable");
    expect(fetchMock.mock.calls[0][1].signal?.aborted).toBe(true);
  });

  it.each([
    [200, "not json"],
    [200, "null"],
    [200, "{}"],
    [200, JSON.stringify({ status: "unhealthy", storageUsedPercent: 34 })],
    [503, JSON.stringify({ status: "ok" })],
    [401, JSON.stringify({ status: "ok" })],
  ])(
    "reports Claude Unavailable for malformed/unhealthy health: %s %s",
    async (httpStatus, body) => {
      // why: exercise external helper responses without contacting the helper.
      vi.stubGlobal(
        "fetch",
        vi.fn(() => Promise.resolve(new Response(body, { status: httpStatus })))
      );
      expect((await dashboardStatus()).claude).toBe("unavailable");
    }
  );

  it("reports Claude Online with no ANTHROPIC_API_KEY when the persistent helper is healthy", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", undefined);
    // why: helper health is an HTTP boundary independent of the Anthropic API.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json({ status: "ok" })))
    );
    expect((await dashboardStatus()).claude).toBe("online");
  });

  it("reports Unavailable without contacting a helper when its configuration is absent", async () => {
    vi.stubEnv("IOIO_IMPORT_HELPER_URL", undefined);
    // why: assert no outbound HTTP request is made without helper configuration.
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect((await dashboardStatus()).claude).toBe("unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
