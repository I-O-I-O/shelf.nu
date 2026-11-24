// @vitest-environment node

import type { ActionFunctionArgs } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockEndSessionByRefreshToken } = vi.hoisted(() => ({
  mockEndSessionByRefreshToken: vi.fn(),
}));
// why: the route test verifies its logout orchestration; Supabase revocation is
// tested at the auth-service boundary without a network call.
vi.mock("~/modules/auth/service.server", () => ({
  endSessionByRefreshToken: mockEndSessionByRefreshToken,
}));

import { action } from "~/routes/_auth+/logout";

function logout(
  redirectTo?: string,
  auth?: { accessToken: string; refreshToken: string; userId: string }
) {
  const destroySession = vi.fn();
  const body = new URLSearchParams();
  if (redirectTo !== undefined) body.set("redirectTo", redirectTo);
  return {
    destroySession,
    args: {
      request: new Request("https://app.shelf.nu/logout", {
        method: "POST",
        body,
      }),
      context: {
        destroySession,
        isAuthenticated: Boolean(auth),
        getSession: () => auth,
      },
      params: {},
    } as unknown as ActionFunctionArgs,
  };
}

describe("logout action redirect", () => {
  beforeEach(() => vi.clearAllMocks());

  it("revokes the active browser session before clearing the cookie", async () => {
    const auth = {
      accessToken: "access-token",
      refreshToken: "refresh-token",
      userId: "user-1",
    };
    const { args, destroySession } = logout("/login?done=1", auth);
    const response = (await action(args)) as Response;

    expect(mockEndSessionByRefreshToken).toHaveBeenCalledWith("refresh-token");
    expect(destroySession).toHaveBeenCalledOnce();
    expect(response.headers.get("Location")).toBe("/login?done=1");
  });

  it("keeps safe relative paths and destroys the session", async () => {
    const { args, destroySession } = logout("/login?done=1");
    const response = (await action(args)) as Response;

    expect(response.headers.get("Location")).toBe("/login?done=1");
    expect(destroySession).toHaveBeenCalledOnce();
    expect(mockEndSessionByRefreshToken).not.toHaveBeenCalled();
  });

  it.each([
    "https://attacker.invalid/",
    "//attacker.invalid/",
    "javascript:alert(1)",
    "/\\attacker.invalid",
  ])("falls back for unsafe destination %s", async (redirectTo) => {
    const { args } = logout(redirectTo);
    const response = (await action(args)) as Response;
    expect(response.headers.get("Location")).toBe("/login");
  });

  it("uses the safe default when the destination is missing or malformed", async () => {
    for (const redirectTo of [undefined, "not-a-path"]) {
      const { args } = logout(redirectTo);
      const response = (await action(args)) as Response;
      expect(response.headers.get("Location")).toBe("/login");
    }
  });

  it("keeps logout POST-only", async () => {
    const { args } = logout();
    args.request = new Request("https://app.shelf.nu/logout", {
      method: "GET",
    });
    await expect(action(args)).rejects.toMatchObject({ status: 405 });
  });
});
