import { beforeEach, describe, expect, it, vi } from "vitest";
import { createActionArgs, createLoaderArgs } from "@mocks/remix";

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  requirePermission: vi.fn(),
  completeSubmittedReturn: vi.fn(),
}));

// why: only the return operation lookup and completion service touch the
// database; stubbing them isolates route authorization and workflow handoff.
vi.mock("~/database/db.server", () => ({
  db: {
    ioioWriteOperation: { findFirst: mocks.findFirst },
  },
}));
vi.mock("~/utils/roles.server", () => ({
  requirePermission: mocks.requirePermission,
}));
vi.mock("~/modules/ioio-student/return-item.server", () => ({
  completeSubmittedReturn: mocks.completeSubmittedReturn,
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
      expect.objectContaining({ context })
    );
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).headers.get("Location")).toBe(
      "/operations?view=returns"
    );
  });
});
