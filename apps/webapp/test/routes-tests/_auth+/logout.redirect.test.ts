// @vitest-environment node

import type { ActionFunctionArgs } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { action } from "~/routes/_auth+/logout";

function logout(redirectTo?: string) {
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
      context: { destroySession },
      params: {},
    } as unknown as ActionFunctionArgs,
  };
}

describe("logout action redirect", () => {
  it("keeps safe relative paths and destroys the session", async () => {
    const { args, destroySession } = logout("/login?done=1");
    const response = (await action(args)) as Response;

    expect(response.headers.get("Location")).toBe("/login?done=1");
    expect(destroySession).toHaveBeenCalledOnce();
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
});
