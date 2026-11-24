import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createActionArgs } from "@mocks/remix";
import { HandbookArticleActions } from "~/components/handbook/handbook-article-actions";
import HandbookManagePage from "~/routes/_layout+/handbook.manage";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  archive: vi.fn(),
  deletePermanently: vi.fn(),
  createCategory: vi.fn(),
  listCategories: vi.fn(),
  listArticles: vi.fn(),
  renameCategory: vi.fn(),
  updateArticleNavigation: vi.fn(),
  setVisibility: vi.fn(),
  staffAccess: vi.fn(),
  HandbookValidationError: class HandbookValidationError extends Error {},
}));
// why: route permission tests vary the trusted Shelf session without a real login.
vi.mock("~/modules/ioio-handbook/access.server", () => ({
  requireIoioHandbookRead: mocks.read,
}));
// why: database mutation safety is tested in the service suite; this suite checks the route boundary and confirmation UI.
vi.mock("~/modules/ioio-handbook/service.server", () => ({
  archiveHandbookArticle: mocks.archive,
  createHandbookCategory: mocks.createCategory,
  deleteHandbookArticlePermanently: mocks.deletePermanently,
  listHandbookCategoriesForManagement: mocks.listCategories,
  listPublishedHandbookArticles: mocks.listArticles,
  renameHandbookCategory: mocks.renameCategory,
  updateHandbookArticleNavigation: mocks.updateArticleNavigation,
  setHandbookArticleVisibility: mocks.setVisibility,
  HandbookValidationError: mocks.HandbookValidationError,
}));
// why: this route delegates the staff role boundary to the shared IOIO staff permission helper.
vi.mock("~/modules/ioio-staff/access.server", () => ({
  requireIoioStaffAccess: mocks.staffAccess,
}));
import { action } from "~/routes/_layout+/handbook.manage";

const context = { getSession: () => ({ userId: "staff-1" }) } as never;
function args(intent = "archive-article") {
  return createActionArgs({
    context,
    request: new Request("http://localhost/handbook/manage", {
      method: "POST",
      body: new URLSearchParams({
        intent,
        articleId: "article-1",
        confirmationTitle:
          intent === "delete-permanently" ? "Old test article" : "",
        canManageArticles: "true",
        staffOnly: "true",
        returnTo: "/handbook/example",
      }),
    }),
  });
}

