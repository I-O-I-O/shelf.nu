import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLoaderArgs } from "@mocks/remix";

const mocks = vi.hoisted(() => ({
  requireRead: vi.fn(),
  getEditData: vi.fn(),
  listArticleTitles: vi.fn(),
}));

// why: the route loader test isolates the zero-category response from the
// external Shelf session and Prisma connections.
vi.mock("~/modules/ioio-handbook/access.server", () => ({
  requireIoioHandbookRead: mocks.requireRead,
}));
vi.mock("~/modules/ioio-handbook/service.server", () => ({
  getHandbookEditData: mocks.getEditData,
  listHandbookArticleTitles: mocks.listArticleTitles,
}));

import { loader } from "~/routes/_layout+/handbook.new";

const context = { getSession: () => ({ userId: "staff-1" }) } as never;

describe("new Handbook article route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireRead.mockResolvedValue({
      userId: "student-1",
      organizationId: "org-1",
      currentOrganization: { type: "TEAM" },
      canEdit: false,
      isStudent: true,
    });
    mocks.getEditData.mockResolvedValue({ article: null, categories: [] });
    mocks.listArticleTitles.mockResolvedValue([]);
  });

  it("loads directly with an empty Handbook category list", async () => {
    const result = await loader(
      createLoaderArgs({
        context,
        request: new Request("http://localhost:3000/handbook/new"),
      })
    );

    expect(result).toMatchObject({
      article: null,
      categories: [],
      initialCategoryId: "",
      titleMatches: [],
      isStudent: true,
    });
    expect(mocks.getEditData).toHaveBeenCalledWith({
      organizationId: "org-1",
    });
    expect(mocks.listArticleTitles).toHaveBeenCalledWith({
      organizationId: "org-1",
    });
  });

  it("preselects a category when a category contribution link is opened", async () => {
    mocks.getEditData.mockResolvedValue({
      article: null,
      categories: [{ id: "category-3d", name: "3D Printing" }],
    });
    const result = await loader(
      createLoaderArgs({
        context,
        request: new Request(
          "http://localhost:3000/handbook/new?handbookCategoryId=category-3d"
        ),
      })
    );

    expect(result).toMatchObject({ initialCategoryId: "category-3d" });
  });
});
