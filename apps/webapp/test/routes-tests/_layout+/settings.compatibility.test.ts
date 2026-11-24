import { describe, expect, it, vi } from "vitest";
import { createLoaderArgs } from "@mocks/remix";

const mocks = vi.hoisted(() => ({ requireIoioStaffAccess: vi.fn() }));

// why: authorization is rejected before the workspace list can query membership data.
vi.mock("~/modules/ioio-staff/access.server", () => ({
  requireIoioStaffAccess: mocks.requireIoioStaffAccess,
}));

import { loader as workspaceLoader } from "~/routes/_layout+/account-details.workspace.index";
import { loader as openingHoursLoader } from "~/routes/_layout+/settings.opening-hours";
import { ShelfError } from "~/utils/error";

describe("Settings compatibility and workspace access", () => {
  it("redirects the old Opening Hours URL to the Lab Information section", () => {
    const response = openingHoursLoader({} as never);
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).headers.get("Location")).toBe(
      "/settings/lab-information#opening-hours"
    );
  });

  it("denies Students direct access to workspace management", async () => {
    mocks.requireIoioStaffAccess.mockRejectedValue(
      new ShelfError({
        cause: null,
        message: "Staff only",
        label: "Permission",
        status: 403,
        shouldBeCaptured: false,
      })
    );
    await expect(
      workspaceLoader(
        createLoaderArgs({
          context: { getSession: () => ({ userId: "student-1" }) } as never,
          request: new Request("http://localhost/account-details/workspace"),
        })
      )
    ).rejects.toMatchObject({ data: { error: { message: "Staff only" } } });
  });
});
