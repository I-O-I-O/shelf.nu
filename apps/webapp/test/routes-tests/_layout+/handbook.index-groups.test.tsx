import { createElement } from "react";
import { render, screen, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";
import HandbookIndexPage from "~/routes/_layout+/handbook._index";

describe("Handbook category groups", () => {
  it("keeps article lists and contribution actions within their categories", async () => {
    const router = createMemoryRouter(
      [
        {
          path: "/handbook",
          loader: () => ({
            articles: [
              {
                id: "article-2",
                slug: "change-filament",
                handbookCategory: { id: "3d", name: "3D Printing" },
                isStartHere: false,
                position: 2,
                publishedVersion: {
                  title: "How to change filament",
                  content: "Replace filament safely.",
                  publishedAt: new Date("2026-10-02T00:00:00.000Z"),
                },
              },
              {
                id: "article-1",
                slug: "what-3d-printing-is",
                handbookCategory: { id: "3d", name: "3D Printing" },
                isStartHere: true,
                position: 1,
                publishedVersion: {
                  title: "What 3D printing is",
                  content: "## Introduction\nBasic concepts.",
                  publishedAt: new Date("2026-10-01T00:00:00.000Z"),
                },
              },
              {
                id: "article-3",
                slug: "soldering-basics",
                staffOnly: true,
                handbookCategory: { id: "soldering", name: "Soldering" },
                isStartHere: false,
                position: 1,
                publishedVersion: {
                  title: "Soldering Basics",
                  content: "Soldering introduction.",
                  publishedAt: new Date("2026-10-03T00:00:00.000Z"),
                },
              },
            ].sort((a, b) => a.position - b.position),
            categories: [],
            query: "",
            handbookCategoryId: "",
            canEdit: true,
            isStudent: false,
          }),
          Component: HandbookIndexPage,
        },
      ],
      { initialEntries: ["/handbook"] }
    );
    render(createElement(RouterProvider, { router }));

    expect(
      await screen.findByRole("heading", { name: "3D Printing" })
    ).toBeTruthy();
    expect(
      await screen.findByRole("heading", { name: "Soldering" })
    ).toBeTruthy();
    const firstArticleLink = screen.getByRole("link", {
      name: "What 3D printing is",
    });
    const secondArticleLink = screen.getByRole("link", {
      name: "How to change filament",
    });
    expect(firstArticleLink).toHaveAttribute(
      "href",
      "/handbook/what-3d-printing-is"
    );
    expect(firstArticleLink).toHaveClass(
      "text-sm",
      "font-medium",
      "text-gray-900",
      "truncate"
    );
    expect(
      screen.queryByRole("heading", { name: "What 3D printing is" })
    ).toBeNull();
    expect(
      screen.queryByRole("heading", { name: "How to change filament" })
    ).toBeNull();
    expect(screen.queryByText(/Start here/i)).toBeNull();
    const printing = screen
      .getByRole("heading", { name: "3D Printing" })
      .closest("section")!;
    expect(
      within(printing)
        .getAllByRole("listitem")
        .map((row) => row.textContent)
    ).toEqual([
      expect.stringContaining("1.What 3D printing is"),
      expect.stringContaining("2.How to change filament"),
    ]);
    expect(within(printing).getByRole("list").tagName).toBe("UL");
    expect(
      within(printing).getAllByRole("listitem")[0].textContent
    ).not.toMatch(/1\.\s*1\./);
    expect(
      firstArticleLink.compareDocumentPosition(secondArticleLink) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Soldering Basics" })).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: "Soldering Basics" })
    ).toBeNull();
    expect(screen.getByText("Staff only")).toBeTruthy();
    expect(
      within(printing)
        .getByRole("link", { name: "New article" })
        .getAttribute("href")
    ).toBe("/handbook/new?handbookCategoryId=3d");
    expect(
      within(
        screen.getByRole("heading", { name: "Soldering" }).closest("section")!
      )
        .getByRole("link", { name: "New article" })
        .getAttribute("href")
    ).toBe("/handbook/new?handbookCategoryId=soldering");
  });

  it("keeps empty category contribution actions available", async () => {
    const router = createMemoryRouter(
      [
        {
          path: "/handbook",
          loader: () => ({
            articles: [],
            categories: [{ id: "laser", name: "Laser Cutting" }],
            query: "",
            handbookCategoryId: "",
            canEdit: true,
            isStudent: false,
          }),
          Component: HandbookIndexPage,
        },
      ],
      { initialEntries: ["/handbook"] }
    );
    render(createElement(RouterProvider, { router }));

    expect(
      await screen.findByRole("heading", { name: "Laser Cutting" })
    ).toBeTruthy();
    const category = screen
      .getByRole("heading", { name: "Laser Cutting" })
      .closest("section")!;
    expect(
      within(category).getByRole("link", { name: "New article" })
    ).toHaveAttribute("href", "/handbook/new?handbookCategoryId=laser");
    expect(
      screen.queryByRole("button", { name: /Reorder article/ })
    ).toBeNull();
    expect(screen.queryByText("Move up")).toBeNull();
    expect(screen.queryByText("Move down")).toBeNull();
  });
});

describe("Handbook staff management visibility", () => {
  it("hides the combined category and ordering manager entry for staff", async () => {
    const renderHome = (canEdit: boolean) => {
      const router = createMemoryRouter(
        [
          {
            path: "/handbook",
            loader: () => ({
              articles: [],
              categories: [],
              query: "",
              handbookCategoryId: "",
              canEdit,
              isStudent: !canEdit,
            }),
            Component: HandbookIndexPage,
          },
        ],
        { initialEntries: ["/handbook"] }
      );
      return render(createElement(RouterProvider, { router }));
    };

    const staff = renderHome(true);
    await screen.findByRole("heading", { name: "Handbook" });
    const staffNavigation = screen
      .getByRole("heading", { name: "Handbook" })
      .closest("header")!;
    const staffActions = within(staffNavigation).getAllByRole("link");
    expect(
      staffActions
        .filter((link) =>
          [
            "New article",
            "My Work",
            "Review contributions",
            "Manage Handbook",
          ].includes(link.textContent?.trim() ?? "")
        )
        .map((link) => link.textContent?.trim())
    ).toEqual([
      "New article",
      "My Work",
      "Review contributions",
      "Manage Handbook",
    ]);
    expect(
      screen.getByRole("link", { name: "Manage Handbook" })
    ).toHaveAttribute("href", "/handbook/manage");
    expect(screen.queryByRole("link", { name: "Categories" })).toBeNull();
    expect(
      screen.queryByRole("link", { name: "Organize articles" })
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Reorder article/ })
    ).toBeNull();
    staff.unmount();

    renderHome(false);
    await screen.findByRole("heading", { name: "Handbook" });
    expect(
      within(
        screen.getByRole("heading", { name: "Handbook" }).closest("header")!
      )
        .getAllByRole("link")
        .filter((link) =>
          ["Contribute", "My Work"].includes(link.textContent?.trim() ?? "")
        )
        .map((link) => link.textContent?.trim())
    ).toEqual(["Contribute", "My Work"]);
    expect(
      screen.queryByRole("link", { name: "Review contributions" })
    ).toBeNull();
    expect(screen.queryByRole("link", { name: "Manage Handbook" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Reorder article/ })
    ).toBeNull();
  });
});
