import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";

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

  it("shows a generated contents panel that links to article headings", async () => {
    const article = {
      id: "article-2",
      slug: "filament-guide",
      updatedAt: new Date("2026-11-03T10:00:00.000Z"),
      handbookCategory: { id: "category-1", name: "3D Printing" },
      publishedVersion: {
        id: "version-2",
        versionNumber: 2,
        title: "How to change filament",
        summary: null,
        section: null,
        content:
          "## Before you start\n\n### Check the display\n\n## Changing the filament\n\n### Remove the old filament\n\n## Safety",
        publishedAt: new Date("2026-11-03T10:00:00.000Z"),
        publishedByName: "IOIO Staff",
        sources: [],
      },
      versions: [
        {
          id: "version-2",
          versionNumber: 2,
          title: "How to change filament",
          publishedAt: new Date("2026-11-03T10:00:00.000Z"),
          publishedBy: "IOIO Staff",
        },
      ],
    };
    const router = createMemoryRouter(
      [
        {
          path: "/handbook/filament-guide",
          loader: () => ({ article, canEdit: false }),
          Component: HandbookArticlePage,
        },
      ],
      { initialEntries: ["/handbook/filament-guide"] }
    );

    render(<RouterProvider router={router} />);

    expect(await screen.findAllByText("Contents")).toHaveLength(2);
    expect(
      screen
        .getAllByRole("link", { name: "Before you start" })
        .some((link) => link.getAttribute("href") === "#before-you-start")
    ).toBe(true);
    expect(
      screen
        .getByRole("heading", { name: "Before you start" })
        .getAttribute("id")
    ).toBe("before-you-start");
    expect(
      screen
        .getAllByRole("link", { name: "Check the display" })
        .some((link) => link.getAttribute("href") === "#check-the-display")
    ).toBe(true);
  });

  it("renders a continuous structured article with nested contents links", async () => {
    const user = userEvent.setup();
    const article = {
      id: "article-3",
      slug: "what-3d-printing-is",
      updatedAt: new Date("2026-11-03T10:00:00.000Z"),
      handbookCategory: { id: "category-1", name: "3D Printing" },
      publishedVersion: {
        id: "version-3",
        versionNumber: 1,
        title: "What 3D printing is",
        summary: null,
        section: null,
        content: [
          "## Introduction",
          "Overview.",
          "## Terminology",
          "### Additive manufacturing",
          "Layers are added.",
          "### Subtractive manufacturing",
          "Material is removed.",
          "## History",
          "Historical context.",
          "## Benefits of 3D printing",
          "Benefits.",
          "## General principles",
          "Principles.",
          "## Processes",
          "Processes.",
          "## Applications",
          "Applications.",
          "## Health and safety",
          "Safety.",
          "## References",
          "A useful link.",
        ].join("\n"),
        publishedAt: new Date("2026-11-03T10:00:00.000Z"),
        publishedByName: "IOIO Staff",
        sources: [],
      },
      versions: [
        {
          id: "version-3",
          versionNumber: 1,
          title: "What 3D printing is",
          publishedAt: new Date("2026-11-03T10:00:00.000Z"),
          publishedBy: "IOIO Staff",
        },
      ],
    };
    const router = createMemoryRouter(
      [
        {
          path: "/handbook/what-3d-printing-is",
          loader: () => ({ article, canEdit: false }),
          Component: HandbookArticlePage,
        },
      ],
      { initialEntries: ["/handbook/what-3d-printing-is"] }
    );

    render(<RouterProvider router={router} />);

    const terminology = await screen.findByRole("heading", {
      name: "Terminology",
    });
    expect(terminology.closest("details")).toBeNull();
    expect(screen.getByText("Overview.")).toBeTruthy();
    expect(screen.getByText("Layers are added.")).toBeTruthy();
    expect(screen.getByText("Historical context.")).toBeTruthy();
    expect(screen.getByText("Safety.")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "History" })).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Additive manufacturing" })
    ).toHaveAttribute("id", "additive-manufacturing");

    await user.click(
      screen.getAllByRole("link", { name: "Additive manufacturing" }).at(-1)!
    );

    expect(window.location.hash).toBe("#additive-manufacturing");
    expect(
      screen
        .getAllByRole("link", { name: "Additive manufacturing" })
        .some((link) => link.getAttribute("aria-current") === "location")
    ).toBe(true);
    for (const title of [
      "Introduction",
      "Terminology",
      "Additive manufacturing",
      "Subtractive manufacturing",
      "History",
      "Benefits of 3D printing",
      "General principles",
      "Processes",
      "Applications",
      "Health and safety",
      "References",
    ]) {
      expect(
        screen
          .getAllByRole("link", { name: title })
          .some(
            (link) =>
              link.getAttribute("href") ===
              `#${title.toLowerCase().replaceAll(" ", "-")}`
          )
      ).toBe(true);
    }
  });

  it("shows deterministic section differences between selected versions", async () => {
    const article = {
      id: "article-4",
      slug: "what-3d-printing-is",
      updatedAt: new Date("2026-11-03T10:00:00.000Z"),
      handbookCategory: { id: "category-1", name: "3D Printing" },
      publishedVersion: {
        id: "version-2",
        versionNumber: 2,
        title: "What 3D printing is",
        summary: null,
        section: null,
        content:
          "## Terminology\nExpanded definitions.\n## FDM\nFilament is deposited.",
        publishedAt: new Date("2026-11-03T10:00:00.000Z"),
        publishedByName: "IOIO Staff",
        sources: [],
      },
      comparisonVersion: {
        id: "version-1",
        versionNumber: 1,
        title: "What 3D printing is",
        content: "## Terminology\nA short definition.",
        publishedAt: new Date("2026-11-02T10:00:00.000Z"),
        publishedByName: "IOIO Staff",
        sources: [],
      },
      versions: [
        {
          id: "version-2",
          versionNumber: 2,
          title: "What 3D printing is",
          publishedAt: new Date("2026-11-03T10:00:00.000Z"),
          publishedBy: "IOIO Staff",
        },
        {
          id: "version-1",
          versionNumber: 1,
          title: "What 3D printing is",
          publishedAt: new Date("2026-11-02T10:00:00.000Z"),
          publishedBy: "IOIO Staff",
        },
      ],
    };
    const router = createMemoryRouter(
      [
        {
          path: "/handbook/what-3d-printing-is",
          loader: () => ({ article, canEdit: false }),
          Component: HandbookArticlePage,
        },
      ],
      { initialEntries: ["/handbook/what-3d-printing-is"] }
    );

    render(<RouterProvider router={router} />);

    expect(
      await screen.findByRole("heading", { name: "v1 → v2 comparison" })
    ).toBeTruthy();
    expect(screen.getByText("Modified")).toBeTruthy();
    expect(screen.getByText("Added")).toBeTruthy();
    expect(screen.getAllByText("Terminology").length).toBeGreaterThan(0);
    expect(screen.getAllByText("FDM").length).toBeGreaterThan(0);
  });
});
