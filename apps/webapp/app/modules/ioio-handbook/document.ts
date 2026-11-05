export type HandbookOutlineItem = {
  level: 2 | 3;
  title: string;
  id: string;
};

export type HandbookDocumentSubsection = {
  id: string;
  title: string;
  content: string;
};

export type HandbookDocumentSection = {
  id: string;
  title: string;
  content: string;
  subsections: HandbookDocumentSubsection[];
};

export type HandbookDocument = {
  introduction: string;
  introductionId: string | null;
  sections: HandbookDocumentSection[];
};

export type HandbookVersionDifference = {
  key: string;
  title: string;
  path: string;
  level: 2 | 3;
  status: "Added" | "Removed" | "Modified" | "Unchanged";
  beforeContent?: string;
  afterContent?: string;
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

/** Splits the canonical Markdown body into H2 sections and nested H3 blocks. */
export function getHandbookDocument(content: string): HandbookDocument {
  const outline = getHandbookOutline(content);
  const introduction: string[] = [];
  const sections: HandbookDocumentSection[] = [];
  let section: HandbookDocumentSection | undefined;
  let subsection: HandbookDocumentSubsection | undefined;
  let buffer: string[] = [];
  let outlineIndex = 0;
  let fencedBy: "`" | "~" | null = null;

  const flush = () => {
    const value = buffer.join("\n").trim();
    if (subsection) subsection.content = value;
    else if (section) section.content = value;
    else if (value) introduction.push(value);
    buffer = [];
  };

  for (const line of content.split(/\r?\n/u)) {
    const fence = line.match(/^\s{0,3}(```+|~~~+)/u)?.[1];
    if (fence) {
      const character = fence[0] as "`" | "~";
      fencedBy = fencedBy === character ? null : fencedBy ?? character;
      buffer.push(line);
      continue;
    }
    const match = fencedBy
      ? null
      : line.match(/^\s{0,3}(#{2,3})\s+(.+?)\s*#*\s*$/u);
    if (!match) {
      buffer.push(line);
      continue;
    }

    flush();
    const item = outline[outlineIndex++];
    if (!item) {
      buffer.push(line);
      continue;
    }
    if (item.level === 2) {
      section = {
        id: item.id,
        title: item.title,
        content: "",
        subsections: [],
      };
      subsection = undefined;
      sections.push(section);
    } else if (section) {
      subsection = { id: item.id, title: item.title, content: "" };
      section.subsections.push(subsection);
    } else {
      // Keep an H3 without a parent in the intro so malformed legacy Markdown
      // remains visible and editable rather than being silently discarded.
      introduction.push(line);
    }
  }
  flush();

  let introductionContent = introduction.join("\n\n").trim();
  if (
    introductionContent &&
    sections[0] &&
    normalizedTitle(sections[0].title) === "introduction"
  ) {
    sections[0].content = [introductionContent, sections[0].content]
      .filter(Boolean)
      .join("\n\n");
    introductionContent = "";
  }
  const usedIds = new Set(outline.map((item) => item.id));
  let introductionId: string | null = null;
  if (introductionContent && sections.length) {
    introductionId = "introduction";
    let suffix = 2;
    while (usedIds.has(introductionId)) {
      introductionId = `introduction-${suffix++}`;
    }
  }

  return {
    introduction: introductionContent,
    introductionId,
    sections,
  };
}

function comparableContent(value: string) {
  return value.replace(/\r\n/gu, "\n").trim();
}

function normalizedTitle(value: string) {
  return comparableHeading(value).replace(/\s+/gu, " ");
}

function getVersionUnits(content: string) {
  const document = getHandbookDocument(content);
  const units: Array<{
    key: string;
    title: string;
    path: string;
    level: 2 | 3;
    content: string;
  }> = [];
  if (document.introduction) {
    units.push({
      key: "intro:introduction",
      title: "Introduction",
      path: "Introduction",
      level: 2,
      content: document.introduction,
    });
  }
  const sectionOccurrences = new Map<string, number>();

  for (const section of document.sections) {
    const baseKey = `h2:${normalizedTitle(section.title)}`;
    const occurrence = (sectionOccurrences.get(baseKey) ?? 0) + 1;
    sectionOccurrences.set(baseKey, occurrence);
    const sectionKey = `${baseKey}:${occurrence}`;
    units.push({
      key: sectionKey,
      title: section.title,
      path: section.title,
      level: 2,
      content: section.content,
    });
    const subsectionOccurrences = new Map<string, number>();
    for (const subsection of section.subsections) {
      const childBaseKey = `h3:${normalizedTitle(subsection.title)}`;
      const childOccurrence =
        (subsectionOccurrences.get(childBaseKey) ?? 0) + 1;
      subsectionOccurrences.set(childBaseKey, childOccurrence);
      units.push({
        key: `${sectionKey}/${childBaseKey}:${childOccurrence}`,
        title: subsection.title,
        path: `${section.title} › ${subsection.title}`,
        level: 3,
        content: subsection.content,
      });
    }
  }
  return units;
}

/** Compares H2/H3 units by normalized heading and parent path. */
export function compareHandbookVersions(
  before: string,
  after: string
): HandbookVersionDifference[] {
  const beforeUnits = getVersionUnits(before);
  const afterUnits = getVersionUnits(after);
  const beforeByKey = new Map(beforeUnits.map((unit) => [unit.key, unit]));
  const afterByKey = new Map(afterUnits.map((unit) => [unit.key, unit]));
  const commonBefore = beforeUnits
    .filter((unit) => afterByKey.has(unit.key))
    .map((unit) => unit.key);
  const commonAfter = afterUnits
    .filter((unit) => beforeByKey.has(unit.key))
    .map((unit) => unit.key);
  const reorderedKeys = new Set<string>();
  for (const [index, key] of commonAfter.entries()) {
    if (commonBefore[index] !== key) reorderedKeys.add(key);
  }
  const differences: HandbookVersionDifference[] = [];

  for (const unit of afterUnits) {
    const previous = beforeByKey.get(unit.key);
    const status = !previous
      ? "Added"
      : comparableContent(previous.content) ===
          comparableContent(unit.content) && !reorderedKeys.has(unit.key)
      ? "Unchanged"
      : "Modified";
    differences.push({
      key: unit.key,
      title: unit.title,
      path: unit.path,
      level: unit.level,
      status,
      ...(previous ? { beforeContent: previous.content } : {}),
      ...(status !== "Unchanged" ? { afterContent: unit.content } : {}),
    });
  }

  for (const unit of beforeUnits) {
    if (afterByKey.has(unit.key)) continue;
    differences.push({
      key: unit.key,
      title: unit.title,
      path: unit.path,
      level: unit.level,
      status: "Removed",
      beforeContent: unit.content,
    });
  }
  return differences;
}

/** Returns the deepest heading that owns a matching search term. */
export function findHandbookSearchMatch(content: string, query: string) {
  const term = query.trim().toLocaleLowerCase("en");
  if (!term) return null;
  const document = getHandbookDocument(content);
  if (
    document.introduction &&
    `Introduction\n${document.introduction}`
      .toLocaleLowerCase("en")
      .includes(term)
  ) {
    return {
      id: document.introductionId ?? "introduction",
      title: "Introduction",
    };
  }
  for (const section of document.sections) {
    for (const subsection of section.subsections) {
      if (
        `${subsection.title}\n${subsection.content}`
          .toLocaleLowerCase("en")
          .includes(term)
      ) {
        return { id: subsection.id, title: subsection.title };
      }
    }
    if (
      `${section.title}\n${section.content}`
        .toLocaleLowerCase("en")
        .includes(term)
    ) {
      return { id: section.id, title: section.title };
    }
  }
  return null;
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
