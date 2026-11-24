import { OrganizationRoles } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createActionArgs } from "@mocks/remix";

const mocks = vi.hoisted(() => ({
  requireIoioStaffAccess: vi.fn(),
  requirePermission: vi.fn(),
  grantAccess: vi.fn(),
  revokeAccess: vi.fn(),
  resolveUserAction: vi.fn(),
}));

// why: the route test isolates the modern permission and annual-access services.
vi.mock("~/modules/ioio-staff/access.server", () => ({
  requireIoioStaffAccess: mocks.requireIoioStaffAccess,
}));
vi.mock("~/utils/roles.server", () => ({
  requirePermission: mocks.requirePermission,
}));
vi.mock("~/modules/ioio-student/annual-access.server", () => ({
  getStaffAnnualAccessApprovals: vi.fn(),
  grantAnnualAccessToStudent: mocks.grantAccess,
  revokeAnnualAccessApproval: mocks.revokeAccess,
}));
vi.mock("~/modules/settings/service.server", () => ({
  getPaginatedAndFilterableSettingUsers: vi.fn(),
}));
vi.mock("~/modules/user/utils.server", () => ({
  resolveUserAction: mocks.resolveUserAction,
}));
// why: imported dialogs use a canvas animation unavailable in happy-dom.
vi.mock("lottie-react", () => ({ default: () => null }));

import { ioioRoleLabel } from "~/components/ioio-staff/role-label";
import { action } from "~/routes/_layout+/settings.team.users";
import { ShelfError } from "~/utils/error";

const context = { getSession: () => ({ userId: "owner-1" }) } as never;

describe("IOIO Users settings actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireIoioStaffAccess.mockResolvedValue({
      userId: "owner-1",
      organizationId: "team-1",
      role: OrganizationRoles.OWNER,
    });
    mocks.requirePermission.mockResolvedValue({
      organizationId: "team-1",
      role: OrganizationRoles.OWNER,
    });
  });

  it("uses IOIO Student and Staff labels for modern organization roles", () => {
    expect(ioioRoleLabel(OrganizationRoles.SELF_SERVICE)).toBe("Student");
    expect(ioioRoleLabel(OrganizationRoles.ADMIN)).toBe("Staff");
  });

  it("grants and revokes Student borrowing access through target services", async () => {
    for (const [intent, extra] of [
      ["grant-borrowing-access", { studentUserId: "student-1" }],
      ["revoke-borrowing-access", { approvalId: "approval-1" }],
    ] as const) {
      await action(
        createActionArgs({
          context,
          request: new Request("http://localhost/settings/team/users", {
            method: "POST",
            body: new URLSearchParams({ intent, ...extra }),
          }),
        })
      );
    }
    expect(mocks.grantAccess).toHaveBeenCalledWith({
      organizationId: "team-1",
      staffUserId: "owner-1",
      studentUserId: "student-1",
    });
    expect(mocks.revokeAccess).toHaveBeenCalledWith({
      organizationId: "team-1",
      staffUserId: "owner-1",
      requestId: "approval-1",
    });
  });

  it("blocks a non-staff member from invoking user administration actions", async () => {
    mocks.requireIoioStaffAccess.mockRejectedValue(
      new ShelfError({
        cause: null,
        message: "Staff only",
        label: "Permission",
        status: 403,
        shouldBeCaptured: false,
      })
    );
    const result = await action(
      createActionArgs({
        context,
        request: new Request("http://localhost/settings/team/users", {
          method: "POST",
          body: new URLSearchParams({ intent: "grant-borrowing-access" }),
        }),
      })
    );
    expect(result).toMatchObject({
      data: { error: { message: "Staff only" } },
    });
    expect(mocks.grantAccess).not.toHaveBeenCalled();
  });
});
