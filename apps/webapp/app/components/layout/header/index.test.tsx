import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import Header from "./index";

// why: this isolates the header's optional Quick Find control from route
// loader data and the command-palette implementation.
vi.mock("react-router", () => ({
  useLoaderData: () => ({ header: { title: "Inventory" } }),
}));
vi.mock("../breadcrumbs", () => ({
  Breadcrumbs: () => <nav aria-label="Breadcrumbs" />,
}));
vi.mock("../command-palette", () => ({
  CommandPaletteButton: () => <button type="button">Quick find ⌘K</button>,
}));

describe("Header Quick Find visibility", () => {
  afterEach(() => cleanup());

  it("hides Quick Find only when the surface requests it", () => {
    const { rerender } = render(<Header hideQuickFind />);
    expect(screen.queryByRole("button", { name: /quick find/i })).toBeNull();

    rerender(<Header />);
    expect(screen.getByRole("button", { name: /quick find/i })).toBeTruthy();
  });
});
