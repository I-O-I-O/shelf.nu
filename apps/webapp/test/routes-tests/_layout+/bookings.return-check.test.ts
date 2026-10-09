import { beforeEach, describe, expect, it, vi } from "vitest";
import { createActionArgs, createLoaderArgs } from "@mocks/remix";

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  assetFindFirst: vi.fn(),
  requirePermission: vi.fn(),
  completeSubmittedReturn: vi.fn(),
  disableReturnedAssetFromUse: vi.fn(),
}));

// why: only the return operation lookup and completion service touch the
// database; stubbing them isolates route authorization and workflow handoff.
vi.mock("~/database/db.server", () => ({
  db: {
    ioioWriteOperation: { findFirst: mocks.findFirst },
    asset: { findFirst: mocks.assetFindFirst },
  },
}));
vi.mock("~/utils/roles.server", () => ({
  requirePermission: mocks.requirePermission,
}));
vi.mock("~/modules/ioio-student/return-item.server", () => ({
  completeSubmittedReturn: mocks.completeSubmittedReturn,
}));
vi.mock("~/modules/asset/service.server", () => ({
  setIndividualAssetAvailability: vi.fn(),
}));
vi.mock("~/modules/ioio-staff/return-inspection.server", () => ({
  disableReturnedAssetFromUse: mocks.disableReturnedAssetFromUse,
}));

import {
  action,
  loader,
} from "~/routes/_layout+/bookings.return-check.$operationId";

const context = { getSession: () => ({ userId: "staff-1" }) } as never;

describe("return review route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requirePermission.mockResolvedValue({
      organizationId: "org-1",
      role: "OWNER",
    });
    mocks.findFirst.mockResolvedValue(null);
    mocks.completeSubmittedReturn.mockResolvedValue({ ok: true });
    mocks.assetFindFirst.mockResolvedValue({
      id: "asset-1",
      type: "INDIVIDUAL",
      availableToBook: true,
    });
    mocks.disableReturnedAssetFromUse.mockResolvedValue(undefined);
  });

  it("returns not found when the submitted return no longer exists", async () => {
    await expect(
      loader(
        createLoaderArgs({
          context,
          params: { operationId: "operation-1" },
          request: new Request(
            "http://localhost/bookings/return-check/operation-1"
          ),
        })
      )
    ).rejects.toBeInstanceOf(Response);
  });

  it("hands a valid review action to the current return service", async () => {
    mocks.findFirst.mockResolvedValue({
      id: "operation-1",
      assetId: "asset-1",
      reportType: "RETURN_ITEM",
    });
    const result = await action(
      createActionArgs({
        context,
        params: { operationId: "operation-1" },
        request: new Request(
          "http://localhost/bookings/return-check/operation-1",
          {
            method: "POST",
            body: new URLSearchParams({
              intent: "mark-available",
              returnTo: "/operations?view=returns",
            }),
          }
        ),
      })
    );

    expect(mocks.completeSubmittedReturn).toHaveBeenCalledWith(
      { operationId: "operation-1" },
      expect.objectContaining({
        context,
        auth: { userId: "staff-1", organizationId: "org-1", role: "OWNER" },
      })
    );
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).headers.get("Location")).toBe(
      "/operations?view=returns"
    );
  });

  it("marks a returned physical unit broken and creates a return-check report", async () => {
    mocks.findFirst.mockResolvedValue({
      id: "operation-1",
      assetId: "asset-1",
      reportType: "RETURN_ITEM",
    });

    const result = await action(
      createActionArgs({
        context,
        params: { operationId: "operation-1" },
        request: new Request(
          "http://localhost/bookings/return-check/operation-1",
          {
            method: "POST",
            body: new URLSearchParams({
              intent: "disable",
              note: "Broken connector",
              returnTo: "/operations?view=returns",
            }),
          }
        ),
      })
    );

    expect(mocks.completeSubmittedReturn).toHaveBeenCalledWith(
      { operationId: "operation-1" },
      expect.objectContaining({
        auth: { userId: "staff-1", organizationId: "org-1", role: "OWNER" },
      })
    );
    expect(mocks.disableReturnedAssetFromUse).toHaveBeenCalledWith({
      assetId: "asset-1",
      organizationId: "org-1",
      userId: "staff-1",
      note: "Broken connector",
    });
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).headers.get("Location")).toBe(
      "/operations?view=returns"
    );
  });

  it("does not allow Students to invoke the Staff return check", async () => {
    mocks.requirePermission.mockResolvedValue({
      organizationId: "org-1",
      role: "SELF_SERVICE",
    });

    await expect(
      action(
        createActionArgs({
          context,
          params: { operationId: "operation-1" },
          request: new Request(
            "http://localhost/bookings/return-check/operation-1",
            {
              method: "POST",
              body: new URLSearchParams({ intent: "mark-available" }),
            }
          ),
        })
      )
    ).rejects.toMatchObject({ status: 403 });
    expect(mocks.completeSubmittedReturn).not.toHaveBeenCalled();
  });
});
