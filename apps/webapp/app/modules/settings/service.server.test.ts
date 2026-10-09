import { OrganizationRoles } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  count: vi.fn(),
  updateCookieWithPerPage: vi.fn(),
}));

// why: this unit test verifies Prisma query scoping without requiring a database or cookie state.
vi.mock("~/database/db.server", () => ({
  db: { userOrganization: { findMany: mocks.findMany, count: mocks.count } },
}));
vi.mock("~/utils/cookies.server", () => ({
  updateCookieWithPerPage: mocks.updateCookieWithPerPage,
}));

import { getPaginatedAndFilterableSettingUsers } from "./service.server";

describe("IOIO Users account-type filter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findMany.mockResolvedValue([]);
    mocks.count.mockResolvedValue(0);
    mocks.updateCookieWithPerPage.mockResolvedValue({ perPage: 20 });
  });

  it("scopes Students to SELF_SERVICE memberships", async () => {
    await getPaginatedAndFilterableSettingUsers({
      organizationId: "team-1",
      request: new Request("http://localhost/settings/team/users?role=student"),
    });
    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: "team-1",
          roles: { has: OrganizationRoles.SELF_SERVICE },
        },
      })
    );
  });

  it("scopes Staff to BASE, ADMIN, and OWNER memberships", async () => {
    await getPaginatedAndFilterableSettingUsers({
      organizationId: "team-1",
      request: new Request("http://localhost/settings/team/users?role=staff"),
    });
    expect(mocks.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: "team-1",
          roles: {
            hasSome: [
              OrganizationRoles.ADMIN,
              OrganizationRoles.OWNER,
              OrganizationRoles.BASE,
            ],
          },
        },
      })
    );
  });

  it("returns both Staff and Students in the organization-wide directory", async () => {
    mocks.findMany.mockResolvedValue([
      {
        roles: [OrganizationRoles.OWNER],
        user: {
          id: "staff-1",
          firstName: "IOIO",
          lastName: "Staff",
          displayName: null,
          profilePicture: null,
          email: "staff@example.test",
          sso: false,
          teamMembers: [],
        },
      },
      {
        roles: [OrganizationRoles.SELF_SERVICE],
        user: {
          id: "student-1",
          firstName: "IOIO",
          lastName: "Student",
          displayName: null,
          profilePicture: null,
          email: "student@example.test",
          sso: false,
          teamMembers: [],
        },
      },
    ]);
    mocks.count.mockResolvedValue(2);

    const result = await getPaginatedAndFilterableSettingUsers({
      organizationId: "team-1",
      request: new Request("http://localhost/settings/team/users"),
    });

    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: "team-1" } })
    );
    expect(
      result.items.map(({ email, roleEnum }) => [email, roleEnum])
    ).toEqual([
      ["staff@example.test", OrganizationRoles.OWNER],
      ["student@example.test", OrganizationRoles.SELF_SERVICE],
    ]);
  });
});
