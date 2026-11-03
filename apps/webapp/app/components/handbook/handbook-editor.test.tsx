import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";
import { HandbookEditor } from "./handbook-editor";

function renderEditor(
  article: Parameters<typeof HandbookEditor>[0]["article"] = null,
  categories: Array<{ id: string; name: string }> = [
    { id: "electronics", name: "Electronics" },
  ]
) {
  const router = createMemoryRouter(
    [
      {
        path: "/handbook/new",
        Component: () => (
          <HandbookEditor article={article} categories={categories} />
        ),
      },
    ],
    { initialEntries: ["/handbook/new"] }
  );

  return render(<RouterProvider router={router} />);
}

describe("HandbookEditor", () => {
  it("shows only title, category, content, references, and the existing actions", () => {
    renderEditor();

    expect(screen.getByLabelText("Title")).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Category" })).toBeTruthy();
    expect(screen.getByLabelText(/Article content/)).toBeTruthy();
    expect(screen.getByLabelText(/External references/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Cancel" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save draft" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Publish article" })
    ).toBeTruthy();

    expect(screen.queryByText("Section")).toBeNull();
    expect(screen.queryByText("Short summary")).toBeNull();
    expect(screen.queryByText(/Related Shelf products/)).toBeNull();
    expect(screen.queryByText(/Related Shelf Kits/)).toBeNull();
  });

  it("uses the same reduced fields when editing a draft", () => {
    renderEditor({
      id: "article-1",
      status: "DRAFT",
      draftTitle: "Soldering Basics",
      draftContent: "Basic soldering guide.",
      handbookCategoryId: "electronics",
      draftSourceUrls: ["https://example.com/reference"],
      versions: [],
    });

    expect(
      screen.getByRole("combobox", { name: "Category" })
    ).toHaveTextContent("Electronics");
    expect(screen.queryByText("Section")).toBeNull();
    expect(screen.queryByText("Short summary")).toBeNull();
    expect(screen.queryByText(/Related Shelf products/)).toBeNull();
    expect(screen.queryByText(/Related Shelf Kits/)).toBeNull();
  });

  it("loads the article form when the organization has zero Handbook categories", () => {
    renderEditor(null, []);

    expect(screen.getByLabelText("Title")).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Category" })).toBeTruthy();
    expect(screen.getByLabelText(/Article content/)).toBeTruthy();
  });
});
