/**
 * Finding the extent of the link under the cursor.
 *
 * The range decides what a link edit rewrites, so it has to stop where one link
 * ends and the next begins. Two links can sit immediately adjacent with no text
 * between them, and walking outward by mark TYPE cannot see that boundary: both
 * neighbours carry a link mark, so the range swallows both and editing one
 * silently rewrites the other.
 *
 * @see {@link file://./helpers.ts}
 */
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { describe, expect, it } from "vitest";

import {
  createEditorSchema,
  parseMarkdoc,
  serializeMarkdoc,
} from "~/modules/editor-v2/markdoc-utils";

import {
  createCalloutCommand,
  createSlashCommands,
  deleteHandbookHeadingCommand,
  findLinkRange,
  insertHandbookHeadingCommand,
  insertImageBlock,
  moveHandbookHeadingCommand,
  renameHandbookHeadingCommand,
  sanitizeHref,
} from "./helpers";

const schema = createEditorSchema();

/** A document from markdoc, with the cursor placed at `cursor`. */
function stateFor(markdoc: string, cursor: number) {
  const doc = parseMarkdoc(markdoc, schema);
  const state = EditorState.create({ doc, schema });

  return state.apply(
    state.tr.setSelection(TextSelection.create(state.doc, cursor))
  );
}

function selectHeading(state: EditorState, title: string) {
  let position = -1;
  state.doc.forEach((node, offset) => {
    if (node.type.name === "heading" && node.textContent === title) {
      position = offset + 1;
    }
  });
  if (position < 0) throw new Error(`Could not find heading: ${title}`);
  return state.apply(
    state.tr.setSelection(TextSelection.create(state.doc, position))
  );
}

function executeCommand(
  state: EditorState,
  command: (
    state: EditorState,
    dispatch?: (transaction: any) => void
  ) => boolean
) {
  let nextState = state;
  const handled = command(state, (transaction) => {
    nextState = state.apply(transaction);
  });
  return { handled, state: nextState };
}

function headingsIn(state: EditorState) {
  const headings: Array<{ level: number; title: string }> = [];
  state.doc.forEach((node) => {
    if (node.type.name === "heading") {
      headings.push({ level: node.attrs.level, title: node.textContent });
    }
  });
  return headings;
}

/** The text a link edit would rewrite, for the cursor at `cursor`. */
function rangeTextAt(markdoc: string, cursor: number) {
  const state = stateFor(markdoc, cursor);
  const range = findLinkRange(state, schema.marks.link);

  return range ? state.doc.textBetween(range.from, range.to) : null;
}

describe("findLinkRange", () => {
  it("covers the whole link the cursor sits in", () => {
    expect(rangeTextAt("[alpha](https://one.test)\n", 3)).toBe("alpha");
  });

  it("stops at the boundary between two adjacent links", () => {
    // No text separates them, so only the href tells them apart.
    const markdoc = "[alpha](https://one.test)[beta](https://two.test)\n";

    expect(rangeTextAt(markdoc, 3)).toBe("alpha");
  });

  it("finds the second of two adjacent links, not both", () => {
    const markdoc = "[alpha](https://one.test)[beta](https://two.test)\n";

    // "alpha" is 5 characters from position 1, so "beta" starts at 6.
    expect(rangeTextAt(markdoc, 8)).toBe("beta");
  });

  it("keeps a single link whole when its neighbour is plain text", () => {
    expect(rangeTextAt("see [alpha](https://one.test) now\n", 7)).toBe("alpha");
  });

  it("answers null when the cursor is not in a link", () => {
    expect(rangeTextAt("plain text only\n", 3)).toBeNull();
  });

  it("treats two runs sharing one href as a single link", () => {
    // Same destination, so there is no boundary to respect: an edit should cover
    // the whole thing rather than half of it.
    const markdoc = "[alpha](https://one.test)[beta](https://one.test)\n";

    expect(rangeTextAt(markdoc, 3)).toBe("alphabeta");
  });
});

describe("Handbook link serialization", () => {
  it("keeps internal targets relative and preserves selected link text", () => {
    const href = "/handbook/how-to-change-filament";
    expect(sanitizeHref(href)).toBe(href);
    expect(sanitizeHref("/handbook/../settings")).toBe("");

    const doc = parseMarkdoc("For more information, see this guide.\n", schema);
    let from = -1;
    let to = -1;
    doc.descendants((node, position) => {
      if (!node.isText || !node.text) return;
      const index = node.text.indexOf("this guide");
      if (index < 0) return;
      from = position + index;
      to = from + "this guide".length;
    });
    expect(from).toBeGreaterThanOrEqual(0);

    const state = EditorState.create({ doc, schema });
    const updated = state.tr.addMark(
      from,
      to,
      schema.marks.link.create({ href })
    );
    const serialized = serializeMarkdoc(state.apply(updated).doc, schema);

    expect(serialized).toContain(`[this guide](${href})`);
    expect(serialized).not.toContain("localhost");
  });

  it("keeps valid external URL behavior and rejects unsafe schemes", () => {
    expect(sanitizeHref("https://example.com/guide")).toBe(
      "https://example.com/guide"
    );
    expect(sanitizeHref("example.com/guide")).toBe("https://example.com/guide");
    expect(sanitizeHref("javascript:alert(1)")).toBe("");
  });
});

