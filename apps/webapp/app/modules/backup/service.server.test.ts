// @vitest-environment node
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  backupConfig,
  getBackupStatus,
  postgresEnvironment,
  startBackup,
} from "./service.server";
import type { BackupConfig, CommandRunner } from "./service.server";

let config: BackupConfig;
// why: PostgreSQL processes are external; use real private filesystem operations
// with simulated tool output so tests never connect to any database.
const success: CommandRunner = async (command, args) => {
  if (command === "pg_dump")
    await fs.writeFile(
      args.find((a) => a.startsWith("--file="))!.slice(7),
      "test archive"
    );
};
// why: simulate a database/tool failure without a real PostgreSQL connection.
const failure: CommandRunner = () =>
  Promise.reject(new Error("postgres://secret:password@host"));
beforeEach(async () => {
  config = backupConfig({
    IOIO_BACKUP_DIR: await fs.mkdtemp(join(tmpdir(), "ioio-backup-test-")),
    DATABASE_URL:
      "postgres://test:secret@localhost/test?schema=public&connection_limit=1",
  });
});
afterEach(async () => {
  await fs.rm(config.directory, { recursive: true, force: true });
});
async function run(runner = success) {
  return (await startBackup(config, runner)).completion;
}
async function oldBackup(day: string) {
  const filename = `ioio-${day.replace(
    /-/g,
    ""
  )}T030000000Z-00000000-0000-4000-8000-000000000000.dump`;
  const metadata = {
    filename,
    createdAt: `${day}T03:00:00.000Z`,
    completedAt: `${day}T03:01:00.000Z`,
    size: 3,
    status: "successful",
    verified: true,
  };
  await fs.writeFile(join(config.directory, filename), "old", { mode: 0o600 });
  await fs.writeFile(
    join(config.directory, `${filename}.json`),
    JSON.stringify(metadata),
    { mode: 0o600 }
  );
  return filename;
}
describe("safe database backups", () => {
  it("reports never run, including a missing directory", async () => {
    expect((await getBackupStatus(config)).status).toBe("never");
    await fs.rmdir(config.directory);
    expect((await getBackupStatus(config)).status).toBe("never");
  });
  it("publishes a verified backup with private permissions and sanitized metadata", async () => {
    expect(await run()).toBe(true);
    const status = await getBackupStatus(config);
    expect(status.status).toBe("successful");
    expect(status.last).toMatchObject({ size: 12, verified: true });
    expect(JSON.stringify(status)).not.toMatch(/secret|password|postgres:\/\//);
    expect(
      (await fs.stat(join(config.directory, status.last!.filename))).mode &
        0o077
    ).toBe(0);
    expect(await fs.readdir(config.directory)).not.toContain(".lock");
  });
  it("keeps seven daily recovery points after success", async () => {
    for (let i = 1; i <= 8; i++) await oldBackup(`2020-01-0${i}`);
    expect(await run()).toBe(true);
    expect((await getBackupStatus(config)).recent).toHaveLength(7);
    expect(
      (await fs.readdir(config.directory)).filter((n) => n.endsWith(".dump"))
    ).toHaveLength(7);
    expect(await fs.readdir(config.directory)).not.toContain(
      expect.stringContaining("20200101")
    );
  });
  it("manual runs on one day preserve other days", async () => {
    await oldBackup("2020-01-01");
    await run();
    await run();
    expect((await getBackupStatus(config)).recent).toHaveLength(2);
  });
  it("never prunes previous successes when dump or verification fails", async () => {
    for (let i = 1; i <= 8; i++) await oldBackup(`2020-01-0${i}`);
    const before = await fs.readdir(config.directory);
    expect(await run(failure)).toBe(false);
    // why: simulate a corrupt output archive at the external verification boundary.
    const invalidArchive: CommandRunner = async (command, args, env) => {
      if (command === "pg_restore") throw new Error("Invalid archive");
      await success(command, args, env);
    };
    expect(await run(invalidArchive)).toBe(false);
    expect((await getBackupStatus(config)).status).toBe("failed");
    for (const file of before)
      expect(await fs.readdir(config.directory)).toContain(file);
    expect(
      (await fs.readdir(config.directory)).some((n) =>
        n.endsWith(".incomplete")
      )
    ).toBe(false);
    expect(
      await fs.readFile(join(config.directory, "last-attempt.json"), "utf8")
    ).not.toContain("secret");
  });
  it("blocks concurrent jobs across runner instances", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    // why: pause external dump execution while a second caller competes for the lock.
    const slow: CommandRunner = async (...args) => {
      await gate;
      await success(...args);
    };
    const first = await startBackup(config, slow);
    expect((await getBackupStatus(config)).running).toBe(true);
    await expect(startBackup(config, success)).rejects.toMatchObject({
      code: "EEXIST",
    });
    release();
    expect(await first.completion).toBe(true);
  });
  it("fails closed on an interrupted job lock", async () => {
    await fs.mkdir(join(config.directory, ".lock"));
    await expect(startBackup(config, success)).rejects.toMatchObject({
      code: "EEXIST",
    });
    expect((await getBackupStatus(config)).running).toBe(true);
  });
  it("tolerates malformed metadata and refuses path traversal", async () => {
    await fs.writeFile(join(config.directory, "bad.dump.json"), "{broken");
    await fs.writeFile(
      join(config.directory, "traversal.dump.json"),
      JSON.stringify({ filename: "../outside.dump" })
    );
    expect(await getBackupStatus(config)).toMatchObject({
      metadataWarning: true,
      last: null,
    });
    await fs.writeFile(join(config.directory, "last-attempt.json"), "null");
    expect((await getBackupStatus(config)).status).toBe("unavailable");
  });
  it("reports missing dump metadata without deleting the orphan", async () => {
    const filename = await oldBackup("2020-01-01");
    await fs.unlink(join(config.directory, `${filename}.json`));
    expect(await getBackupStatus(config)).toMatchObject({
      last: null,
      metadataWarning: true,
    });
    expect(await run(failure)).toBe(false);
    expect(await fs.readFile(join(config.directory, filename), "utf8")).toBe(
      "old"
    );
  });
  it("does not follow a symlink masquerading as a successful dump", async () => {
    const name = await oldBackup("2020-01-01");
    await fs.unlink(join(config.directory, name));
    await fs.symlink("last-attempt.json", join(config.directory, name));
    expect(await getBackupStatus(config)).toMatchObject({
      last: null,
      metadataWarning: true,
    });
  });
  it("rejects unsafe configuration and non-private directories", async () => {
    expect(() =>
      backupConfig({ IOIO_BACKUP_DIR: "/srv/public/backups" })
    ).toThrow();
    expect(() => backupConfig({ IOIO_BACKUP_RETENTION: "0" })).toThrow();
    await fs.chmod(config.directory, 0o755);
    await expect(startBackup(config, success)).rejects.toThrow();
  });
  it("reuses direct configuration, strips Prisma parameters and keeps credentials off argv", () => {
    const direct = backupConfig({
      IOIO_BACKUP_DIR: config.directory,
      DATABASE_URL: "postgres://pooled/a",
      DIRECT_URL:
        "postgres://user:p%40ss@direct:5433/db?sslmode=require&schema=public",
    });
    expect(postgresEnvironment(direct)).toMatchObject({
      PGHOST: "direct",
      PGPORT: "5433",
      PGPASSWORD: "p@ss",
      PGSSLMODE: "require",
      PGDATABASE: "db",
    });
  });
});
