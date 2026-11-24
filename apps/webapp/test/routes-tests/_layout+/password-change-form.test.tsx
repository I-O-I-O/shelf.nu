import { cleanup, render, screen } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import PasswordChangeForm from "~/components/user/password-change-form";

afterEach(() => cleanup());

function renderPasswordChangeForm() {
  const Stub = createRoutesStub([
    {
      path: "/account-details/general",
      Component: PasswordChangeForm,
      loader: () => ({}),
      HydrateFallback: () => <div>Loading password settings...</div>,
    },
  ]);
  return render(<Stub initialEntries={["/account-details/general"]} />);
}

describe("signed-in password form", () => {
  it("requires current, new, and confirmation passwords and offers email recovery separately", async () => {
    const { container } = renderPasswordChangeForm();
    await screen.findByLabelText("Current password");

    for (const label of [
      "Current password",
      "New password",
      "Confirm new password",
    ]) {
      expect(screen.getByLabelText(label)).toBeRequired();
      expect(screen.getByLabelText(label)).toHaveAttribute("type", "password");
    }

    expect(
      screen.getByRole("button", { name: "Change password" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Reset password by email" })
    ).toBeInTheDocument();
    expect(container.querySelectorAll("form")).toHaveLength(2);
  });
});
