// @vitest-environment node

/**
 * Code confirmation: a new account records the signup link's intent on its
 * signup event. IOIO profiles resolve directly to their Team surface, while
 * incomplete legacy Shelf signups continue through onboarding. A login ignores
 * the signup intent.
 *
 * @see {@link file://./../../../app/routes/_auth+/otp.tsx}
 * @see {@link file://./../../../app/modules/signup-intent/cookie.server.ts}
 */
import type { ActionFunctionArgs } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { USER_EMAIL, USER_ID, ORGANIZATION_ID } from "@mocks/user";

import { verifyOtpAndSignin } from "~/modules/auth/service.server";
import { ensureInitialIoioTeamForUser } from "~/modules/ioio/initial-team.server";
import {
  getSelectedOrganization,
  setSelectedOrganizationIdCookie,
} from "~/modules/organization/context.server";
import {
  readSignupIntent,
  serializeSignupIntent,
} from "~/modules/signup-intent/cookie.server";
import { createUser, findUserById } from "~/modules/user/service.server";
import { generateUniqueUsername } from "~/modules/user/utils.server";
import { action } from "~/routes/_auth+/otp";

// why: code verification is a Supabase call; the tests assert on the
// redirect and the cookies it carries.
vi.mock("~/modules/auth/service.server", () => ({
  verifyOtpAndSignin: vi.fn(),
}));
// why: the new-user branch creates a database row; the tests only check that
// it is reached, not what it writes.
vi.mock("~/modules/user/service.server", () => ({
  createUser: vi.fn(),
  findUserById: vi.fn(),
}));
// why: username generation queries the database for collisions
vi.mock("~/modules/user/utils.server", () => ({
  generateUniqueUsername: vi.fn(),
}));
// why: initialization policy and its transaction lock are tested in the
// helper suite; these tests verify the OTP auth boundary invokes the helper.
vi.mock("~/modules/ioio/initial-team.server", () => ({
  ensureInitialIoioTeamForUser: vi.fn(),
}));
// why: the workspace cookie is a fixed string here so the intent cookie can
// be told apart from it in the response headers
vi.mock("~/modules/organization/context.server", () => ({
  getSelectedOrganization: vi.fn(),
  setSelectedOrganizationIdCookie: vi.fn(),
}));
// why: importing the otp route transitively loads ~/database/db.server, whose
// module-level connect rejects in a DB-less test env.
vi.mock("~/database/db.server", () => ({ db: {} }));

function confirmArgs(cookie?: string, mode?: string) {
  const headers = new Headers({
    "Content-Type": "application/x-www-form-urlencoded",
  });
  if (cookie) {
    headers.set("Cookie", cookie);
  }
  return {
    request: new Request(
      mode
        ? `http://localhost:3000/otp?mode=${mode}`
        : "http://localhost:3000/otp",
      {
        method: "POST",
        headers,
        body: new URLSearchParams({ email: USER_EMAIL, otp: "123456" }),
      }
    ),
    context: { isAuthenticated: false, setSession: vi.fn() },
    params: {},
  } as unknown as ActionFunctionArgs;
}

async function intentCookie(
  intent: Parameters<typeof serializeSignupIntent>[0]
) {
  return (await serializeSignupIntent(intent)).split(";")[0];
}

async function signupIntentSetBy(response: Response) {
  const setCookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith("signup-intent="));
  if (!setCookie) {
    return null;
  }
  return readSignupIntent(
    new Request("http://localhost:3000/onboarding", {
      headers: { Cookie: setCookie.split(";")[0] },
    })
  );
}

