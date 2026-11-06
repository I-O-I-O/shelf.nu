import { useEffect, useMemo, useRef, useState } from "react";
import { Form, Link, useFetcher, useNavigation } from "react-router";
import { MarkdownViewer } from "~/components/markdown/markdown-viewer";
import { getHandbookOutline } from "~/modules/ioio-handbook/document";
import type {
  HandbookImportArticle,
  HandbookImportDraft,
  HandbookImportSection,
} from "~/modules/ioio-handbook/pdf-import.shared";

type ExistingArticle = {
  id: string;
  slug: string;
  title: string;
  handbookCategoryId: string | null;
  publishedVersionId: string | null;
  categoryName: string;
};

type ReviewSection = HandbookImportSection & { included: boolean };
type ReviewArticle = Omit<HandbookImportArticle, "sections"> & {
  sections: ReviewSection[];
  included: boolean;
  contentOverride?: string;
};

type ClaudeSuggestion = {
  articles: HandbookImportArticle[];
  categorySuggestion: string;
};

type StructureSnapshot = {
  articles: ReviewArticle[];
  categorySuggestion: string;
  categoryId: string;
  newCategoryName: string;
};

function normalizeTitle(value: string) {
  return value
    .normalize("NFKD")
    .toLocaleLowerCase("en")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function titleOverlap(left: string, right: string) {
  const a = new Set(
    normalizeTitle(left)
      .split(/\s+/u)
      .filter((token) => token.length > 2)
  );
  const b = new Set(
    normalizeTitle(right)
      .split(/\s+/u)
      .filter((token) => token.length > 2)
  );
  if (!a.size || !b.size) return 0;
  const shared = [...a].filter((token) => b.has(token)).length;
  return shared / Math.max(a.size, b.size);
}

function splitSectionMarkdown(markdown: string) {
  const lines = markdown.split(/\r?\n/u);
  const blocks: Array<{ title: string; level: 2 | 3; markdown: string }> = [];
  let currentLines: string[] | null = null;
  let currentHeading: { title: string; level: 2 | 3 } | null = null;
  let prelude: string[] = [];
  let fencedBy: "`" | "~" | null = null;
  const flush = () => {
    if (!currentLines || !currentHeading) return;
    blocks.push({
      ...currentHeading,
      markdown: currentLines.join("\n").trim(),
    });
  };

  for (const line of lines) {
    const fence = line.match(/^\s{0,3}(```+|~~~+)/u)?.[1];
    const heading = !fencedBy
      ? line.match(/^\s{0,3}(#{2,3})\s+(.+?)\s*#*\s*$/u)
      : null;
    if (heading) {
      flush();
      currentHeading = {
        title: heading[2]!.trim(),
        level: heading[1]!.length as 2 | 3,
      };
      currentLines = [...prelude, line];
      prelude = [];
    } else if (currentLines) {
      currentLines.push(line);
    } else {
      prelude.push(line);
    }
    if (fence) {
      const character = fence[0] as "`" | "~";
      fencedBy = fencedBy === character ? null : fencedBy ?? character;
    }
  }
  flush();
  return blocks;
}

function expandArticle(
  article: HandbookImportArticle,
  draft: HandbookImportDraft,
  pageByHeadingId: Map<string, number>
): ReviewArticle {
  const sections: ReviewSection[] = article.sections.flatMap(
    (sourceSection): ReviewSection[] => {
      const blocks = splitSectionMarkdown(sourceSection.markdown);
      if (!blocks.length) {
        return [
          {
            ...sourceSection,
            id: `${sourceSection.id}-content`,
            level: 2 as const,
            markdown: `## ${
              sourceSection.title
            }\n\n${sourceSection.markdown.trim()}`,
            included: true,
          },
        ];
      }
      const denominator = blocks.length + 1;
      return blocks.map((block, index): ReviewSection => {
        const headingId = sourceSection.sourceHeadingIds?.[index];
        const sourceUrls = draft.referencesByHeading[block.title] ?? [];
        return {
          ...sourceSection,
          id: `${sourceSection.id}-heading-${index + 1}`,
          sourceOrder: sourceSection.sourceOrder + index / denominator,
          title: block.title,
          level: block.level,
          markdown: block.markdown,
          sourceUrls:
            sourceUrls.length || Object.keys(draft.referencesByHeading).length
              ? sourceUrls
              : index === 0
              ? sourceSection.sourceUrls
              : [],
          sourcePage:
            (headingId ? pageByHeadingId.get(headingId) : undefined) ??
            sourceSection.sourcePage,
          sourceHeadingIds: headingId ? [headingId] : undefined,
          included: true,
        };
      });
    }
  );
  return { ...article, sections, included: true };
}

function expandArticles(
  articles: HandbookImportArticle[],
  draft: HandbookImportDraft
) {
  const pageByHeadingId = new Map(
    draft.sourceOutline.flatMap((heading) =>
      heading.sourcePage === undefined
        ? []
        : [[heading.id, heading.sourcePage] as const]
    )
  );
  return articles.map((article) =>
    expandArticle(article, draft, pageByHeadingId)
  );
}

function articleContent(article: ReviewArticle) {
  if (article.contentOverride !== undefined) return article.contentOverride;
  return [...article.sections]
    .filter((section) => section.included)
    .sort((left, right) => left.sourceOrder - right.sourceOrder)
    .map((section) => section.markdown.trim())
    .filter(Boolean)
    .join("\n\n");
}

function syncArticleContent(article: ReviewArticle): ReviewArticle {
  if (article.contentOverride === undefined) return article;
  const existing = article.sections
    .filter((section) => section.included)
    .sort((left, right) => left.sourceOrder - right.sourceOrder);
  const excluded = article.sections.filter((section) => !section.included);
  const parsed = splitSectionMarkdown(article.contentOverride);
  const blocks = parsed.length
    ? parsed
    : [
        {
          title: article.title || "Section",
          level: 2 as const,
          markdown: `## ${
            article.title || "Section"
          }\n\n${article.contentOverride.trim()}`,
        },
      ];
  const firstOrder = existing[0]?.sourceOrder ?? 0;
  const sections = blocks.map((block, index) => {
    const previous = existing[index];
    return {
      ...(previous ?? {
        id: `manual-${article.id}-${index + 1}`,
        sourceUrls: [],
      }),
      title: block.title,
      level: block.level,
      markdown: block.markdown,
      sourceOrder:
        previous?.sourceOrder ?? firstOrder + index / (blocks.length + 1),
      included: true,
    } satisfies ReviewSection;
  });
  return {
    ...article,
    contentOverride: undefined,
    sections: [...sections, ...excluded].sort(
      (left, right) => left.sourceOrder - right.sourceOrder
    ),
  };
}

function articleReferences(article: ReviewArticle) {
  return [
    ...new Set(
      article.sections
        .filter((section) => section.included)
        .flatMap((section) => section.sourceUrls)
    ),
  ];
}

function updateSectionHeading(markdown: string, title: string, level: 2 | 3) {
  const lines = markdown.split(/\r?\n/u);
  let fencedBy: "`" | "~" | null = null;
  let replaced = false;
  const updated = lines.map((line) => {
    const fence = line.match(/^\s{0,3}(```+|~~~+)/u)?.[1];
    if (!replaced && !fencedBy) {
      const heading = line.match(/^\s{0,3}(#{2,3})\s+(.+?)\s*#*\s*$/u);
      if (heading) {
        replaced = true;
        return `${"#".repeat(level)} ${title}`;
      }
    }
    if (fence) {
      const character = fence[0] as "`" | "~";
      fencedBy = fencedBy === character ? null : fencedBy ?? character;
    }
    return line;
  });
  if (!replaced) return `#${"#".repeat(level - 1)} ${title}\n\n${markdown}`;
  return updated.join("\n");
}

function proposalHeadings(article: ReviewArticle) {
  return [...article.sections]
    .filter((section) => section.included)
    .sort((left, right) => left.sourceOrder - right.sourceOrder)
    .map(({ title, level }) => ({ title, level }));
}

export function HandbookImportReview({
  draft,
  categories,
  existingArticles,
  isStudent,
  claudeAvailable,
  errorMessage,
  onImportAnother,
}: {
  draft: HandbookImportDraft;
  categories: Array<{ id: string; name: string }>;
  existingArticles: ExistingArticle[];
  isStudent: boolean;
  claudeAvailable: boolean;
  errorMessage?: string;
  onImportAnother: () => void;
}) {
  const matchingCategory = categories.find(
    (category) =>
      category.name.toLocaleLowerCase("en") ===
      draft.categorySuggestion.toLocaleLowerCase("en")
  );
  const [articles, setArticles] = useState<ReviewArticle[]>(() =>
    expandArticles(draft.articles, draft)
  );
  const [categorySuggestion, setCategorySuggestion] = useState(
    draft.categorySuggestion
  );
  const [categoryId, setCategoryId] = useState(matchingCategory?.id ?? "");
  const [newCategoryName, setNewCategoryName] = useState(
    !matchingCategory && !isStudent ? draft.categorySuggestion : ""
  );
  const [structureMessage, setStructureMessage] = useState("");
  const [structureSource, setStructureSource] = useState<
    "deterministic" | "claude"
  >("deterministic");
  const [claudeSuggestion, setClaudeSuggestion] =
    useState<ClaudeSuggestion | null>(null);
  const [originalSnapshot, setOriginalSnapshot] =
    useState<StructureSnapshot | null>(null);
  const [selectedSectionIds, setSelectedSectionIds] = useState<string[]>([]);
  const [newArticleTitles, setNewArticleTitles] = useState<
    Record<string, string>
  >({});
  const nextArticleId = useRef(1);
  const navigation = useNavigation();
  const structureFetcher = useFetcher<{
    kind: "structure-suggestion" | "error";
    articles?: HandbookImportArticle[];
    categorySuggestion?: string;
    message?: string;
  }>();
  const busy = navigation.state === "submitting";
  const structureBusy = structureFetcher.state !== "idle";
  const provenance = `> [!NOTE] Imported from: ${draft.sourceName}`;
  const articleContentLimit = Math.max(0, 30_000 - provenance.length - 2);
  const totalSourceSections = useMemo(
    () =>
      articles.reduce((total, article) => total + article.sections.length, 0),
    [articles]
  );
  const approvedArticles = articles
    .filter(
      (article) =>
        article.included && article.sections.some((section) => section.included)
    )
    .map((article) => ({
      title: article.title,
      content: articleContent(article),
      sourceUrls: articleReferences(article),
      ...(article.existingArticleSlug
        ? {
            existingArticleSlug: article.existingArticleSlug,
            revisionBaseVersionId: article.revisionBaseVersionId,
          }
        : {}),
    }));
  const serializedArticles = JSON.stringify(approvedArticles);
  const overLengthArticles = approvedArticles.filter(
    (article) => article.content.length > articleContentLimit
  );

  useEffect(() => {
    if (structureFetcher.data?.kind !== "structure-suggestion") return;
    setClaudeSuggestion({
      articles: structureFetcher.data.articles ?? [],
      categorySuggestion:
        structureFetcher.data.categorySuggestion ?? categorySuggestion,
    });
    setStructureMessage(
      "Claude suggested another grouping. Review it before applying."
    );
  }, [categorySuggestion, structureFetcher.data]);

  function updateArticle(
    articleId: string,
    update: (article: ReviewArticle) => ReviewArticle
  ) {
    setArticles((current) =>
      current.map((article) =>
        article.id === articleId ? update(article) : article
      )
    );
  }

  function updateSection(
    articleId: string,
    sectionId: string,
    update: (section: ReviewSection) => ReviewSection
  ) {
    updateArticle(articleId, (current) => {
      const article = syncArticleContent(current);
      return {
        ...article,
        sections: article.sections.map((section) =>
          section.id === sectionId ? update(section) : section
        ),
      };
    });
  }

  function moveSection(sectionId: string, targetArticleId: string) {
    setArticles((current) => {
      const source = current.find((article) =>
        article.sections.some((section) => section.id === sectionId)
      );
      const target = current.find((article) => article.id === targetArticleId);
      if (!source || !target || source.id === target.id) return current;
      const syncedSource = syncArticleContent(source);
      const syncedTarget = syncArticleContent(target);
      const section = syncedSource.sections.find(
        (item) => item.id === sectionId
      );
      if (!section) return current;
      return current
        .map((article) => {
          if (article.id === source.id) {
            return {
              ...syncedSource,
              sections: syncedSource.sections.filter(
                (item) => item.id !== sectionId
              ),
            };
          }
          if (article.id === target.id) {
            return {
              ...syncedTarget,
              sections: [...syncedTarget.sections, section].sort(
                (left, right) => left.sourceOrder - right.sourceOrder
              ),
            };
          }
          return article;
        })
        .filter((article) => article.sections.length > 0);
    });
    setSelectedSectionIds((current) =>
      current.filter((id) => id !== sectionId)
    );
  }

  function mergeArticle(sourceId: string, targetId: string) {
    setArticles((current) => {
      const source = current.find((article) => article.id === sourceId);
      if (!source) return current;
      const target = current.find((article) => article.id === targetId);
      if (!target) return current;
      const syncedSource = syncArticleContent(source);
      const syncedTarget = syncArticleContent(target);
      return current
        .map((article) =>
          article.id === targetId
            ? {
                ...syncedTarget,
                sections: [
                  ...syncedTarget.sections,
                  ...syncedSource.sections,
                ].sort((left, right) => left.sourceOrder - right.sourceOrder),
                included: article.included || source.included,
              }
            : article
        )
        .filter((article) => article.id !== sourceId);
    });
  }

  function splitSelectedSections(articleId: string) {
    const selected = new Set(selectedSectionIds);
    const title = newArticleTitles[articleId]?.trim();
    if (!title || !selected.size) return;
    setArticles((current) => {
      const source = current.find((article) => article.id === articleId);
      if (!source) return current;
      const syncedSource = syncArticleContent(source);
      const moved = syncedSource.sections.filter((section) =>
        selected.has(section.id)
      );
      if (!moved.length) return current;
      const remaining = syncedSource.sections.filter(
        (section) => !selected.has(section.id)
      );
      const newArticle: ReviewArticle = {
        id: `article-split-${nextArticleId.current++}`,
        title,
        included: true,
        sections: moved.sort(
          (left, right) => left.sourceOrder - right.sourceOrder
        ),
      };
      const next: ReviewArticle[] = [];
      for (const article of current) {
        if (article.id !== articleId) {
          next.push(article);
          continue;
        }
        if (remaining.length) {
          next.push({
            ...syncedSource,
            sections: remaining,
          });
        }
        next.push(newArticle);
      }
      return next;
    });
    setSelectedSectionIds((current) =>
      current.filter((id) => !selected.has(id))
    );
    setNewArticleTitles((current) => ({ ...current, [articleId]: "" }));
  }

  function continueAsOneArticle() {
    const sections = articles
      .map(syncArticleContent)
      .flatMap((article) => article.sections)
      .sort((left, right) => left.sourceOrder - right.sourceOrder);
    setArticles([
      {
        id: "article-single",
        title: draft.title,
        sections,
        included: true,
      },
    ]);
    setSelectedSectionIds([]);
  }

  function requestClaudeStructure() {
    setOriginalSnapshot({
      articles,
      categorySuggestion,
      categoryId,
      newCategoryName,
    });
    setClaudeSuggestion(null);
    setStructureMessage("");
    const formData = new FormData();
    formData.set("intent", "improve-structure");
    formData.set("draft", JSON.stringify(draft));
    void structureFetcher.submit(formData, {
      method: "post",
      action: "/handbook/import",
    });
  }

  function applyClaudeSuggestion() {
    if (!claudeSuggestion) return;
    const nextArticles = expandArticles(claudeSuggestion.articles, draft);
    setArticles(nextArticles);
    setStructureSource("claude");
    setCategorySuggestion(claudeSuggestion.categorySuggestion);
    const existing = categories.find(
      (category) =>
        category.name.toLocaleLowerCase("en") ===
        claudeSuggestion.categorySuggestion.toLocaleLowerCase("en")
    );
    setCategoryId(existing?.id ?? "");
    setNewCategoryName(
      !existing && !isStudent ? claudeSuggestion.categorySuggestion : ""
    );
    setSelectedSectionIds([]);
    setClaudeSuggestion(null);
    setStructureMessage(
      "Claude structure applied. You can still edit it below."
    );
  }

  function keepOriginalStructure() {
    if (structureSource === "claude" && originalSnapshot) {
      setArticles(originalSnapshot.articles);
      setCategorySuggestion(originalSnapshot.categorySuggestion);
      setCategoryId(originalSnapshot.categoryId);
      setNewCategoryName(originalSnapshot.newCategoryName);
      setStructureSource("deterministic");
      setStructureMessage("The original extracted grouping is restored.");
    } else {
      setStructureMessage("The original extracted grouping is kept.");
    }
    setClaudeSuggestion(null);
    setSelectedSectionIds([]);
  }

  function potentialMatches(article: ReviewArticle) {
    return existingArticles
      .filter(
        (existing) =>
          (!categoryId || existing.handbookCategoryId === categoryId) &&
          titleOverlap(article.title, existing.title) >= 0.4
      )
      .sort(
        (left, right) =>
          titleOverlap(article.title, right.title) -
          titleOverlap(article.title, left.title)
      )
      .slice(0, 4);
  }

  function changeCategorySuggestion(value: string) {
    setCategorySuggestion(value);
    const matching = categories.find(
      (category) =>
        category.name.toLocaleLowerCase("en") === value.toLocaleLowerCase("en")
    );
    if (matching) {
      setCategoryId(matching.id);
      setNewCategoryName("");
    } else {
      setCategoryId("");
      setNewCategoryName(!isStudent ? value : "");
    }
  }

  const pageByHeadingTitle = useMemo(() => {
    const pages = new Map<string, number>();
    for (const heading of draft.sourceOutline) {
      if (heading.sourcePage !== undefined) {
        const key = normalizeTitle(heading.title);
        if (!pages.has(key)) pages.set(key, heading.sourcePage);
      }
    }
    return pages;
  }, [draft.sourceOutline]);

  return (
    <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link
            to="/handbook"
            className="text-sm font-semibold text-red-800 hover:underline"
          >
            ← Handbook
          </Link>
          <h1 className="mt-2 text-2xl font-semibold text-gray-950">
            Review Handbook structure
          </h1>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-gray-600">
            This is how the importer interpreted the PDF. Review and adjust the
            detected outline and proposed articles before creating any drafts.
          </p>
        </div>
        <button
          type="button"
          onClick={onImportAnother}
          className="inline-flex h-9 items-center rounded-lg border border-gray-300 px-3 text-sm font-semibold text-gray-700 hover:bg-gray-50"
        >
          Import another PDF
        </button>
      </div>

      {errorMessage ? (
        <p
          role="alert"
          className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900"
        >
          {errorMessage}
        </p>
      ) : null}

      <section className="mb-5 rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5">
        <p className="text-sm font-semibold text-gray-900">Source document</p>
        <p className="mt-1 text-sm text-gray-700">{draft.sourceName}</p>
        <p className="mt-1 text-xs text-gray-500">
          {draft.hierarchyDetected
            ? `${draft.sourceOutline.length} source headings detected across ${
                new Set(
                  draft.sourceOutline
                    .map((heading) => heading.sourcePage)
                    .filter(Boolean)
                ).size || 1
              } pages.`
            : "No reliable headings were detected. The source text remains available in the article preview and editor."}
        </p>
        {draft.imageDetectedPages?.length ? (
          <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-950">
            Images detected but not imported on pages{" "}
            {draft.imageDetectedPages.join(", ")}. The PDF text remains
            available; review the source pages for visual context.
          </p>
        ) : null}
        {draft.articles.some((article) =>
          article.sections.some((section) => section.possibleAuthorNote)
        ) ? (
          <p className="mt-2 text-xs text-gray-600">
            Possible author note tags are advisory. Source text remains included
            until you exclude it.
          </p>
        ) : null}
      </section>

      <section className="mb-5 rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5">
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-gray-950">
              Suggested Handbook category
            </h2>
            <label className="mt-2 block text-sm font-semibold text-gray-800">
              Rename suggested category
              <input
                value={categorySuggestion}
                maxLength={80}
                onChange={(event) =>
                  changeCategorySuggestion(event.currentTarget.value)
                }
                className="mt-1 block h-10 w-full rounded-lg border border-gray-300 px-3 font-normal"
              />
            </label>
            <label className="mt-3 block text-sm font-semibold text-gray-800">
              Select an existing category
              <select
                value={categoryId}
                onChange={(event) => {
                  setCategoryId(event.currentTarget.value);
                  if (event.currentTarget.value) setNewCategoryName("");
                }}
                className="mt-1 block h-10 w-full rounded-lg border border-gray-300 bg-white px-3 font-normal"
              >
                <option value="">No existing category selected</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
            </label>
            {!isStudent ? (
              <label className="mt-3 block text-sm font-semibold text-gray-800">
                Category to create on approval
                <input
                  value={newCategoryName}
                  maxLength={80}
                  onChange={(event) => {
                    setNewCategoryName(event.currentTarget.value);
                    if (event.currentTarget.value) setCategoryId("");
                  }}
                  placeholder="Leave blank to use the selected category"
                  className="mt-1 block h-10 w-full rounded-lg border border-gray-300 px-3 font-normal"
                />
              </label>
            ) : (
              <p className="mt-2 text-xs text-gray-500">
                You can save drafts without a category, then choose or propose
                one in the normal article review flow.
              </p>
            )}
            <div className="mt-6 border-t border-gray-200 pt-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-base font-semibold text-gray-950">
                  Proposed Handbook structure
                </h2>
                {structureSource === "claude" ? (
                  <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-semibold text-violet-900">
                    AI suggested
                  </span>
                ) : (
                  <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-semibold text-blue-900">
                    Deterministic
                  </span>
                )}
              </div>
              <p className="mt-1 text-xs text-gray-500">
                ARTICLE → SECTION → SUBSECTION
              </p>
              <ol className="mt-3 space-y-3">
                {articles.map((article) => (
                  <li
                    key={article.id}
                    className={`rounded-lg border p-3 ${
                      article.included
                        ? "border-gray-200 bg-white"
                        : "border-gray-200 bg-gray-100 text-gray-500"
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      <span className="shrink-0 rounded bg-gray-900 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
                        Article
                      </span>
                      <span className="min-w-0 flex-1 font-semibold text-gray-900">
                        {article.title || "Untitled article"}
                      </span>
                    </div>
                    <ul className="mt-2 space-y-1">
                      {proposalHeadings(article).map((heading, index) => (
                        <li
                          key={`${article.id}-${index}-${heading.title}`}
                          className={`flex gap-2 text-sm ${
                            heading.level === 3 ? "ml-6" : "ml-2"
                          }`}
                        >
                          <span className="shrink-0 text-[10px] font-bold uppercase tracking-wide text-gray-400">
                            {heading.level === 2 ? "Section" : "Subsection"}
                          </span>
                          <span className="text-gray-700">{heading.title}</span>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ol>
            </div>
          </div>

          <div className="min-w-0">
            <h2 className="text-base font-semibold text-gray-950">
              Detected PDF structure
            </h2>
            <p className="mt-1 text-xs text-gray-500">
              Original parser interpretation · H2/H3 levels · page numbers when
              available
            </p>
            <div className="mt-3 max-h-[34rem] overflow-auto rounded-lg border border-gray-200 bg-gray-50 p-3">
              <p className="mb-2 text-sm font-semibold text-gray-900">
                {draft.title}
              </p>
              {draft.sourceOutline.length ? (
                <ol className="space-y-1">
                  {draft.sourceOutline.map((heading) => (
                    <li
                      key={heading.id}
                      className={`flex items-start gap-2 rounded px-2 py-1 text-sm ${
                        heading.level === 3 ? "ml-5" : ""
                      }`}
                    >
                      <span className="shrink-0 rounded bg-white px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-gray-500">
                        {heading.level === 2 ? "H2" : "H3"}
                      </span>
                      <span className="min-w-0 flex-1 text-gray-800">
                        {heading.title}
                      </span>
                      <span className="shrink-0 text-[11px] text-gray-500">
                        {heading.sourcePage
                          ? `Page ${heading.sourcePage}`
                          : `Source ${heading.sourceOrder + 1}`}
                      </span>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="text-sm text-gray-600">
                  No headings were detected. The extracted text is available in
                  the article preview.
                </p>
              )}
            </div>
          </div>
        </div>
      </section>

      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-gray-950">
            Edit proposed articles
          </h2>
          <p className="text-sm text-gray-600">
            {articles.length} article proposals · {totalSourceSections} detected
            headings · excluded content remains visible here
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {claudeAvailable ? (
            <button
              type="button"
              onClick={requestClaudeStructure}
              disabled={structureBusy}
              className="inline-flex h-9 items-center rounded-lg border border-gray-300 bg-white px-3 text-sm font-semibold text-gray-800 disabled:opacity-60"
            >
              {structureBusy
                ? "Improving structure…"
                : "Improve structure with Claude"}
            </button>
          ) : (
            <p className="self-center text-xs text-gray-500">
              Claude structure analysis is unavailable.
            </p>
          )}
          <button
            type="button"
            onClick={continueAsOneArticle}
            className="inline-flex h-9 items-center rounded-lg border border-gray-300 bg-white px-3 text-sm font-semibold text-gray-800"
          >
            Continue with one article
          </button>
        </div>
      </div>

      {claudeSuggestion ? (
        <section
          aria-label="Claude suggested structure"
          className="mb-4 rounded-xl border border-violet-200 bg-violet-50 p-4"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="font-semibold text-violet-950">
                Claude suggested structure · AI suggested
              </h3>
              <p className="mt-1 text-sm text-violet-900">
                Category: {claudeSuggestion.categorySuggestion}
              </p>
              <ul className="mt-2 list-inside list-disc text-sm text-violet-950">
                {claudeSuggestion.articles.map((article) => (
                  <li key={article.id}>
                    {article.title} ({article.sections.length} detected source
                    sections)
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-violet-900">
                Your current deterministic structure remains active until you
                choose to use this suggestion.
              </p>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={applyClaudeSuggestion}
                className="h-9 rounded-lg bg-violet-800 px-3 text-sm font-semibold text-white hover:bg-violet-900"
              >
                Use suggestion
              </button>
              <button
                type="button"
                onClick={keepOriginalStructure}
                className="h-9 rounded-lg border border-violet-300 bg-white px-3 text-sm font-semibold text-violet-950"
              >
                Keep original structure
              </button>
            </div>
          </div>
        </section>
      ) : structureSource === "claude" ? (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-violet-200 bg-violet-50 px-3 py-2">
          <p className="text-sm text-violet-950">
            AI suggested grouping is active. You can edit it or restore the
            original extracted grouping.
          </p>
          <button
            type="button"
            onClick={keepOriginalStructure}
            className="h-8 rounded-lg border border-violet-300 bg-white px-3 text-xs font-semibold text-violet-950"
          >
            Keep original structure
          </button>
        </div>
      ) : null}
      {structureMessage || structureFetcher.data?.message ? (
        <p
          role={structureFetcher.data?.kind === "error" ? "alert" : "status"}
          className="mb-3 text-sm text-gray-700"
        >
          {structureFetcher.data?.message ?? structureMessage}
        </p>
      ) : null}

      <Form method="post" action="/handbook/import" className="space-y-4">
        <input type="hidden" name="intent" value="approve-structure" />
        <input type="hidden" name="draftTitle" value={draft.title} />
        <input type="hidden" name="sourceName" value={draft.sourceName} />
        <input type="hidden" name="articles" value={serializedArticles} />
        <input type="hidden" name="handbookCategoryId" value={categoryId} />
        <input type="hidden" name="newCategoryName" value={newCategoryName} />

        {articles.map((article, articleIndex) => {
          const matches = potentialMatches(article);
          const selectedExisting = existingArticles.find(
            (existing) => existing.slug === article.existingArticleSlug
          );
          const orderedSections = article.sections
            .slice()
            .sort((left, right) => left.sourceOrder - right.sourceOrder);
          const includedCount = orderedSections.filter(
            (section) => section.included
          ).length;
          const content = articleContent(article);
          const outline = getHandbookOutline(content);
          const previewContent = [content, provenance]
            .filter(Boolean)
            .join("\n\n");

          return (
            <section
              key={article.id}
              aria-label={`Proposed article ${article.title}`}
              className={`rounded-xl border p-4 shadow-sm sm:p-5 ${
                article.included
                  ? "border-gray-200 bg-white"
                  : "border-gray-200 bg-gray-50 opacity-70"
              }`}
            >
              <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  aria-label={`Include ${article.title}`}
                  checked={article.included}
                  onChange={(event) => {
                    const included = event.currentTarget.checked;
                    updateArticle(article.id, (current) => ({
                      ...current,
                      included,
                    }));
                  }}
                  className="mt-1 size-4 rounded border-gray-300 text-red-700 focus:ring-red-600"
                />
                <div className="min-w-0 flex-1">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <span className="rounded bg-gray-900 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
                      Article
                    </span>
                    {structureSource === "claude" || article.rationale ? (
                      <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-semibold text-violet-900">
                        AI suggested
                      </span>
                    ) : null}
                    <span className="text-xs text-gray-500">
                      {includedCount} included section
                      {includedCount === 1 ? "" : "s"}
                    </span>
                  </div>
                  <label className="block text-sm font-semibold text-gray-800">
                    Rename article
                    <input
                      required={article.included}
                      maxLength={180}
                      value={article.title}
                      onChange={(event) => {
                        const title = event.currentTarget.value;
                        updateArticle(article.id, (current) => ({
                          ...current,
                          title,
                        }));
                      }}
                      className="mt-1 block h-10 w-full rounded-lg border border-gray-300 px-3 font-normal"
                    />
                  </label>
                  {article.rationale ? (
                    <p className="mt-2 rounded-md bg-violet-50 px-3 py-2 text-xs text-violet-900">
                      Claude rationale: {article.rationale}
                    </p>
                  ) : null}

                  {matches.length || selectedExisting ? (
                    <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
                      <p className="text-sm font-semibold text-amber-950">
                        Potential existing article
                      </p>
                      {matches.map((match) => (
                        <p
                          key={match.id}
                          className="mt-1 text-xs text-amber-900"
                        >
                          {match.title} ·{" "}
                          {match.categoryName || "Uncategorized"}
                        </p>
                      ))}
                      <label className="mt-2 block text-xs font-semibold text-amber-950">
                        Import action
                        <select
                          value={article.existingArticleSlug ?? ""}
                          onChange={(event) => {
                            const target = existingArticles.find(
                              (item) => item.slug === event.currentTarget.value
                            );
                            updateArticle(article.id, (current) => ({
                              ...current,
                              existingArticleSlug: target?.slug,
                              revisionBaseVersionId:
                                target?.publishedVersionId ?? undefined,
                            }));
                          }}
                          className="mt-1 block h-9 w-full rounded-lg border border-amber-300 bg-white px-2 font-normal text-gray-800"
                        >
                          <option value="">Create new article</option>
                          {[
                            ...new Map(
                              [
                                ...matches,
                                ...(selectedExisting ? [selectedExisting] : []),
                              ].map((item) => [item.slug, item])
                            ).values(),
                          ].map((match) => (
                            <option key={match.slug} value={match.slug}>
                              Use existing / improve: {match.title}
                            </option>
                          ))}
                        </select>
                      </label>
                      {selectedExisting ? (
                        <p className="mt-1 text-xs text-amber-900">
                          Approval creates a proposed revision of “
                          {selectedExisting.title}” and keeps its current
                          published version live.
                        </p>
                      ) : null}
                    </div>
                  ) : null}

                  <div className="mt-4">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                      Sections and subsections
                    </h3>
                    {orderedSections.length ? (
                      <ol className="mt-2 space-y-2">
                        {orderedSections.map((section, sectionIndex) => {
                          const previousHasSection = orderedSections
                            .slice(0, sectionIndex)
                            .some(
                              (previous) =>
                                previous.included && previous.level === 2
                            );
                          const titlePage = pageByHeadingTitle.get(
                            normalizeTitle(section.title)
                          );
                          return (
                            <li
                              key={section.id}
                              className={`rounded-lg border p-3 ${
                                section.included
                                  ? "border-gray-200 bg-gray-50"
                                  : "border-dashed border-gray-300 bg-gray-100"
                              } ${section.level === 3 ? "ml-5 sm:ml-8" : ""}`}
                            >
                              <div className="flex flex-wrap items-start gap-2">
                                <input
                                  type="checkbox"
                                  aria-label={`Include section ${section.title}`}
                                  checked={section.included}
                                  onChange={(event) => {
                                    const included =
                                      event.currentTarget.checked;
                                    updateSection(
                                      article.id,
                                      section.id,
                                      (item) => ({
                                        ...item,
                                        included,
                                      })
                                    );
                                  }}
                                  className="mt-1 size-4 rounded border-gray-300 text-red-700 focus:ring-red-600"
                                />
                                <div className="min-w-0 flex-1">
                                  <div className="mb-1 flex flex-wrap items-center gap-2">
                                    <span className="rounded bg-gray-200 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-gray-700">
                                      {section.level === 2
                                        ? "Section"
                                        : "Subsection"}
                                    </span>
                                    <span className="text-[11px] text-gray-500">
                                      {section.sourcePage ?? titlePage
                                        ? `Source page ${
                                            section.sourcePage ?? titlePage
                                          }`
                                        : `Source order ${
                                            section.sourceOrder + 1
                                          }`}
                                    </span>
                                    {!section.included ? (
                                      <span className="text-[11px] font-semibold text-gray-500">
                                        Excluded from import · still detected
                                      </span>
                                    ) : null}
                                    {section.possibleAuthorNote ? (
                                      <span
                                        title="Review this source text before importing; it has not been removed."
                                        className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-950"
                                      >
                                        Possible author note
                                      </span>
                                    ) : null}
                                  </div>
                                  <label className="block text-xs font-semibold text-gray-600">
                                    Rename{" "}
                                    {section.level === 2
                                      ? "section"
                                      : "subsection"}
                                    <input
                                      aria-label={`Rename heading ${section.title}`}
                                      value={section.title}
                                      maxLength={180}
                                      onChange={(event) => {
                                        const title = event.currentTarget.value;
                                        updateSection(
                                          article.id,
                                          section.id,
                                          (item) => ({
                                            ...item,
                                            title,
                                            markdown: updateSectionHeading(
                                              item.markdown,
                                              title,
                                              item.level
                                            ),
                                          })
                                        );
                                      }}
                                      className="mt-1 block h-9 w-full rounded-md border border-gray-300 bg-white px-2 text-sm font-normal text-gray-900"
                                    />
                                  </label>
                                  <div className="mt-2 flex flex-wrap items-center gap-2">
                                    {section.level === 2 ? (
                                      <button
                                        type="button"
                                        disabled={!previousHasSection}
                                        onClick={() =>
                                          updateSection(
                                            article.id,
                                            section.id,
                                            (item) => ({
                                              ...item,
                                              level: 3,
                                              markdown: updateSectionHeading(
                                                item.markdown,
                                                item.title,
                                                3
                                              ),
                                            })
                                          )
                                        }
                                        className="h-8 rounded-md border border-gray-300 bg-white px-2 text-xs font-semibold text-gray-700 disabled:cursor-not-allowed disabled:opacity-40"
                                      >
                                        Make subsection
                                      </button>
                                    ) : (
                                      <button
                                        type="button"
                                        onClick={() =>
                                          updateSection(
                                            article.id,
                                            section.id,
                                            (item) => ({
                                              ...item,
                                              level: 2,
                                              markdown: updateSectionHeading(
                                                item.markdown,
                                                item.title,
                                                2
                                              ),
                                            })
                                          )
                                        }
                                        className="h-8 rounded-md border border-gray-300 bg-white px-2 text-xs font-semibold text-gray-700"
                                      >
                                        Make section
                                      </button>
                                    )}
                                    {articles.length > 1 ? (
                                      <label className="flex items-center gap-2 text-xs text-gray-600">
                                        Move to…
                                        <select
                                          aria-label={`Move ${section.title} to article`}
                                          value={article.id}
                                          onChange={(event) =>
                                            moveSection(
                                              section.id,
                                              event.currentTarget.value
                                            )
                                          }
                                          className="h-8 max-w-56 rounded-md border border-gray-300 bg-white px-2"
                                        >
                                          {articles.map((target) => (
                                            <option
                                              key={target.id}
                                              value={target.id}
                                            >
                                              {target.title ||
                                                `Article ${articleIndex + 1}`}
                                            </option>
                                          ))}
                                        </select>
                                      </label>
                                    ) : null}
                                    <label className="flex items-center gap-1 text-xs text-gray-600">
                                      <input
                                        type="checkbox"
                                        checked={selectedSectionIds.includes(
                                          section.id
                                        )}
                                        onChange={(event) => {
                                          const selected =
                                            event.currentTarget.checked;
                                          setSelectedSectionIds((current) =>
                                            selected
                                              ? [
                                                  ...new Set([
                                                    ...current,
                                                    section.id,
                                                  ]),
                                                ]
                                              : current.filter(
                                                  (id) => id !== section.id
                                                )
                                          );
                                        }}
                                        aria-label={`Select ${section.title} to move into a new article`}
                                        className="size-3.5 rounded border-gray-300"
                                      />
                                      Select for new article
                                    </label>
                                  </div>
                                  {section.sourceUrls.length ? (
                                    <p className="mt-2 text-xs text-gray-500">
                                      {section.sourceUrls.length} source
                                      reference
                                      {section.sourceUrls.length === 1
                                        ? ""
                                        : "s"}{" "}
                                      attached
                                    </p>
                                  ) : null}
                                </div>
                              </div>
                            </li>
                          );
                        })}
                      </ol>
                    ) : (
                      <p className="mt-2 text-sm text-gray-500">
                        No sections remain in this proposal.
                      </p>
                    )}
                  </div>

                  {orderedSections.length ? (
                    <div className="mt-3 flex flex-wrap items-end gap-2 rounded-lg border border-dashed border-gray-300 p-3">
                      <label className="min-w-56 flex-1 text-xs font-semibold text-gray-700">
                        New article title
                        <input
                          aria-label={`New article title from ${article.title}`}
                          value={newArticleTitles[article.id] ?? ""}
                          maxLength={180}
                          onChange={(event) => {
                            const title = event.currentTarget.value;
                            setNewArticleTitles((current) => ({
                              ...current,
                              [article.id]: title,
                            }));
                          }}
                          placeholder="Title for selected sections"
                          className="mt-1 block h-9 w-full rounded-md border border-gray-300 bg-white px-2 text-sm font-normal"
                        />
                      </label>
                      <button
                        type="button"
                        disabled={
                          !newArticleTitles[article.id]?.trim() ||
                          !article.sections.some((section) =>
                            selectedSectionIds.includes(section.id)
                          )
                        }
                        onClick={() => splitSelectedSections(article.id)}
                        className="h-9 rounded-lg border border-gray-300 bg-white px-3 text-xs font-semibold text-gray-800 disabled:opacity-50"
                      >
                        Move selected to new article
                      </button>
                    </div>
                  ) : null}

                  {articles.length > 1 ? (
                    <label className="mt-3 flex items-center gap-2 text-xs text-gray-600">
                      Merge with…
                      <select
                        aria-label={`Merge ${article.title} with`}
                        defaultValue=""
                        className="h-8 max-w-64 rounded-md border border-gray-300 bg-white px-2"
                        onChange={(event) => {
                          if (event.currentTarget.value) {
                            mergeArticle(article.id, event.currentTarget.value);
                          }
                        }}
                      >
                        <option value="">Choose article</option>
                        {articles
                          .filter((target) => target.id !== article.id)
                          .map((target) => (
                            <option key={target.id} value={target.id}>
                              {target.title}
                            </option>
                          ))}
                      </select>
                    </label>
                  ) : null}

                  <details className="mt-4 rounded-lg border border-gray-200 p-3">
                    <summary className="cursor-pointer text-sm font-semibold text-gray-800">
                      Edit article content (Markdown)
                    </summary>
                    <label className="mt-3 block text-sm font-semibold text-gray-800">
                      Article content
                      <textarea
                        rows={draft.fallback ? 18 : 12}
                        maxLength={articleContentLimit}
                        value={content}
                        onChange={(event) => {
                          const contentOverride = event.currentTarget.value;
                          updateArticle(article.id, (current) => ({
                            ...current,
                            contentOverride,
                          }));
                        }}
                        onBlur={() =>
                          updateArticle(article.id, syncArticleContent)
                        }
                        className="mt-1 block w-full rounded-lg border border-gray-300 p-3 font-mono text-sm font-normal leading-6"
                      />
                    </label>
                    <p className="mt-1 text-xs text-gray-500">
                      Use Markdown headings to preserve the outline.{" "}
                      {content.length.toLocaleString()} /{" "}
                      {articleContentLimit.toLocaleString()} characters
                      available.
                    </p>
                  </details>

                  <details className="mt-3 rounded-lg border border-blue-200 bg-blue-50 p-3">
                    <summary className="cursor-pointer text-sm font-semibold text-blue-950">
                      Preview article
                    </summary>
                    <div className="mt-3 rounded-lg border border-blue-100 bg-white p-4">
                      <p className="text-xs font-semibold uppercase tracking-wide text-blue-700">
                        Handbook preview
                      </p>
                      <h3 className="mt-1 text-xl font-semibold text-gray-950">
                        {article.title || "Untitled article"}
                      </h3>
                      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(12rem,0.7fr)_minmax(0,1.3fr)]">
                        <nav
                          aria-label={`Table of contents for ${article.title}`}
                        >
                          <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                            Table of contents
                          </p>
                          <ol className="mt-2 space-y-1 text-sm">
                            {outline.length ? (
                              outline.map((item) => (
                                <li
                                  key={item.id}
                                  className={item.level === 3 ? "ml-4" : ""}
                                >
                                  {item.title}
                                </li>
                              ))
                            ) : (
                              <li className="text-gray-500">No headings</li>
                            )}
                          </ol>
                        </nav>
                        <div className="min-w-0">
                          <MarkdownViewer
                            content={previewContent}
                            allowExternalLinks
                          />
                          {articleReferences(article).length ? (
                            <div className="mt-4 border-t border-gray-200 pt-3">
                              <h4 className="text-sm font-semibold text-gray-800">
                                Article references
                              </h4>
                              <ul className="mt-1 list-inside list-disc text-sm text-blue-800">
                                {articleReferences(article).map((url) => (
                                  <li key={url}>
                                    <a
                                      href={url}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="break-all underline"
                                    >
                                      {url}
                                    </a>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  </details>
                </div>
              </div>
            </section>
          );
        })}

        {overLengthArticles.length ? (
          <p
            role="alert"
            className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-950"
          >
            Shorten each selected article to the 30,000-character Handbook limit
            before creating drafts.
          </p>
        ) : null}

        <div className="flex flex-wrap justify-end gap-2 border-t border-gray-200 pt-4">
          <Link
            to="/handbook"
            className="inline-flex h-10 items-center rounded-lg border border-gray-300 px-4 text-sm font-semibold text-gray-700"
          >
            Cancel
          </Link>
          <button
            type="submit"
            disabled={
              busy ||
              approvedArticles.length === 0 ||
              overLengthArticles.length > 0
            }
            className="inline-flex h-10 items-center rounded-lg bg-red-700 px-4 text-sm font-semibold text-white hover:bg-red-800 disabled:opacity-60"
          >
            {busy
              ? "Saving drafts…"
              : `Create ${approvedArticles.length} draft${
                  approvedArticles.length === 1 ? "" : "s"
                }`}
          </button>
        </div>
      </Form>
    </main>
  );
}
