import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createActionArgs, createLoaderArgs } from "@mocks/remix";

const mocks = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  listCategories: vi.fn(),
  createCategory: vi.fn(),
  renameCategory: vi.fn(),
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
  renameHandbookCategory: mocks.renameCategory,
}));

import {
  action,
  loader,
  default as HandbookCategoriesPage,
} from "~/routes/_layout+/handbook.categories";

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

  it("loads Handbook categories only for the active organization", async () => {
    const result = await loader(
      createLoaderArgs({
        context,
        request: new Request("http://localhost/handbook/categories"),
      })
    );

    expect(result).toMatchObject({
      categories: [
        { id: "category-1", name: "Workshop Safety", _count: { articles: 2 } },
      ],
    });
    expect(mocks.listCategories).toHaveBeenCalledWith("org-1");
  });

  it("creates a canonical Handbook category through the Staff route action", async () => {
    const form = new FormData();
    form.set("intent", "create-category");
    form.set("name", "Electronics");
    const args = createActionArgs({
      context,
      request: new Request("http://localhost/handbook/categories", {
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
      request: new Request("http://localhost/handbook/categories", {
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

  it("shows article counts and the simple Add category form", async () => {
    const user = userEvent.setup();
    const router = createMemoryRouter(
      [
        {
          path: "/handbook/categories",
          loader: () => ({
            categories: [
              {
                id: "category-1",
                name: "Workshop Safety",
                _count: { articles: 2 },
              },
            ],
          }),
          HydrateFallback: () => <p>Loading categories…</p>,
          Component: HandbookCategoriesPage,
        },
      ],
      { initialEntries: ["/handbook/categories"] }
    );
    render(<RouterProvider router={router} />);

    expect(await screen.findByText("2 articles")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Add category" }));
    expect(screen.getByLabelText("Name")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });
});
