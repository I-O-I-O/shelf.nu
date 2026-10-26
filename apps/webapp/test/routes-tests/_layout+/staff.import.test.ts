import { beforeEach, describe, expect, it, vi } from "vitest";
import { createActionArgs, createLoaderArgs } from "@mocks/remix";

const mocks = vi.hoisted(() => ({
  requireIoioStaffAccess: vi.fn(),
  requirePermission: vi.fn(),
  getStaffInventoryImportProposal: vi.fn(),
  applyStaffInventoryImport: vi.fn(),
}));

// why: the route's authorization and proposal loader delegate to database-backed
// services; these route tests verify the staff gate and route wiring.
vi.mock("~/modules/ioio-staff/access.server", () => ({
  requireIoioStaffAccess: mocks.requireIoioStaffAccess,
}));
vi.mock("~/utils/roles.server", () => ({
  requirePermission: mocks.requirePermission,
}));
vi.mock("~/modules/ioio-staff/inventory-import.server", () => ({
  applyStaffInventoryImport: mocks.applyStaffInventoryImport,
  cancelStaffInventoryImport: vi.fn(),
  getStaffInventoryImportProposal: mocks.getStaffInventoryImportProposal,
  prepareStaffInventoryImport: vi.fn(),
}));

import { action, loader } from "~/routes/_layout+/staff.import";

describe("staff inventory import route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireIoioStaffAccess.mockResolvedValue({
      organizationId: "org-1",
      userId: "staff-1",
    });
    mocks.requirePermission.mockResolvedValue({});
  });

  it("requires staff access and renders the new-import state", async () => {
    const result = (await loader(
      createLoaderArgs({
        request: new Request("http://localhost/staff/import"),
        context: { getSession: () => ({ userId: "staff-1" }) } as never,
      })
    )) as {
      header: { title: string };
      importProposal: null;
      importNotice: null;
    };

    expect(mocks.requireIoioStaffAccess).toHaveBeenCalledOnce();
    expect(result.header.title).toBe("Import inventory");
    expect(result.importProposal).toBeNull();
    expect(result.importNotice).toBeNull();
  });

  it("passes the canonical category-creation permission to the review UI", async () => {
    const result = (await loader(
      createLoaderArgs({
        request: new Request("http://localhost/staff/import"),
        context: { getSession: () => ({ userId: "staff-1" }) } as never,
      })
    )) as { canCreateCategory: boolean };

    expect(result.canCreateCategory).toBe(true);
    expect(mocks.requirePermission).toHaveBeenCalledOnce();
  });

  it("marks category creation unavailable when Shelf denies the permission", async () => {
    mocks.requirePermission.mockRejectedValue(new Error("Permission denied"));

    const result = (await loader(
      createLoaderArgs({
        request: new Request("http://localhost/staff/import"),
        context: { getSession: () => ({ userId: "staff-1" }) } as never,
      })
    )) as { canCreateCategory: boolean };

    expect(result.canCreateCategory).toBe(false);
  });

  it("loads a saved review proposal through the current IOIO import service", async () => {
    const proposal = { operationId: "operation-1", rows: [] };
    mocks.getStaffInventoryImportProposal.mockResolvedValue(proposal);

    const result = (await loader(
      createLoaderArgs({
        request: new Request(
          "http://localhost/staff/import?importOperation=operation-1"
        ),
        context: { getSession: () => ({ userId: "staff-1" }) } as never,
      })
    )) as unknown as { importProposal: typeof proposal };

    expect(mocks.getStaffInventoryImportProposal).toHaveBeenCalledWith({
      context: expect.anything(),
      request: expect.any(Request),
      operationId: "operation-1",
    });
    expect(result.importProposal).toEqual(proposal);
  });

  it("routes a confirmed Apply request to the shared import engine and returns its result", async () => {
    const resultData = {
      operationId: "operation-1",
      createdIds: ["asset-1"],
      updatedIds: [],
      reusedIds: [],
      failedRows: [],
      conflictRows: [],
      totalRows: 1,
      succeededRows: 1,
      failedRowsCount: 0,
      conflictedRowsCount: 0,
      ignoredRows: 0,
    };
    mocks.applyStaffInventoryImport.mockResolvedValue(resultData);
    const form = new FormData();
    form.set("intent", "apply-import");
    form.set("operationId", "operation-1");
    form.set("proposalHash", "reviewed-hash");
    form.set("reviewDecisions", JSON.stringify([{ rowNumber: 1 }]));
    const request = new Request("http://localhost/staff/import", {
      method: "POST",
      body: form,
    });

    const result = await action(
      createActionArgs({
        request,
        context: { getSession: () => ({ userId: "staff-1" }) } as never,
      })
    );

    expect(mocks.applyStaffInventoryImport).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: "operation-1",
        proposalHash: "reviewed-hash",
        reviewDecisions: expect.any(String),
      })
    );
    expect(result).toMatchObject({
      error: null,
      kind: "import-result",
      result: resultData,
    });
  });
});
