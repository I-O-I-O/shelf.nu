import { beforeEach, describe, expect, it, vi } from "vitest";
import { loader as handbookArticleLoader } from "~/routes/_layout+/handbook.$slug";
import { loader as handbookIndexLoader } from "~/routes/_layout+/handbook._index";
import {
  action as handbookManageAction,
  loader as handbookManageLoader,
} from "~/routes/_layout+/handbook.manage";

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  listHandbookCategories: vi.fn(),
  listHandbookCategoriesWithPublishedArticles: vi.fn(),
  listHandbookCategoriesForManagement: vi.fn(),
  listPublishedHandbookArticles: vi.fn(),
  getPublishedHandbookArticle: vi.fn(),
  updateHandbookArticleNavigation: vi.fn(),
  createHandbookCategory: vi.fn(),
  renameHandbookCategory: vi.fn(),
  archiveHandbookArticle: vi.fn(),
  deleteHandbookArticlePermanently: vi.fn(),
}));

// why: access is controlled by Shelf's permission service, which is the input
// varied here to prove the Handbook routes accept both intended IOIO roles.
vi.mock("~/utils/roles.server", () => ({
  requirePermission: mocks.requirePermission,
}));

// why: these route tests verify role access and organization scoping, not the
// Handbook database query implementation.
vi.mock("~/modules/ioio-handbook/service.server", () => ({
  HandbookValidationError: class HandbookValidationError extends Error {},
  listHandbookCategories: mocks.listHandbookCategories,
  listHandbookCategoriesWithPublishedArticles:
    mocks.listHandbookCategoriesWithPublishedArticles,
  listHandbookCategoriesForManagement:
    mocks.listHandbookCategoriesForManagement,
  listPublishedHandbookArticles: mocks.listPublishedHandbookArticles,
  getPublishedHandbookArticle: mocks.getPublishedHandbookArticle,
  updateHandbookArticleNavigation: mocks.updateHandbookArticleNavigation,
  createHandbookCategory: mocks.createHandbookCategory,
  renameHandbookCategory: mocks.renameHandbookCategory,
  archiveHandbookArticle: mocks.archiveHandbookArticle,
  deleteHandbookArticlePermanently: mocks.deleteHandbookArticlePermanently,
}));

// why: ErrorContent and MarkdownViewer are not rendered by loader tests.
vi.mock("~/components/errors", () => ({ ErrorContent: () => null }));
vi.mock("~/components/markdown/markdown-viewer", () => ({
  MarkdownViewer: () => null,
}));

function loaderArgs(path: string, params: Record<string, string> = {}) {
  return {
    context: { getSession: () => ({ userId: "user-1" }) },
    request: new Request(`http://localhost${path}`),
    params,
  } as never;
}

function handbookPermission(role: string) {
  return {
    organizationId: "ioio-team-1",
    currentOrganization: { id: "ioio-team-1", type: "TEAM" },
    userOrganizations: [
      {
        organizationId: "ioio-team-1",
        organization: { id: "ioio-team-1", type: "TEAM" },
        roles: [role],
      },
    ],
    role,
  };
}

