import { AuthApiError } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ShelfError } from "~/utils/error";

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  getUser: vi.fn(),
  setSession: vi.fn(),
  updateUser: vi.fn(),
  getSession: vi.fn(),
  signOut: vi.fn(),
}));

// why: the password change is an Auth network operation; these spies let the
// test verify the current Shelf identity and supplied current password are
// sent through Supabase's supported user update API.
vi.mock("~/integrations/supabase/client", () => ({
  getSupabaseAuthClient: () => ({
    auth: {
      getUser: mocks.getUser,
      setSession: mocks.setSession,
      updateUser: mocks.updateUser,
      getSession: mocks.getSession,
    },
  }),
  getSupabaseAdmin: () => ({ auth: { admin: { signOut: mocks.signOut } } }),
}));

// why: the auth database lookup only checks the existing SSO account flag;
// no password data is read from the application database.
vi.mock("~/database/db.server", () => ({
  db: { user: { findFirst: mocks.findFirst } },
}));

import { changeAccountPassword } from "./service.server";

const session = {
  accessToken: "current-access-token",
  refreshToken: "current-refresh-token",
};

function changePassword(
  overrides: Partial<Parameters<typeof changeAccountPassword>[0]> = {}
) {
  return changeAccountPassword({
    id: "user-1",
    ...session,
    currentPassword: "old-password",
    newPassword: "new-password-123",
    ...overrides,
  });
}

describe("changeAccountPassword", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFirst.mockResolvedValue({ sso: false });
    mocks.getUser.mockResolvedValue({
      data: { user: { id: "user-1", email: "student@example.com" } },
      error: null,
    });
    mocks.setSession.mockResolvedValue({
      data: {
        user: { id: "user-1", email: "student@example.com" },
        session: {
          access_token: "current-access-token",
          user: { id: "user-1", email: "student@example.com" },
        },
      },
      error: null,
    });
    mocks.updateUser.mockResolvedValue({
      data: { user: { id: "user-1" } },
      error: null,
    });
    mocks.getSession.mockResolvedValue({
      data: { session: { access_token: "updated-access-token" } },
      error: null,
    });
    mocks.signOut.mockResolvedValue({ error: null });
  });

  it("verifies and updates the password for the current signed-in user", async () => {
    await changePassword();

    expect(mocks.getUser).toHaveBeenCalledWith(session.accessToken);
    expect(mocks.setSession).toHaveBeenCalledWith({
      access_token: session.accessToken,
      refresh_token: session.refreshToken,
    });
    expect(mocks.updateUser).toHaveBeenCalledWith({
      current_password: "old-password",
      password: "new-password-123",
    });
    expect(mocks.signOut).toHaveBeenCalledWith(
      "updated-access-token",
      "global"
    );
  });

  it("does not update when Supabase rejects the current password", async () => {
    mocks.updateUser.mockResolvedValueOnce({
      data: { user: null },
      error: new AuthApiError(
        "Current password is incorrect",
        400,
        "invalid_credentials"
      ),
    });

    const cause = await changePassword().catch((error: unknown) => error);

    expect(cause).toBeInstanceOf(ShelfError);
    expect(cause).toMatchObject({
      message: "Current password is incorrect.",
      status: 400,
    });
    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(JSON.stringify(cause)).not.toContain("old-password");
    expect(JSON.stringify(cause)).not.toContain("new-password-123");
  });

  it("does not reverify or change a different Supabase user", async () => {
    mocks.getUser.mockResolvedValueOnce({
      data: { user: { id: "different-user", email: "other@example.com" } },
      error: null,
    });

    await expect(changePassword()).rejects.toMatchObject({
      message: "Your session could not be verified. Please sign in again.",
      status: 401,
    });
    expect(mocks.setSession).not.toHaveBeenCalled();
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });

  it("refuses password changes for SSO accounts", async () => {
    mocks.findFirst.mockResolvedValueOnce({ sso: true });

    await expect(changePassword()).rejects.toMatchObject({
      message: "You cannot update the password of an SSO user.",
      status: 403,
    });
    expect(mocks.getUser).not.toHaveBeenCalled();
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });
});
