import { cleanup, render, screen } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import Join from "~/routes/_auth+/join";
import Login from "~/routes/_auth+/login";

// why: these tests render only the auth presentation; server services and
// Prisma are covered by their own action/service tests and are not called.
vi.mock("~/database/db.server", () => ({ db: {} }));
vi.mock("~/modules/auth/service.server", () => ({
  INVALID_CREDENTIALS_MESSAGE: "Incorrect email or password",
  signInWithEmail: vi.fn(),
  signUpWithEmailPass: vi.fn(),
}));
vi.mock("~/modules/auth/sso-enforcement.server", () => ({
  isSsoDomainEmail: vi.fn(),
}));
vi.mock("~/modules/ioio/initial-team.server", () => ({
  ensureInitialIoioTeamForUser: vi.fn(),
}));
vi.mock("~/modules/organization/context.server", () => ({
  getSelectedOrganization: vi.fn(),
  setSelectedOrganizationIdCookie: vi.fn(),
}));
vi.mock("~/modules/signup-intent/cookie.server", () => ({
  clearSignupIntentHeaders: vi.fn(),
  readSignupIntent: vi.fn(),
  refreshSignupIntentHeaders: vi.fn(),
  signupIntentHeaders: vi.fn(),
}));
vi.mock("~/modules/user/service.server", () => ({
  findUserByEmail: vi.fn(),
}));
vi.mock("~/utils/sso.server", () => ({
  validateNonSSOSignup: vi.fn(),
}));

afterEach(() => cleanup());

function renderLogin() {
  const Stub = createRoutesStub([
    {
      path: "/",
      Component: Login,
      loader: () => ({ title: "Welcome back" }),
      HydrateFallback: () => <div>Loading login...</div>,
    },
  ]);
  render(<Stub initialEntries={["/"]} />);
}

function renderJoin() {
  const Stub = createRoutesStub([
    {
      path: "/join",
      Component: Join,
      loader: () => ({ signupIntent: null }),
      HydrateFallback: () => <div>Loading signup...</div>,
    },
  ]);
  render(<Stub initialEntries={["/join"]} />);
}

describe("IOIO authentication presentation", () => {
  it("shows only email and password login with a red primary action and visible signup link", async () => {
    renderLogin();

    expect(
      await screen.findByPlaceholderText("student@example.com")
    ).toBeTruthy();
    expect(screen.getByLabelText("Password")).toBeTruthy();
    expect(screen.queryByText(/One Time Password/i)).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Continue with OTP/i })
    ).toBeNull();

    const loginButton = screen.getByRole("button", { name: "Log in" });
    expect(loginButton).toHaveClass("bg-red-700");
    expect(screen.getByRole("link", { name: "Sign up" })).toHaveAttribute(
      "href",
      "/join"
    );
    expect(screen.getByText(/Don.t have an account\?/i)).toBeTruthy();
  });

  it("shows the IOIO signup fields with a red primary action and visible login link", async () => {
    renderJoin();

    expect(await screen.findByLabelText("First name")).toBeTruthy();
    expect(screen.getByLabelText("Last name")).toBeTruthy();
    expect(screen.getByPlaceholderText("student@example.com")).toBeTruthy();
    expect(screen.getByLabelText("Password")).toBeTruthy();
    expect(screen.getByLabelText("Confirm Password")).toBeTruthy();
    expect(screen.queryByText(/One Time Password/i)).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Sign up with OTP/i })
    ).toBeNull();

    const createAccountButton = screen.getByRole("button", {
      name: "Create account",
    });
    expect(createAccountButton).toHaveClass("bg-red-700");
    expect(screen.getByRole("link", { name: "Log in" })).toHaveAttribute(
      "href",
      "/"
    );
    expect(screen.getByText(/Already have an account\?/i)).toBeTruthy();
  });
});
