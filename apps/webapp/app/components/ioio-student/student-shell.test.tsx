import type { FormEventHandler, ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

// why: the shell only needs router primitives in this component test; a real
// data router would add unrelated route loading and navigation behavior.
vi.mock("react-router", () => ({
  Link: ({
    to,
    children,
    ...props
  }: { to: string; children: ReactNode } & Record<string, unknown>) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  NavLink: ({
    to,
    children,
    className,
    onClick,
  }: {
    to: string;
    children: ReactNode;
    className?: string | ((args: { isActive: boolean }) => string);
    onClick?: () => void;
  }) => (
    <a
      href={to}
      className={
        typeof className === "function"
          ? className({ isActive: false })
          : className
      }
      onClick={onClick}
    >
      {children}
    </a>
  ),
  Form: ({
    action,
    method,
    onSubmit,
    className,
    children,
  }: {
    action?: string;
    method?: string;
    onSubmit?: FormEventHandler<HTMLFormElement>;
    className?: string;
    children: ReactNode;
  }) => (
    <form
      action={action}
      method={method}
      onSubmit={onSubmit}
      className={className}
    >
      {children}
    </form>
  ),
  Outlet: () => null,
  useFetcher: () => ({ data: null, submit: () => undefined }),
  useLocation: () => ({ pathname: "/ioio" }),
  useNavigate: () => () => undefined,
  useMatches: () => [],
  useRouteLoaderData: () => undefined,
}));

import StudentShell from "./student-shell";
import { StudentCheckoutProvider } from "./checkout-context";
import { StudentCheckoutButton } from "./student-ui";
import { StudentBorrowListIndicator } from "./student-shell";
import type { StudentAsset } from "~/modules/ioio-student/service.server";

function checkoutAsset(): StudentAsset {
  return {
    id: "arduino-nano",
    title: "Arduino Nano",
    description: null,
    mainImage: null,
    mainImageExpiration: null,
    thumbnailImage: null,
    assetModel: null,
    status: "AVAILABLE",
    type: "QUANTITY_TRACKED",
    quantity: 8,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    assetModelId: null,
    availableQuantity: 8,
    availableToBook: true,
    sequentialId: null,
    category: null,
    locations: [],
    kits: [],
    qrIds: [],
  };
}

describe("StudentShell account controls", () => {
  it("keeps logout available in the desktop sidebar and mobile drawer", async () => {
    const user = userEvent.setup();

    render(<StudentShell />);

    expect(
      screen.getAllByRole("region", { name: "Student account" })
    ).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /log out/i })).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: /log out/i }).closest("form")
    ).toHaveAttribute("action", "/logout");
    expect(
      screen.getByRole("button", { name: /log out/i }).closest("form")
    ).toHaveAttribute("method", "post");

    await user.click(screen.getByRole("button", { name: "Menu" }));

    expect(
      screen.getAllByRole("region", { name: "Student account" })
    ).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: /log out/i })).toHaveLength(2);
  });
});

describe("Student borrowing list feedback", () => {
  it("updates its existing count and confirms the item beside the basket", async () => {
    window.sessionStorage.clear();
    const user = userEvent.setup();

    render(
      <StudentCheckoutProvider>
        <StudentBorrowListIndicator />
        <StudentCheckoutButton asset={checkoutAsset()} />
      </StudentCheckoutProvider>
    );

    await user.click(
      screen.getByRole("button", { name: "Add to borrow list" })
    );

    expect(screen.getByRole("link", { name: /1 selected item/i })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain(
      "Arduino Nano added to borrow list"
    );
    expect(screen.getByRole("button", { name: "In borrow list" })).toBeTruthy();
  });
});
