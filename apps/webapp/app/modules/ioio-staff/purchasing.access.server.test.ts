import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSelectedOrganization: vi.fn(),
  findTA: vi.fn(),
}));

// why: the guard's selected Shelf membership is the authorization input under
// test; it is varied without a database connection.
vi.mock("~/modules/organization/context.server", () => ({
  getSelectedOrganization: mocks.getSelectedOrganization,
}));

// why: a TA row is supplied to prove that the separate assignment no longer
// grants access to staff-only Purchasing.
vi.mock("~/database/db.server", () => ({
  db: { ioioLabTA: { findUnique: mocks.findTA } },
}));

import { requirePurchasingAccess } from "./purchasing.server";

const request = new Request("http://localhost/purchasing");

describe("Purchasing access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSelectedOrganization.mockResolvedValue({
      organizationId: "ioio-team-1",
      userOrganizations: [
        {
          organization: { id: "ioio-team-1" },
          roles: ["SELF_SERVICE"],
        },
      ],
    });
    mocks.findTA.mockResolvedValue({ id: "ta-assignment-1" });
  });

  it("does not let a SELF_SERVICE TA read or change Purchasing", async () => {
    await expect(
      requirePurchasingAccess({ userId: "student-1", request })
    ).rejects.toMatchObject({ status: 403 });
    expect(mocks.findTA).not.toHaveBeenCalled();
  });

  it("keeps access for an OWNER membership", async () => {
    mocks.getSelectedOrganization.mockResolvedValue({
      organizationId: "ioio-team-1",
      userOrganizations: [
        { organization: { id: "ioio-team-1" }, roles: ["OWNER"] },
      ],
    });

    await expect(
      requirePurchasingAccess({ userId: "staff-1", request })
    ).resolves.toMatchObject({ organizationId: "ioio-team-1", isAdmin: true });
  });
});
