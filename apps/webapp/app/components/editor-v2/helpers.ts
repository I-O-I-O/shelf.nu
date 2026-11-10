import {
  toggleMark,
  setBlockType,
  wrapIn,
  baseKeymap,
} from "prosemirror-commands";
import { history, redo, undo } from "prosemirror-history";
import {
  InputRule,
  inputRules,
  smartQuotes,
  textblockTypeInputRule,
  wrappingInputRule,
} from "prosemirror-inputrules";
import { keymap } from "prosemirror-keymap";
import {
  Fragment,
  type MarkType,
  type Node as ProseMirrorNode,
  type Schema,
} from "prosemirror-model";
import {
  wrapInList,
  liftListItem,
  sinkListItem,
  splitListItem,
} from "prosemirror-schema-list";
import { Plugin } from "prosemirror-state";
import {
  Selection,
  NodeSelection,
  TextSelection,
  type Command as PMCommand,
  type EditorState,
} from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { Decoration, DecorationSet } from "prosemirror-view";
import { isInternalPath } from "~/utils/safe-internal-path";

import type { SlashCommandItem, ToolbarBlock } from "./types";

export const EDITOR_BASE_CLASS =
  "pm-doc pm--editing max-w-none min-h-[200px] bg-transparent";
export const EDITOR_DISABLED_CLASS = "pointer-events-none opacity-60";

export const placeholderPluginKey = new Plugin({
  props: {
    decorations(state) {
      const placeholder = (state as any).placeholder as string | undefined;
      if (!placeholder) {
        return null;
      }
      const docIsEmpty =
        state.doc.childCount === 1 &&
        state.doc.firstChild?.type.name === "paragraph" &&
        state.doc.firstChild.childCount === 0;
      if (!docIsEmpty) {
        return null;
      }
      const deco = Decoration.widget(1, () => {
        const span = document.createElement("span");
        span.className = "pointer-events-none text-sm text-gray-400";
        span.textContent = placeholder;
        return span;
      });
      return DecorationSet.create(state.doc, [deco]);
    },
  },
}) as Plugin & {
  props: {
    decorations: (
      state: EditorState & { placeholder?: string }
    ) => DecorationSet | null;
  };
};

export function createInputRules(schema: Schema) {
  const rules = [
    textblockTypeInputRule(/^(#{1,4})\s$/, schema.nodes.heading, (match) => ({
      level: match[1].length,
    })),
    wrappingInputRule(/^>\s$/, schema.nodes.blockquote),
    wrappingInputRule(/^[*-]\s$/, schema.nodes.bullet_list),
    wrappingInputRule(/^(\d+)\.\s$/, schema.nodes.ordered_list, (match) => ({
      order: Number.parseInt(match[1], 10),
    })),
  ];

  if (schema.nodes.horizontal_rule) {
    const horizontalRule = schema.nodes.horizontal_rule;
    rules.push(
      new InputRule(/^---$/, (state, _match, start, end) => {
        const { tr } = state;
        const from = Math.max(0, start - 1);
        return tr.replaceWith(from, end, horizontalRule.create());
      })
    );
  }

  return [...smartQuotes, ...rules];
}

export function markIsActive(state: EditorState, mark: string) {
  const { from, $from, to, empty } = state.selection;
  if (empty) {
    return (
      (!!mark &&
        !!state.storedMarks?.some((stored) => stored.type.name === mark)) ||
      $from.marks().some((stored) => stored.type.name === mark)
    );
  }
  return state.doc.rangeHasMark(from, to, state.schema.marks[mark]);
}

export function getBlockFromState(state: EditorState): ToolbarBlock {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    if (node.type.name === "bullet_list") {
      return "bullet_list";
    }
    if (node.type.name === "ordered_list") {
      return "ordered_list";
    }
    if (node.type.name === "blockquote") {
      return "blockquote";
    }
  }

  const parent = $from.parent;
  if (parent.type.name === "heading") {
    const level = Math.min(Math.max(parent.attrs.level ?? 1, 1), 4);
    return `heading${level}` as ToolbarBlock;
  }
  if (parent.type.name === "raw_block") {
    return "raw_block";
  }
  return "paragraph";
}

