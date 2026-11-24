// @vitest-environment node

import type { LoaderFunctionArgs } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requirePermission: vi.fn() }));

// why: the staff gate's Shelf permission result is varied without a database
// connection so the Team organization write guard can be exercised directly.
vi.mock("~/utils/roles.server", () => ({
  requirePermission: mocks.requirePermission,
}));

// why: this test checks that the redirect selects the resolved workspace;
// cookie serialization is represented by its Shelf cookie name and value.
vi.mock("~/modules/organization/context.server", () => ({
  setSelectedOrganizationIdCookie: vi.fn((organizationId: string) =>
    Promise.resolve(`selected-organization-id=${organizationId}`)
  ),
}));

import { requireIoioStaffAccess } from "./access.server";

function args(
  method = "POST"
): Pick<LoaderFunctionArgs, "context" | "request"> {
  return {
    context: { getSession: () => ({ userId: "staff-1" }) },
    request: new Request("http://localhost/handbook/new", { method }),
  } as unknown as Pick<LoaderFunctionArgs, "context" | "request">;
}

describe("IOIO staff write organization guard", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects staff writes when Shelf has selected a PERSONAL workspace", async () => {
    mocks.requirePermission.mockResolvedValue({
      organizationId: "personal-1",
      currentOrganization: { id: "personal-1", type: "PERSONAL" },
      userOrganizations: [
        {
          organizationId: "personal-1",
          organization: { id: "personal-1", type: "PERSONAL" },
          roles: ["OWNER"],
        },
      ],
      role: "OWNER",
    });

    await expect(requireIoioStaffAccess(args())).rejects.toMatchObject({
      status: 403,
      title: "IOIO Team organization required",
    });
  });

  it("allows staff writes in the selected authorized TEAM organization", async () => {
    mocks.requirePermission.mockResolvedValue({
      organizationId: "team-1",
      currentOrganization: { id: "team-1", type: "TEAM" },
      userOrganizations: [
        {
          organizationId: "team-1",
          organization: { id: "team-1", type: "TEAM" },
          roles: ["ADMIN"],
        },
      ],
      role: "ADMIN",
    });

    await expect(requireIoioStaffAccess(args())).resolves.toMatchObject({
      organizationId: "team-1",
      role: "ADMIN",
    });
  });

  it("redirects Personal reads to Shelf's resolved authorized TEAM selection", async () => {
    mocks.requirePermission.mockResolvedValue({
      organizationId: "personal-1",
      currentOrganization: { id: "personal-1", type: "PERSONAL" },
      userOrganizations: [
        {
          organizationId: "personal-1",
          organization: { id: "personal-1", type: "PERSONAL" },
          roles: ["OWNER"],
          user: { lastSelectedOrganizationId: "team-1" },
        },
        {
          organizationId: "team-1",
          organization: { id: "team-1", type: "TEAM" },
          roles: ["ADMIN"],
        },
      ],
      role: "OWNER",
    });

    try {
      await requireIoioStaffAccess(args("GET"));
      throw new Error("Expected a redirect to the resolved Team workspace.");
    } catch (cause) {
      expect(cause).toBeInstanceOf(Response);
      const response = cause as Response;
      expect(response.headers.get("Location")).toBe("/handbook/new");
      expect(response.headers.getSetCookie()[0]).toContain(
        "selected-organization-id=team-1"
      );
    }
  });

  it("rejects a TEAM organization the user is not a member of", async () => {
    mocks.requirePermission.mockResolvedValue({
      organizationId: "other-team",
      currentOrganization: { id: "other-team", type: "TEAM" },
      userOrganizations: [
        {
          organizationId: "team-1",
          organization: { id: "team-1", type: "TEAM" },
          roles: ["ADMIN"],
        },
      ],
      role: "ADMIN",
    });

    await expect(requireIoioStaffAccess(args())).rejects.toMatchObject({
      status: 403,
    });
  });
});
