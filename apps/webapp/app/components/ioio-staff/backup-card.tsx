import { useEffect } from "react";
import { useFetcher } from "react-router";
import type { BackupStatus } from "~/modules/backup/service.server";

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
        {backup.automatic === "configured"
          ? "Enabled (server configuration confirmed)"
          : "Not confirmed — server setup required"}
      </p>
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
            {backup.recent.map((b) => (
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
export function BackupCard() {
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
  return (
    <section
      aria-label="Backup"
      className="mt-3 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-700"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="mb-2 text-xs font-bold uppercase tracking-[0.16em] text-gray-500">
            Backup
          </h2>
          {backup ? (
            <BackupDetails backup={backup} />
          ) : (
            <p>Loading backup status…</p>
          )}
          <p className="pt-1 text-xs text-gray-500">
            Database only. Uploaded images and files are not included.
          </p>
        </div>
        <fetcher.Form method="post" action="/api/backups">
          <button
            type="submit"
            disabled={!backup?.available || backup.running || state !== "idle"}
            className="rounded-lg bg-gray-950 px-4 py-2 font-semibold text-white disabled:opacity-50"
          >
            {backup?.running || state === "submitting"
              ? "Backing up…"
              : "Back up now"}
          </button>
        </fetcher.Form>
      </div>
      {fetcher.data?.message ? (
        <p role="status" className="mt-2">
          {fetcher.data.message}
        </p>
      ) : null}
      {backup && !backup.running && backup.status === "failed" ? (
        <p role="status" className="mt-2 text-red-700">
          The last attempt failed. Previous successful backups remain available.
        </p>
      ) : null}
    </section>
  );
}