describe("Handbook editor commands", () => {
  it("offers clear Section and Subsection commands with the Handbook block set", () => {
    const commands = createSlashCommands(schema, {
      headingLevels: [2, 3],
      enableHandbookBlocks: true,
      onRequestImage: () => undefined,
    });

    expect(commands.map(({ label }) => label)).toEqual(
      expect.arrayContaining([
        "Text",
        "Section",
        "Subsection",
        "Callout · Note",
        "Callout · Tip",
        "Callout · Warning",
        "Callout · Important",
        "Code block",
        "Image",
      ])
    );
    expect(commands.some(({ label }) => label === "Heading 1")).toBe(false);
    expect(commands.some(({ label }) => label === "Heading 4")).toBe(false);
  });

  it("adds a Subsection inside its current Section and appends a new Section", () => {
    let state = stateFor(
      "## Introduction\nOverview.\n\n## Terminology\nDefinitions.\n",
      1
    );
    state = selectHeading(state, "Terminology");

    const subsection = executeCommand(
      state,
      insertHandbookHeadingCommand(schema, 3)
    );
    expect(subsection.handled).toBe(true);
    expect(headingsIn(subsection.state)).toEqual([
      { level: 2, title: "Introduction" },
      { level: 2, title: "Terminology" },
      { level: 3, title: "" },
    ]);
    expect(subsection.state.doc.textContent).toContain("Definitions.");

    const section = executeCommand(
      subsection.state,
      insertHandbookHeadingCommand(schema, 2)
    );
    expect(headingsIn(section.state)).toEqual([
      { level: 2, title: "Introduction" },
      { level: 2, title: "Terminology" },
      { level: 3, title: "" },
      { level: 2, title: "" },
    ]);
  });

  it("renames and reorders a complete section with its content", () => {
    let state = stateFor(
      "## Introduction\nOverview.\n\n## Terminology\nDefinitions.\n\n### Additive manufacturing\nLayers are added.\n\n## History\nHistorical context.\n",
      1
    );
    state = selectHeading(state, "History");
    state = executeCommand(state, moveHandbookHeadingCommand("up")).state;

    expect(headingsIn(state).map(({ title }) => title)).toEqual([
      "Introduction",
      "History",
      "Terminology",
      "Additive manufacturing",
    ]);
    expect(state.doc.textContent).toContain("Historical context.");
    expect(state.doc.textContent).toContain("Layers are added.");

    state = selectHeading(state, "History");
    state = executeCommand(
      state,
      renameHandbookHeadingCommand(schema, "Background")
    ).state;
    expect(headingsIn(state).map(({ title }) => title)).toContain("Background");

    state = selectHeading(state, "Terminology");
    state = executeCommand(state, deleteHandbookHeadingCommand()).state;
    expect(headingsIn(state).map(({ title }) => title)).toEqual([
      "Introduction",
      "Background",
    ]);
    expect(state.doc.textContent).not.toContain("Definitions.");
    expect(state.doc.textContent).not.toContain("Layers are added.");
  });

  it("moves a Subsection within its parent Section", () => {
    let state = stateFor(
      "## Terminology\nDefinitions.\n\n### Additive manufacturing\nLayers are added.\n\n### Subtractive manufacturing\nMaterial is removed.\n",
      1
    );
    state = selectHeading(state, "Additive manufacturing");
    state = executeCommand(state, moveHandbookHeadingCommand("down")).state;

    expect(headingsIn(state)).toEqual([
      { level: 2, title: "Terminology" },
      { level: 3, title: "Subtractive manufacturing" },
      { level: 3, title: "Additive manufacturing" },
    ]);
    expect(state.doc.textContent).toContain("Layers are added.");
    expect(state.doc.textContent).toContain("Material is removed.");
  });

  it("creates a typed callout using the normal Markdown document format", () => {
    const doc = parseMarkdoc("Make sure the printer is stopped.\n", schema);
    const state = EditorState.create({ doc, schema });
    let transaction = state.tr;

    expect(
      createCalloutCommand(schema, "WARNING")(state, (next) => {
        transaction = next;
      })
    ).toBe(true);

    expect(serializeMarkdoc(transaction.doc, schema)).toContain(
      "> \\[!WARNING\\] Make sure the printer is stopped."
    );
    expect(transaction.selection.$from.parentOffset).toBe("[!WARNING] ".length);
  });

  it("inserts an uploaded image as its own document block", () => {
    const doc = parseMarkdoc("First paragraph.\n\nNext paragraph.\n", schema);
    const state = EditorState.create({ doc, schema });
    const container = document.createElement("div");
    let view: EditorView;
    view = new EditorView(container, {
      state,
      dispatchTransaction(transaction) {
        view.updateState(view.state.apply(transaction));
      },
    });
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, 4))
    );

    expect(
      insertImageBlock(
        view,
        "/api/handbook-image?path=handbook/org/image.png",
        "Laser cutter"
      )
    ).toBe(true);

    const content = serializeMarkdoc(view.state.doc, schema);
    expect(content.indexOf("First paragraph.")).toBeLessThan(
      content.indexOf("![Laser cutter](/api/handbook-image")
    );
    expect(content.indexOf("![Laser cutter](/api/handbook-image")).toBeLessThan(
      content.indexOf("Next paragraph.")
    );
    view.destroy();
  });
});
