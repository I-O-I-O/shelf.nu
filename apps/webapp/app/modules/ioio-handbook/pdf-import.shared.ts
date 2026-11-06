export type HandbookImportSection = {
  id: string;
  sourceOrder: number;
  title: string;
  level: 2 | 3;
  markdown: string;
  sourceUrls: string[];
  sourcePage?: number;
  sourceHeadingIds?: string[];
  possibleAuthorNote?: boolean;
};

export type HandbookImportOutlineHeading = {
  id: string;
  sourceOrder: number;
  title: string;
  level: 2 | 3;
  sourcePage?: number;
};

export type HandbookImportArticle = {
  id: string;
  title: string;
  sections: HandbookImportSection[];
  rationale?: string;
  proposedOutline?: string[];
  existingArticleSlug?: string;
  revisionBaseVersionId?: string;
};

export type HandbookImportDraft = {
  title: string;
  content: string;
  sourceUrls: string[];
  sourceName: string;
  categorySuggestion: string;
  referencesByHeading: Record<string, string[]>;
  sourceOutline: HandbookImportOutlineHeading[];
  sections: HandbookImportSection[];
  articles: HandbookImportArticle[];
  hierarchyDetected: boolean;
  fallback: boolean;
  imageDetectedPages?: number[];
};

type MarkdownNode = {
  id: string;
  title: string;
  level: 2 | 3;
  body: string[];
  children: MarkdownNode[];
};

