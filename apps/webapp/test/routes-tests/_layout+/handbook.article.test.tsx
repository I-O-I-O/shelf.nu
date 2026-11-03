import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";

// why: the article-page test covers visible fields; Markdown parsing and route
// access are separate behaviors and are not needed to verify metadata output.
vi.mock("~/components/markdown/markdown-viewer", () => ({
  MarkdownViewer: ({ content }: { content: string }) => <div>{content}</div>,
}));
// why: this component test supplies loader data directly and must not access
// the database or perform authorization queries.
vi.mock("~/modules/ioio-handbook/service.server", () => ({
  getPublishedHandbookArticle: vi.fn(),
}));
vi.mock("~/modules/ioio-handbook/access.server", () => ({
  requireIoioHandbookRead: vi.fn(),
}));

import HandbookArticlePage from "~/routes/_layout+/handbook.$slug";

describe("published Handbook article page", () => {
  it("shows category, content, references, and version details without legacy metadata", async () => {
    const article = {
      id: "article-1",
      slug: "soldering-basics",
      updatedAt: new Date("2026-11-03T10:00:00.000Z"),
      handbookCategory: {
        id: "handbook-category-1",
        name: "Electronics Knowledge",
      },
      publishedVersion: {
        id: "version-1",
        versionNumber: 1,
        title: "Soldering Basics",
        summary: "Legacy summary should not appear",
        section: "Legacy section should not appear",
        content: "Basic soldering guide.",
        publishedAt: new Date("2026-11-03T10:00:00.000Z"),
        publishedByName: "IOIO Staff",
        sources: [
          {
            source: {
              id: "source-1",
              title: "example.com",
              url: "https://example.com/reference",
              kind: "EXTERNAL_REFERENCE",
            },
          },
        ],
      },
      versions: [
        {
          id: "version-1",
          versionNumber: 1,
          title: "Soldering Basics",
          publishedAt: new Date("2026-11-03T10:00:00.000Z"),
          publishedBy: "IOIO Staff",
        },
      ],
    };
    const router = createMemoryRouter(
      [
        {
          path: "/handbook/soldering-basics",
          loader: () => ({ article, canEdit: false }),
          Component: HandbookArticlePage,
        },
      ],
      { initialEntries: ["/handbook/soldering-basics"] }
    );

    render(<RouterProvider router={router} />);

    expect(await screen.findByText("Electronics Knowledge")).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Soldering Basics" })
    ).toBeTruthy();
    expect(screen.getByText("Basic soldering guide.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "example.com" })).toHaveAttribute(
      "href",
      "https://example.com/reference"
    );
    expect(screen.getByText(/Version 1 · Published/)).toBeTruthy();
    expect(screen.queryByText("Legacy summary should not appear")).toBeNull();
    expect(screen.queryByText("Legacy section should not appear")).toBeNull();
    expect(screen.queryByText("Related Shelf equipment")).toBeNull();
  });
});
