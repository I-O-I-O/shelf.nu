import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";
import { HandbookEditor } from "./handbook-editor";

function renderEditor(
  article: Parameters<typeof HandbookEditor>[0]["article"] = null,
  categories: Array<{ id: string; name: string }> = [
    { id: "electronics", name: "Electronics" },
  ],
  isStudent = false,
  extraProps: Partial<Parameters<typeof HandbookEditor>[0]> = {},
  initialEntry = "/handbook/new"
) {
  const router = createMemoryRouter(
    [
      {
        path: "/handbook/*",
        Component: () => (
          <HandbookEditor
            article={article}
            categories={categories}
            isStudent={isStudent}
            {...extraProps}
          />
        ),
      },
    ],
    { initialEntries: [initialEntry] }
  );

  return render(<RouterProvider router={router} />);
}

describe("HandbookEditor", () => {
  it.each(["/handbook/new", "/handbook/what-3d-printing-is/edit"])(
    "fills the content canvas and focuses its blank edge at the end on %s",
    (path) => {
      renderEditor(null, undefined, false, {}, path);

      const canvas = screen.getByTestId("editor-v2-content");
      const contentPane = canvas.parentElement;
      const editorFrame = contentPane?.parentElement;
      const proseMirror = canvas.querySelector('[contenteditable="true"]');

      expect(editorFrame?.className).toContain("xl:items-stretch");
      expect(contentPane?.className).toContain("xl:flex-col");
      expect(canvas.className).toContain("xl:flex-1");
      expect(proseMirror?.className).toContain("xl:flex-1");

      fireEvent.mouseDown(canvas);
      expect(document.activeElement).toBe(proseMirror);
    }
  );

  it("remembers the editing tools preference and can restore the tools", async () => {
    const user = userEvent.setup();
    window.localStorage.removeItem("handbook.editor.tools.collapsed");
    const view = renderEditor();
    await user.click(screen.getByRole("button", { name: "Hide editor tools" }));
    expect(
      screen.getByRole("button", { name: "Show editor tools" })
    ).toHaveAttribute("aria-expanded", "false");
    expect(window.localStorage.getItem("handbook.editor.tools.collapsed")).toBe(
      "true"
    );
    view.unmount();
    renderEditor();
    await user.click(
      await screen.findByRole("button", { name: "Show editor tools" })
    );
    expect(
      screen.getByRole("button", { name: "Hide editor tools" })
    ).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "+ Section" })).toBeTruthy();
    window.localStorage.removeItem("handbook.editor.tools.collapsed");
  });

  it("shows visibility alongside the article fields and existing actions", () => {
    renderEditor();

    expect(
      screen.getByText(
        "Start typing to search existing categories. If no suitable category appears, type the new category name and choose “Create”."
      )
    ).toBeTruthy();
    expect(screen.getByLabelText("Title")).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Category" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Visibility" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Everyone" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Staff only" })).not.toBeChecked();
    expect(
      screen.getByRole("textbox", { name: "Article content" })
    ).toBeTruthy();
    expect(screen.queryByText(/\/\s*30,?000\b/u)).toBeNull();
    expect(
      screen.getByText(
        "Use Link for Handbook articles or external URLs. Use Section for a main article part and Subsection for a nested part. Type / to add blocks. Images may be up to 2 MB."
      )
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Inline code" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Insert image" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "+ Section" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "+ Subsection" })).toBeDisabled();
    expect(
      screen.getByRole("combobox", { name: "Text style" })
    ).toHaveTextContent("Section");
    expect(
      screen.getByRole("combobox", { name: "Text style" })
    ).toHaveTextContent("Subsection");
    expect(screen.getByLabelText(/External references/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Cancel" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save draft" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Publish article" })
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Submit for review" })
    ).toBeNull();

    expect(screen.queryByText("Short summary")).toBeNull();
    expect(screen.queryByText(/Related Shelf products/)).toBeNull();
    expect(screen.queryByText(/Related Shelf Kits/)).toBeNull();
  });

  it("lets Staff choose staff-only visibility and keeps the setting when editing", async () => {
    const user = userEvent.setup();
    renderEditor({
      id: "article-private",
      status: "PUBLISHED",
      staffOnly: true,
      draftTitle: "Printer maintenance procedure",
      draftContent: "Clean the nozzle.",
      handbookCategoryId: "electronics",
      draftSourceUrls: [],
      attachments: [],
      versions: [],
    });

    const staffOnly = screen.getByRole("radio", { name: "Staff only" });
    expect(staffOnly).toBeChecked();
    await user.click(screen.getByRole("radio", { name: "Everyone" }));
    expect(staffOnly).not.toBeChecked();
  });

  it("does not offer Students a staff-only visibility option", () => {
    renderEditor(null, undefined, true);

    expect(screen.getByText("Visibility")).toBeTruthy();
    expect(screen.getByText("Everyone")).toBeTruthy();
    expect(screen.queryByRole("radio", { name: "Staff only" })).toBeNull();
  });

  it("adds a section and nested subsection using the visible editor actions", async () => {
    const user = userEvent.setup();
    renderEditor();

    const editor = screen.getByTestId("editor-v2-content");
    await user.click(screen.getByRole("button", { name: "+ Section" }));
    expect(editor.querySelector("h2")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "+ Subsection" })
    ).not.toBeDisabled();

    await user.click(screen.getByRole("button", { name: "+ Subsection" }));
    expect(editor.querySelector("h3")).toBeTruthy();
    expect(
      screen.getByRole("group", { name: "Subsection controls" })
    ).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Rename" }));
    await user.type(
      screen.getByRole("textbox", { name: "Rename subsection" }),
      "Additive manufacturing"
    );
    await user.click(screen.getByRole("button", { name: "Save name" }));
    expect(editor.querySelector("h3")?.textContent).toBe(
      "Additive manufacturing"
    );
  });

  it("uses the same reduced fields when editing a draft", () => {
    renderEditor({
      id: "article-1",
      status: "DRAFT",
      draftTitle: "Soldering Basics",
      draftContent: "Basic soldering guide.",
      handbookCategoryId: "electronics",
      draftSourceUrls: ["https://example.com/reference"],
      attachments: [],
      versions: [],
    });

    expect(
      screen.getByRole("combobox", { name: "Category" })
    ).toHaveTextContent("Electronics");
    expect(screen.getByLabelText("Title")).toHaveValue("Soldering Basics");
    expect(
      screen.getByText(
        "Start typing to search existing categories. If no suitable category appears, type the new category name and choose “Create”."
      )
    ).toBeTruthy();
    expect(
      screen.getByRole("textbox", { name: "Article content" })
    ).toHaveTextContent("Basic soldering guide.");
    expect(screen.getByLabelText(/External references/)).toHaveValue(
      "https://example.com/reference"
    );
    expect(screen.queryByText("Short summary")).toBeNull();
    expect(screen.queryByText(/Related Shelf products/)).toBeNull();
    expect(screen.queryByText(/Related Shelf Kits/)).toBeNull();
  });

  it("lets an article editor remove a staged attachment", async () => {
    const user = userEvent.setup();
    const view = renderEditor({
      id: "article-1",
      status: "DRAFT",
      draftTitle: "Soldering Basics",
      draftContent: "Basic soldering guide.",
      handbookCategoryId: "electronics",
      draftSourceUrls: [],
      attachments: [
        {
          id: "source-1",
          title: "notes.txt",
          fileName: "notes.txt",
          fileSizeBytes: 12,
        },
      ],
      versions: [],
    });

    expect(
      view.container.querySelector('input[name="attachmentSourceId"]')
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Remove notes.txt" }));
    expect(
      view.container.querySelector('input[name="attachmentSourceId"]')
    ).toBeNull();
    expect(screen.getByLabelText("Upload files")).toBeTruthy();
  });

  it("loads the article form when the organization has zero Handbook categories", () => {
    renderEditor(null, []);

    expect(screen.getByLabelText("Title")).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Category" })).toBeTruthy();
    expect(
      screen.getByRole("textbox", { name: "Article content" })
    ).toBeTruthy();
  });

  it("creates a Staff category inline and remains in the article form", async () => {
    const user = userEvent.setup();
    const savedDrafts: FormData[] = [];
    const router = createMemoryRouter(
      [
        {
          path: "/handbook/new",
          // why: the in-memory action returns a canonical category without a
          // live database, so this test can verify the editor's inline flow.
          action: async ({ request }) => {
            const formData = await request.formData();
            if (formData.get("intent") === "create-category") {
              return {
                ok: true,
                category: {
                  id: "category-2",
                  name: String(formData.get("categoryName")),
                },
              };
            }
            savedDrafts.push(formData);
            return { ok: true };
          },
          Component: () => (
            <HandbookEditor article={null} categories={[]} isStudent={false} />
          ),
        },
      ],
      { initialEntries: ["/handbook/new"] }
    );
    render(<RouterProvider router={router} />);

    await user.click(screen.getByRole("combobox", { name: "Category" }));
    await user.type(
      await screen.findByRole("combobox", {
        name: "Search Handbook categories",
      }),
      "Laser Cutting"
    );
    await user.click(
      screen.getByRole("option", { name: 'Create "Laser Cutting"' })
    );

    expect(
      await screen.findByRole("combobox", { name: "Category" })
    ).toHaveTextContent("Laser Cutting");
    await user.type(screen.getByLabelText("Title"), "Laser Cutter Basics");
    await user.type(
      screen.getByRole("textbox", { name: "Article content" }),
      "Safe setup and cutting instructions."
    );
    await user.click(screen.getByRole("button", { name: "Save draft" }));

    await waitFor(() => expect(savedDrafts).toHaveLength(1));
    expect(savedDrafts[0]?.get("handbookCategoryId")).toBe("category-2");
    expect(savedDrafts[0]?.get("title")).toBe("Laser Cutter Basics");
    expect(router.state.location.pathname).toBe("/handbook/new");
    expect(
      screen.queryByRole("combobox", { name: "Search Handbook categories" })
    ).toBeNull();
  });

  it("gives Students a review action and no publish action", () => {
    renderEditor(null, [{ id: "electronics", name: "Electronics" }], true);

    expect(screen.getByRole("button", { name: "Save draft" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Submit for review" })
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Start typing to search existing categories. If no suitable category appears, type the new category name and choose “Propose”."
      )
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Publish/ })).toBeNull();
  });

  it("lets Students keep a missing category as a proposal", async () => {
    const user = userEvent.setup();
    renderEditor(null, [], true);

    await user.click(screen.getByRole("combobox", { name: "Category" }));
    await user.type(
      await screen.findByRole("combobox", {
        name: "Search Handbook categories",
      }),
      "Workshop Safety"
    );
    await user.click(
      screen.getByRole("option", { name: 'Propose "Workshop Safety"' })
    );

    expect(
      screen.getByRole("combobox", { name: "Category" })
    ).toHaveTextContent("Proposed: Workshop Safety");
    expect(
      screen.getByRole("button", { name: "Submit for review" })
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Publish article" })
    ).toBeNull();
  });

  it("shows relevant existing article titles while a new title is typed", async () => {
    const user = userEvent.setup();
    renderEditor(null, [{ id: "3d-printing", name: "3D Printing" }], false, {
      initialCategoryId: "3d-printing",
      titleMatches: [
        {
          slug: "change-filament",
          title: "How to change filament",
          handbookCategoryId: "3d-printing",
          categoryName: "3D Printing",
        },
      ],
    });

    await user.type(screen.getByLabelText("Title"), "How to change filament");

    expect(
      screen.getByText("Similar knowledge already exists in this category")
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "View article" }).getAttribute("href")
    ).toBe("/handbook/change-filament");
    expect(
      screen.getByRole("link", { name: "Edit article" }).getAttribute("href")
    ).toBe("/handbook/change-filament/edit?improve=1");
    expect(
      screen.getByRole("button", { name: "Publish article" })
    ).toBeTruthy();
  });

  it("prefills a revision editor from the selected published snapshot", () => {
    renderEditor(
      {
        id: "article-1",
        status: "PUBLISHED",
        draftTitle: "How to change filament",
        draftContent: "Open the latch and remove the filament.",
        handbookCategoryId: "electronics",
        revisionBaseVersionId: "version-2",
        draftSourceUrls: ["https://example.com/guide"],
        attachments: [],
        versions: [],
      },
      [{ id: "electronics", name: "Electronics" }],
      true,
      { revisionMode: true }
    );

    expect(
      screen.getByRole("heading", { name: "Edit Handbook article" })
    ).toBeTruthy();
    expect(screen.getByLabelText("Title")).toHaveValue(
      "How to change filament"
    );
    expect(
      screen.getByRole("textbox", { name: "Article content" })
    ).toHaveTextContent("Open the latch and remove the filament.");
    expect(screen.getByLabelText(/External references/)).toHaveValue(
      "https://example.com/guide"
    );
    expect(
      screen.getByRole("button", {
        name: "Submit for review",
      })
    ).toBeTruthy();
  });

  it("inserts a typed callout through the slash menu", async () => {
    const user = userEvent.setup();
    renderEditor();
    const editor = screen.getByRole("textbox", { name: "Article content" });

    await act(async () => {
      await user.type(editor, "/warn");
    });
    const warningOption = await screen.findByRole("option", {
      name: /Callout · Warning/,
    });
    await act(async () => {
      await user.click(warningOption);
    });

    expect(editor).toHaveTextContent("[!WARNING]");
    await waitFor(() =>
      expect(
        (screen.getByTestId("editor-v2-input") as HTMLTextAreaElement).value
      ).toContain("\\[!WARNING\\]")
    );
  });
});