describe("otp action — confirming the code", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(verifyOtpAndSignin).mockResolvedValue({
      userId: USER_ID,
      email: USER_EMAIL,
    } as never);
    vi.mocked(findUserById).mockResolvedValue(null);
    vi.mocked(generateUniqueUsername).mockResolvedValue("new-person");
    vi.mocked(createUser).mockResolvedValue({ id: USER_ID } as never);
    vi.mocked(ensureInitialIoioTeamForUser).mockResolvedValue(null);
    vi.mocked(getSelectedOrganization).mockResolvedValue({
      organizationId: ORGANIZATION_ID,
    } as never);
    vi.mocked(setSelectedOrganizationIdCookie).mockResolvedValue(
      "selected-organization-id=org"
    );
  });

  it("lands on the assets page and sets only the workspace cookie without an intent", async () => {
    const response = (await action(confirmArgs())) as Response;

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/assets");
    expect(response.headers.getSetCookie()).toEqual([
      "selected-organization-id=org",
    ]);
    expect(createUser).toHaveBeenCalledWith(
      expect.objectContaining({
        signupIntent: null,
        bootstrapIoioTeamOnFreshSignup: true,
      })
    );
    expect(ensureInitialIoioTeamForUser).toHaveBeenCalledWith({
      userId: USER_ID,
    });
  });

  it("verifies an IOIO signup, creates the Student profile, and selects the Team", async () => {
    vi.mocked(verifyOtpAndSignin).mockResolvedValue({
      userId: USER_ID,
      email: USER_EMAIL,
      signupProfile: { firstName: "Jane", lastName: "Student" },
    } as never);
    vi.mocked(getSelectedOrganization).mockResolvedValue({
      organizationId: "personal-1",
      currentOrganization: { type: "PERSONAL" },
      userOrganizations: [
        {
          organizationId: "personal-1",
          roles: ["OWNER"],
          organization: { type: "PERSONAL" },
          user: { lastSelectedOrganizationId: "ioio-team-1" },
        },
        {
          organizationId: "ioio-team-1",
          roles: ["SELF_SERVICE"],
          organization: { type: "TEAM" },
        },
      ],
    } as never);
    vi.mocked(setSelectedOrganizationIdCookie).mockResolvedValue(
      "selected-organization-id=ioio-team-1"
    );

    const response = (await action(confirmArgs())) as Response;

    expect(response.headers.get("Location")).toBe("/ioio");
    expect(createUser).toHaveBeenCalledWith(
      expect.objectContaining({
        firstName: "Jane",
        lastName: "Student",
        ioioSignup: true,
      })
    );
    expect(setSelectedOrganizationIdCookie).toHaveBeenCalledWith("ioio-team-1");
  });

  it("hands the intent on to onboarding with a fresh window", async () => {
    const intent = { plan: "team" as const, trial: true, utmSource: "website" };

    const response = (await action(
      confirmArgs(await intentCookie(intent))
    )) as Response;

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/assets");
    expect(response.headers.getSetCookie()[0]).toBe(
      "selected-organization-id=org"
    );
    await expect(signupIntentSetBy(response)).resolves.toEqual(intent);
    // The new account records the intent on its signup event.
    expect(createUser).toHaveBeenCalledTimes(1);
    expect(createUser).toHaveBeenCalledWith(
      expect.objectContaining({ signupIntent: intent })
    );
  });

  it("sends an onboarded account to the link's in-app redirectTo", async () => {
    vi.mocked(findUserById).mockResolvedValue({
      id: USER_ID,
      onboarded: true,
    } as never);

    const response = (await action(
      confirmArgs(await intentCookie({ redirectTo: "/qr/abc?x=1" }))
    )) as Response;

    expect(response.headers.get("Location")).toBe("/qr/abc?x=1");
    expect(createUser).not.toHaveBeenCalled();
  });

  it("sends a new account to /assets, and so to onboarding, whatever the redirectTo", async () => {
    const response = (await action(
      confirmArgs(await intentCookie({ redirectTo: "/qr/abc" }))
    )) as Response;

    expect(response.headers.get("Location")).toBe("/assets");
    expect(createUser).toHaveBeenCalledTimes(1);
    // The intent still travels on for onboarding to consume.
    await expect(signupIntentSetBy(response)).resolves.toEqual({
      redirectTo: "/qr/abc",
    });
  });

  it("sends an account that has not onboarded to /assets, whatever the redirectTo", async () => {
    vi.mocked(findUserById).mockResolvedValue({
      id: USER_ID,
      onboarded: false,
    } as never);

    const response = (await action(
      confirmArgs(await intentCookie({ redirectTo: "/qr/abc" }))
    )) as Response;

    expect(response.headers.get("Location")).toBe("/assets");
    expect(createUser).not.toHaveBeenCalled();
  });

  it("ignores a leftover intent when the code is for a login", async () => {
    vi.mocked(findUserById).mockResolvedValue({
      id: USER_ID,
      onboarded: true,
    } as never);
    vi.mocked(getSelectedOrganization).mockResolvedValue({
      organizationId: ORGANIZATION_ID,
      currentOrganization: { type: "TEAM" },
      userOrganizations: [
        {
          organizationId: ORGANIZATION_ID,
          roles: ["SELF_SERVICE"],
          organization: { type: "TEAM" },
        },
      ],
    } as never);
    vi.mocked(setSelectedOrganizationIdCookie).mockResolvedValue(
      `selected-organization-id=${ORGANIZATION_ID}`
    );

    const response = (await action(
      confirmArgs(
        await intentCookie({ plan: "team", redirectTo: "/qr/abc" }),
        "login"
      )
    )) as Response;

    expect(response.headers.get("Location")).toBe("/ioio");
    expect(response.headers.getSetCookie()).toEqual([
      `selected-organization-id=${ORGANIZATION_ID}`,
    ]);
    expect(ensureInitialIoioTeamForUser).toHaveBeenCalledWith({
      userId: USER_ID,
    });
  });

  it("recovers a sole existing OTP user, selects the Team, and lands in Staff Desk", async () => {
    vi.mocked(findUserById).mockResolvedValue({
      id: USER_ID,
      onboarded: true,
    } as never);
    vi.mocked(ensureInitialIoioTeamForUser).mockResolvedValue({
      id: "ioio-team-1",
    } as never);
    vi.mocked(getSelectedOrganization).mockResolvedValue({
      organizationId: "personal-1",
      currentOrganization: { type: "PERSONAL" },
      userOrganizations: [
        {
          organizationId: "personal-1",
          roles: ["OWNER"],
          organization: { type: "PERSONAL" },
          user: { lastSelectedOrganizationId: "ioio-team-1" },
        },
        {
          organizationId: "ioio-team-1",
          roles: ["OWNER"],
          organization: { type: "TEAM" },
        },
      ],
    } as never);
    vi.mocked(setSelectedOrganizationIdCookie).mockResolvedValue(
      "selected-organization-id=ioio-team-1"
    );

    const response = (await action(
      confirmArgs(undefined, "login")
    )) as Response;

    expect(response.headers.get("Location")).toBe("/home");
    expect(setSelectedOrganizationIdCookie).toHaveBeenCalledWith("ioio-team-1");
    expect(response.headers.getSetCookie()).toContain(
      "selected-organization-id=ioio-team-1"
    );
  });

  it("keeps an OTP login with no Team membership blocked", async () => {
    vi.mocked(findUserById).mockResolvedValue({
      id: USER_ID,
      onboarded: true,
    } as never);
    vi.mocked(getSelectedOrganization).mockResolvedValue({
      organizationId: "personal-1",
      currentOrganization: { type: "PERSONAL" },
      userOrganizations: [
        {
          organizationId: "personal-1",
          roles: ["OWNER"],
          organization: { type: "PERSONAL" },
        },
      ],
    } as never);

    const response = (await action(
      confirmArgs(undefined, "login")
    )) as Response;

    expect((response as unknown as { init?: ResponseInit }).init?.status).toBe(
      403
    );
    expect(
      (response as unknown as { data?: { error?: { title?: string } } }).data
        ?.error?.title
    ).toBe("IOIO Team organization required");
    expect(setSelectedOrganizationIdCookie).not.toHaveBeenCalled();
  });

  it("never follows a redirectTo off our origin", async () => {
    // Onboarded, so the only thing keeping it on /assets is safeRedirect.
    vi.mocked(findUserById).mockResolvedValue({
      id: USER_ID,
      onboarded: true,
    } as never);

    const response = (await action(
      confirmArgs(await intentCookie({ redirectTo: "https://evil.example/x" }))
    )) as Response;

    expect(response.headers.get("Location")).toBe("/assets");
  });
});
