/** Shared by the web action and the independent server scheduler. No database writes. */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

const NAME = /^ioio-\d{8}T\d{9}Z-[0-9a-f-]{36}\.dump$/;
export type Backup = {
  filename: string;
  createdAt: string;
  completedAt: string;
  size: number;
  status: "successful";
  verified: true;
};
type Attempt = {
  startedAt: string;
  status: "successful" | "failed";
  retentionWarning?: boolean;
  completedAt: string;
};
export type BackupStatus = {
  available: boolean;
  automatic: "configured" | "unconfirmed";
  retention: number;
  running: boolean;
  status: "successful" | "failed" | "never" | "unavailable";
  last: Backup | null;
  recent: Backup[];
  metadataWarning: boolean;
  retentionWarning?: boolean;
};
export type BackupConfig = ReturnType<typeof backupConfig>;
export function backupConfig(
  env: Record<string, string | undefined> = process.env
) {
  const directory = env.IOIO_BACKUP_DIR || "/var/lib/ioio-shelf/backups";
  const retention = Number(env.IOIO_BACKUP_RETENTION || 7);
  if (
    !isAbsolute(directory) ||
    !Number.isInteger(retention) ||
    retention < 1 ||
    retention > 365
  ) {
    throw new Error("Invalid backup configuration");
  }
  // Backups must never live within the application checkout or a public tree.
  const normalized = resolve(directory);
  if (
    normalized === "/" ||
    normalized.split("/").some((part) => ["public", "static"].includes(part)) ||
    normalized === process.cwd() ||
    normalized.startsWith(`${process.cwd()}/`)
  ) {
    throw new Error("Unsafe backup directory");
  }
  return {
    directory: normalized,
    retention,
    automatic: env.IOIO_BACKUP_SCHEDULE_CONFIRMED === "true",
    databaseUrl: env.DIRECT_URL || env.DATABASE_URL,
  };
}

async function privateDirectory(config: BackupConfig, create = false) {
  if (create)
    await fs.mkdir(config.directory, { recursive: true, mode: 0o700 });
  const realDirectory = await fs.realpath(config.directory);
  if (
    realDirectory.split("/").some((part) => ["public", "static"].includes(part))
  )
    throw new Error("Unsafe backup directory");
  const info = await fs.lstat(config.directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
    throw new Error("Backup directory must be private");
}
async function readJson(path: string): Promise<unknown> {
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 16_384)
      throw new Error("Invalid metadata");
    return JSON.parse(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
}
function validDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
function parseBackup(value: unknown): Backup | null {
  if (!value || typeof value !== "object") return null;
  const b = value as Backup;
  if (
    !NAME.test(b.filename) ||
    !validDate(b.createdAt) ||
    !validDate(b.completedAt) ||
    b.status !== "successful" ||
    b.verified !== true ||
    !Number.isSafeInteger(b.size) ||
    b.size <= 0
  )
    return null;
  // Explicit projection prevents unexpected metadata fields leaking into responses.
  return {
    filename: b.filename,
    createdAt: b.createdAt,
    completedAt: b.completedAt,
    size: b.size,
    status: "successful",
    verified: true,
  };
}
async function list(config: BackupConfig) {
  const backups: Backup[] = [];
  let warning = false;
  const entries = await fs.readdir(config.directory);
  for (const name of entries) {
    if (name.endsWith(".dump") && !entries.includes(`${name}.json`))
      warning = true;
    if (!name.endsWith(".dump.json")) continue;
    try {
      const b = parseBackup(await readJson(join(config.directory, name)));
      if (!b || name !== `${b.filename}.json`)
        throw new Error("Invalid metadata");
      const info = await fs.lstat(join(config.directory, b.filename));
      if (!info.isFile() || info.isSymbolicLink() || info.size !== b.size)
        throw new Error("Invalid dump");
      backups.push(b);
    } catch {
      warning = true;
    }
  }
  return {
    backups: backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    warning,
  };
}
async function exists(path: string) {
  try {
    await fs.lstat(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}
export async function getBackupStatus(
  config?: BackupConfig
): Promise<BackupStatus> {
  const base: BackupStatus = {
    available: false,
    automatic: "unconfirmed",
    retention: 7,
    running: false,
    status: "unavailable",
    last: null,
    recent: [],
    metadataWarning: false,
  };
  try {
    config ??= backupConfig();
    base.retention = config.retention;
    base.automatic = config.automatic ? "configured" : "unconfirmed";
    base.available = Boolean(config.databaseUrl);
    if (!(await exists(config.directory))) return { ...base, status: "never" };
    await privateDirectory(config);
    const { backups, warning } = await list(config);
    base.last = backups[0] ?? null;
    base.recent = backups.slice(0, 7);
    base.metadataWarning = warning;
    base.running = await exists(join(config.directory, ".lock"));
    base.status = base.last ? "successful" : "never";
    if (await exists(join(config.directory, "last-attempt.json"))) {
      try {
        const attempt = (await readJson(
          join(config.directory, "last-attempt.json")
        )) as Attempt;
        if (
          !attempt ||
          !validDate(attempt.startedAt) ||
          !validDate(attempt.completedAt) ||
          !["successful", "failed"].includes(attempt.status) ||
          (attempt.status === "successful" && !base.last)
        )
          throw new Error("Invalid attempt");
        base.status = attempt.status;
        base.retentionWarning = attempt.retentionWarning === true;
      } catch {
        base.metadataWarning = true;
        base.status = "unavailable";
      }
    }
    return base;
  } catch {
    return { ...base, available: false, status: "unavailable" };
  }
}
async function atomicJson(directory: string, name: string, value: unknown) {
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, JSON.stringify(value), {
      mode: 0o600,
      flag: "wx",
    });
    await fs.rename(temporary, join(directory, name));
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}
/** libpq configuration only in the child environment; never argv or logs. */
export function postgresEnvironment(
  config: BackupConfig
): Record<string, string | undefined> {
  const url = new URL(config.databaseUrl || "");
  if (!["postgres:", "postgresql:"].includes(url.protocol))
    throw new Error("Invalid database configuration");
  const env: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    LANG: "C",
    PGHOST: url.hostname.replace(/^\[|\]$/g, ""),
    PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGCONNECT_TIMEOUT: "15",
  };
  // Prisma-only parameters (schema, pgbouncer, connection_limit) are not libpq options.
  for (const [key, variable] of Object.entries({
    sslmode: "PGSSLMODE",
    sslrootcert: "PGSSLROOTCERT",
    sslcert: "PGSSLCERT",
    sslkey: "PGSSLKEY",
  })) {
    if (url.searchParams.has(key)) env[variable] = url.searchParams.get(key)!;
  }
  return env;
}
export type CommandRunner = (
  command: "pg_dump" | "pg_restore",
  args: string[],
  env: Record<string, string | undefined>
) => Promise<void>;
export const runPostgres: CommandRunner = (command, args, env) =>
  new Promise((resolveCommand, reject) => {
    // Required web-app env keys do not apply to this isolated libpq child.
    const child = spawn(command, args, {
      env: env as NodeJS.ProcessEnv,
      stdio: "ignore",
      shell: false,
    });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 60 * 60 * 1000);
    child.once("error", () => {
      clearTimeout(timeout);
      reject(new Error("PostgreSQL tool failed"));
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      code === 0
        ? resolveCommand()
        : reject(new Error("PostgreSQL tool failed"));
    });
  });

