import { useEffect } from "react";
import {
  Popover,
  PopoverContent,
  PopoverPortal,
  PopoverTrigger,
} from "@radix-ui/react-popover";
import { useFetcher } from "react-router";
import type { BackupStatus } from "~/modules/backup/service.server";

// A daily backup gets a 12-hour grace period before it needs attention.
const MAX_BACKUP_AGE_MS = 36 * 60 * 60 * 1000;
export function getBackupIndicator(
  backup: BackupStatus | undefined,
  now = Date.now()
): { label: string; color: string } {
  if (backup?.running) return { label: "Running", color: "bg-orange-500" };
  const completedAt = backup?.last ? Date.parse(backup.last.completedAt) : NaN;
  if (
    !backup?.available ||
    backup.automatic !== "configured" ||
    backup.status !== "successful" ||
    !backup.last?.verified ||
    !Number.isFinite(completedAt) ||
    completedAt > now ||
    now - completedAt > MAX_BACKUP_AGE_MS
  ) {
    return { label: "Needs attention", color: "bg-red-600" };
  }
  if (backup.metadataWarning || backup.retentionWarning)
    return { label: "Needs attention", color: "bg-orange-500" };
  return { label: "Up to date", color: "bg-green-600" };
}

export function BackupDetails({ backup }: { backup: BackupStatus }) {
  const label = backup.running
    ? "Backup in progress"
    : {
        successful: "Successful",
        failed: "Failed",
        never: "Never run",
        unavailable: "Unavailable",
      }[backup.status];
  return (
    <>
      <p>
        Automatic backups:{" "}
        {backup.automatic === "configured" ? "Enabled" : "Not configured"}
      </p>
      {backup.automatic === "configured" ? (
        <p>Schedule: Daily at 03:00 (server local time)</p>
      ) : null}
      <p>
        Status:{" "}
        <span
          className={
            backup.status === "failed"
              ? "font-semibold text-red-700"
              : "font-semibold text-gray-950"
          }
        >
          {label}
        </span>
      </p>
      <p>
        Last successful backup:{" "}
        {backup.last
          ? new Date(backup.last.completedAt).toLocaleString()
          : "No successful database backup yet"}
      </p>
      <p>Retention: Last {backup.retention} daily backups</p>
      <p>Included: PostgreSQL database</p>
      <p>Not included: Uploaded images/files</p>
      {backup.retentionWarning ? (
        <p className="text-red-700">
          The backup succeeded, but retention cleanup needs administrator
          attention.
        </p>
      ) : null}
      {backup.metadataWarning ? (
        <p className="text-red-700">
          Some backup metadata could not be read. Ask an administrator to
          inspect it.
        </p>
      ) : null}
      {backup.recent.length ? (
        <details className="pt-1">
          <summary className="cursor-pointer">Recent database backups</summary>
          <ul className="mt-2 space-y-1">
            {backup.recent.slice(0, 3).map((b) => (
              <li key={b.filename}>
                {new Date(b.completedAt).toLocaleString()} ·{" "}
                {(b.size / 1024 / 1024).toFixed(2)} MB · Successful, verified
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </>
  );
}
export function BackupStatusItem() {
  const fetcher = useFetcher<{ backup: BackupStatus; message?: string }>();
  const { load, state } = fetcher;
  const backup = fetcher.data?.backup;
  useEffect(() => {
    void load("/api/backups");
  }, [load]);
  useEffect(() => {
    const timer = setInterval(
      () => {
        if (state === "idle") void load("/api/backups");
      },
      backup?.running ? 3000 : 15000
    );
    return () => clearInterval(timer);
  }, [load, state, backup?.running]);
  const indicator = getBackupIndicator(backup);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-2 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2"
        >
          <span
            aria-hidden="true"
            className={`size-2 rounded-full ${indicator.color}`}
          />
          <span>Backup</span>
          <span className="font-semibold text-gray-950">{indicator.label}</span>
        </button>
      </PopoverTrigger>
      <PopoverPortal>
        <PopoverContent
          aria-label="Backup details"
          side="bottom"
          align="end"
          sideOffset={8}
          collisionPadding={12}
          className="z-50 max-h-[80vh] w-[calc(100vw-2rem)] max-w-sm overflow-y-auto rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-700 shadow-lg outline-none"
        >
          <h2 className="mb-3 font-semibold text-gray-950">Backup</h2>
          <div className="space-y-1">
            {backup ? (
              <BackupDetails backup={backup} />
            ) : (
              <p>Loading backup status…</p>
            )}
          </div>
          <fetcher.Form method="post" action="/api/backups" className="mt-4">
            <button
              type="submit"
              disabled={
                !backup?.available || backup.running || state !== "idle"
              }
              className="rounded-lg bg-gray-950 px-4 py-2 font-semibold text-white disabled:opacity-50"
            >
              {backup?.running || state === "submitting"
                ? "Backing up…"
                : "Back up now"}
            </button>
          </fetcher.Form>
          {fetcher.data?.message ? (
            <p role="status" className="mt-2">
              {fetcher.data.message}
            </p>
          ) : null}
          {backup && !backup.running && backup.status === "failed" ? (
            <p role="status" className="mt-2 text-red-700">
              The last attempt failed. Previous successful backups remain
              available.
            </p>
          ) : null}
        </PopoverContent>
      </PopoverPortal>
    </Popover>
  );
}
