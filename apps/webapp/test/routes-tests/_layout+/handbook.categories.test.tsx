import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createActionArgs, createLoaderArgs } from "@mocks/remix";
import { ShelfError } from "~/utils/error";

const mocks = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  listCategories: vi.fn(),
  listArticles: vi.fn(),
  createCategory: vi.fn(),
  renameCategory: vi.fn(),
  updateArticleNavigation: vi.fn(),
  archiveArticle: vi.fn(),
  deleteArticle: vi.fn(),
}));

// why: route tests verify organization scoping and Staff-only writes without a
// live Shelf session or database connection.
vi.mock("~/modules/ioio-staff/access.server", () => ({
  requireIoioStaffAccess: mocks.requireStaff,
}));
vi.mock("~/modules/ioio-handbook/service.server", () => ({
  HandbookValidationError: class HandbookValidationError extends Error {},
  createHandbookCategory: mocks.createCategory,
  listHandbookCategoriesForManagement: mocks.listCategories,
  listPublishedHandbookArticles: mocks.listArticles,
  renameHandbookCategory: mocks.renameCategory,
  updateHandbookArticleNavigation: mocks.updateArticleNavigation,
  archiveHandbookArticle: mocks.archiveArticle,
  deleteHandbookArticlePermanently: mocks.deleteArticle,
}));

import {
  action,
  loader,
  default as HandbookManagePage,
} from "~/routes/_layout+/handbook.manage";
import { loader as legacyCategoriesLoader } from "~/routes/_layout+/handbook.categories";
import { loader as legacyOrganizerLoader } from "~/routes/_layout+/handbook.organize";

const context = { getSession: () => ({ userId: "staff-1" }) } as never;

describe("Handbook categories route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireStaff.mockResolvedValue({
      userId: "staff-1",
      organizationId: "org-1",
      currentOrganization: { type: "TEAM" },
    });
    mocks.listCategories.mockResolvedValue([
      { id: "category-1", name: "Workshop Safety", _count: { articles: 2 } },
    ]);
    mocks.listArticles.mockResolvedValue([]);
    mocks.createCategory.mockResolvedValue({
      id: "category-2",
      name: "Electronics",
      alreadyExists: false,
    });
    mocks.renameCategory.mockResolvedValue({
      id: "category-1",
      name: "Lab Safety",
      unchanged: false,
    });
  });

  it("loads Handbook categories and article lists for the active organization", async () => {
    const result = await loader(
      createLoaderArgs({
        context,
        request: new Request("http://localhost/handbook/manage"),
      })
    );

    expect(result).toMatchObject({
      categories: [
        {
          id: "category-1",
          name: "Workshop Safety",
          _count: { articles: 2 },
          articles: [],
        },
      ],
    });
    expect(mocks.listCategories).toHaveBeenCalledWith("org-1");
    expect(mocks.listArticles).toHaveBeenCalledWith({
      organizationId: "org-1",
    });
  });

  it("redirects the old category route into Manage Handbook", async () => {
    const result = await legacyCategoriesLoader(
      createLoaderArgs({
        context,
        request: new Request("http://localhost/handbook/categories"),
      })
    );
    expect((result as Response).headers.get("Location")).toBe(
      "/handbook/manage"
    );
  });

  it("redirects the old article organizer route into Manage Handbook", async () => {
    const result = await legacyOrganizerLoader(
      createLoaderArgs({
        context,
        request: new Request("http://localhost/handbook/organize"),
      })
    );
    expect((result as Response).headers.get("Location")).toBe(
      "/handbook/manage"
    );
  });

  it("creates a canonical Handbook category through the Staff route action", async () => {
    const form = new FormData();
    form.set("intent", "create-category");
    form.set("name", "Electronics");
    const args = createActionArgs({
      context,
      request: new Request("http://localhost/handbook/manage", {
        method: "POST",
        body: form,
      }),
    });

    const result = await action(args);

    expect(result).toMatchObject({
      success: true,
      intent: "create-category",
    });
    expect(mocks.createCategory).toHaveBeenCalledWith({
      organizationId: "org-1",
      name: "Electronics",
    });
  });

  it("renames a canonical Handbook category through the Staff route action", async () => {
    const form = new FormData();
    form.set("intent", "rename-category");
    form.set("categoryId", "category-1");
    form.set("name", "Lab Safety");
    const args = createActionArgs({
      context,
      request: new Request("http://localhost/handbook/manage", {
        method: "POST",
        body: form,
      }),
    });

    const result = await action(args);

    expect(result).toMatchObject({
      success: true,
      intent: "rename-category",
    });
    expect(mocks.renameCategory).toHaveBeenCalledWith({
      organizationId: "org-1",
      categoryId: "category-1",
      name: "Lab Safety",
    });
  });

  it("requires the Staff access gate before category writes", async () => {
    mocks.requireStaff.mockRejectedValue(
      new ShelfError({
        cause: null,
        message: "Staff only",
        label: "Permission",
        status: 403,
        shouldBeCaptured: false,
      })
    );
    const form = new FormData();
    form.set("intent", "rename-category");
    form.set("categoryId", "category-1");
    form.set("name", "Lab Safety");

    const result = await action(
      createActionArgs({
        context,
        request: new Request("http://localhost/handbook/manage", {
          method: "POST",
          body: form,
        }),
      })
    );
    expect((result as { init: { status: number } }).init.status).toBe(403);
    expect(mocks.renameCategory).not.toHaveBeenCalled();
  });

  it("blocks Students from loading category management", async () => {
    mocks.requireStaff.mockRejectedValue(
      new ShelfError({
        cause: null,
        message: "This Handbook feature is available to Staff only.",
        label: "Permission",
        status: 403,
        shouldBeCaptured: false,
      })
    );
    const result = await loader(
      createLoaderArgs({
        context,
        request: new Request("http://localhost/handbook/manage"),
      })
    ).catch((reason: unknown) => reason);

    expect((result as { init: { status: number } }).init.status).toBe(403);
    expect(mocks.listCategories).not.toHaveBeenCalled();
  });

  it("shows article counts and simple create and inline rename actions", async () => {
    const user = userEvent.setup();
    const router = createMemoryRouter(
      [
        {
          path: "/handbook/manage",
          loader: () => ({
            categories: [
              {
                id: "category-1",
                name: "Workshop Safety",
                _count: { articles: 2 },
                articles: [],
              },
            ],
          }),
          HydrateFallback: () => <p>Loading categories…</p>,
          Component: HandbookManagePage,
        },
      ],
      { initialEntries: ["/handbook/manage"] }
    );
    render(<RouterProvider router={router} />);

    expect(
      await screen.findByRole("button", { name: "Collapse Workshop Safety" })
    ).toHaveTextContent("2 articles");
    await user.click(screen.getByRole("button", { name: "+ New category" }));
    expect(screen.getByLabelText("Category name")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Create category" })
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Rename" }));
    expect(screen.getByLabelText("Name for Workshop Safety")).toHaveValue(
      "Workshop Safety"
    );
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  });
});
