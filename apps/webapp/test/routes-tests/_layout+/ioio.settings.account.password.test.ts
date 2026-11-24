// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  changeAccountPassword: vi.fn(),
  sendResetPasswordLink: vi.fn(),
  requireStudentAccountSettings: vi.fn(),
  destroySession: vi.fn(),
}));

// why: the action's auth service calls Supabase and sends email; these spies
// verify the route passes only the authenticated account and expected fields.
vi.mock("~/modules/auth/service.server", () => ({
  changeAccountPassword: mocks.changeAccountPassword,
  sendResetPasswordLink: mocks.sendResetPasswordLink,
  refreshAccessToken: vi.fn(),
  signInWithEmail: vi.fn(),
}));

// why: the route authorization depends on the IOIO organization membership;
// the route action behavior is tested after that boundary resolves.
vi.mock("~/modules/ioio-student/route.server", () => ({
  requireStudentAccountSettings: mocks.requireStudentAccountSettings,
}));

// why: account email and email-change integrations are unrelated to password
// actions tested here.
vi.mock("~/modules/user/service.server", () => ({
  getUserByID: vi.fn(),
  updateUserEmail: vi.fn(),
}));
vi.mock("~/integrations/supabase/client", () => ({
  getSupabaseAdmin: vi.fn(),
}));
vi.mock("~/emails/mail.server", () => ({ sendEmail: vi.fn() }));
vi.mock("~/emails/change-user-email-address", () => ({
  changeEmailAddressHtmlEmail: vi.fn(),
  changeEmailAddressTextEmail: vi.fn(),
}));
vi.mock("~/modules/auth/sso-enforcement.server", () => ({
  assertEmailChangeAllowed: vi.fn(),
}));
vi.mock("~/components/user/password-change-form", () => ({
  default: () => null,
}));

import { action } from "~/routes/_layout+/ioio.settings.account";

const authSession = {
  userId: "student-1",
  email: "student@example.com",
  accessToken: "access-token",
  refreshToken: "refresh-token",
};

function callAction(fields: Record<string, string>) {
  const form = new URLSearchParams(fields);
  return action({
    request: new Request("http://localhost/ioio/settings/account", {
      method: "POST",
      body: form,
    }),
    params: {},
    context: {
      getSession: () => authSession,
      destroySession: mocks.destroySession,
    },
  } as never);
}

describe("IOIO account password actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireStudentAccountSettings.mockResolvedValue({
      userId: authSession.userId,
    });
    mocks.changeAccountPassword.mockResolvedValue(undefined);
    mocks.sendResetPasswordLink.mockResolvedValue(undefined);
  });

  it("requires current, new, and confirmation passwords before calling Auth", async () => {
    const result = (await callAction({
      intent: "changePassword",
      type: "changePassword",
      newPassword: "new-password-123",
      confirmPassword: "new-password-123",
    })) as { data: { error: { message: string } } };

    expect(result.data.error.message).toContain(
      "Current password is required."
    );
    expect(mocks.changeAccountPassword).not.toHaveBeenCalled();
  });

  it("rejects a missing new password and confirmation", async () => {
    const result = (await callAction({
      intent: "changePassword",
      type: "changePassword",
      currentPassword: "current-password",
    })) as { data: { error: { message: string } } };

    expect(result.data.error.message).toMatch(/password/i);
    expect(mocks.changeAccountPassword).not.toHaveBeenCalled();
  });

  it("rejects mismatched or policy-invalid new passwords", async () => {
    const mismatch = (await callAction({
      intent: "changePassword",
      type: "changePassword",
      currentPassword: "current-password",
      newPassword: "new-password-123",
      confirmPassword: "different-password-123",
    })) as { data: { error: { message: string } } };
    expect(mismatch.data.error.message).toContain(
      "New password and confirmation must match."
    );

    const weakPassword = (await callAction({
      intent: "changePassword",
      type: "changePassword",
      currentPassword: "current-password",
      newPassword: "short",
      confirmPassword: "short",
    })) as { data: { error: { message: string } } };
    expect(weakPassword.data.error.message).toContain(
      "Password is too short. Minimum 8 characters."
    );
    expect(mocks.changeAccountPassword).not.toHaveBeenCalled();
  });

  it("sends a neutral reset request to the signed-in user's email", async () => {
    const result = (await callAction({
      intent: "requestPasswordReset",
      type: "requestPasswordReset",
    })) as { data: { resetEmailRequested: boolean } };

    expect(result.data.resetEmailRequested).toBe(true);
    expect(mocks.sendResetPasswordLink).toHaveBeenCalledWith(
      "student@example.com"
    );
    expect(mocks.changeAccountPassword).not.toHaveBeenCalled();
  });

  it("uses the shared current-password verifier and ends the Shelf session", async () => {
    const result = (await callAction({
      intent: "changePassword",
      type: "changePassword",
      currentPassword: "current-password",
      newPassword: "new-password-123",
      confirmPassword: "new-password-123",
    })) as Response;

    expect(mocks.changeAccountPassword).toHaveBeenCalledWith({
      id: "student-1",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      currentPassword: "current-password",
      newPassword: "new-password-123",
    });
    expect(mocks.destroySession).toHaveBeenCalledOnce();
    expect(result.headers.get("Location")).toBe("/login?password_changed=true");
  });
});
