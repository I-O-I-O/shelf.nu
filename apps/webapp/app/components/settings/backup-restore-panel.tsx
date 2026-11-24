import { useRef, useState } from "react";
import { Button } from "~/components/shared/button";

type BackupCounts = {
  inventory: number;
  physicalUnits: number;
  categories: number;
  locations: number;
  kits: number;
};

type PanelState =
  | { status: "idle"; files: File[] }
  | { status: "previewing"; files: File[] }
  | { status: "ready"; files: File[]; preview: BackupCounts }
  | { status: "restoring"; files: File[]; preview: BackupCounts }
  | { status: "success"; files: File[]; restored: BackupCounts }
  | { status: "error"; files: File[]; message: string };

function countsLabel(counts: BackupCounts) {
  return [
    ["Items", counts.inventory],
    ["Physical units", counts.physicalUnits],
    ["Categories", counts.categories],
    ["Locations", counts.locations],
    ...(counts.kits > 0 ? [["Kits", counts.kits] as const] : []),
  ] as const;
}

async function readActionResponse(response: Response) {
  const body = (await response.json()) as {
    ok?: boolean;
    error?: string | { message?: string };
    preview?: BackupCounts;
    restored?: BackupCounts;
  };
  if (!response.ok || !body.ok) {
    const error = body.error;
    throw new Error(
      typeof error === "string"
        ? error
        : error?.message ?? "The backup could not be processed."
    );
  }
  return body;
}

export function BackupRestorePanel() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<PanelState>({
    status: "idle",
    files: [],
  });

  function chooseFiles(fileList: FileList | null) {
    setState({
      status: "idle",
      files: fileList ? Array.from(fileList) : [],
    });
  }

  async function previewBackup() {
    if (state.files.length === 0) return;
    setState({ status: "previewing", files: state.files });
    try {
      const formData = new FormData();
      formData.set("intent", "preview");
      for (const file of state.files) formData.append("file", file);
      const body = await readActionResponse(
        await fetch("/api/settings/backup.zip", {
          method: "POST",
          body: formData,
          credentials: "same-origin",
        })
      );
      if (!body.preview) throw new Error("The backup preview was incomplete.");
      setState({ status: "ready", files: state.files, preview: body.preview });
    } catch (cause) {
      setState({
        status: "error",
        files: state.files,
        message:
          cause instanceof Error
            ? cause.message
            : "The backup could not be validated.",
      });
    }
  }

  async function restoreBackup() {
    if (state.status !== "ready") return;
    const { files, preview } = state;
    setState({ status: "restoring", files, preview });
    try {
      const formData = new FormData();
      formData.set("intent", "restore");
      for (const file of files) formData.append("file", file);
      const body = await readActionResponse(
        await fetch("/api/settings/backup.zip", {
          method: "POST",
          body: formData,
          credentials: "same-origin",
        })
      );
      setState({
        status: "success",
        files,
        restored: body.restored ?? preview,
      });
    } catch (cause) {
      setState({
        status: "error",
        files,
        message:
          cause instanceof Error
            ? cause.message
            : "The backup could not be restored.",
      });
    }
  }

  const counts =
    state.status === "ready" || state.status === "restoring"
      ? state.preview
      : state.status === "success"
      ? state.restored
      : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <label className="shadow-xs inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded border border-gray-300 bg-white px-4 text-sm font-semibold text-gray-700 hover:bg-gray-50">
          <span>Choose file</span>
          <input
            ref={inputRef}
            type="file"
            accept=".zip,.csv,application/zip,application/x-zip-compressed,text/csv"
            multiple
            className="sr-only"
            onChange={(event) => chooseFiles(event.target.files)}
          />
        </label>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          icon="install"
          className="h-10 min-w-[9.5rem] justify-center px-4"
          onClick={previewBackup}
          disabled={
            state.files.length === 0 ||
            state.status === "previewing" ||
            state.status === "restoring"
          }
        >
          {state.status === "previewing"
            ? "Checking backup..."
            : "Import backup"}
        </Button>
      </div>

      {state.files.length > 0 ? (
        <div className="space-y-1 text-sm text-gray-600">
          <p>Selected files:</p>
          <ul className="list-inside list-disc">
            {state.files.map((file) => (
              <li key={`${file.name}-${file.size}-${file.lastModified}`}>
                {file.name}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {counts ? (
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
          <p className="font-semibold text-gray-900">
            {state.status === "success"
              ? "Backup restored"
              : "Backup ready to import"}
          </p>
          <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
            {countsLabel(counts).map(([label, value]) => (
              <div key={label}>
                <dt className="text-gray-600">{label}</dt>
                <dd className="font-semibold text-gray-900">{value}</dd>
              </div>
            ))}
          </dl>
          {state.status === "ready" || state.status === "restoring" ? (
            <p className="mt-3 text-sm text-gray-600">
              Existing operational records may be updated. Nothing changes until
              you choose Restore backup.
            </p>
          ) : null}
          {state.status === "ready" || state.status === "restoring" ? (
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => {
                  setState({ status: "idle", files: [] });
                  if (inputRef.current) inputRef.current.value = "";
                }}
                disabled={state.status === "restoring"}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="danger"
                size="sm"
                onClick={restoreBackup}
                disabled={state.status === "restoring"}
              >
                {state.status === "restoring"
                  ? "Restoring backup..."
                  : "Restore backup"}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {state.status === "error" ? (
        <p className="text-sm text-error-700" role="alert">
          {state.message}
        </p>
      ) : null}
    </div>
  );
}
