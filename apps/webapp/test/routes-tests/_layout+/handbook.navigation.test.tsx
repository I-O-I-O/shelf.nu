import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createMemoryRouter,
  RouterProvider,
  useLocation,
  useParams,
} from "react-router";
import { describe, expect, it } from "vitest";
import HandbookIndexPage from "~/routes/_layout+/handbook._index";
import HandbookMyWorkPage from "~/routes/_layout+/handbook.my-work";

function renderHandbook({
  isStudent = true,
  canEdit = false,
}: { isStudent?: boolean; canEdit?: boolean } = {}) {
  const router = createMemoryRouter(
    [
      {
        path: "/handbook",
        loader: () => ({
          articles: [],
          categories: [],
          query: "",
          handbookCategoryId: "",
          isStudent,
          canEdit,
        }),
        Component: HandbookIndexPage,
      },
      {
        path: "/handbook/new",
        Component: () => <p>Article create route</p>,
      },
      {
        path: "/handbook/categories",
        Component: () => <p>Handbook categories route</p>,
      },
      {
        path: "/handbook/my-work",
        loader: () => ({
          isStudent: true,
          drafts: [
            {
              id: "article-1",
              slug: "test-handbook-draft",
              draftTitle: "Test Handbook Draft",
              updatedAt: new Date("2026-11-04T00:00:00.000Z"),
              handbookCategory: { id: "category-1", name: "Workshop Safety" },
            },
          ],
        }),
        Component: HandbookMyWorkPage,
      },
      {
        path: "/handbook/:slug/edit",
        Component: () => {
          const { slug } = useParams();
          const location = useLocation();
          return (
            <p>
              {location.pathname} · {slug}
            </p>
          );
        },
      },
    ],
    { initialEntries: ["/handbook"] }
  );

  return { router, ...render(<RouterProvider router={router} />) };
}

describe("Handbook navigation", () => {
  it("opens the normal article create route from Contribute knowledge", async () => {
    const user = userEvent.setup();
    const { router } = renderHandbook();

    await user.click(
      await screen.findByRole("link", { name: "Contribute knowledge" })
    );

    expect(router.state.location.pathname).toBe("/handbook/new");
    expect(await screen.findByText("Article create route")).toBeTruthy();
  });

  it("opens the My Work route from the Handbook index", async () => {
    const user = userEvent.setup();
    const { router } = renderHandbook();

    await user.click(await screen.findByRole("link", { name: "My Work" }));

    expect(router.state.location.pathname).toBe("/handbook/my-work");
    expect(await screen.findByText("Test Handbook Draft")).toBeTruthy();
  });

  it("keeps the separate category page out of the normal Handbook navigation", async () => {
    renderHandbook({ isStudent: false, canEdit: true });

    expect(
      await screen.findByRole("link", { name: "New article" })
    ).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Categories" })).toBeNull();
  });

  it("opens the selected draft editor from My Work", async () => {
    const user = userEvent.setup();
    const { router } = renderHandbook();

    await user.click(await screen.findByRole("link", { name: "My Work" }));
    await user.click(await screen.findByRole("link", { name: "Edit draft" }));

    expect(router.state.location.pathname).toBe(
      "/handbook/test-handbook-draft/edit"
    );
    expect(
      await screen.findByText(
        "/handbook/test-handbook-draft/edit · test-handbook-draft"
      )
    ).toBeTruthy();
  });
});
