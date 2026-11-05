import { beforeEach, describe, expect, it, vi } from "vitest";
import { loader as handbookArticleLoader } from "~/routes/_layout+/handbook.$slug";
import {
  action as handbookIndexAction,
  loader as handbookIndexLoader,
} from "~/routes/_layout+/handbook._index";

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  listHandbookCategories: vi.fn(),
  listPublishedHandbookArticles: vi.fn(),
  getPublishedHandbookArticle: vi.fn(),
  updateHandbookArticleNavigation: vi.fn(),
}));

// why: access is controlled by Shelf's permission service, which is the input
// varied here to prove the Handbook routes accept both intended IOIO roles.
vi.mock("~/utils/roles.server", () => ({
  requirePermission: mocks.requirePermission,
}));

// why: these route tests verify role access and organization scoping, not the
// Handbook database query implementation.
vi.mock("~/modules/ioio-handbook/service.server", () => ({
  listHandbookCategories: mocks.listHandbookCategories,
  listPublishedHandbookArticles: mocks.listPublishedHandbookArticles,
  getPublishedHandbookArticle: mocks.getPublishedHandbookArticle,
  updateHandbookArticleNavigation: mocks.updateHandbookArticleNavigation,
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
      const article = (await handbookArticleLoader(
        loaderArgs("/handbook/equipment-care", { slug: "equipment-care" })
      )) as { canEdit: boolean; isStudent: boolean };

      expect(index).toMatchObject({ canEdit, isStudent });
      expect(article).toMatchObject({ canEdit, isStudent });
      expect(mocks.listPublishedHandbookArticles).toHaveBeenCalledWith({
        organizationId: "ioio-team-1",
        query: "",
      });
      expect(mocks.listHandbookCategories).toHaveBeenCalledWith("ioio-team-1");
      expect(mocks.getPublishedHandbookArticle).toHaveBeenCalledWith({
        organizationId: "ioio-team-1",
        slug: "equipment-care",
        versionId: undefined,
        compareVersionId: undefined,
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
    });
  });

  it("lets Staff update category order while blocking Students", async () => {
    const createRequest = () => {
      const formData = new FormData();
      formData.set("intent", "set-start-here");
      formData.set("articleId", "article-1");
      return new Request("http://localhost/handbook", {
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

    const staffResult = await handbookIndexAction(
      createActionArgs(createRequest())
    );

    expect(mocks.updateHandbookArticleNavigation).toHaveBeenCalledWith({
      organizationId: "ioio-team-1",
      articleId: "article-1",
      intent: "set-start-here",
    });
    expect((staffResult as Response).headers.get("Location")).toBe("/handbook");

    vi.clearAllMocks();
    mocks.requirePermission.mockResolvedValue(
      handbookPermission("SELF_SERVICE")
    );
    const studentResult = await handbookIndexAction(
      createActionArgs(createRequest())
    );

    expect(mocks.updateHandbookArticleNavigation).not.toHaveBeenCalled();
    expect((studentResult as { init: { status: number } }).init.status).toBe(
      403
    );
  });
});
