import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLoaderArgs } from "@mocks/remix";

const mocks = vi.hoisted(() => ({
  requireIoioStaffAccess: vi.fn(),
  getStaffInventoryImportProposal: vi.fn(),
}));

// why: the route's authorization and proposal loader delegate to database-backed
// services; these route tests verify the staff gate and route wiring.
vi.mock("~/modules/ioio-staff/access.server", () => ({
  requireIoioStaffAccess: mocks.requireIoioStaffAccess,
}));
vi.mock("~/modules/ioio-staff/inventory-import.server", () => ({
  applyStaffInventoryImport: vi.fn(),
  cancelStaffInventoryImport: vi.fn(),
  getStaffInventoryImportProposal: mocks.getStaffInventoryImportProposal,
  prepareStaffInventoryImport: vi.fn(),
}));

import { loader } from "~/routes/_layout+/staff.import";

describe("staff inventory import route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireIoioStaffAccess.mockResolvedValue({
      organizationId: "org-1",
      userId: "staff-1",
    });
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
    )) as { importProposal: typeof proposal };

    expect(mocks.getStaffInventoryImportProposal).toHaveBeenCalledWith({
      context: expect.anything(),
      request: expect.any(Request),
      operationId: "operation-1",
    });
    expect(result.importProposal).toEqual(proposal);
  });
});
