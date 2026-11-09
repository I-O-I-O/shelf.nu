import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LinkDialog } from "./dialogs";

describe("Handbook link dialog", () => {
  it("searches current articles, shows categories, and selects a relative target", () => {
    const hrefChanges: string[] = [];
    render(
      <LinkDialog
        state={{ open: true, href: "", range: { from: 1, to: 12 } }}
        onClose={() => undefined}
        onHrefChange={(href) => hrefChanges.push(href)}
        onApply={() => undefined}
        handbookArticles={[
          {
            slug: "what-3d-printing-is",
            title: "What 3D printing is",
            categoryName: "3D Printing",
          },
          {
            slug: "how-to-change-filament",
            title: "How to change filament",
            categoryName: "3D Printing",
            staffOnly: true,
          },
          {
            slug: "choosing-software",
            title: "Choosing Software for Laser Cutting",
            categoryName: "Laser Cutting",
            staffOnly: true,
          },
        ]}
      />
    );

    fireEvent.change(screen.getByRole("combobox", { name: "Link to" }), {
      target: { value: "handbook" },
    });
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "change filament" },
    });

    const results = screen.getByRole("list", {
      name: "Handbook article results",
    });
    expect(within(results).getByText("How to change filament")).toBeTruthy();
    expect(within(results).getByText("3D Printing")).toBeTruthy();
    expect(within(results).getByText("Staff only")).toBeTruthy();
    expect(
      within(results).queryByText("Choosing Software for Laser Cutting")
    ).toBeNull();

    fireEvent.click(
      within(results).getByRole("button", {
        name: "3D Printing How to change filament Staff only",
      })
    );
    expect(hrefChanges.at(-1)).toBe("/handbook/how-to-change-filament");
  });

  it("keeps the external URL option available", () => {
    const hrefChanges: string[] = [];
    render(
      <LinkDialog
        state={{ open: true, href: "", range: { from: 1, to: 12 } }}
        onClose={() => undefined}
        onHrefChange={(href) => hrefChanges.push(href)}
        onApply={() => undefined}
        handbookArticles={[]}
      />
    );

    fireEvent.change(screen.getByRole("combobox", { name: "Link to" }), {
      target: { value: "external" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "External URL" }), {
      target: { value: "https://example.com/guide" },
    });

    expect(hrefChanges.at(-1)).toBe("https://example.com/guide");
  });
});
