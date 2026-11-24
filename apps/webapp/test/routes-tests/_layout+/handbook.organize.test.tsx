import { createElement } from "react";
import {
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";
import HandbookManagePage from "~/routes/_layout+/handbook.manage";

function article(
  id: string,
  title: string,
  position: number,
  categoryId = "3d"
) {
  return {
    id,
    slug: id,
    position,
    handbookCategory: {
      id: categoryId,
      name: categoryId === "3d" ? "3D Printing" : "Soldering",
    },
    publishedVersion: {
      title,
      content: title,
      publishedAt: new Date("2026-11-09T00:00:00.000Z"),
    },
  };
}

const fiveArticles = [
  article("article-1", "What 3D printing is", 1),
  article("article-2", "How to change filament", 2),
  article("article-3", "Replacing the hot end", 3),
  article("article-4", "Bed leveling", 4),
  article("article-5", "Materials", 5),
];

function renderManagePage({
  initialArticles = fiveArticles,
  initialCategories = [
    { id: "3d", name: "3D Printing" },
    { id: "soldering", name: "Soldering" },
  ],
}: {
  initialArticles?: ReturnType<typeof article>[];
  initialCategories?: Array<{ id: string; name: string }>;
} = {}) {
  let articles = [...initialArticles];
  const submissions: Record<string, FormDataEntryValue>[] = [];
  const getCategories = () =>
    initialCategories.map((category) => {
      const categoryArticles = articles.filter(
        (item) => item.handbookCategory?.id === category.id
      );
      return {
        ...category,
        _count: { articles: categoryArticles.length },
        articles: categoryArticles,
      };
    });
  const router = createMemoryRouter(
    [
      {
        path: "/handbook/manage",
        loader: () => ({ categories: getCategories() }),
        action: async ({ request }) => {
          const submitted = Object.fromEntries(await request.formData());
          submissions.push(submitted);
          const source = articles.find(
            (item) => item.id === submitted.articleId
          );
          const target = articles.find(
            (item) => item.id === submitted.targetArticleId
          );
          if (
            source &&
            target &&
            source.handbookCategory?.id === target.handbookCategory?.id
          ) {
            const categoryId = source.handbookCategory.id;
            const group = articles.filter(
              (item) => item.handbookCategory?.id === categoryId
            );
            const sourceIndex = group.findIndex(
              (item) => item.id === source.id
            );
            const targetIndex = group.findIndex(
              (item) => item.id === target.id
            );
            const [moved] = group.splice(sourceIndex, 1);
            const adjustedTarget =
              sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
            group.splice(
              adjustedTarget + (submitted.intent === "move-after" ? 1 : 0),
              0,
              moved!
            );
            group.forEach((item, index) => {
              item.position = index + 1;
            });
            articles = [
              ...group,
              ...articles.filter(
                (item) => item.handbookCategory?.id !== categoryId
              ),
            ];
          }
          return {
            success: true,
            intent: String(submitted.intent),
            message: "Article order saved.",
          };
        },
        Component: HandbookManagePage,
      },
      { path: "/handbook", Component: () => <p>Handbook</p> },
      { path: "/handbook/new", Component: () => <p>New article</p> },
    ],
    { initialEntries: ["/handbook/manage"] }
  );
  const view = render(createElement(RouterProvider, { router }));
  return { submissions, router, view };
}

describe("Manage Handbook", () => {
  it("shows all five articles in canonical order and persists a drag reorder", async () => {
    const { submissions, router } = renderManagePage();
    const category = await screen.findByRole("button", {
      name: "Collapse 3D Printing",
    });
    const section = category.closest("section")!;
    const list = within(section).getByRole("list");
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((row) => row.textContent)
    ).toEqual([
      expect.stringContaining("1.What 3D printing is"),
      expect.stringContaining("2.How to change filament"),
      expect.stringContaining("3.Replacing the hot end"),
      expect.stringContaining("4.Bed leveling"),
      expect.stringContaining("5.Materials"),
    ]);

    const handle = within(section).getByRole("button", {
      name: "Reorder article: Materials",
    });
    const target = within(section)
      .getByRole("link", { name: "How to change filament" })
      .closest("li")!;
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 10,
      top: 10,
      bottom: 110,
      left: 0,
      right: 400,
      width: 400,
      height: 100,
      toJSON: () => ({}),
    });
    // why: Happy DOM does not implement the browser's native DataTransfer object.
    const dataTransfer = {
      setData: vi.fn(),
      effectAllowed: "",
      dropEffect: "",
    };
    fireEvent.dragStart(handle, { dataTransfer });
    fireEvent.dragOver(target, { dataTransfer, clientY: 20 });
    expect(screen.getByText("Drop here")).toBeTruthy();
    fireEvent.drop(target, { dataTransfer, clientY: 20 });

    await waitFor(() =>
      expect(submissions).toEqual([
        {
          articleId: "article-5",
          intent: "move-before",
          targetArticleId: "article-2",
        },
      ])
    );
    await waitFor(() => {
      const rows = within(
        screen
          .getByRole("button", { name: "Collapse 3D Printing" })
          .closest("section")!
      ).getAllByRole("listitem");
      expect(
        rows.map((row) => row.textContent?.match(/^\s*(\d+)\./)?.[1])
      ).toEqual(["1", "2", "3", "4", "5"]);
    });
    const reorderedCategory = screen
      .getByRole("button", { name: "Collapse 3D Printing" })
      .closest("section")!;
    const reorderedTitles = within(within(reorderedCategory).getByRole("list"))
      .getAllByRole("listitem")
      .map((row) => row.textContent);
    expect(reorderedTitles[1]).toContain("Materials");
    expect(reorderedTitles[2]).toContain("How to change filament");

    await router.navigate(router.state.location.pathname);
    await waitFor(() =>
      expect(
        within(
          screen
            .getByRole("button", { name: "Collapse 3D Printing" })
            .closest("section")!
        ).getAllByRole("listitem")[1].textContent
      ).toContain("Materials")
    );
  });

  it("shows articles grouped in their own categories and rejects cross-category drops", async () => {
    const { submissions } = renderManagePage({
      initialArticles: [
        ...fiveArticles,
        article("solder-1", "Soldering basics", 1, "soldering"),
      ],
    });
    const printing = await screen.findByRole("button", {
      name: "Collapse 3D Printing",
    });
    const soldering = screen.getByRole("button", {
      name: "Collapse Soldering",
    });
    const printingSection = printing.closest("section")!;
    const solderingSection = soldering.closest("section")!;
    expect(
      within(solderingSection).getByRole("link", {
        name: "Soldering basics",
      })
    ).toBeTruthy();
    const handle = within(printingSection).getByRole("button", {
      name: "Reorder article: Materials",
    });
    const crossCategoryTarget = within(solderingSection)
      .getByRole("link", { name: "Soldering basics" })
      .closest("li")!;
    const dataTransfer = {
      setData: vi.fn(),
      effectAllowed: "",
      dropEffect: "",
    };
    fireEvent.dragStart(handle, { dataTransfer });
    fireEvent.dragOver(crossCategoryTarget, { dataTransfer, clientY: 1 });
    fireEvent.drop(crossCategoryTarget, { dataTransfer, clientY: 1 });
    expect(submissions).toEqual([]);
    expect(
      within(printingSection).getByRole("link", { name: "Materials" })
    ).toBeTruthy();
    expect(
      within(solderingSection).getByRole("link", { name: "Soldering basics" })
    ).toBeTruthy();
  });

  it("handles empty and one-article categories without broken reorder controls", async () => {
    window.localStorage.clear();
    const empty = renderManagePage({ initialArticles: [] });
    expect(
      await screen.findAllByText(
        "No published articles to order in this category."
      )
    ).toHaveLength(2);
    expect(
      screen.queryByRole("button", { name: /Reorder article/ })
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Collapse 3D Printing" })
    ).toHaveTextContent("0 articles");
    expect(
      screen.getByRole("button", { name: "Collapse Soldering" })
    ).toHaveTextContent("0 articles");
    empty.view.unmount();

    renderManagePage({ initialArticles: [article("only", "One article", 1)] });
    const handle = await screen.findByRole("button", {
      name: "Reorder article: One article",
    });
    expect(handle).toHaveAttribute("draggable", "false");
    expect(
      screen.getByRole("button", { name: "Collapse 3D Printing" })
    ).toHaveTextContent("1 article");
  });

  it("remembers collapsed categories locally", async () => {
    window.localStorage.clear();
    const first = renderManagePage();
    const collapse = await screen.findByRole("button", {
      name: "Collapse 3D Printing",
    });
    fireEvent.click(collapse);
    expect(
      await screen.findByRole("button", { name: "Expand 3D Printing" })
    ).toHaveAttribute("aria-expanded", "false");
    await waitFor(() =>
      expect(
        window.localStorage.getItem("ioio-handbook-manage-collapsed")
      ).toContain("3d")
    );
    first.view.unmount();

    renderManagePage();
    expect(
      await screen.findByRole("button", { name: "Expand 3D Printing" })
    ).toBeTruthy();
    expect(
      screen.queryByRole("link", { name: "What 3D printing is" })
    ).toBeNull();
  });

  it("shows an empty state when the workspace has no categories", async () => {
    const router = createMemoryRouter(
      [
        {
          path: "/handbook/manage",
          loader: () => ({ categories: [] }),
          Component: HandbookManagePage,
        },
      ],
      { initialEntries: ["/handbook/manage"] }
    );
    render(createElement(RouterProvider, { router }));
    expect(
      await screen.findByRole("heading", { name: "No Handbook categories yet" })
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /Reorder article/ })
    ).toBeNull();
  });
});
