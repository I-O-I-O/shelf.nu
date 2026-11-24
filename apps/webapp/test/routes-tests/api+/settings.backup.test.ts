import { beforeEach, describe, expect, it, vi } from "vitest";
import { createActionArgs } from "@mocks/remix";

const mocks = vi.hoisted(() => ({
  requireIoioStaffAccess: vi.fn(),
  createBackup: vi.fn(),
  getPreview: vi.fn(),
  readFiles: vi.fn(),
  restore: vi.fn(),
}));

// why: backup route tests must never read or write real inventory data.
vi.mock("~/modules/ioio-staff/access.server", () => ({
  requireIoioStaffAccess: mocks.requireIoioStaffAccess,
}));
vi.mock("~/modules/ioio-staff/backup.server", () => ({
  createIoioInventoryBackup: mocks.createBackup,
  getIoioBackupPreview: mocks.getPreview,
  IoioBackupValidationError: class IoioBackupValidationError extends Error {},
  readIoioInventoryBackupFiles: mocks.readFiles,
  restoreIoioInventoryBackup: mocks.restore,
}));

import { IoioBackupValidationError } from "~/modules/ioio-staff/backup.server";
import { action } from "~/routes/api+/settings.backup[.zip]";

const context = { getSession: () => ({ userId: "owner-1" }) } as never;

describe("IOIO backup resource route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireIoioStaffAccess.mockResolvedValue({
      userId: "owner-1",
      organizationId: "team-1",
    });
    mocks.readFiles.mockResolvedValue({ organizationId: "team-1" });
    mocks.getPreview.mockReturnValue({
      inventory: 2,
      physicalUnits: 3,
      categories: 1,
      locations: 1,
      kits: 0,
    });
  });

  it("previews the uploaded backup without restoring it", async () => {
    const form = new FormData();
    form.set("intent", "preview");
    form.append("file", new File(["inventory"], "inventory.csv"));
    const result = await action(
      createActionArgs({
        context,
        request: new Request("http://localhost/api/settings/backup.zip", {
          method: "POST",
          body: form,
        }),
      })
    );
    expect(result).toMatchObject({
      data: { ok: true, preview: { inventory: 2 } },
    });
    expect(mocks.restore).not.toHaveBeenCalled();
  });

  it("rejects missing files and returns organization mismatch validation", async () => {
    const emptyResult = await action(
      createActionArgs({
        context,
        request: new Request("http://localhost/api/settings/backup.zip", {
          method: "POST",
          body: new FormData(),
        }),
      })
    );
    expect(emptyResult).toMatchObject({ data: { ok: false } });

    const invalidForm = new FormData();
    invalidForm.set("intent", "preview");
    invalidForm.append("file", new File(["not a backup"], "backup.csv"));
    mocks.readFiles.mockRejectedValueOnce(
      new IoioBackupValidationError("The backup file is invalid.")
    );
    const invalidResult = await action(
      createActionArgs({
        context,
        request: new Request("http://localhost/api/settings/backup.zip", {
          method: "POST",
          body: invalidForm,
        }),
      })
    );
    expect(invalidResult).toMatchObject({ data: { ok: false } });
    expect(mocks.restore).not.toHaveBeenCalled();

    const form = new FormData();
    form.set("intent", "restore");
    form.append("file", new File(["backup"], "backup.zip"));
    mocks.restore.mockRejectedValue(
      new IoioBackupValidationError(
        "This backup belongs to a different organization."
      )
    );
    const restoreResult = await action(
      createActionArgs({
        context,
        request: new Request("http://localhost/api/settings/backup.zip", {
          method: "POST",
          body: form,
        }),
      })
    );
    expect(mocks.restore).toHaveBeenCalledWith({
      backup: { organizationId: "team-1" },
      organizationId: "team-1",
      userId: "owner-1",
    });
    expect(restoreResult).toMatchObject({ data: { ok: false } });
  });
});
