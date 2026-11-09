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
        path: "/handbook/manage",
        Component: () => <p>Manage Handbook route</p>,
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
        path: "/handbook/review",
        Component: () => <p>Review contributions route</p>,
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
  it("opens the normal article create route from Contribute", async () => {
    const user = userEvent.setup();
    const { router } = renderHandbook();

    await user.click(await screen.findByRole("link", { name: "Contribute" }));

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

  it("shows one combined management action in Staff Handbook navigation", async () => {
    renderHandbook({ isStudent: false, canEdit: true });

    const newArticleLinks = await screen.findAllByRole("link", {
      name: "New article",
    });
    expect(
      newArticleLinks.some(
        (link) => link.getAttribute("href") === "/handbook/new"
      )
    ).toBe(true);
    expect(screen.queryByRole("link", { name: "Contribute" })).toBeNull();
    expect(
      screen
        .getByRole("link", { name: "Review contributions" })
        .getAttribute("href")
    ).toBe("/handbook/review");
    expect(
      screen.getByRole("link", { name: "Manage Handbook" }).getAttribute("href")
    ).toBe("/handbook/manage");
    expect(screen.queryByRole("link", { name: "Categories" })).toBeNull();
    expect(
      screen.queryByRole("link", { name: "Organize articles" })
    ).toBeNull();
    expect(screen.queryByRole("link", { name: "Contribute" })).toBeNull();
  });

  it("opens combined Handbook management from the staff Handbook page", async () => {
    const user = userEvent.setup();
    const { router } = renderHandbook({ isStudent: false, canEdit: true });

    await user.click(
      await screen.findByRole("link", { name: "Manage Handbook" })
    );

    expect(router.state.location.pathname).toBe("/handbook/manage");
    expect(await screen.findByText("Manage Handbook route")).toBeTruthy();
  });

  it("does not show review contributions to Students", async () => {
    renderHandbook();

    expect(
      screen.queryByRole("link", { name: "Review contributions" })
    ).toBeNull();
    expect(screen.queryByRole("link", { name: "Manage Handbook" })).toBeNull();
    expect(
      await screen.findByRole("link", { name: "Contribute" })
    ).toBeTruthy();
    expect(screen.queryByRole("link", { name: "New article" })).toBeNull();
    expect(await screen.findByRole("link", { name: "My Work" })).toBeTruthy();
  });

  it("opens the Handbook review route from Staff navigation", async () => {
    const user = userEvent.setup();
    const { router } = renderHandbook({ isStudent: false, canEdit: true });

    await user.click(
      await screen.findByRole("link", { name: "Review contributions" })
    );

    expect(router.state.location.pathname).toBe("/handbook/review");
    expect(await screen.findByText("Review contributions route")).toBeTruthy();
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
