import { createElement } from "react";
import {
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
    expect(
      screen.getByRole("heading", { name: "What 3D printing is" })
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "How to change filament" })
    ).toBeTruthy();
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
    expect(
      screen
        .getByRole("link", { name: "What 3D printing is" })
        .compareDocumentPosition(
          screen.getByRole("link", { name: "How to change filament" })
        ) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Soldering Basics" })
    ).toBeTruthy();
    expect(
      within(printing)
        .getByRole("link", { name: "Contribute" })
        .getAttribute("href")
    ).toBe("/handbook/new?handbookCategoryId=3d");
    expect(
      within(
        screen.getByRole("heading", { name: "Soldering" }).closest("section")!
      )
        .getByRole("link", { name: "Contribute" })
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
    expect(screen.getByRole("link", { name: "Contribute" })).toHaveAttribute(
      "href",
      "/handbook/new?handbookCategoryId=laser"
    );
  });
});

function renderOrderingExample(canEdit = true) {
  const submissions: Record<string, FormDataEntryValue>[] = [];
  const articles = [
    "What 3D printing is",
    "Why this piece of art is not working?",
    "How to change filament",
  ].map((title, index) => ({
    id: `article-${index + 1}`,
    slug: `article-${index + 1}`,
    position: index + 1,
    handbookCategory: { id: "3d", name: "3D Printing" },
    publishedVersion: {
      title,
      content: title,
      publishedAt: "2026-11-06T00:00:00Z",
    },
  }));
  const router = createMemoryRouter(
    [
      {
        path: "/handbook",
        loader: () => ({
          articles,
          categories: [],
          query: "",
          handbookCategoryId: "",
          canEdit,
          isStudent: !canEdit,
        }),
        action: async ({ request }) => {
          submissions.push(Object.fromEntries(await request.formData()));
          return { ok: true };
        },
        Component: HandbookIndexPage,
      },
    ],
    { initialEntries: ["/handbook"] }
  );
  render(createElement(RouterProvider, { router }));
  return submissions;
}

describe("Handbook ordering controls", () => {
  it("lets keyboard and touch users submit move actions from each article menu", async () => {
    const user = userEvent.setup();
    const submissions = renderOrderingExample();
    await user.click(
      await screen.findByLabelText("Article actions for How to change filament")
    );
    await user.click(
      within(
        screen.getByRole("group", { name: "Reorder How to change filament" })
      ).getByRole("button", { name: "Move up" })
    );
    await waitFor(() =>
      expect(submissions).toEqual([
        { articleId: "article-3", intent: "move-up", returnTo: "/handbook" },
      ])
    );
  });

  it("submits the source and same-category destination when dragging", async () => {
    const submissions = renderOrderingExample();
    const source = await screen.findByRole("button", {
      name: "Drag to reorder How to change filament",
    });
    const target = screen
      .getByRole("link", { name: "Why this piece of art is not working?" })
      .closest("li")!;
    // why: Happy DOM does not provide native browser drag data transfer.
    const dataTransfer = {
      setData: () => {},
      effectAllowed: "",
      dropEffect: "",
    };
    fireEvent.dragStart(source, { dataTransfer });
    fireEvent.dragOver(target, { dataTransfer, clientY: 0 });
    fireEvent.drop(target, { dataTransfer, clientY: 0 });
    await waitFor(() =>
      expect(submissions).toEqual([
        {
          articleId: "article-3",
          intent: "move-before",
          targetArticleId: "article-2",
          returnTo: "/handbook",
        },
      ])
    );
  });

  it("shows readers the numbered list without staff ordering controls", async () => {
    renderOrderingExample(false);
    await screen.findByRole("heading", { name: "3D Printing" });
    expect(
      screen.getAllByRole("listitem").map((row) => row.textContent?.slice(0, 2))
    ).toEqual(["1.", "2.", "3."]);
    expect(
      screen.queryByRole("button", { name: /Drag to reorder/ })
    ).toBeNull();
    expect(screen.queryByLabelText(/Article actions for/)).toBeNull();
    expect(screen.queryByText(/Start here/i)).toBeNull();
    expect(screen.getByRole("link", { name: "Contribute" })).toHaveAttribute(
      "href",
      "/handbook/new?handbookCategoryId=3d"
    );
  });
});
