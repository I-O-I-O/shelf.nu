import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { data } from "react-router";
import { ErrorContent } from "~/components/errors";
import { BackupDownloadButton } from "~/components/settings/backup-download-button";
import { BackupRestorePanel } from "~/components/settings/backup-restore-panel";
import { requireIoioStaffAccess } from "~/modules/ioio-staff/access.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { makeShelfError } from "~/utils/error";
import { error } from "~/utils/http.server";

export async function loader({ context, request }: LoaderFunctionArgs) {
  const { userId } = context.getSession();

  try {
    await requireIoioStaffAccess({ context, request });
    return null;
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    throw data(error(reason), { status: reason.status });
  }
}

export const handle = { breadcrumb: () => "Backup" };

export const meta: MetaFunction = () => [
  { title: appendToMetaTitle("Backup") },
];

export default function SettingsBackupPage() {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6">
      <section className="rounded-lg border border-gray-200 bg-white p-6">
        <h2 className="text-lg font-semibold text-gray-900">Backup</h2>
        <p className="mt-2 max-w-2xl text-sm text-gray-600">
          Export or restore IOIO Lab inventory data.
        </p>
        <div className="mt-5">
          <BackupDownloadButton />
        </div>
      </section>
      <section className="mt-6 rounded-lg border border-gray-200 bg-white p-6">
        <h2 className="text-lg font-semibold text-gray-900">Restore backup</h2>
        <p className="mt-2 max-w-2xl text-sm text-gray-600">
          Import a backup created by IOIO Lab. The file is checked before any
          inventory data is changed.
        </p>
        <p className="mt-2 max-w-2xl text-xs text-gray-500">
          Allowed uploads: one IOIO Lab .zip backup, or the CSV datasets
          inventory.csv, physical-units.csv, categories.csv, locations.csv, and
          optionally kits.csv.
        </p>
        <div className="mt-5">
          <BackupRestorePanel />
        </div>
      </section>
    </div>
  );
}

export const ErrorBoundary = () => <ErrorContent />;
