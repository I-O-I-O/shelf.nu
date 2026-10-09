import {
  data,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";
import { requireIoioStaffAccess } from "~/modules/ioio-staff/access.server";
import {
  createIoioInventoryBackup,
  getIoioBackupPreview,
  IoioBackupValidationError,
  readIoioInventoryBackupFiles,
  restoreIoioInventoryBackup,
} from "~/modules/ioio-staff/backup.server";
import { makeShelfError } from "~/utils/error";
import { error } from "~/utils/http.server";
import { Logger } from "~/utils/logger";

export async function loader({ context, request }: LoaderFunctionArgs) {
  const { userId } = context.getSession();

  try {
    const { organizationId } = await requireIoioStaffAccess({
      context,
      request,
    });
    const backup = await createIoioInventoryBackup({ organizationId });
    const date = new Date().toISOString().slice(0, 10);

    // Return the ZIP as a binary ArrayBuffer so the resource route is handled
    // as a real download instead of being coerced through a data response.
    const body = backup.slice().buffer;

    return new Response(body, {
      headers: {
        "content-type": "application/zip",
        "Content-Disposition": `attachment; filename="ioio-lab-backup-${date}.zip"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (cause) {
    Logger.dev("[IOIO BACKUP] generation failed", { userId, cause });
    const reason = makeShelfError(cause, { userId });
    return data(error(reason), { status: reason.status });
  }
}

export async function action({ context, request }: ActionFunctionArgs) {
  const { userId } = context.getSession();

  try {
    const { organizationId } = await requireIoioStaffAccess({
      context,
      request,
    });
    const formData = await request.formData();
    const intent = formData.get("intent");
    const uploadedFiles = formData
      .getAll("file")
      .filter(
        (value): value is File =>
          typeof value === "object" && value !== null && "arrayBuffer" in value
      );

    if (uploadedFiles.length === 0) {
      return data(
        {
          ok: false,
          error: "Choose one backup ZIP or the supported CSV datasets first.",
        },
        { status: 400 }
      );
    }
    if (intent !== "preview" && intent !== "restore") {
      return data(
        { ok: false, error: "The backup action is not supported." },
        { status: 400 }
      );
    }

    const files = await Promise.all(
      uploadedFiles.map(async (file, index) => ({
        name: file.name || `upload-${index}.csv`,
        bytes: new Uint8Array(await file.arrayBuffer()),
      }))
    );
    const backup = await readIoioInventoryBackupFiles(files);
    if (intent === "preview") {
      return data({ ok: true, preview: getIoioBackupPreview(backup) });
    }

    const restored = await restoreIoioInventoryBackup({
      backup,
      organizationId,
      userId,
    });
    return data({ ok: true, restored });
  } catch (cause) {
    if (cause instanceof IoioBackupValidationError) {
      return data({ ok: false, error: cause.message }, { status: 400 });
    }
    Logger.dev("[IOIO BACKUP] restore failed", { userId, cause });
    const reason = makeShelfError(cause, { userId });
    return data(error(reason), { status: reason.status });
  }
}
