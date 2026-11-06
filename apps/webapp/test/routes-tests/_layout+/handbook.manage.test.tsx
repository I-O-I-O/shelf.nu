import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createActionArgs } from "@mocks/remix";
import { HandbookArticleActions } from "~/components/handbook/handbook-article-actions";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  archive: vi.fn(),
  deletePermanently: vi.fn(),
  HandbookValidationError: class HandbookValidationError extends Error {},
}));
// why: route permission tests vary the trusted Shelf session without a real login.
vi.mock("~/modules/ioio-handbook/access.server", () => ({
  requireIoioHandbookRead: mocks.read,
}));
// why: database mutation safety is tested in the service suite; this suite checks the route boundary and confirmation UI.
vi.mock("~/modules/ioio-handbook/service.server", () => ({
  archiveHandbookArticle: mocks.archive,
  deleteHandbookArticlePermanently: mocks.deletePermanently,
  HandbookValidationError: mocks.HandbookValidationError,
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
    mocks.archive.mockResolvedValue({ id: "article-1" });
    mocks.deletePermanently.mockResolvedValue({
      id: "article-1",
      slug: "old-test-article",
      title: "Old test article",
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
