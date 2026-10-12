// @vitest-environment node

import { OrganizationRoles } from "@prisma/client";
import type { LoaderFunctionArgs } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { requirePermission } from "~/utils/roles.server";
import { requireStudentRead } from "./route.server";

// why: permission resolution depends on the authenticated organization
// membership; these cases exercise the Student-only boundary independently.
vi.mock("~/utils/roles.server", () => ({
  requirePermission: vi.fn(),
}));

// why: this test checks the existing selected-organization cookie is attached
// to the resolver redirect without depending on environment secret setup.
vi.mock("~/modules/organization/context.server", () => ({
  setSelectedOrganizationIdCookie: vi.fn((organizationId: string) =>
    Promise.resolve(`selected-organization-id=${organizationId}`)
  ),
}));

function args(method = "GET"): Pick<LoaderFunctionArgs, "context" | "request"> {
  return {
    context: { getSession: () => ({ userId: "student-1" }) },
    request: new Request("http://localhost:3000/ioio", { method }),
  } as unknown as Pick<LoaderFunctionArgs, "context" | "request">;
}

describe("IOIO Student route authorization", () => {
  beforeEach(() => vi.clearAllMocks());

  it("allows a SELF_SERVICE member to read the Student surface", async () => {
    vi.mocked(requirePermission).mockResolvedValue({
      organizationId: "org-1",
      currentOrganization: { id: "org-1", type: "TEAM" },
      userOrganizations: [
        {
          organizationId: "org-1",
          organization: { id: "org-1", type: "TEAM" },
          roles: [OrganizationRoles.SELF_SERVICE],
        },
      ],
      role: OrganizationRoles.SELF_SERVICE,
    } as never);

    await expect(requireStudentRead(args())).resolves.toMatchObject({
      userId: "student-1",
      organizationId: "org-1",
      role: OrganizationRoles.SELF_SERVICE,
    });
  });

  it.each([OrganizationRoles.OWNER, OrganizationRoles.ADMIN])(
    "denies %s from using Student routes directly",
    async (role) => {
      vi.mocked(requirePermission).mockResolvedValue({
        organizationId: "org-1",
        currentOrganization: { id: "org-1", type: "TEAM" },
        userOrganizations: [
          {
            organizationId: "org-1",
            organization: { id: "org-1", type: "TEAM" },
            roles: [role],
          },
        ],
        role,
      } as never);

      await expect(requireStudentRead(args())).rejects.toMatchObject({
        status: 403,
        title: "Student access required",
      });
    }
  );

  it("rejects Student writes while PERSONAL is selected", async () => {
    vi.mocked(requirePermission).mockResolvedValue({
      organizationId: "personal-1",
      currentOrganization: { id: "personal-1", type: "PERSONAL" },
      userOrganizations: [
        {
          organizationId: "personal-1",
          organization: { id: "personal-1", type: "PERSONAL" },
          roles: [OrganizationRoles.SELF_SERVICE],
        },
      ],
      role: OrganizationRoles.SELF_SERVICE,
    } as never);

    await expect(requireStudentRead(args("POST"))).rejects.toMatchObject({
      status: 403,
      title: "IOIO Team organization required",
    });
  });

  it("allows Student writes in the selected TEAM organization", async () => {
    vi.mocked(requirePermission).mockResolvedValue({
      organizationId: "org-1",
      currentOrganization: { id: "org-1", type: "TEAM" },
      userOrganizations: [
        {
          organizationId: "org-1",
          organization: { id: "org-1", type: "TEAM" },
          roles: [OrganizationRoles.SELF_SERVICE],
        },
      ],
      role: OrganizationRoles.SELF_SERVICE,
    } as never);

    await expect(requireStudentRead(args("POST"))).resolves.toMatchObject({
      organizationId: "org-1",
      role: OrganizationRoles.SELF_SERVICE,
    });
  });

  it("redirects a Personal Student selection to the resolved TEAM organization", async () => {
    vi.mocked(requirePermission).mockResolvedValue({
      organizationId: "personal-1",
      currentOrganization: { id: "personal-1", type: "PERSONAL" },
      userOrganizations: [
        {
          organizationId: "personal-1",
          organization: { id: "personal-1", type: "PERSONAL" },
          roles: [OrganizationRoles.OWNER],
          user: { lastSelectedOrganizationId: "team-1" },
        },
        {
          organizationId: "team-1",
          organization: { id: "team-1", type: "TEAM" },
          roles: [OrganizationRoles.SELF_SERVICE],
        },
      ],
      role: OrganizationRoles.OWNER,
    } as never);

    try {
      await requireStudentRead(args());
      throw new Error("Expected a redirect to the resolved Team workspace.");
    } catch (cause) {
      expect(cause).toBeInstanceOf(Response);
      const response = cause as Response;
      expect(response.headers.get("Location")).toBe("/ioio");
      expect(response.headers.getSetCookie()[0]).toContain(
        "selected-organization-id=team-1"
      );
    }
  });
});
