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

function args(): Pick<LoaderFunctionArgs, "context" | "request"> {
  return {
    context: { getSession: () => ({ userId: "student-1" }) },
    request: new Request("http://localhost:3000/ioio"),
  } as unknown as Pick<LoaderFunctionArgs, "context" | "request">;
}

describe("IOIO Student route authorization", () => {
  beforeEach(() => vi.clearAllMocks());

  it("allows a SELF_SERVICE member to read the Student surface", async () => {
    vi.mocked(requirePermission).mockResolvedValue({
      organizationId: "org-1",
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
        role,
      } as never);

      await expect(requireStudentRead(args())).rejects.toMatchObject({
        status: 403,
        title: "Student access required",
      });
    }
  );
});
