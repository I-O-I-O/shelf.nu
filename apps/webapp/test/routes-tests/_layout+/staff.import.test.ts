import { beforeEach, describe, expect, it, vi } from "vitest";
import { createActionArgs, createLoaderArgs } from "@mocks/remix";

const mocks = vi.hoisted(() => ({
  requireIoioStaffAccess: vi.fn(),
  requirePermission: vi.fn(),
  getStaffInventoryImportProposal: vi.fn(),
  getStaffInventoryImportDrafts: vi.fn(),
  saveStaffInventoryImportDraft: vi.fn(),
  revertStaffInventoryImportRow: vi.fn(),
  applyStaffInventoryImport: vi.fn(),
  processStaffImportImageUpload: vi.fn(),
}));

// why: the route's authorization and proposal loader delegate to database-backed
// services; these route tests verify the staff gate and route wiring.
vi.mock("~/modules/ioio-staff/access.server", () => ({
  requireIoioStaffAccess: mocks.requireIoioStaffAccess,
}));
// why: image decoding is covered in the bounded image processor's unit tests;
// this route test verifies the staff-only upload intent and response wiring.
vi.mock("~/modules/ioio-staff/product-enrichment.server", () => ({
  IMPORT_IMAGE_SOURCE_MAX_BYTES: 8 * 1024 * 1024,
  processStaffImportImageUpload: mocks.processStaffImportImageUpload,
}));
vi.mock("~/utils/roles.server", () => ({
  requirePermission: mocks.requirePermission,
}));
vi.mock("~/modules/ioio-staff/inventory-import.server", () => ({
  applyStaffInventoryImport: mocks.applyStaffInventoryImport,
  cancelStaffInventoryImport: vi.fn(),
  getStaffInventoryImportProposal: mocks.getStaffInventoryImportProposal,
  getStaffInventoryImportDrafts: mocks.getStaffInventoryImportDrafts,
  saveStaffInventoryImportDraft: mocks.saveStaffInventoryImportDraft,
  revertStaffInventoryImportRow: mocks.revertStaffInventoryImportRow,
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
    mocks.getStaffInventoryImportDrafts.mockResolvedValue([]);
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
    mocks.getStaffInventoryImportProposal.mockResolvedValue({
      operationId: "operation-1",
      rows: [],
      appliedRowNumbers: [1],
    });
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
      kind: "import-complete",
      proposal: { appliedRowNumbers: [1] },
      result: resultData,
    });
  });

  it("routes a row Import request to scoped Apply", async () => {
    mocks.applyStaffInventoryImport.mockResolvedValue({
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
    });
    const form = new FormData();
    form.set("intent", "apply-row");
    form.set("operationId", "operation-1");
    form.set("proposalHash", "reviewed-hash");
    form.set("rowNumber", "3");
    form.set("reviewDecisions", JSON.stringify([{ rowNumber: 3 }]));

    await action(
      createActionArgs({
        request: new Request("http://localhost/staff/import", {
          method: "POST",
          body: form,
        }),
        context: { getSession: () => ({ userId: "staff-1" }) } as never,
      })
    );

    expect(mocks.applyStaffInventoryImport).toHaveBeenCalledWith(
      expect.objectContaining({ applyOnlyRowNumber: 3 })
    );
  });

  it("returns selected-row readiness issues without turning them into an error", async () => {
    mocks.applyStaffInventoryImport.mockResolvedValue({
      status: "NEEDS_REVIEW",
      operationId: "operation-1",
      readyCount: 3,
      blockedCount: 2,
      blockedRows: [
        {
          rowNumber: 2,
          title: "Rigol DS1054Z",
          issues: [
            {
              code: "MISSING_LOCATION",
              message:
                "Choose a location for Rigol DS1054Z before importing it.",
            },
          ],
        },
      ],
    });
    const form = new FormData();
    form.set("intent", "apply-selected");
    form.set("operationId", "operation-1");
    form.set("proposalHash", "reviewed-hash");
    form.set("rowNumbers", "[2,3,4,5,6]");
    form.set("reviewDecisions", "[]");
    const result = await action(
      createActionArgs({
        request: new Request("http://localhost/staff/import", {
          method: "POST",
          body: form,
        }),
        context: { getSession: () => ({ userId: "staff-1" }) } as never,
      })
    );
    expect(mocks.applyStaffInventoryImport).toHaveBeenCalledWith(
      expect.objectContaining({ applyOnlyRowNumbers: [2, 3, 4, 5, 6] })
    );
    expect(result).toMatchObject({
      error: null,
      kind: "import-review-blocked",
      readyCount: 3,
      blockedCount: 2,
      blockedRows: [{ rowNumber: 2, issues: [{ code: "MISSING_LOCATION" }] }],
    });
  });

  it("saves review edits using the existing import operation", async () => {
    mocks.saveStaffInventoryImportDraft.mockResolvedValue({
      operationId: "operation-1",
      saved: true,
    });
    const form = new FormData();
    form.set("intent", "save-draft");
    form.set("operationId", "operation-1");
    form.set(
      "reviewDecisions",
      JSON.stringify([{ rowNumber: 2, decision: null }])
    );
    const result = await action(
      createActionArgs({
        request: new Request("http://localhost/staff/import", {
          method: "POST",
          body: form,
        }),
        context: { getSession: () => ({ userId: "staff-1" }) } as never,
      })
    );

    expect(mocks.saveStaffInventoryImportDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: "operation-1",
        reviewDecisions: expect.any(String),
      })
    );
    expect(result).toMatchObject({ error: null, kind: "import-draft-saved" });
  });

  it("processes staff image uploads into review-only proposal data", async () => {
    const imageProposal = {
      status: "IMAGE_FOUND",
      mimeType: "image/webp",
      dataBase64: "cHJvY2Vzc2Vk",
      source: "MANUAL_UPLOAD",
      sourceName: "Manual upload",
      autoAccepted: true,
    };
    mocks.processStaffImportImageUpload.mockResolvedValue(imageProposal);
    const form = new FormData();
    form.set("intent", "process-import-image");
    form.set("rowNumber", "3");
    form.set(
      "file",
      new File(["source"], "product.png", { type: "image/png" })
    );
    const result = await action(
      createActionArgs({
        request: new Request("http://localhost/staff/import", {
          method: "POST",
          body: form,
        }),
        context: { getSession: () => ({ userId: "staff-1" }) } as never,
      })
    );

    expect(mocks.processStaffImportImageUpload).toHaveBeenCalledWith(
      Buffer.from("source"),
      "image/png"
    );
    expect(result).toMatchObject({
      error: null,
      kind: "import-image-processed",
      rowNumber: 3,
      proposal: imageProposal,
    });
    expect(mocks.applyStaffInventoryImport).not.toHaveBeenCalled();
  });

  it("returns the remaining proposal after a partial Apply", async () => {
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
      remainingRows: 19,
    };
    const proposal = {
      operationId: "operation-1",
      rows: [],
      appliedRowNumbers: [2],
    };
    mocks.applyStaffInventoryImport.mockResolvedValue(resultData);
    mocks.getStaffInventoryImportProposal.mockResolvedValue(proposal);
    const form = new FormData();
    form.set("intent", "apply-import");
    form.set("operationId", "operation-1");
    form.set("proposalHash", "reviewed-hash");
    form.set(
      "reviewDecisions",
      JSON.stringify([{ rowNumber: 2, decision: "APPROVE" }])
    );

    const result = await action(
      createActionArgs({
        request: new Request("http://localhost/staff/import", {
          method: "POST",
          body: form,
        }),
        context: { getSession: () => ({ userId: "staff-1" }) } as never,
      })
    );

    expect(mocks.getStaffInventoryImportProposal).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: "operation-1" })
    );
    expect(result).toMatchObject({
      error: null,
      kind: "import-partial",
      proposal,
      result: resultData,
    });
  });

  it("routes a row revert through the server-side import service", async () => {
    mocks.revertStaffInventoryImportRow.mockResolvedValue({
      operationId: "operation-1",
      rowNumber: 3,
      reverted: true,
    });
    const form = new FormData();
    form.set("intent", "revert-row");
    form.set("operationId", "operation-1");
    form.set("rowNumber", "3");

    const result = await action(
      createActionArgs({
        request: new Request("http://localhost/staff/import", {
          method: "POST",
          body: form,
        }),
        context: { getSession: () => ({ userId: "staff-1" }) } as never,
      })
    );

    expect(mocks.revertStaffInventoryImportRow).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: "operation-1", rowNumber: 3 })
    );
    expect(result).toMatchObject({
      error: null,
      kind: "import-row-reverted",
      result: { rowNumber: 3, reverted: true },
    });
  });

  it("reverts only the selected implemented rows through the server service", async () => {
    mocks.revertStaffInventoryImportRow
      .mockResolvedValueOnce({
        operationId: "operation-1",
        rowNumber: 1,
        reverted: true,
      })
      .mockResolvedValueOnce({
        operationId: "operation-1",
        rowNumber: 3,
        reverted: true,
      });
    const proposal = {
      operationId: "operation-1",
      rows: [],
      appliedRowNumbers: [2],
      revertedRowNumbers: [1, 3],
    };
    mocks.getStaffInventoryImportProposal.mockResolvedValue(proposal);
    const form = new FormData();
    form.set("intent", "revert-selected");
    form.set("operationId", "operation-1");
    form.set("rowNumbers", JSON.stringify([1, 3]));

    const result = await action(
      createActionArgs({
        request: new Request("http://localhost/staff/import", {
          method: "POST",
          body: form,
        }),
        context: { getSession: () => ({ userId: "staff-1" }) } as never,
      })
    );

    expect(mocks.revertStaffInventoryImportRow).toHaveBeenCalledTimes(2);
    expect(mocks.revertStaffInventoryImportRow).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ operationId: "operation-1", rowNumber: 1 })
    );
    expect(mocks.revertStaffInventoryImportRow).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ operationId: "operation-1", rowNumber: 3 })
    );
    expect(mocks.revertStaffInventoryImportRow).not.toHaveBeenCalledWith(
      expect.objectContaining({ rowNumber: 2 })
    );
    expect(result).toMatchObject({
      error: null,
      kind: "import-rows-reverted",
      proposal,
      result: {
        operationId: "operation-1",
        revertedRowNumbers: [1, 3],
        failedRows: [],
      },
    });
  });
});
