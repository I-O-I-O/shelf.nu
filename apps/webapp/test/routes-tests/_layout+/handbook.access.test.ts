import { createElement } from "react";
import { render, screen } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loader as handbookArticleLoader } from "~/routes/_layout+/handbook.$slug";
import HandbookIndexPage, {
  loader as handbookIndexLoader,
} from "~/routes/_layout+/handbook._index";

const mocks = vi.hoisted(() => ({
  requireIoioHandbookRead: vi.fn(),
  getHandbookIndex: vi.fn(),
  getHandbookArticleDetail: vi.fn(),
}));

// why: route tests supply a known Shelf permission result and avoid database access.
vi.mock("~/modules/ioio-handbook/access.server", () => ({
  requireIoioHandbookRead: mocks.requireIoioHandbookRead,
}));
// why: test route data wiring independently from the Handbook database service.
vi.mock("~/modules/ioio-handbook/handbook-index.server", () => ({
  getHandbookIndex: mocks.getHandbookIndex,
}));
// why: ensure page loaders do not import Claude review infrastructure.
vi.mock("~/modules/ioio-handbook/handbook-review.server", () => {
  throw new Error("Claude helper unavailable");
});
// why: article detail behavior is outside this index route test.
vi.mock("~/modules/ioio-handbook/workflow.server", () => ({
  getHandbookArticleDetail: mocks.getHandbookArticleDetail,
}));
// why: these view components are irrelevant to loader behavior and import browser-only dependencies.
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

function accessFor(role: string) {
  return {
    organizationId: "ioio-team-1",
    userId: "user-1",
    role,
    canEdit: role === "ADMIN" || role === "OWNER",
    isStudent: role === "SELF_SERVICE",
  };
}

const emptyHome = {
  articles: [],
  categories: [],
  topics: [],
};

describe("IOIO Handbook routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireIoioHandbookRead.mockResolvedValue(accessFor("ADMIN"));
    mocks.getHandbookIndex.mockResolvedValue(emptyHome);
    mocks.getHandbookArticleDetail.mockResolvedValue({
      id: "article-1",
      slug: "equipment-care",
      viewedVersion: { title: "Equipment care" },
      currentVersion: { title: "Equipment care" },
      history: [],
      isHistorical: false,
    });
  });

  it.each([
    ["ADMIN", true, false],
    ["OWNER", true, false],
    ["SELF_SERVICE", false, true],
  ])("loads current knowledge for %s", async (role, canEdit, isStudent) => {
    mocks.requireIoioHandbookRead.mockResolvedValue(accessFor(role));

    const index = (await handbookIndexLoader(loaderArgs("/handbook"))) as {
      canEdit: boolean;
      isStudent: boolean;
      articles: unknown[];
    };
    const article = (await handbookArticleLoader(
      loaderArgs("/handbook/equipment-care", { slug: "equipment-care" })
    )) as { canEdit: boolean; isStudent: boolean };

    expect(index).toMatchObject({ canEdit, isStudent, articles: [] });
    expect(article).toMatchObject({ canEdit, isStudent });
    expect(mocks.getHandbookIndex).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "ioio-team-1",
        query: "",
      })
    );
    expect(mocks.getHandbookArticleDetail).toHaveBeenCalledWith({
      organizationId: "ioio-team-1",
      slug: "equipment-care",
      versionId: undefined,
    });
  });

  it("renders a clear empty state for a new organization", async () => {
    const Stub = createRoutesStub([
      {
        path: "/handbook",
        Component: HandbookIndexPage,
        HydrateFallback: () => createElement("div", null, "Loading Handbook"),
        loader: () => ({
          ...emptyHome,
          canEdit: false,
          isStudent: true,
          articleTypes: ["Guide"],
          filters: {
            query: "",
            category: "",
            topic: "",
            type: "",
          },
        }),
      },
    ]);

    render(createElement(Stub, { initialEntries: ["/handbook"] }));

    expect(
      await screen.findByRole("heading", { name: "Handbook" })
    ).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "No articles yet" })
    ).toBeVisible();
  });
});
