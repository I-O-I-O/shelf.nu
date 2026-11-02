import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLoaderArgs } from "@mocks/remix";

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  getCategories: vi.fn(),
  updateCookieWithPerPage: vi.fn(),
  serializeUserPrefs: vi.fn(),
}));

// why: the loader test supplies a known Shelf permission result without database access.
vi.mock("~/utils/roles.server", () => ({
  requirePermission: mocks.requirePermission,
}));
// why: category persistence is an existing Shelf service boundary and is mocked to return an empty workspace.
vi.mock("~/modules/category/service.server", () => ({
  deleteCategory: vi.fn(),
  getCategories: mocks.getCategories,
}));
// why: cookie state is unrelated to whether the existing Categories page loader can render an empty list.
vi.mock("~/utils/cookies.server", () => ({
  setCookie: vi.fn(() => "shelf-preferences=test"),
  updateCookieWithPerPage: mocks.updateCookieWithPerPage,
  userPrefs: { serialize: mocks.serializeUserPrefs },
}));
// why: these route-view imports include browser animation dependencies not needed by the loader test.
vi.mock("~/components/errors", () => ({ ErrorContent: () => null }));

import { loader } from "~/routes/_layout+/categories";

describe("Shelf Categories page loader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requirePermission.mockResolvedValue({ organizationId: "org-1" });
    mocks.getCategories.mockResolvedValue({
      categories: [],
      totalCategories: 0,
    });
    mocks.updateCookieWithPerPage.mockResolvedValue({ perPage: 20 });
    mocks.serializeUserPrefs.mockResolvedValue("serialized-preferences");
  });

  it("loads an empty organization without throwing a page error", async () => {
    const result = await loader(
      createLoaderArgs({
        context: { getSession: () => ({ userId: "staff-1" }) } as never,
        request: new Request("http://localhost/categories"),
      })
    );

    expect(result).toBeDefined();
    expect(mocks.requirePermission).toHaveBeenCalled();
    expect(mocks.getCategories).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org-1" })
    );
  });
});