export function createHorizontalRuleCommand(schema: Schema): PMCommand {
  return (state, dispatch) => {
    const hr = schema.nodes.horizontal_rule;
    if (!hr) return false;
    if (dispatch) {
      const tr = state.tr.replaceSelectionWith(hr.create());
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

type HandbookHeadingContext = {
  level: 2 | 3;
  title: string;
  index: number;
  canMoveUp: boolean;
  canMoveDown: boolean;
  canAddSubsection: boolean;
};

function isHandbookHeading(node: ProseMirrorNode | undefined) {
  return (
    node?.type.name === "heading" &&
    (node.attrs.level === 2 || node.attrs.level === 3)
  );
}

function getTopLevelNodes(doc: ProseMirrorNode) {
  const nodes: ProseMirrorNode[] = [];
  doc.forEach((node) => nodes.push(node));
  return nodes;
}

function findPreviousHeading(
  nodes: ProseMirrorNode[],
  start: number,
  level: 2 | 3,
  lowerBound = 0
) {
  for (let index = start - 1; index >= lowerBound; index -= 1) {
    if (
      isHandbookHeading(nodes[index]) &&
      nodes[index]?.attrs.level === level
    ) {
      return index;
    }
  }
  return -1;
}

function findNextHeading(
  nodes: ProseMirrorNode[],
  start: number,
  level: 2 | 3,
  upperBound = nodes.length
) {
  for (let index = start + 1; index < upperBound; index += 1) {
    if (
      isHandbookHeading(nodes[index]) &&
      nodes[index]?.attrs.level === level
    ) {
      return index;
    }
  }
  return -1;
}

function getSectionBounds(nodes: ProseMirrorNode[], index: number) {
  const sectionIndex =
    nodes[index]?.attrs.level === 2
      ? index
      : findPreviousHeading(nodes, index + 1, 2);
  if (sectionIndex < 0) return null;
  const nextSection = findNextHeading(nodes, sectionIndex, 2);
  return {
    start: sectionIndex,
    end: nextSection < 0 ? nodes.length : nextSection,
  };
}

function getHeadingAtSelection(state: EditorState) {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    if (
      node.type.name === "heading" &&
      (node.attrs.level === 2 || node.attrs.level === 3)
    ) {
      return { node, depth, index: $from.index(0) };
    }
  }
  return null;
}

/** Returns controls for the H2/H3 block under the editor selection. */
export function getHandbookHeadingContext(
  state: EditorState
): HandbookHeadingContext | null {
  const selected = getHeadingAtSelection(state);
  if (!selected || selected.depth !== 1) return null;
  const nodes = getTopLevelNodes(state.doc);
  const level = selected.node.attrs.level as 2 | 3;
  const section = getSectionBounds(nodes, selected.index);
  if (level === 2) {
    const previous = findPreviousHeading(nodes, selected.index, 2);
    const next = findNextHeading(nodes, selected.index, 2);
    return {
      level,
      title: selected.node.textContent,
      index: selected.index,
      canMoveUp: previous >= 0,
      canMoveDown: next >= 0,
      canAddSubsection: true,
    };
  }
  if (!section) return null;
  const previous = findPreviousHeading(
    nodes,
    selected.index,
    3,
    section.start + 1
  );
  const next = findNextHeading(nodes, selected.index, 3, section.end);
  return {
    level,
    title: selected.node.textContent,
    index: selected.index,
    canMoveUp: previous >= 0,
    canMoveDown: next >= 0,
    canAddSubsection: true,
  };
}

export function canAddHandbookSubsection(state: EditorState) {
  const nodes = getTopLevelNodes(state.doc);
  const index = state.selection.$from.index(0);
  return Boolean(getSectionBounds(nodes, index));
}

function applyDocumentChildren(
  state: EditorState,
  dispatch: ((transaction: any) => void) | undefined,
  nodes: ProseMirrorNode[],
  focusNode?: ProseMirrorNode
) {
  if (!dispatch) return true;
  const content = nodes.length ? Fragment.fromArray(nodes) : null;
  const nextContent =
    content ?? Fragment.from(state.schema.nodes.paragraph.create());
  const transaction = state.tr.replaceWith(
    0,
    state.doc.content.size,
    nextContent
  );
  if (focusNode) {
    const index = nodes.indexOf(focusNode);
    let position = 0;
    for (let cursor = 0; cursor < index; cursor += 1) {
      position += nodes[cursor]!.nodeSize;
    }
    transaction.setSelection(
      TextSelection.near(transaction.doc.resolve(position + 1))
    );
  }
  dispatch(transaction.scrollIntoView());
  return true;
}

function swapDocumentRanges(
  nodes: ProseMirrorNode[],
  firstStart: number,
  firstEnd: number,
  secondEnd: number
) {
  return [
    ...nodes.slice(0, firstStart),
    ...nodes.slice(firstEnd, secondEnd),
    ...nodes.slice(firstStart, firstEnd),
    ...nodes.slice(secondEnd),
  ];
}

/** Appends a Section, or adds a Subsection at the end of the current section. */
export function insertHandbookHeadingCommand(
  schema: Schema,
  level: 2 | 3
): PMCommand {
  return (state, dispatch) => {
    const nodes = getTopLevelNodes(state.doc);
    let insertIndex = nodes.length;
    if (
      level === 2 &&
      nodes.length === 1 &&
      nodes[0]?.type.name === "paragraph" &&
      nodes[0].content.size === 0
    ) {
      const heading = schema.nodes.heading.create({ level });
      nodes[0] = heading;
      if (!dispatch) return true;
      const transaction = state.tr.replaceWith(
        0,
        state.doc.content.size,
        Fragment.fromArray(nodes)
      );
      transaction.setSelection(TextSelection.create(transaction.doc, 1));
      dispatch(transaction.scrollIntoView());
      return true;
    }
    if (level === 3) {
      const selectedIndex = state.selection.$from.index(0);
      const section = getSectionBounds(nodes, selectedIndex);
      if (!section) return false;
      insertIndex = section.end;
    }
    const heading = schema.nodes.heading.create({ level });
    nodes.splice(insertIndex, 0, heading);
    if (!dispatch) return true;
    const transaction = state.tr.replaceWith(
      0,
      state.doc.content.size,
      Fragment.fromArray(nodes)
    );
    let position = 0;
    for (let index = 0; index < insertIndex; index += 1) {
      position += nodes[index]!.nodeSize;
    }
    transaction.setSelection(
      TextSelection.create(transaction.doc, position + 1)
    );
    dispatch(transaction.scrollIntoView());
    return true;
  };
}

/** Renames the selected Section or Subsection without changing its content. */
export function renameHandbookHeadingCommand(
  schema: Schema,
  title: string
): PMCommand {
  return (state, dispatch) => {
    const selected = getHeadingAtSelection(state);
    if (!selected || selected.depth !== 1 || !title.trim()) return false;
    const nodes = getTopLevelNodes(state.doc);
    const replacement = schema.nodes.heading.create(
      { level: selected.node.attrs.level },
      schema.text(title.trim())
    );
    nodes[selected.index] = replacement;
    return applyDocumentChildren(state, dispatch, nodes, replacement);
  };
}

/** Moves the selected heading together with all blocks that belong to it. */
export function moveHandbookHeadingCommand(
  direction: "up" | "down"
): PMCommand {
  return (state, dispatch) => {
    const selected = getHeadingAtSelection(state);
    if (!selected || selected.depth !== 1) return false;
    const nodes = getTopLevelNodes(state.doc);
    const level = selected.node.attrs.level as 2 | 3;
    const section = getSectionBounds(nodes, selected.index);
    const unitStart = selected.index;
    const unitEndHeading =
      level === 2
        ? findNextHeading(nodes, unitStart, 2)
        : section
        ? findNextHeading(nodes, unitStart, 3, section.end)
        : -1;
    const unitEnd =
      unitEndHeading < 0
        ? level === 3 && section
          ? section.end
          : nodes.length
        : unitEndHeading;
    let moved: ProseMirrorNode[] | null = null;
    if (direction === "up") {
      const previousStart = findPreviousHeading(
        nodes,
        unitStart,
        level,
        level === 3 && section ? section.start + 1 : 0
      );
      if (previousStart < 0) return false;
      moved = swapDocumentRanges(nodes, previousStart, unitStart, unitEnd);
    } else {
      const nextStart = unitEndHeading;
      if (nextStart < 0) return false;
      const nextEndHeading =
        level === 2
          ? findNextHeading(nodes, nextStart, 2)
          : section
          ? findNextHeading(nodes, nextStart, 3, section.end)
          : -1;
      const nextEnd =
        nextEndHeading < 0
          ? level === 3 && section
            ? section.end
            : nodes.length
          : nextEndHeading;
      moved = swapDocumentRanges(nodes, unitStart, unitEnd, nextEnd);
    }
    return applyDocumentChildren(state, dispatch, moved, selected.node);
  };
}

/** Deletes the selected heading and its body (or its subsection body). */
export function deleteHandbookHeadingCommand(): PMCommand {
  return (state, dispatch) => {
    const selected = getHeadingAtSelection(state);
    if (!selected || selected.depth !== 1) return false;
    const nodes = getTopLevelNodes(state.doc);
    const level = selected.node.attrs.level as 2 | 3;
    const section = getSectionBounds(nodes, selected.index);
    const nextHeading =
      level === 2
        ? findNextHeading(nodes, selected.index, 2)
        : section
        ? findNextHeading(nodes, selected.index, 3, section.end)
        : -1;
    const end =
      nextHeading < 0
        ? level === 3 && section
          ? section.end
          : nodes.length
        : nextHeading;
    nodes.splice(selected.index, end - selected.index);
    return applyDocumentChildren(state, dispatch, nodes);
  };
}

export function sanitizeHref(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";

  if (trimmed.startsWith("/handbook/")) {
    try {
      const url = new URL(trimmed, "https://internal.invalid");
      if (
        isInternalPath(trimmed) &&
        url.pathname.startsWith("/handbook/") &&
        url.pathname !== "/handbook/"
      ) {
        return `${url.pathname}${url.search}${url.hash}`;
      }
      return "";
    } catch {
      return "";
    }
  }

  const allowedProtocols = new Set(["http:", "https:", "mailto:", "tel:"]);

  try {
    const hasProtocol = /^[a-z]+:/i.test(trimmed);
    const url = new URL(hasProtocol ? trimmed : `https://${trimmed}`);
    if (!allowedProtocols.has(url.protocol)) {
      return "";
    }
    if (
      !hasProtocol &&
      (url.protocol === "http:" || url.protocol === "https:")
    ) {
      return url.href;
    }
    return trimmed;
  } catch {
    return "";
  }
}

/**
 * The extent of the link the cursor sits in.
 *
 * The caller both reads the href from this range and re-marks the whole of it,
 * so the range has to end where the link does. Two links can sit immediately
 * adjacent with no text between them, and the only thing separating them is the
 * href: walking outward by mark TYPE cannot see that boundary, because both
 * neighbours carry a link mark. The walk therefore compares against the cursor's
 * own mark, whose `eq` includes the attributes, so it stops at a change of
 * destination. Two runs sharing one href are one link and stay whole.
 *
 * @param state - The editor state, whose selection locates the link
 * @param linkType - The schema's link mark type
 * @returns The range to edit, or null when the cursor is not in a link
 */
export function findLinkRange(state: EditorState, linkType: MarkType) {
  const { from, to, empty, $from } = state.selection;
  if (!empty) {
    return state.doc.rangeHasMark(from, to, linkType) ? { from, to } : null;
  }

  const mark = linkType.isInSet(state.storedMarks || $from.marks());
  if (!mark) {
    return null;
  }

  let start = from;
  while (start > 0 && state.doc.rangeHasMark(start - 1, start, mark)) {
    start -= 1;
  }

  let end = from;
  while (
    end < state.doc.content.size &&
    state.doc.rangeHasMark(end, end + 1, mark)
  ) {
    end += 1;
  }

  return start === end ? null : { from: start, to: end };
}

export function buildKeymap(schema: Schema, openLinkDialog: () => void) {
  const hardBreak = (state: EditorState, dispatch?: (tr: any) => void) => {
    const br = schema.nodes.hard_break;
    if (!br) return false;
    if (dispatch) {
      dispatch(state.tr.replaceSelectionWith(br.create()).scrollIntoView());
    }
    return true;
  };

  const linkCommand: PMCommand = () => {
    openLinkDialog();
    return true;
  };

  const bindings = {
    "Mod-b": toggleMark(schema.marks.strong),
    "Mod-B": toggleMark(schema.marks.strong),
    "Mod-i": toggleMark(schema.marks.em),
    "Mod-I": toggleMark(schema.marks.em),
    "Mod-k": linkCommand,
    "Mod-K": linkCommand,
    Enter: splitListItem(schema.nodes.list_item),
    "Shift-Enter": hardBreak,
    "Mod-Enter": hardBreak,
    "Mod-z": undo,
    "Mod-y": redo,
    "Mod-Shift-z": redo,
    "Shift-Tab": liftListItem(schema.nodes.list_item),
    Tab: sinkListItem(schema.nodes.list_item),
  } as Record<string, PMCommand>;

  return [keymap(bindings), keymap(baseKeymap)];
}

export interface SlashCommandOptions {
  headingLevels?: number[];
  enableHandbookBlocks?: boolean;
  onRequestImage?: () => void;
}

export function createSlashCommands(
  schema: Schema,
  options: SlashCommandOptions = {}
): SlashCommandItem[] {
  const headingLevels = options.headingLevels ?? [1, 2, 3, 4];
  const commands: SlashCommandItem[] = [
    {
      id: "paragraph",
      label: options.enableHandbookBlocks ? "Text" : "Paragraph",
      description: "Normal text",
      aliases: ["p", "text"],
      command: setBlockType(schema.nodes.paragraph),
    },
    ...headingLevels.map((level) => ({
      id: `heading${level}`,
      label:
        options.enableHandbookBlocks && level === 2
          ? "Section"
          : options.enableHandbookBlocks && level === 3
          ? "Subsection"
          : level === 2
          ? "Heading 2"
          : level === 3
          ? "Heading 3"
          : `Heading ${level}`,
      description: level === 2 ? "Main article section" : "Article subsection",
      aliases: [`h${level}`],
      command: setBlockType(schema.nodes.heading, { level }),
    })),
    {
      id: "bullet_list",
      label: "Bulleted list",
      description: "Create a simple bullet list",
      aliases: ["ul", "list"],
      command: wrapInList(schema.nodes.bullet_list),
    },
    {
      id: "ordered_list",
      label: "Numbered list",
      description: "Create a numbered list",
      aliases: ["ol", "1."],
      command: wrapInList(schema.nodes.ordered_list),
    },
    {
      id: "blockquote",
      label: "Quote",
      description: "Highlight supporting text",
      aliases: ["quote", "blockquote"],
      command: wrapIn(schema.nodes.blockquote),
    },
  ];

  if (schema.nodes.horizontal_rule) {
    commands.push({
      id: "horizontal_rule",
      label: "Divider",
      description: "Insert a horizontal divider",
      aliases: ["divider", "hr"],
      command: createHorizontalRuleCommand(schema),
    });
  }

  if (options.enableHandbookBlocks) {
    commands.push(
      ...(["NOTE", "TIP", "WARNING", "IMPORTANT"] as const).map((kind) => ({
        id: `callout_${kind.toLocaleLowerCase("en")}`,
        label: `Callout · ${kind[0]}${kind.slice(1).toLocaleLowerCase("en")}`,
        description: `Insert a ${kind.toLocaleLowerCase("en")} callout block`,
        aliases: ["callout", kind.toLocaleLowerCase("en")],
        command: createCalloutCommand(schema, kind),
      })),
      {
        id: "code_block",
        label: "Code block",
        description: "Insert formatted code or commands",
        aliases: ["code", "snippet"],
        command: setBlockType(schema.nodes.code_block),
      }
    );
  }

  if (options.onRequestImage) {
    commands.push({
      id: "image",
      label: "Image",
      description: "Upload an image into the article",
      aliases: ["photo", "picture"],
      command: () => {
        options.onRequestImage?.();
        return true;
      },
    });
  }

  return commands;
}

export function createCalloutCommand(
  schema: Schema,
  kind: "NOTE" | "TIP" | "WARNING" | "IMPORTANT" = "NOTE"
): PMCommand {
  return (state, dispatch) => {
    const parent = state.selection.$from.parent;
    const depth = state.selection.$from.depth;
    if (!parent.isTextblock || depth < 1) return false;

    const marker = `[!${kind}] `;
    const paragraph = schema.nodes.paragraph.create(
      null,
      Fragment.fromArray([schema.text(marker), ...parent.content.content])
    );
    const callout = schema.nodes.blockquote.create(null, paragraph);
    const from = state.selection.$from.before(depth);
    const tr = state.tr.replaceWith(from, from + parent.nodeSize, callout);
    const cursor = Math.min(from + 2 + marker.length, tr.doc.content.size);
    tr.setSelection(Selection.near(tr.doc.resolve(cursor)));
    dispatch?.(tr.scrollIntoView());
    return true;
  };
}

export function insertImageBlock(view: EditorView, src: string, alt: string) {
  const { state } = view;
  const image = state.schema.nodes.image.create({ src, alt, title: alt });
  if (
    state.selection instanceof NodeSelection &&
    state.selection.node.type === state.schema.nodes.image
  ) {
    view.dispatch(state.tr.replaceSelectionWith(image).scrollIntoView());
    view.focus();
    return true;
  }
  const depth = state.selection.$from.depth;
  if (depth < 1) return false;

  const currentBlock = state.selection.$from.node(depth);
  const blockPosition = state.selection.$from.before(depth);
  const imageParagraph = state.schema.nodes.paragraph.create(null, image);
  const blankParagraph = state.schema.nodes.paragraph.create();
  const tr = state.tr.insert(
    blockPosition + currentBlock.nodeSize,
    Fragment.fromArray([imageParagraph, blankParagraph])
  );
  const cursor =
    blockPosition + currentBlock.nodeSize + imageParagraph.nodeSize + 1;
  tr.setSelection(Selection.near(tr.doc.resolve(cursor)));
  view.dispatch(tr.scrollIntoView());
  view.focus();
  return true;
}

/** Insert a pasted image at the selection, replacing it when an image is selected. */
export function insertImageAtSelection(
  view: EditorView,
  src: string,
  alt: string,
  selection = view.state.selection
) {
  const image = view.state.schema.nodes.image.create({ src, alt, title: alt });
  const tr = view.state.tr.setSelection(selection).replaceSelectionWith(image);
  view.dispatch(tr.scrollIntoView());
  view.focus();
  return true;
}

export function filterSlashCommands(
  commands: SlashCommandItem[],
  query: string
) {
  if (!query) {
    return commands;
  }
  const normalized = query.toLowerCase();
  return commands.filter((command) => {
    if (command.label.toLowerCase().includes(normalized)) {
      return true;
    }
    return command.aliases.some((alias) =>
      alias.toLowerCase().includes(normalized)
    );
  });
}

export function createInputPlugins(schema: Schema, openLinkDialog: () => void) {
  return [
    history(),
    inputRules({ rules: createInputRules(schema) }),
    ...buildKeymap(schema, openLinkDialog),
  ];
}
