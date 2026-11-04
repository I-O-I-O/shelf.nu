export type HandbookOutlineItem = {
  level: 2 | 3;
  title: string;
  id: string;
};

function cleanHeading(value: string) {
  return value
    .replace(/\s+#+\s*$/u, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/[`*_~]/gu, "")
    .trim();
}

function headingSlug(value: string) {
  return (
    cleanHeading(value)
      .normalize("NFKD")
      .toLocaleLowerCase("en")
      .replace(/\p{M}/gu, "")
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/gu, "") || "section"
  );
}

/** Extracts article headings directly from the canonical Markdown body. */
export function getHandbookOutline(content: string): HandbookOutlineItem[] {
  const items: HandbookOutlineItem[] = [];
  const usedIds = new Map<string, number>();
  let fencedBy: "`" | "~" | null = null;

  for (const line of content.split(/\r?\n/u)) {
    const fence = line.match(/^\s{0,3}(```+|~~~+)/u)?.[1];
    if (fence) {
      const character = fence[0] as "`" | "~";
      fencedBy = fencedBy === character ? null : fencedBy ?? character;
      continue;
    }
    if (fencedBy) continue;

    const match = line.match(/^\s{0,3}(#{2,3})\s+(.+?)\s*#*\s*$/u);
    if (!match) continue;
    const title = cleanHeading(match[2] ?? "");
    if (!title) continue;

    const baseId = headingSlug(title);
    const occurrence = (usedIds.get(baseId) ?? 0) + 1;
    usedIds.set(baseId, occurrence);
    items.push({
      level: match[1]!.length as 2 | 3,
      title,
      id: occurrence === 1 ? baseId : `${baseId}-${occurrence}`,
    });
  }

  return items;
}

function comparableHeading(value: string) {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("en")
    .trim();
}

/** Adds the same deterministic IDs used by the generated article outline. */
export function assignHandbookHeadingIds(
  container: HTMLElement,
  outline: HandbookOutlineItem[]
) {
  const elements = [...container.querySelectorAll<HTMLElement>("h2, h3")];
  const remaining = [...outline];
  for (const element of elements) {
    const title = comparableHeading(element.textContent ?? "");
    const index = remaining.findIndex(
      (item) => comparableHeading(item.title) === title
    );
    if (index < 0) continue;
    const [match] = remaining.splice(index, 1);
    if (match) element.id = match.id;
  }

  for (const blockquote of container.querySelectorAll<HTMLElement>(
    "blockquote"
  )) {
    if (blockquote.dataset.handbookCallout) continue;
    const paragraph = blockquote.querySelector<HTMLElement>(":scope > p");
    const textNode = paragraph?.firstChild;
    if (!paragraph || textNode?.nodeType !== Node.TEXT_NODE) continue;
    const match = textNode.textContent?.match(
      /^\[!(NOTE|TIP|WARNING|IMPORTANT)\]\s*/iu
    );
    if (!match) continue;

    const kind = match[1]!.toLocaleLowerCase("en");
    textNode.textContent = ` ${textNode.textContent!.slice(match[0].length)}`;
    const label = document.createElement("span");
    label.className = "handbook-callout-label";
    label.textContent = `${kind.toLocaleUpperCase("en")}:`;
    paragraph.insertBefore(label, paragraph.firstChild);
    blockquote.dataset.handbookCallout = kind;
    blockquote.classList.add("handbook-callout");
  }
}
