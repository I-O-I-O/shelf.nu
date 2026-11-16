import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { getBackupStatus, startBackup } from "~/modules/backup/service.server";
import { requireIoioStaffAccess } from "~/modules/ioio-staff/access.server";

const headers = { "Cache-Control": "no-store" };
export async function loader(args: LoaderFunctionArgs) {
  await requireIoioStaffAccess(args);
  return Response.json({ backup: await getBackupStatus() }, { headers });
}
export async function action(args: ActionFunctionArgs) {
  await requireIoioStaffAccess(args);
  if (args.request.method !== "POST")
    return new Response(null, { status: 405, headers });
  // Cookie-authenticated server-wide operations require a same-origin submission.
  if (args.request.headers.get("Origin") !== new URL(args.request.url).origin)
    return new Response(null, { status: 403, headers });
  try {
    const job = await startBackup();
    // Work continues independently of the HTTP connection. The timer uses the
    // same runner and awaits completion; no browser is needed for daily jobs.
    void job.completion.catch(() => undefined);
    return Response.json(
      { backup: await getBackupStatus(), message: "Backup started." },
      { status: 202, headers }
    );
  } catch (cause) {
    const busy = (cause as NodeJS.ErrnoException)?.code === "EEXIST";
    return Response.json(
      {
        backup: await getBackupStatus(),
        message: busy
          ? "A backup is already running or needs administrator attention."
          : "Backup could not start. Ask an administrator to check server configuration.",
      },
      { status: busy ? 409 : 503, headers }
    );
  }
}
