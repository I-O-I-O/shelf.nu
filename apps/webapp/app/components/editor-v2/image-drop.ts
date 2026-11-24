import { Fragment, Slice } from "prosemirror-model";
import type { Node } from "prosemirror-model";
import { NodeSelection, Plugin, PluginKey } from "prosemirror-state";
import { dropPoint } from "prosemirror-transform";
import { Decoration, DecorationSet } from "prosemirror-view";
import type { EditorView } from "prosemirror-view";

type ImageDrop = { position: number; source: number } | null;
const key = new PluginKey<ImageDrop>("image-block-drop");

function draggedImage(view: EditorView): Node | null {
  let node = view.dragging?.slice.content.firstChild;
  if (view.dragging?.slice.content.childCount !== 1) return null;
  if (node?.type.name === "paragraph" && node.childCount === 1) {
    node = node.firstChild;
  }
  return node?.type.name === "image" ? node : null;
}

function sourceSelection(view: EditorView) {
  return view.state.selection instanceof NodeSelection
    ? view.state.selection
    : null;
}

function blockTarget(view: EditorView, event: DragEvent, image: Node) {
  const hit = view.posAtCoords({ left: event.clientX, top: event.clientY });
  if (!hit) return null;
  const resolved = view.state.doc.resolve(hit.pos);
  let position = hit.pos;
  if (resolved.depth) {
    const before = resolved.before(1);
    const dom = view.nodeDOM(before);
    if (!(dom instanceof HTMLElement)) return null;
    const bounds = dom.getBoundingClientRect();
    position =
      event.clientY < (bounds.top + bounds.bottom) / 2
        ? before
        : resolved.after(1);
  }
  const block = view.state.schema.nodes.paragraph.create(null, image);
  return dropPoint(
    view.state.doc,
    position,
    new Slice(Fragment.from(block), 0, 0)
  );
}

/** Use ProseMirror positions, schema fitting, decorations and history for image
 * moves. The displayed boundary is also the exact destination of the drop. */
export function imageBlockDropPlugin() {
  return new Plugin<ImageDrop>({
    key,
    state: {
      init: () => null,
      apply(tr, previous) {
        const next = tr.getMeta(key) as ImageDrop | undefined;
        if (next !== undefined) return next;
        return tr.docChanged ? null : previous;
      },
    },
    props: {
      decorations(state) {
        const target = key.getState(state);
        if (!target) return null;
        const image = state.doc.nodeAt(target.source);
        const decorations = [
          Decoration.widget(
            target.position,
            () => {
              const marker = document.createElement("div");
              marker.contentEditable = "false";
              marker.setAttribute("aria-hidden", "true");
              marker.className = "pointer-events-none relative h-0 w-full";
              marker.style.cssText = "border-top:3px solid #b91c1c;z-index:10";
              return marker;
            },
            { side: -1, key: "image-drop-marker" }
          ),
        ];
        if (image?.type.name === "image") {
          decorations.push(
            Decoration.node(target.source, target.source + image.nodeSize, {
              style: "opacity:0.4;outline:2px solid #b91c1c;cursor:grabbing",
            })
          );
        }
        return DecorationSet.create(state.doc, decorations);
      },
      handleDOMEvents: {
        dragstart(view, event) {
          if (view.editable && event.target instanceof HTMLImageElement) {
            const position = view.posAtDOM(event.target, 0);
            if (view.state.doc.nodeAt(position)?.type.name === "image") {
              view.dispatch(
                view.state.tr.setSelection(
                  NodeSelection.create(view.state.doc, position)
                )
              );
            }
          }
          return false;
        },
        dragover(view, event) {
          const image = draggedImage(view);
          if (!image || !view.editable || !sourceSelection(view)) return false;
          event.preventDefault();
          const position = blockTarget(view, event, image);
          const target = key.getState(view.state);
          const source = sourceSelection(view)!.from;
          if (position === null) {
            if (target) view.dispatch(view.state.tr.setMeta(key, null));
          } else if (
            target?.position !== position ||
            target.source !== source
          ) {
            view.dispatch(view.state.tr.setMeta(key, { position, source }));
          }
          return true;
        },
        dragleave(view, event) {
          if (
            !view.dom.contains(event.relatedTarget as globalThis.Node | null)
          ) {
            view.dispatch(view.state.tr.setMeta(key, null));
          }
          return false;
        },
        dragend(view) {
          view.dispatch(view.state.tr.setMeta(key, null));
          return false;
        },
      },
      handleDrop(view, event, _slice, moved) {
        const image = draggedImage(view);
        const target = key.getState(view.state);
        if (!image || !target || !sourceSelection(view)) return false;
        event.preventDefault();
        const tr = view.state.tr;
        if (moved) {
          const { $from, from, to } = sourceSelection(view)!;
          if ($from.depth === 1 && $from.parent.childCount === 1) {
            tr.delete($from.before(1), $from.after(1));
          } else {
            tr.delete(from, to);
          }
        }
        const destination = tr.mapping.map(target.position);
        tr.insert(
          destination,
          view.state.schema.nodes.paragraph.create(null, image)
        );
        tr.setSelection(NodeSelection.create(tr.doc, destination + 1));
        view.dispatch(tr.setMeta(key, null).scrollIntoView());
        view.focus();
        return true;
      },
    },
  });
}