describe("IOIO Handbook read access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requirePermission.mockImplementation(() =>
      Promise.resolve(handbookPermission("ADMIN"))
    );
    mocks.listPublishedHandbookArticles.mockResolvedValue([]);
    mocks.listHandbookCategories.mockResolvedValue([]);
    mocks.listHandbookCategoriesWithPublishedArticles.mockResolvedValue([]);
    mocks.listHandbookCategoriesForManagement.mockResolvedValue([]);
    mocks.getPublishedHandbookArticle.mockResolvedValue({
      id: "article-1",
      slug: "equipment-care",
      publishedVersion: { title: "Equipment care" },
    });
  });

  it.each([
    ["ADMIN", true, false],
    ["OWNER", true, false],
    ["SELF_SERVICE", false, true],
  ])(
    "allows %s to read the Handbook index and article",
    async (role, canEdit, isStudent) => {
      mocks.requirePermission.mockImplementation(() =>
        Promise.resolve(handbookPermission(role))
      );

      const index = (await handbookIndexLoader(loaderArgs("/handbook"))) as {
        canEdit: boolean;
        isStudent: boolean;
      };
      if (role === "ADMIN" || role === "OWNER") {
        await handbookManageLoader(loaderArgs("/handbook/manage"));
      } else {
        const result = await handbookManageLoader(
          loaderArgs("/handbook/manage")
        ).catch((reason: unknown) => reason);
        expect((result as { init: { status: number } }).init.status).toBe(403);
      }
      const article = (await handbookArticleLoader(
        loaderArgs("/handbook/equipment-care", { slug: "equipment-care" })
      )) as { canEdit: boolean; isStudent: boolean };

      expect(index).toMatchObject({ canEdit, isStudent });
      expect(article).toMatchObject({ canEdit, isStudent });
      expect(mocks.listPublishedHandbookArticles).toHaveBeenCalledWith({
        organizationId: "ioio-team-1",
        query: "",
        handbookCategoryId: undefined,
        canReadStaffOnly: canEdit,
      });
      if (canEdit) {
        expect(mocks.listHandbookCategories).toHaveBeenCalledWith(
          "ioio-team-1"
        );
      } else {
        expect(
          mocks.listHandbookCategoriesWithPublishedArticles
        ).toHaveBeenCalledWith({ organizationId: "ioio-team-1" });
      }
      expect(mocks.getPublishedHandbookArticle).toHaveBeenCalledWith({
        organizationId: "ioio-team-1",
        slug: "equipment-care",
        versionId: undefined,
        compareVersionId: undefined,
        canReadStaffOnly: canEdit,
      });
    }
  );

  it("keeps Handbook access unavailable to non-staff and non-student roles", async () => {
    mocks.requirePermission.mockResolvedValue(handbookPermission("BASE"));

    const result = await handbookIndexLoader(loaderArgs("/handbook")).catch(
      (reason: unknown) => reason
    );

    expect((result as { init: { status: number } }).init.status).toBe(403);
    expect(mocks.listPublishedHandbookArticles).not.toHaveBeenCalled();
  });

  it("loads an explicit article version comparison", async () => {
    await handbookArticleLoader(
      loaderArgs(
        "/handbook/equipment-care?version=version-3&compare=version-2",
        { slug: "equipment-care" }
      )
    );

    expect(mocks.getPublishedHandbookArticle).toHaveBeenCalledWith({
      organizationId: "ioio-team-1",
      slug: "equipment-care",
      versionId: "version-3",
      compareVersionId: "version-2",
      canReadStaffOnly: true,
    });
  });

  it.each(["move-before", "move-after"])(
    "lets Staff %s while blocking Students",
    async (intent) => {
      const createRequest = () => {
        const formData = new FormData();
        formData.set("intent", intent);
        formData.set("targetArticleId", "article-2");
        formData.set("articleId", "article-1");
        return new Request("http://localhost/handbook/manage", {
          method: "POST",
          body: formData,
        });
      };
      const createActionArgs = (request: Request) =>
        ({
          context: { getSession: () => ({ userId: "user-1" }) },
          request,
          params: {},
          url: new URL(request.url),
          pattern: "/handbook",
        }) as never;
      mocks.updateHandbookArticleNavigation.mockResolvedValue({
        articleId: "article-1",
      });

      const staffResult = await handbookManageAction(
        createActionArgs(createRequest())
      );

      expect(mocks.updateHandbookArticleNavigation).toHaveBeenCalledWith({
        organizationId: "ioio-team-1",
        articleId: "article-1",
        intent,
        targetArticleId: "article-2",
      });
      expect(staffResult).toMatchObject({ success: true });

      vi.clearAllMocks();
      mocks.requirePermission.mockResolvedValue(
        handbookPermission("SELF_SERVICE")
      );
      const studentResult = await handbookManageAction(
        createActionArgs(createRequest())
      );

      expect(mocks.updateHandbookArticleNavigation).not.toHaveBeenCalled();
      expect((studentResult as { init: { status: number } }).init.status).toBe(
        403
      );
    }
  );

  it("loads all active categories and their articles for staff management", async () => {
    mocks.listHandbookCategoriesForManagement.mockResolvedValue([
      { id: "3d", name: "3D Printing", _count: { articles: 1 } },
      { id: "laser", name: "Laser Cutting", _count: { articles: 0 } },
    ]);
    mocks.listPublishedHandbookArticles.mockResolvedValue([
      { id: "article-1", handbookCategory: { id: "3d" } },
    ]);
    const result = (await handbookManageLoader(
      loaderArgs("/handbook/manage")
    )) as { categories: Array<{ id: string; articles: unknown[] }> };

    expect(result.categories).toEqual([
      {
        id: "3d",
        name: "3D Printing",
        _count: { articles: 1 },
        articles: [{ id: "article-1", handbookCategory: { id: "3d" } }],
      },
      {
        id: "laser",
        name: "Laser Cutting",
        _count: { articles: 0 },
        articles: [],
      },
    ]);
  });

  it.each(["move-up", "move-down"])(
    "rejects the removed %s Handbook ordering action",
    async (intent) => {
      const formData = new FormData();
      formData.set("intent", intent);
      formData.set("articleId", "article-1");
      const request = new Request("http://localhost/handbook/manage", {
        method: "POST",
        body: formData,
      });
      const result = await handbookManageAction({
        context: { getSession: () => ({ userId: "user-1" }) },
        request,
        params: {},
        url: new URL(request.url),
        pattern: "/handbook",
      } as never);

      expect(mocks.updateHandbookArticleNavigation).not.toHaveBeenCalled();
      expect((result as { init: { status: number } }).init.status).toBe(400);
    }
  );
});
