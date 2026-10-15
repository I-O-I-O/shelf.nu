import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import Header from "./index";

const mocks = vi.hoisted(() => ({
  useRouteLoaderData: vi.fn(() => ({ isIoioStaff: false })),
}));

// why: this isolates the header's optional Quick Find control from route
// loader data and the command-palette implementation.
vi.mock("react-router", () => ({
  useLoaderData: () => ({ header: { title: "Inventory" } }),
  useRouteLoaderData: mocks.useRouteLoaderData,
}));
vi.mock("../breadcrumbs", () => ({
  Breadcrumbs: () => <nav aria-label="Breadcrumbs" />,
}));
vi.mock("../command-palette", () => ({
  CommandPaletteButton: () => <button type="button">Quick find ⌘K</button>,
}));

describe("Header Quick Find visibility", () => {
  afterEach(() => cleanup());

  afterEach(() =>
    mocks.useRouteLoaderData.mockReset().mockReturnValue({ isIoioStaff: false })
  );

  it("hides Quick Find only when the surface requests it", () => {
    const { rerender } = render(<Header hideQuickFind />);
    expect(screen.queryByRole("button", { name: /quick find/i })).toBeNull();

    rerender(<Header />);
    expect(screen.getByRole("button", { name: /quick find/i })).toBeTruthy();
  });

  it("hides Quick Find throughout the IOIO Staff shell", () => {
    mocks.useRouteLoaderData.mockReturnValue({ isIoioStaff: true } as never);

    render(<Header />);
    expect(screen.queryByRole("button", { name: /quick find/i })).toBeNull();
  });

  it("keeps page-specific search controls available on the Staff surface", () => {
    mocks.useRouteLoaderData.mockReturnValue({ isIoioStaff: true } as never);

    render(
      <Header>
        <input aria-label="Search inventory" />
      </Header>
    );
    expect(
      screen.getAllByRole("textbox", { name: "Search inventory" })
    ).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /quick find/i })).toBeNull();
    expect(
      screen.queryByRole("navigation", { name: "Breadcrumbs" })
    ).toBeNull();
  });

  it("removes the Staff breadcrumb row and page title divider", () => {
    mocks.useRouteLoaderData.mockReturnValue({ isIoioStaff: true } as never);

    const { container } = render(<Header />);
    const header = container.querySelector("header");
    const titleRow = header?.firstElementChild;

    expect(header?.children).toHaveLength(1);
    expect(titleRow).not.toHaveClass("border-b");
    expect(
      screen.queryByRole("navigation", { name: "Breadcrumbs" })
    ).toBeNull();
  });
});
