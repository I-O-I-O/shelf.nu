import { undo, history } from "prosemirror-history";
import { schema } from "prosemirror-schema-basic";
import { EditorState, NodeSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { expect, it, vi } from "vitest";
import { imageBlockDropPlugin } from "./image-drop";

it("moves an image to the indicated block boundary and restores it with Undo without changing headings", () => {
  const image = schema.nodes.image.create({
    src: "/test-image.png",
    alt: "Example",
  });
  const paragraph = schema.nodes.paragraph;
  const doc = schema.nodes.doc.create(null, [
    paragraph.create(null, image),
    paragraph.create(null, schema.text("A")),
    schema.nodes.heading.create({ level: 2 }, schema.text("Section")),
    schema.nodes.heading.create({ level: 3 }, schema.text("Subsection")),
  ]);
  const plugin = imageBlockDropPlugin();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView(host, {
    state: EditorState.create({
      doc,
      selection: NodeSelection.create(doc, 1),
      plugins: [history(), plugin],
    }),
  });
  try {
    view.dragging = { slice: view.state.selection.content(), move: true };
    // why: Happy DOM has no layout; supply the browser's resolved pointer hit
    // inside paragraph A, leaving schema fitting and transactions real.
    view.posAtCoords = vi.fn(() => ({ pos: 4, inside: 3 }));
    const event = new MouseEvent("dragover", {
      clientY: 1,
      cancelable: true,
    }) as DragEvent;
    plugin.props.handleDOMEvents!.dragover!.call(plugin, view, event);
    expect(
      host.querySelector('[aria-hidden="true"]')?.getAttribute("style")
    ).toContain("border-top");
    expect(host.querySelector("img")?.getAttribute("style")).toContain(
      "opacity"
    );
    plugin.props.handleDrop!.call(
      plugin,
      view,
      event,
      view.dragging.slice,
      true
    );
    expect(view.state.doc.child(0).textContent).toBe("A");
    expect(view.state.doc.child(1).firstChild?.type.name).toBe("image");
    expect(view.state.doc.child(2).attrs.level).toBe(2);
    expect(view.state.doc.child(3).attrs.level).toBe(3);
    expect(undo(view.state, view.dispatch)).toBe(true);
    expect(view.state.doc.eq(doc)).toBe(true);
  } finally {
    view.destroy();
    host.remove();
  }
});
