import { createElement } from "react";
import { render, screen } from "@testing-library/react";
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
                id: "article-1",
                slug: "what-3d-printing-is",
                handbookCategory: { id: "3d", name: "3D Printing" },
                publishedVersion: {
                  title: "What 3D printing is",
                  publishedAt: new Date("2026-10-01T00:00:00.000Z"),
                },
              },
              {
                id: "article-2",
                slug: "change-filament",
                handbookCategory: { id: "3d", name: "3D Printing" },
                publishedVersion: {
                  title: "How to change filament",
                  publishedAt: new Date("2026-10-02T00:00:00.000Z"),
                },
              },
              {
                id: "article-3",
                slug: "soldering-basics",
                handbookCategory: { id: "soldering", name: "Soldering" },
                publishedVersion: {
                  title: "Soldering Basics",
                  publishedAt: new Date("2026-10-03T00:00:00.000Z"),
                },
              },
            ],
            categories: [],
            query: "",
            handbookCategoryId: "",
            canEdit: false,
            isStudent: true,
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
    expect(
      screen.getByRole("heading", { name: "What 3D printing is" })
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "How to change filament" })
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Soldering Basics" })
    ).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Contribute to 3D Printing" })
        .getAttribute("href")
    ).toBe("/handbook/new?handbookCategoryId=3d");
    expect(
      screen
        .getByRole("link", { name: "Contribute to Soldering" })
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
            canEdit: false,
            isStudent: true,
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
    expect(
      screen.getByRole("link", { name: "Contribute to Laser Cutting" })
    ).toHaveAttribute("href", "/handbook/new?handbookCategoryId=laser");
  });
});
