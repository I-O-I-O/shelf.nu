import { beforeEach, describe, expect, it, vi } from "vitest";
import { loader as handbookArticleLoader } from "~/routes/_layout+/handbook.$slug";
import { loader as handbookIndexLoader } from "~/routes/_layout+/handbook._index";

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  listPublishedHandbookArticles: vi.fn(),
  getPublishedHandbookArticle: vi.fn(),
}));

// why: access is controlled by Shelf's permission service, which is the input
// varied here to prove the Handbook routes accept both intended IOIO roles.
vi.mock("~/utils/roles.server", () => ({
  requirePermission: mocks.requirePermission,
}));

// why: these route tests verify role access and organization scoping, not the
// Handbook database query implementation.
vi.mock("~/modules/ioio-handbook/service.server", () => ({
  listPublishedHandbookArticles: mocks.listPublishedHandbookArticles,
  getPublishedHandbookArticle: mocks.getPublishedHandbookArticle,
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

describe("IOIO Handbook read access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requirePermission.mockImplementation(() =>
      Promise.resolve({ organizationId: "ioio-team-1", role: "ADMIN" })
    );
    mocks.listPublishedHandbookArticles.mockResolvedValue([]);
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
        Promise.resolve({ organizationId: "ioio-team-1", role })
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
        section: undefined,
      });
      expect(mocks.getPublishedHandbookArticle).toHaveBeenCalledWith({
        organizationId: "ioio-team-1",
        slug: "equipment-care",
        versionId: undefined,
      });
    }
  );

  it("keeps Handbook access unavailable to non-staff and non-student roles", async () => {
    mocks.requirePermission.mockResolvedValue({
      organizationId: "ioio-team-1",
      role: "BASE",
    });

    const result = await handbookIndexLoader(loaderArgs("/handbook")).catch(
      (reason: unknown) => reason
    );

    expect((result as { init: { status: number } }).init.status).toBe(403);
    expect(mocks.listPublishedHandbookArticles).not.toHaveBeenCalled();
  });
});