function normalize(value: string) {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("en")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function slug(value: string) {
  return normalize(value).replace(/\s+/gu, "-").slice(0, 80) || "section";
}

function parseMarkdownTree(content: string) {
  const roots: MarkdownNode[] = [];
  const prelude: string[] = [];
  let currentRoot: MarkdownNode | null = null;
  let currentNode: MarkdownNode | null = null;
  let fencedBy: "`" | "~" | null = null;
  let sequence = 0;

  for (const line of content.split(/\r?\n/u)) {
    const fence = line.match(/^\s{0,3}(```+|~~~+)/u)?.[1];
    if (fence) {
      const character = fence[0] as "`" | "~";
      fencedBy = fencedBy === character ? null : fencedBy ?? character;
    }
    const heading = !fencedBy
      ? line.match(/^\s{0,3}(#{2,3})\s+(.+?)\s*#*\s*$/u)
      : null;
    if (!heading) {
      (currentNode?.body ?? prelude).push(line);
      continue;
    }

    const level = heading[1]!.length as 2 | 3;
    const node: MarkdownNode = {
      id: `source-section-${++sequence}`,
      title: heading[2]!.trim(),
      level,
      body: [],
      children: [],
    };
    if (level === 2 || !currentRoot) {
      roots.push(node);
      currentRoot = node;
    } else {
      currentRoot.children.push(node);
    }
    currentNode = node;
  }

  return { roots, prelude: prelude.join("\n").trim() };
}

function nodeMarkdown(node: MarkdownNode, promote = false): string {
  const level = promote ? 2 : node.level;
  const body = node.body.join("\n").trim();
  const children = node.children
    .map((child) => nodeMarkdown(child))
    .filter(Boolean);
  return [`${"#".repeat(level)} ${node.title}`, body, ...children]
    .filter(Boolean)
    .join("\n\n");
}

function familyFor(title: string): string | null {
  const heading = normalize(title);
  if (/finger joint|box joint|friction fit|fit joint|kerf/u.test(heading)) {
    return "joints";
  }
  if (/inkscape/u.test(heading)) return "inkscape";
  if (
    /makercase|maker js|gear generator|box generator|parametric|generator/u.test(
      heading
    )
  ) {
    return "generators";
  }
  if (
    /cad|onshape|fusion 360|2d workflow|3d workflow|export(?:ing)?/u.test(
      heading
    )
  ) {
    return "cad";
  }
  if (
    /tutorial|reference|resources?|useful links|further reading/u.test(heading)
  ) {
    return "resources";
  }
  if (
    /software|illustrator|affinity|file format|vector editor/u.test(heading)
  ) {
    return "software";
  }
  if (
    /introduction|what is|basics?|vector graphics?|cutting|engraving|raster|laser/u.test(
      heading
    )
  ) {
    return "basics";
  }
  return null;
}

const FAMILY_TITLES: Record<string, string> = {
  basics: "Laser Cutting Basics",
  joints: "Finger Joints and Friction Fits",
  software: "Choosing Software for Laser Cutting",
  inkscape: "Inkscape for Laser Cutting",
  generators: "Parametric Generators for Laser Cutting",
  cad: "CAD for Laser Cutting",
  resources: "Laser Cutting Resources",
};

function referencesFor(
  headings: string[],
  referencesByHeading: Record<string, string[]>
) {
  const references = new Set<string>();
  for (const heading of headings) {
    for (const url of referencesByHeading[heading] ?? []) references.add(url);
  }
  return [...references];
}

function makeSection(
  id: string,
  sourceOrder: number,
  title: string,
  level: 2 | 3,
  markdown: string,
  sourceUrls: string[],
  sourcePage?: number,
  sourceHeadingIds?: string[]
): HandbookImportSection {
  return {
    id,
    sourceOrder,
    title,
    level,
    markdown,
    sourceUrls,
    sourcePage,
    sourceHeadingIds,
  };
}

/** Deterministically groups source headings into semantic articles while
 * retaining source order and the original Markdown blocks. */
export function suggestHandbookArticles({
  title,
  content,
  referencesByHeading = {},
  sourcePageById = {},
}: {
  title: string;
  content: string;
  referencesByHeading?: Record<string, string[]>;
  sourcePageById?: Record<string, number>;
}) {
  const { roots, prelude } = parseMarkdownTree(content);
  const normalizedDocument = normalize(`${title} ${content}`);
  const isLaserDocument = /laser cutting|laser cutter|laser cut/u.test(
    normalizedDocument
  );
  const classifyHeading = (heading: string) =>
    isLaserDocument ? familyFor(heading) : null;
  const atoms: Array<{
    section: HandbookImportSection;
    family: string | null;
    order: number;
    sourceHeadings: string[];
  }> = [];
  let order = 0;

  if (prelude) {
    atoms.push({
      section: makeSection(
        "source-introduction",
        order,
        "Introduction",
        2,
        `## Introduction\n\n${prelude}`,
        referencesFor(["Introduction"], referencesByHeading),
        sourcePageById["source-introduction"]
      ),
      family: isLaserDocument ? "basics" : null,
      order: order++,
      sourceHeadings: ["Introduction"],
    });
  }

  for (const root of roots) {
    const rootFamily = classifyHeading(root.title);
    const childFamilies = root.children.map((child) =>
      classifyHeading(child.title)
    );
    const shouldSplitChildren = root.children.some(
      (_, index) =>
        childFamilies[index] !== null && childFamilies[index] !== rootFamily
    );

    if (shouldSplitChildren) {
      const rootBody = root.body.join("\n").trim();
      if (rootBody) {
        atoms.push({
          section: makeSection(
            root.id,
            order,
            root.title,
            2,
            nodeMarkdown({ ...root, children: [] }),
            referencesFor([root.title], referencesByHeading),
            sourcePageById[root.id],
            [root.id]
          ),
          family: rootFamily ?? (isLaserDocument ? "basics" : null),
          order: order++,
          sourceHeadings: [root.title],
        });
      }
      for (const child of root.children) {
        atoms.push({
          section: makeSection(
            child.id,
            order,
            child.title,
            3,
            nodeMarkdown(child, true),
            referencesFor([child.title], referencesByHeading),
            sourcePageById[child.id],
            [child.id]
          ),
          family:
            classifyHeading(child.title) ??
            rootFamily ??
            (isLaserDocument ? "basics" : null),
          order: order++,
          sourceHeadings: [child.title],
        });
      }
      continue;
    }

    const sourceHeadings = [
      root.title,
      ...root.children.map((item) => item.title),
    ];
    atoms.push({
      section: makeSection(
        root.id,
        order,
        root.title,
        2,
        nodeMarkdown(root),
        referencesFor(sourceHeadings, referencesByHeading),
        sourcePageById[root.id],
        [root.id, ...root.children.map((child) => child.id)]
      ),
      family: rootFamily ?? (isLaserDocument ? "basics" : null),
      order: order++,
      sourceHeadings,
    });
  }

  const hierarchyDetected = atoms.length > 0 && roots.length > 0;
  const fallback = !hierarchyDetected;
  if (!atoms.length) {
    atoms.push({
      section: makeSection(
        "source-content",
        0,
        title || "Imported content",
        2,
        content,
        Object.values(referencesByHeading).flat(),
        sourcePageById["source-content"]
      ),
      family: null,
      order: 0,
      sourceHeadings: [],
    });
  }

  const families = new Set(atoms.map(({ family }) => family).filter(Boolean));
  const genericSplit =
    !isLaserDocument && families.size === 0 && roots.length >= 4;
  const groups = new Map<string, typeof atoms>();
  for (const atom of atoms) {
    const family =
      atom.family ??
      (genericSplit ? `topic:${slug(atom.section.title)}` : "document");
    const group = groups.get(family) ?? [];
    group.push(atom);
    groups.set(family, group);
  }

  const articles = [...groups.entries()]
    .sort((left, right) => left[1][0]!.order - right[1][0]!.order)
    .map(([family, items], index) => {
      const articleTitle =
        family === "document"
          ? title || "Imported Handbook article"
          : family.startsWith("topic:")
          ? items[0]!.section.title
          : FAMILY_TITLES[family] ?? title;
      return {
        id: `article-${index + 1}`,
        title: articleTitle,
        sections: items.map(({ section }) => section),
      } satisfies HandbookImportArticle;
    });

  const flatSections = atoms
    .sort((left, right) => left.order - right.order)
    .map(({ section }) => section);
  return { articles, sections: flatSections, hierarchyDetected, fallback };
}

export function inferHandbookCategoryName(title: string, content: string) {
  return /\blaser\s*(?:cutting|cutter|cut)\b/iu.test(`${title}\n${content}`)
    ? "Laser Cutting"
    : "";
}