/** Acquires the cross-process lock before returning a job. Never expires a live/stale lock automatically. */
export async function startBackup(
  config = backupConfig(),
  run: CommandRunner = runPostgres
): Promise<{ completion: Promise<boolean> }> {
  const env = postgresEnvironment(config);
  await privateDirectory(config, true);
  const lock = join(config.directory, ".lock");
  await fs.mkdir(lock, { mode: 0o700 }); // Atomic across timer, HTTP workers, and CLI.
  const startedAt = new Date().toISOString();
  const filename = `ioio-${startedAt.replace(
    /[-:.]/g,
    ""
  )}-${randomUUID()}.dump`;
  const temporary = join(config.directory, `${filename}.incomplete`);
  const completion = (async () => {
    try {
      await atomicJson(lock, "owner.json", { pid: process.pid, startedAt });
      // Precreate exclusively with restrictive permissions; pg_dump preserves mode.
      await fs.writeFile(temporary, "", { mode: 0o600, flag: "wx" });
      await run(
        "pg_dump",
        ["--format=custom", "--no-password", `--file=${temporary}`],
        env
      );
      await run("pg_restore", ["--list", temporary], {
        PATH: process.env.PATH,
        LANG: "C",
      });
      const handle = await fs.open(temporary, "r+");
      const info = await handle.stat();
      try {
        if (!info.size) throw new Error("Empty dump");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, join(config.directory, filename));
      const backup: Backup = {
        filename,
        createdAt: startedAt,
        completedAt: new Date().toISOString(),
        size: info.size,
        status: "successful",
        verified: true,
      };
      await atomicJson(config.directory, `${filename}.json`, backup);
      const attempt: Attempt = {
        startedAt,
        completedAt: backup.completedAt,
        status: "successful",
      };
      // Commit success before any retention. Cleanup failure is a separate warning,
      // never a failed backup after already deleting older recovery points.
      await atomicJson(config.directory, "last-attempt.json", attempt);
      try {
        const { backups } = await list(config);
        const days = new Set<string>();
        for (const b of backups) {
          const day = b.createdAt.slice(0, 10);
          if (!days.has(day) && days.size < config.retention) {
            days.add(day);
            continue;
          }
          await fs.unlink(join(config.directory, b.filename));
          await fs.unlink(join(config.directory, `${b.filename}.json`));
        }
      } catch {
        await atomicJson(config.directory, "last-attempt.json", {
          ...attempt,
          retentionWarning: true,
        }).catch(() => undefined);
      }
      return true;
    } catch {
      await atomicJson(config.directory, "last-attempt.json", {
        startedAt,
        completedAt: new Date().toISOString(),
        status: "failed",
      }).catch(() => undefined);
      return false;
    } finally {
      await fs.unlink(temporary).catch(() => undefined);
      await fs.unlink(join(lock, "owner.json")).catch(() => undefined);
      await fs.rmdir(lock).catch(() => undefined);
      // A published verified dump is retained even if retention/metadata fails.
    }
  })();
  return { completion };
}