describe("Handbook article management", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.read.mockResolvedValue({
      organizationId: "org-1",
      userId: "staff-1",
      canEdit: true,
    });
    mocks.staffAccess.mockResolvedValue({
      organizationId: "org-1",
      userId: "staff-1",
      role: "ADMIN",
      currentOrganization: { type: "TEAM" },
    });
    mocks.archive.mockResolvedValue({ id: "article-1" });
    mocks.deletePermanently.mockResolvedValue({
      id: "article-1",
      slug: "old-test-article",
      title: "Old test article",
    });
    mocks.setVisibility.mockResolvedValue({ id: "article-1", staffOnly: true });
  });
  it("lets Staff toggle article visibility through the staff-protected management action", async () => {
    const result = await action(args("set-visibility"));

    expect(mocks.staffAccess).toHaveBeenCalledOnce();
    expect(mocks.setVisibility).toHaveBeenCalledWith({
      organizationId: "org-1",
      articleId: "article-1",
      staffOnly: true,
      canManageArticles: true,
    });
    expect((result as Response).headers.get("Location")).toBe(
      "/handbook/example"
    );
  });
  it("filters management rows without renumbering the canonical category order", async () => {
    const router = createMemoryRouter(
      [
        {
          path: "/handbook/manage",
          loader: () => ({
            visibilityFilter: "STAFF_ONLY",
            categories: [
              {
                id: "category-1",
                name: "3D Printing",
                _count: { articles: 2 },
                articles: [
                  {
                    id: "public-1",
                    slug: "what-3d-printing-is",
                    staffOnly: false,
                    publishedVersion: { title: "What 3D printing is" },
                  },
                  {
                    id: "private-1",
                    slug: "printer-maintenance",
                    staffOnly: true,
                    publishedVersion: {
                      title: "Printer maintenance procedure",
                    },
                  },
                ],
              },
            ],
          }),
          Component: HandbookManagePage,
        },
      ],
      { initialEntries: ["/handbook/manage?visibility=STAFF_ONLY"] }
    );
    render(<RouterProvider router={router} />);

    expect(
      await screen.findByRole("heading", { name: "Manage Handbook" })
    ).toBeTruthy();
    expect(
      screen.getByRole("combobox", { name: "Article visibility" })
    ).toHaveValue("STAFF_ONLY");
    expect(screen.getByText("Printer maintenance procedure")).toBeTruthy();
    expect(screen.queryByText("What 3D printing is")).toBeNull();
    expect(screen.getByText("2.")).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "Reorder article: Printer maintenance procedure",
      })
    ).toBeDisabled();
  });

  it("shows each article's access level and changes visibility from its row", async () => {
    const user = userEvent.setup();
    const router = createMemoryRouter(
      [
        {
          path: "/handbook/manage",
          loader: () => ({
            visibilityFilter: "ALL",
            categories: [
              {
                id: "category-1",
                name: "3D Printing",
                _count: { articles: 4 },
                articles: [
                  {
                    id: "public-1",
                    slug: "what-3d-printing-is",
                    staffOnly: false,
                    publishedVersion: { title: "What 3D printing is" },
                  },
                  {
                    id: "private-1",
                    slug: "printer-maintenance",
                    staffOnly: true,
                    publishedVersion: {
                      title: "Printer maintenance procedure",
                    },
                  },
                  {
                    id: "long-1",
                    slug: "long-title",
                    staffOnly: false,
                    publishedVersion: {
                      title:
                        "A deliberately long article title that should truncate cleanly without pushing the access badge or row actions out of alignment",
                    },
                  },
                  {
                    id: "how-to-3d-print",
                    slug: "how-to-3d-print",
                    staffOnly: false,
                    publishedVersion: { title: "How to 3D Print" },
                  },
                ],
              },
            ],
          }),
          action: (routeArgs) => action({ ...routeArgs, context }),
          Component: HandbookManagePage,
        },
      ],
      { initialEntries: ["/handbook/manage"] }
    );
    render(<RouterProvider router={router} />);

    const publicRow = await screen
      .findByRole("link", { name: "What 3D printing is" })
      .then((link) => link.closest("li"));
    const staffOnlyRow = screen
      .getByRole("link", { name: "Printer maintenance procedure" })
      .closest("li");
    expect(publicRow).toBeTruthy();
    expect(staffOnlyRow).toBeTruthy();
    expect(within(publicRow!).getByText("Everyone")).toBeTruthy();
    expect(within(staffOnlyRow!).getByText("Staff only")).toBeTruthy();
    expect(screen.getByText("1.")).toBeTruthy();
    expect(screen.getByText("2.")).toBeTruthy();
    expect(screen.getByText("3.")).toBeTruthy();
    expect(screen.getByText("4.")).toBeTruthy();
    expect(screen.getByRole("list").tagName).toBe("UL");
    expect(screen.getByRole("link", { name: "How to 3D Print" })).toBeTruthy();
    const longTitle =
      "A deliberately long article title that should truncate cleanly without pushing the access badge or row actions out of alignment";
    const longTitleLink = screen.getByRole("link", { name: longTitle });
    expect(longTitleLink).toHaveClass(
      "text-sm",
      "font-medium",
      "text-gray-900",
      "truncate",
      "hover:text-gray-700"
    );
    expect(longTitleLink).not.toHaveClass("text-xl");
    expect(longTitleLink).toHaveAttribute("href", "/handbook/long-title");
    expect(
      within(longTitleLink.closest("li")!).getByText("Everyone")
    ).toHaveClass("shrink-0");
    expect(screen.queryByRole("heading", { name: longTitle })).toBeNull();
    expect(
      screen.getByRole("button", {
        name: "Reorder article: What 3D printing is",
      })
    ).toHaveAttribute("draggable", "true");
    await user.click(
      within(publicRow!).getByRole("button", {
        name: "Article actions for What 3D printing is",
      })
    );
    expect(mocks.updateArticleNavigation).not.toHaveBeenCalled();
    expect(
      screen.getByRole("menuitem", { name: "Edit article" })
    ).toHaveAttribute("href", "/handbook/what-3d-printing-is/edit?improve=1");
    expect(publicRow!.contains(screen.getByRole("menu"))).toBe(false);
    await user.click(
      screen.getByRole("menuitem", { name: "Delete permanently" })
    );
    const deletion = screen.getByRole("alertdialog");
    expect(
      within(deletion).getByRole("button", { name: "Delete permanently" })
    ).toBeDisabled();
    expect(
      within(deletion).getByLabelText(/Type “What 3D printing is” to confirm/)
    ).toBeTruthy();
    await user.click(within(deletion).getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("menuitem", { name: "Archive article" }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent(
      "history will be preserved"
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mocks.archive).not.toHaveBeenCalled();
    expect(mocks.deletePermanently).not.toHaveBeenCalled();
    await user.click(screen.getByRole("menuitem", { name: "Make staff only" }));

    await waitFor(() => {
      expect(mocks.setVisibility).toHaveBeenCalledWith({
        organizationId: "org-1",
        articleId: "public-1",
        staffOnly: true,
        canManageArticles: true,
      });
    });
  });
  it.each(["archive-article", "restore-article"])(
    "allows Staff to %s with the authenticated scope",
    async (intent) => {
      const result = await action(args(intent));
      expect(mocks.archive).toHaveBeenCalledWith({
        organizationId: "org-1",
        articleId: "article-1",
        userId: "staff-1",
        canManageArticles: true,
        restore: intent === "restore-article",
      });
      expect(result).toBeInstanceOf(Response);
    }
  );
  it.each(["archive-article", "delete-permanently"])(
    "blocks a reader from %s even when the form forges staff capability",
    async (intent) => {
      mocks.read.mockResolvedValue({
        organizationId: "org-1",
        userId: "student-1",
        canEdit: false,
      });
      const result = await action(args(intent));
      expect((result as { init: { status: number } }).init.status).toBe(403);
      expect(mocks.archive).not.toHaveBeenCalled();
      expect(mocks.deletePermanently).not.toHaveBeenCalled();
    }
  );
  it("never accepts a published hard-delete intent", async () => {
    const result = await action(args("delete-draft"));
    expect((result as { init: { status: number } }).init.status).toBe(400);
    expect(mocks.archive).not.toHaveBeenCalled();
  });
  it("routes permanent deletion through the authenticated staff service", async () => {
    const result = await action(args("delete-permanently"));
    expect(mocks.deletePermanently).toHaveBeenCalledWith({
      organizationId: "org-1",
      articleId: "article-1",
      userId: "staff-1",
      canManageArticles: true,
      confirmationTitle: "Old test article",
    });
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).headers.get("Location")).toBe("/handbook");
  });
  it("rejects permanent deletion without a typed title", async () => {
    const request = new Request("http://localhost/handbook/manage", {
      method: "POST",
      body: new URLSearchParams({
        intent: "delete-permanently",
        articleId: "article-1",
      }),
    });
    const result = await action(createActionArgs({ context, request }));
    expect((result as { init: { status: number } }).init.status).toBe(400);
    expect(mocks.deletePermanently).not.toHaveBeenCalled();
  });
  it("requires confirmation and supports cancelling before archive", async () => {
    const user = userEvent.setup();
    const router = createMemoryRouter(
      [
        {
          path: "/handbook/example",
          Component: () => (
            <HandbookArticleActions
              articleId="article-1"
              slug="example"
              articleTitle="Old test article"
            />
          ),
        },
        {
          path: "/handbook/manage",
          action: (routeArgs) => action({ ...routeArgs, context }),
        },
        { path: "/handbook", Component: () => <p>Handbook listing</p> },
      ],
      { initialEntries: ["/handbook/example"] }
    );
    render(<RouterProvider router={router} />);
    await user.click(screen.getByLabelText("Article actions"));
    expect(screen.queryByRole("button", { name: "Delete draft" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Delete permanently" })
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Archive article" }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent(
      "history will be preserved"
    );
    expect(mocks.archive).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mocks.archive).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Archive article" }));
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Archive article",
      })
    );
    expect(await screen.findByText("Handbook listing")).toBeTruthy();
    expect(mocks.archive).toHaveBeenCalledOnce();
    expect(router.state.location.search).toBe("?archived=1");
  });

  it("shows permanent deletion on the published article menu and requires its exact title", async () => {
    const user = userEvent.setup();
    const router = createMemoryRouter(
      [
        {
          path: "/handbook/example",
          Component: () => (
            <HandbookArticleActions
              articleId="article-1"
              slug="example"
              articleTitle="Old test article"
            />
          ),
        },
        {
          path: "/handbook/manage",
          action: (routeArgs) => action({ ...routeArgs, context }),
        },
        { path: "/handbook", Component: () => <p>Handbook listing</p> },
      ],
      { initialEntries: ["/handbook/example"] }
    );
    render(<RouterProvider router={router} />);

    await user.click(screen.getByLabelText("Article actions"));
    expect(
      screen.getByRole("button", { name: "Archive article" })
    ).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: "Delete permanently" })
    );
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent("Delete “Old test article” permanently?");
    expect(
      within(dialog).getByRole("button", { name: "Delete permanently" })
    ).toBeDisabled();
    expect(mocks.deletePermanently).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(mocks.deletePermanently).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("button", { name: "Delete permanently" })
    );
    const confirmationInput = screen.getByLabelText(
      /Type “Old test article” to confirm/
    );
    await user.type(confirmationInput, "Old test");
    const confirmButton = within(screen.getByRole("alertdialog")).getByRole(
      "button",
      { name: "Delete permanently" }
    );
    expect(confirmButton).toBeDisabled();
    await user.clear(confirmationInput);
    await user.type(confirmationInput, "Old test article");
    expect(confirmButton).toBeEnabled();
    await user.click(confirmButton);

    expect(await screen.findByText("Handbook listing")).toBeTruthy();
    expect(mocks.deletePermanently).toHaveBeenCalledWith({
      organizationId: "org-1",
      articleId: "article-1",
      userId: "staff-1",
      canManageArticles: true,
      confirmationTitle: "Old test article",
    });
  });
});
