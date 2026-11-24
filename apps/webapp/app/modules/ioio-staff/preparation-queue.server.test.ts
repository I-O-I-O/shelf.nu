import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  findMany: vi.fn(),
}));

// why: the queue resolver's authorization and organization filters are tested
// with deterministic memberships and pending-request rows.
vi.mock("~/database/db.server", () => ({
  db: {
    ioioWriteOperation: { findMany: database.findMany },
  },
}));

import { getStaffPreparationQueueOrganizationId } from "./preparation-queue.server";

const ownerTeam = {
  organization: { id: "team-1", type: "TEAM" },
  roles: ["OWNER"],
};

describe("getStaffPreparationQueueOrganizationId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    database.findMany.mockResolvedValue([]);
  });

  it("selects the sole authorized Team with pending preparation requests", async () => {
    database.findMany.mockResolvedValue([{ organizationId: "team-1" }]);

    await expect(
      getStaffPreparationQueueOrganizationId({
        organizationId: "personal-1",
        organizationType: "PERSONAL",
        userOrganizations: [ownerTeam],
      })
    ).resolves.toBe("team-1");
    expect(database.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: { in: ["team-1"] },
          operationType: "IOIO_PREPARATION",
          status: "PENDING_PREPARATION",
          source: { in: ["IOIO_PREPARATION_REQUEST", "IOIO_ASSISTANT"] },
        }),
      })
    );
  });

  it("does not query or expose a Team where Staff is not OWNER or ADMIN", async () => {
    await expect(
      getStaffPreparationQueueOrganizationId({
        organizationId: "personal-1",
        organizationType: "PERSONAL",
        userOrganizations: [
          {
            organization: { id: "team-other", type: "TEAM" },
            roles: ["SELF_SERVICE"],
          },
        ],
      })
    ).resolves.toBe("personal-1");
    expect(database.findMany).not.toHaveBeenCalled();
  });

  it("keeps Personal when requests are pending in multiple authorized Teams", async () => {
    database.findMany.mockResolvedValue([
      { organizationId: "team-1" },
      { organizationId: "team-2" },
    ]);

    await expect(
      getStaffPreparationQueueOrganizationId({
        organizationId: "personal-1",
        organizationType: "PERSONAL",
        userOrganizations: [
          ownerTeam,
          {
            organization: { id: "team-2", type: "TEAM" },
            roles: ["ADMIN"],
          },
        ],
      })
    ).resolves.toBe("personal-1");
  });
});
