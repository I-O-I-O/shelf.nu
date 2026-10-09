// @vitest-environment node
import { OrganizationRoles } from "@prisma/client";
import type { ActionFunctionArgs } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { signInWithEmail } from "~/modules/auth/service.server";
import {
  getSelectedOrganization,
  setSelectedOrganizationIdCookie,
} from "~/modules/organization/context.server";
import { action } from "~/routes/_auth+/login";

// why: sign-in is an external authentication boundary; the tests focus on the
// route's role-aware destination after the modern session has been verified.
vi.mock("~/modules/auth/service.server", () => ({
  INVALID_CREDENTIALS_MESSAGE: "Invalid email or password",
  signInWithEmail: vi.fn(),
}));

// why: organization membership and selected-workspace cookies are supplied by
// the modern organization service and are varied per account in these tests.
vi.mock("~/modules/organization/context.server", () => ({
  getSelectedOrganization: vi.fn(),
  setSelectedOrganizationIdCookie: vi.fn(),
}));

// why: importing the route otherwise initializes Prisma in this route-only
// test; all database access is represented by the organization mock above.
vi.mock("~/database/db.server", () => ({
  db: { user: { findMany: vi.fn() } },
}));

function loginArgs(redirectTo: string) {
  return {
    request: new Request("http://localhost:3000/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        email: "student@example.edu",
        password: "correct-password",
        redirectTo,
      }),
    }),
    context: { isAuthenticated: false, setSession: vi.fn() },
    params: {},
  } as unknown as ActionFunctionArgs;
}

async function loginForRole(role: OrganizationRoles, redirectTo: string) {
  vi.mocked(signInWithEmail).mockResolvedValue({
    userId: "user-1",
    email: "student@example.edu",
  } as never);
  vi.mocked(getSelectedOrganization).mockResolvedValue({
    organizationId: "org-1",
    currentOrganization: { type: "TEAM" },
    userOrganizations: [
      {
        organizationId: "org-1",
        roles: [role],
        organization: { type: "TEAM" },
      },
    ],
  } as never);
  vi.mocked(setSelectedOrganizationIdCookie).mockResolvedValue(
    "selected-organization-id=org-1"
  );

  return (await action(loginArgs(redirectTo))) as Response;
}

describe("login redirects to the authenticated IOIO surface", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lands a Student in IOIO instead of the staff Inventory route", async () => {
    const response = await loginForRole(
      OrganizationRoles.SELF_SERVICE,
      "/assets"
    );

    expect(response.headers.get("Location")).toBe("/ioio");
    expect(response.headers.getSetCookie()).toContain(
      "selected-organization-id=org-1"
    );
  });

  it("preserves a Student deep link inside the Student surface", async () => {
    const response = await loginForRole(
      OrganizationRoles.SELF_SERVICE,
      "/ioio/loans"
    );

    expect(response.headers.get("Location")).toBe("/ioio/loans");
  });

  it("selects the sole Student Team membership when Shelf defaulted to Personal", async () => {
    vi.mocked(signInWithEmail).mockResolvedValue({
      userId: "user-1",
      email: "student@example.edu",
    } as never);
    vi.mocked(getSelectedOrganization).mockResolvedValue({
      organizationId: "personal-1",
      currentOrganization: { type: "PERSONAL" },
      userOrganizations: [
        {
          organizationId: "personal-1",
          roles: [OrganizationRoles.OWNER],
          organization: { type: "PERSONAL" },
        },
        {
          organizationId: "ioio-team-1",
          roles: [OrganizationRoles.SELF_SERVICE],
          organization: { type: "TEAM" },
        },
      ],
    } as never);
    vi.mocked(setSelectedOrganizationIdCookie).mockResolvedValue(
      "selected-organization-id=ioio-team-1"
    );

    const response = (await action(loginArgs("/assets"))) as Response;

    expect(response.headers.get("Location")).toBe("/ioio");
    expect(setSelectedOrganizationIdCookie).toHaveBeenCalledWith("ioio-team-1");
  });

  it("keeps staff out of Student routes after login", async () => {
    const response = await loginForRole(OrganizationRoles.OWNER, "/ioio/loans");

    expect(response.headers.get("Location")).toBe("/home");
  });
});
