import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSelectedOrganization: vi.fn(),
  validatePermission: vi.fn(),
  setUser: vi.fn(),
  setTag: vi.fn(),
}));

// why: permission resolution is stubbed so this test isolates the IOIO
// organization assertion that runs after the existing permission succeeds.
vi.mock("~/modules/organization/context.server", () => ({
  getSelectedOrganization: mocks.getSelectedOrganization,
}));

// why: validation itself is outside this regression; both fixture roles are
// accepted so the test can focus on organization selection.
vi.mock("./permissions/permission.validator.server", () => ({
  validatePermission: mocks.validatePermission,
}));

// why: Sentry scope decoration is unrelated to selected organization safety.
vi.mock("@sentry/react-router", () => ({
  setUser: mocks.setUser,
  setTag: mocks.setTag,
}));

// why: roles.server imports the shared DB client, whose module connects on
// import in development; this permission-only test does not use the database.
vi.mock("~/database/db.server", () => ({ db: {} }));

import {
  PermissionAction,
  PermissionEntity,
} from "./permissions/permission.data";
import { requirePermission } from "./roles.server";

function organization(type: "PERSONAL" | "TEAM") {
  const id = type === "PERSONAL" ? "personal-1" : "team-1";
  return {
    organizationId: id,
    organizations: [{ id, type }],
    currentOrganization: {
      id,
      type,
      selfServiceCanSeeCustody: false,
      baseUserCanSeeCustody: false,
      barcodesEnabled: false,
      auditsEnabled: false,
    },
    userOrganizations: [
      {
        organizationId: id,
        organization: { id, type },
        roles: [type === "PERSONAL" ? "OWNER" : "ADMIN"],
      },
    ],
  };
}

function request(pathname: string, method = "POST") {
  return new Request(`http://localhost${pathname}`, { method });
}

describe("Shelf permission IOIO write organization guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.validatePermission.mockResolvedValue(undefined);
  });

  const permissionArgs = (requestValue: Request) => ({
    userId: "user-1",
    request: requestValue,
    entity: PermissionEntity.workingHours,
    action: PermissionAction.update,
  });

  it("rejects IOIO staff writes when PERSONAL is selected", async () => {
    mocks.getSelectedOrganization.mockResolvedValue(organization("PERSONAL"));

    await expect(
      requirePermission(permissionArgs(request("/settings/bookings")))
    ).rejects.toMatchObject({
      status: 403,
      title: "IOIO Team organization required",
    });
  });

  it("allows IOIO writes in the selected TEAM organization", async () => {
    mocks.getSelectedOrganization.mockResolvedValue(organization("TEAM"));

    await expect(
      requirePermission(permissionArgs(request("/settings/bookings")))
    ).resolves.toMatchObject({ organizationId: "team-1" });
  });

  it("keeps PERSONAL writes on ordinary Shelf routes unchanged", async () => {
    mocks.getSelectedOrganization.mockResolvedValue(organization("PERSONAL"));

    await expect(
      requirePermission(
        permissionArgs(request("/account-details/subscription"))
      )
    ).resolves.toMatchObject({ organizationId: "personal-1" });
  });
});
