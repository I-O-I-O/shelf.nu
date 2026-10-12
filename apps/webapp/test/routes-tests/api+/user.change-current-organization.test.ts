// @vitest-environment node
import type { ActionFunctionArgs } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "~/database/db.server";
import { setSelectedOrganizationIdCookie } from "~/modules/organization/context.server";
import { action } from "~/routes/api+/user.change-current-organization";
import { setCookie } from "~/utils/cookies.server";

// why: this route's membership query and cross-device persistence write are
// the authorization boundary under test; keep it isolated from PostgreSQL.
vi.mock("~/database/db.server", () => ({
  db: {
    userOrganization: { findUnique: vi.fn() },
    $executeRaw: vi.fn(),
  },
}));

// why: assert that only an authorized selection reaches the existing signed
// selected-organization cookie flow without depending on session secrets.
vi.mock("~/modules/organization/context.server", () => ({
  setSelectedOrganizationIdCookie: vi.fn(),
}));

// why: keep the response header deterministic while asserting the existing
// cookie value is attached to the redirect.
vi.mock("~/utils/cookies.server", () => ({
  setCookie: vi.fn((cookie: string) => ["Set-Cookie", cookie]),
}));

const dbMock = vi.mocked(db) as unknown as {
  userOrganization: { findUnique: ReturnType<typeof vi.fn> };
  $executeRaw: ReturnType<typeof vi.fn>;
};

function run(formValues: Record<string, string>) {
  const formData = new FormData();
  for (const [key, value] of Object.entries(formValues)) {
    formData.set(key, value);
  }

  return action({
    request: new Request(
      "https://app.shelf.nu/api/user/change-current-organization",
      {
        method: "POST",
        body: formData,
      }
    ),
    params: {},
    context: { getSession: () => ({ userId: "staff-user-id" }) },
  } as unknown as ActionFunctionArgs);
}

describe("user.change-current-organization action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(setSelectedOrganizationIdCookie).mockResolvedValue(
      "selected-organization-id=ioio-lab-dev-id"
    );
    dbMock.$executeRaw.mockResolvedValue(1);
  });

  it("selects a workspace the signed-in user belongs to and redirects with Shelf's cookie", async () => {
    dbMock.userOrganization.findUnique.mockResolvedValue({
      id: "membership-id",
      user: { sso: false },
      organization: { type: "TEAM" },
    });

    const response = (await run({
      organizationId: "ioio-lab-dev-id",
    })) as Response;

    expect(dbMock.userOrganization.findUnique).toHaveBeenCalledWith({
      where: {
        userId_organizationId: {
          userId: "staff-user-id",
          organizationId: "ioio-lab-dev-id",
        },
      },
      select: {
        id: true,
        user: { select: { sso: true } },
        organization: { select: { type: true } },
      },
    });
    expect(setSelectedOrganizationIdCookie).toHaveBeenCalledWith(
      "ioio-lab-dev-id"
    );
    expect(setCookie).toHaveBeenCalledWith(
      "selected-organization-id=ioio-lab-dev-id"
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/");
    expect(response.headers.get("Set-Cookie")).toContain(
      "selected-organization-id=ioio-lab-dev-id"
    );
  });

  it("rejects a workspace the user is not a member of", async () => {
    dbMock.userOrganization.findUnique.mockResolvedValue(null);

    const response = (await run({
      organizationId: "unauthorized-org-id",
    })) as { init?: { status?: number } };

    expect(response.init?.status).toBe(403);
    expect(setSelectedOrganizationIdCookie).not.toHaveBeenCalled();
    expect(dbMock.$executeRaw).not.toHaveBeenCalled();
  });

  it("rejects personal workspaces for SSO users", async () => {
    dbMock.userOrganization.findUnique.mockResolvedValue({
      id: "membership-id",
      user: { sso: true },
      organization: { type: "PERSONAL" },
    });

    const response = (await run({
      organizationId: "personal-workspace-id",
    })) as { init?: { status?: number } };

    expect(response.init?.status).toBe(403);
    expect(setSelectedOrganizationIdCookie).not.toHaveBeenCalled();
    expect(dbMock.$executeRaw).not.toHaveBeenCalled();
  });
});
