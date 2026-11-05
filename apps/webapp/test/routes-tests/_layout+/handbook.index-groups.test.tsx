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
                handbookCategory: { id: "soldering", name: "Soldering" },
                isStartHere: false,
                position: 1,
                publishedVersion: {
                  title: "Soldering Basics",
                  content: "Soldering introduction.",
                  publishedAt: new Date("2026-10-03T00:00:00.000Z"),
                },
              },
            ],
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
    expect(
      screen.getByRole("heading", { name: "What 3D printing is" })
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "How to change filament" })
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Start here" })).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "What 3D printing is" }).closest("li")
        ?.parentElement?.previousElementSibling?.textContent
    ).toContain("Start here");
    expect(
      screen
        .getByRole("link", { name: "What 3D printing is" })
        .compareDocumentPosition(
          screen.getByRole("link", { name: "How to change filament" })
        ) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Remove Start here" })
    ).toBeTruthy();
    expect(
      screen.getAllByRole("button", { name: "Start here" }).length
    ).toBeGreaterThan(0);
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
