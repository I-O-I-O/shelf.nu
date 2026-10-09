import { useState } from "react";
import { DownloadIcon } from "lucide-react";
import { Button } from "~/components/shared/button";

type BackupState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string };

export function BackupDownloadButton() {
  const [state, setState] = useState<BackupState>({ status: "idle" });

  async function createBackup() {
    setState({ status: "loading" });
    try {
      const response = await fetch("/api/settings/backup.zip", {
        credentials: "same-origin",
      });

      if (!response.ok) {
        let message = "The backup could not be created. Please try again.";
        try {
          const body = (await response.json()) as {
            error?: { message?: string };
          };
          message = body.error?.message ?? message;
        } catch {
          // Keep the friendly fallback when the server did not return JSON.
        }
        throw new Error(message);
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `ioio-lab-backup-${new Date()
        .toISOString()
        .slice(0, 10)}.zip`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setState({ status: "idle" });
    } catch (cause) {
      setState({
        status: "error",
        message:
          cause instanceof Error
            ? cause.message
            : "The backup could not be created. Please try again.",
      });
    }
  }

  return (
    <div className="flex items-center gap-3">
      <Button
        type="button"
        variant="primary"
        size="sm"
        compactLayout
        noVerticalPadding
        className="h-10 min-w-[9.5rem] shrink-0"
        onClick={createBackup}
        disabled={state.status === "loading"}
      >
        <span className="inline-flex items-center gap-2">
          <DownloadIcon aria-hidden="true" className="size-4 shrink-0" />
          <span>
            {state.status === "loading"
              ? "Creating backup..."
              : "Export backup"}
          </span>
        </span>
      </Button>
      {state.status === "error" ? (
        <p className="text-sm text-error-700" role="alert">
          {state.message}
        </p>
      ) : null}
    </div>
  );
}
