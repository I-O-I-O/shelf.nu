# Editor V2 Schema Mapping

The Editor V2 ProseMirror schema intentionally mirrors the Markdown/Markdoc nodes that we already support in Shelf. The goal is to guarantee a lossless round-trip when converting between Markdoc and ProseMirror, while also preserving unsupported blocks verbatim via the raw block node.

## Block Nodes

| ProseMirror Node       | Markdown/Markdoc Equivalent  | Notes                                      |
| ---------------------- | ---------------------------- | ------------------------------------------ |
| `doc`                  | document root                | unchanged                                  |
| `paragraph`            | paragraph (`<p>`)            | default block                              |
| `heading` (level 1–4)  | `#`–`####`                   | limited to 4 levels to match product needs |
| `bullet_list`          | unordered list (`-` / `*`)   | child nodes are `list_item`                |
| `ordered_list`         | ordered list (`1.` etc.)     | supports `order` attribute from Markdown   |
| `list_item`            | list item                    | used inside ordered/bullet lists           |
| `blockquote`           | blockquote (`>`)             | wraps paragraphs or other blocks           |
| `horizontal_rule`      | divider (`---`)              | serialized as `---`                        |
| `code_block` (`fence`) | fenced code block (`\`\`\``) | optional language attribute preserved      |
| `raw_block`            | unsupported Markdoc nodes    | stores untouched source text               |

## Inline Nodes / Marks

| ProseMirror Mark | Markdown/Markdoc Syntax | Notes                          |
| ---------------- | ----------------------- | ------------------------------ |
| `strong`         | `**bold**`              | keyboard shortcut `Cmd/Ctrl+B` |
| `em`             | `*italic*`              | keyboard shortcut `Cmd/Ctrl+I` |
| `code`           | `` `inline code` ``     | styled inline node             |
| `link`           | `[text](url)`           | sanitized URL, optional dialog |

## Handbook Profile

The Handbook uses this existing editor and keeps Markdown/Markdoc as its
canonical revision content. The title stays outside the body. Its editor
controls offer Heading 2 for article sections and Heading 3 for subsections;
the shared schema continues to parse older Heading 1 and Heading 4 content.

Handbook callouts use a normal blockquote with a deterministic marker at the
start of its first paragraph:

```md
> [!WARNING] Stop the printer before clearing the nozzle.
```

The reader recognizes NOTE, TIP, WARNING, and IMPORTANT markers and styles the
blockquote as a callout. Handbook images use ordinary Markdown image syntax,
with the source pointing to an organization-scoped Shelf Storage object through
the Handbook image route. Image bytes are never stored in article content.

PDF import continues to produce this same Markdown content. No heading,
section, or image database records are created. The Handbook editor preserves
unsupported existing Markdoc blocks but disables their raw-source editor.

## Raw Blocks

Unsupported Markdoc tags and custom components are normalized into placeholder
paragraphs during parsing. After the Markdown is parsed, placeholders are
replaced with dedicated `raw_block` nodes whose `raw` attribute stores the
original Markdoc snippet. Serializing the document writes the raw text back
verbatim, preserving whitespace and structure.

Raw blocks are rendered in the shared editor as bordered, monospace boxes with
an “Edit source” button. Editing the block opens a dialog where the raw Markdoc
can be updated directly. The Handbook editor uses the same parser and preserves
these blocks, but disables raw-source editing.

## Input Rules and Shortcuts

Common Markdown triggers map to their respective node transformations:

- `#`, `##`, `###`, `####` → headings 1–4
- `- ` / `* ` → bullet list
- `1. ` → ordered list
- `> ` → blockquote
- `---` → horizontal rule
- `Shift+Enter` → hard line break
- `Cmd/Ctrl+B` → bold mark
- `Cmd/Ctrl+I` → italic mark
- `Cmd/Ctrl+K` → link dialog

Slash commands (`/h1`, `/h2`, `/ul`, `/ol`, `/quote`, `/divider`) execute the same ProseMirror commands, ensuring identical serialization output.

## Serialization

`serializeMarkdoc` reuses ProseMirror’s Markdown serializer with custom handlers for bullet lists and raw blocks. After every edit we serialize the document back to Markdoc, guaranteeing that the stored value matches what downstream Markdoc consumers expect.

For detailed implementation, see [`app/modules/editor-v2/markdoc-utils.ts`](../../../apps/webapp/app/modules/editor-v2/markdoc-utils.ts).
