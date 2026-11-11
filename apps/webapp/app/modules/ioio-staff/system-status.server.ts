import { readFile, statfs } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { checkApplicationHealth } from "~/utils/healthcheck.server";
import { getImportHelperHealth } from "./import-helper-client.server";

export type StaffSystemStatus = {
  server: "online" | "issue";
  storagePercentUsed: number | null;
  claude: "online" | "offline" | "unavailable";
};

type FilesystemUsage = {
  blocks: number;
  bfree: number;
  bavail: number;
};

type StoragePathEnvironment = Record<string, string | undefined>;

type StoragePathDependencies = {
  platform: string;
  environment: StoragePathEnvironment;
  homeDirectory: string;
  workingDirectory: string;
  readSettingsFile(path: string): Promise<string>;
};

const DEFAULT_STORAGE_PATH_DEPENDENCIES: StoragePathDependencies = {
  platform: process.platform,
  environment: process.env,
  homeDirectory: homedir(),
  workingDirectory: process.cwd(),
  readSettingsFile: (path) => readFile(path, "utf8"),
};

function isConfiguredAbsolutePath(value: string | undefined) {
  const path = value?.trim();
  return path && isAbsolute(path) ? path : null;
}

function getSingleConfiguredPersistentPath(
  environment: StoragePathEnvironment
) {
  const primary = isConfiguredAbsolutePath(
    environment.IOIO_PRIMARY_PERSISTENT_STORAGE_PATH
  );
  if (primary) return primary;
  if (environment.IOIO_PRIMARY_PERSISTENT_STORAGE_PATH?.trim()) return null;

  const database = isConfiguredAbsolutePath(environment.PGDATA);
  if (database) return database;
  if (environment.PGDATA?.trim()) return null;

  const configuredRoots = environment.IOIO_PERSISTENT_STORAGE_PATHS?.trim();
  if (!configuredRoots) return undefined;
  try {
    const roots: unknown = JSON.parse(configuredRoots);
    if (
      Array.isArray(roots) &&
      roots.length === 1 &&
      typeof roots[0] === "string" &&
      isAbsolute(roots[0].trim())
    ) {
      return roots[0].trim();
    }
  } catch {
    // Invalid or ambiguous configuration must not silently select the source disk.
  }
  return null;
}

async function getDockerDesktopDataFolder({
  homeDirectory,
  readSettingsFile,
}: Pick<StoragePathDependencies, "homeDirectory" | "readSettingsFile">) {
  const settingsPaths = [
    join(
      homeDirectory,
      "Library",
      "Group Containers",
      "group.com.docker",
      "settings-store.json"
    ),
    join(
      homeDirectory,
      "Library",
      "Group Containers",
      "group.com.docker",
      "settings.json"
    ),
  ];

  for (const settingsPath of settingsPaths) {
    let contents: string;
    try {
      contents = await readSettingsFile(settingsPath);
    } catch (cause) {
      if (
        cause &&
        typeof cause === "object" &&
        "code" in cause &&
        cause.code === "ENOENT"
      ) {
        continue;
      }
      return null;
    }

    try {
      const settings: unknown = JSON.parse(contents);
      if (!settings || typeof settings !== "object") return null;
      const diskImageLocation =
        "DiskImageLocation" in settings
          ? settings.DiskImageLocation
          : "diskImageLocation" in settings
          ? settings.diskImageLocation
          : undefined;
      if (
        typeof diskImageLocation === "string" &&
        isAbsolute(diskImageLocation.trim())
      ) {
        return diskImageLocation.trim();
      }
      const dataFolder =
        "DataFolder" in settings
          ? settings.DataFolder
          : "dataFolder" in settings
          ? settings.dataFolder
          : undefined;
      if (typeof dataFolder === "string" && isAbsolute(dataFolder.trim())) {
        return dataFolder.trim();
      }
    } catch {
      return null;
    }
  }
  return undefined;
}

async function getPrimaryPersistentStoragePath(
  dependencies: StoragePathDependencies
) {
  const configuredPath = getSingleConfiguredPersistentPath(
    dependencies.environment
  );
  if (configuredPath !== undefined) return configuredPath;

  if (dependencies.platform === "darwin") {
    const dockerDataFolder = await getDockerDesktopDataFolder(dependencies);
    if (dockerDataFolder !== undefined) return dockerDataFolder;
  }

  // CWD is only the final fallback after persistent-storage discovery.
  return dependencies.workingDirectory;
}

/** Measures the filesystem backing the primary persistent data location. */
export async function getLocalStorageUsedPercent({
  readFilesystem = statfs,
  pathDependencies = DEFAULT_STORAGE_PATH_DEPENDENCIES,
}: {
  readFilesystem?: (path: string) => Promise<FilesystemUsage>;
  pathDependencies?: StoragePathDependencies;
} = {}): Promise<number | null> {
  try {
    const storagePath = await getPrimaryPersistentStoragePath(pathDependencies);
    if (!storagePath) return null;
    const { blocks, bfree, bavail } = await readFilesystem(storagePath);
    const used = blocks - bfree;
    // Match the Use% displayed by df, excluding reserved space from capacity.
    const capacity = used + bavail;
    if (
      !Number.isFinite(capacity) ||
      capacity <= 0 ||
      !Number.isFinite(used) ||
      used < 0 ||
      bavail < 0
    ) {
      return null;
    }
    return Math.min(100, Math.ceil((used / capacity) * 100));
  } catch {
    return null;
  }
}

async function getServerStatus(
  checkHealth: typeof checkApplicationHealth
): Promise<StaffSystemStatus["server"]> {
  try {
    await checkHealth();
    return "online";
  } catch {
    return "issue";
  }
}

export async function getStaffSystemStatus({
  checkHealth = checkApplicationHealth,
  readStoragePercent = () => getLocalStorageUsedPercent(),
  checkHelperHealth = getImportHelperHealth,
}: {
  checkHealth?: typeof checkApplicationHealth;
  readStoragePercent?: () => Promise<number | null>;
  checkHelperHealth?: typeof getImportHelperHealth;
} = {}): Promise<StaffSystemStatus> {
  const [server, storagePercentUsed, helperHealth] = await Promise.all([
    getServerStatus(checkHealth),
    readStoragePercent().catch(() => null),
    checkHelperHealth().catch(() => ({ status: "unavailable" as const })),
  ]);

  return {
    server,
    storagePercentUsed,
    claude: helperHealth.status === "ok" ? "online" : "unavailable",
  };
}
