import { useCallback, useEffect, useMemo, useState } from "react";
import { Form, Link, useFetcher } from "react-router";
import { EditorV2 } from "~/components/editor-v2/editor-v2";
import { HandbookCategoryPicker } from "./handbook-category-picker";
import { HandbookRemovalButton } from "./handbook-removal-button";

const HANDBOOK_HEADING_LEVELS = [2, 3];

type HandbookEditorArticle = {
  id: string;
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED";
  draftTitle: string;
  draftContent: string;
  handbookCategoryId: string | null;
  proposedCategoryName?: string | null;
  revisionBaseVersionId?: string | null;
  revisionSubmitted?: boolean;
  pendingSubmissionId?: string | null;
  draftSourceUrls: string[];
  versions: Array<{
    versionNumber: number;
    title: string;
    publishedAt: Date | string;
    publishedBy: string | null;
  }>;
};

type HandbookTitleMatch = {
  slug: string;
  title: string;
  handbookCategoryId: string | null;
  categoryName: string;
};

function normalizeTitle(value: string) {
  return value
    .normalize("NFKD")
    .toLocaleLowerCase("en")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function findSimilarTitles(value: string, titles: HandbookTitleMatch[]) {
  const query = normalizeTitle(value);
  if (query.length < 3) return [];
  const queryTokens = new Set(query.split(/\s+/));
  return titles
    .map((item) => {
      const normalizedTitle = normalizeTitle(item.title);
      const titleTokens = new Set(normalizedTitle.split(/\s+/));
      const overlap = [...queryTokens].filter((token) =>
        titleTokens.has(token)
      ).length;
      const score =
        normalizedTitle.includes(query) || query.includes(normalizedTitle)
          ? 1
          : overlap / Math.max(queryTokens.size, titleTokens.size);
      return { ...item, score };
    })
    .filter((item) => item.score >= 0.5)
    .sort(
      (left, right) =>
        right.score - left.score || left.title.localeCompare(right.title)
    )
    .slice(0, 4);
}

export function HandbookEditor({
  article,
  categories,
  busy = false,
  errorMessage,
  saved = false,
  isStudent = false,
  revisionMode = false,
  initialCategoryId = "",
  titleMatches = [],
}: {
  article: HandbookEditorArticle | null;
  categories: Array<{ id: string; name: string }>;
  busy?: boolean;
  errorMessage?: string;
  saved?: boolean;
  isStudent?: boolean;
  revisionMode?: boolean;
  initialCategoryId?: string;
  titleMatches?: HandbookTitleMatch[];
}) {
  const categoryFetcher = useFetcher<{
    ok: boolean;
    category?: { id: string; name: string };
    message?: string;
  }>();
  const [availableCategories, setAvailableCategories] = useState(categories);
  const [handbookCategoryId, setHandbookCategoryId] = useState(
    article?.handbookCategoryId ?? initialCategoryId
  );
  const [proposedCategoryName, setProposedCategoryName] = useState(
    article?.proposedCategoryName ?? ""
  );
  const [title, setTitle] = useState(article?.draftTitle ?? "");

  const uploadArticleImage = useCallback(async (file: File) => {
    const formData = new FormData();
    formData.set("image", file);
    const response = await fetch("/api/handbook-image-upload", {
      method: "POST",
      body: formData,
      credentials: "same-origin",
    });
    const result = (await response.json()) as {
      ok?: boolean;
      src?: string;
      message?: string;
    };
    if (!response.ok || !result.ok || !result.src) {
      throw new Error(result.message ?? "The image could not be uploaded.");
    }
    return { src: result.src, alt: file.name.replace(/\.[^.]+$/u, "") };
  }, []);

  useEffect(() => {
    setHandbookCategoryId(article?.handbookCategoryId ?? "");
    setProposedCategoryName(article?.proposedCategoryName ?? "");
    setTitle(article?.draftTitle ?? "");
  }, [
    article?.id,
    article?.handbookCategoryId,
    article?.proposedCategoryName,
    article?.draftTitle,
    revisionMode,
  ]);

  useEffect(() => {
    if (!article) setHandbookCategoryId(initialCategoryId);
  }, [article, initialCategoryId]);

  useEffect(() => {
    setAvailableCategories((current) => {
      const next = [...current];
      for (const category of categories) {
        if (!next.some((item) => item.id === category.id)) next.push(category);
      }
      return next;
    });
  }, [categories]);

  useEffect(() => {
    const category = categoryFetcher.data?.category;
    if (!categoryFetcher.data?.ok || !category) return;
    setAvailableCategories((current) =>
      current.some((item) => item.id === category.id)
        ? current
        : [...current, category].sort((a, b) => a.name.localeCompare(b.name))
    );
    setHandbookCategoryId(category.id);
    setProposedCategoryName("");
  }, [categoryFetcher.data]);

  function createCategory(name: string) {
    void categoryFetcher.submit(
      { intent: "create-category", categoryName: name },
      { method: "post" }
    );
  }

  const similarTitles = useMemo(
    () =>
      findSimilarTitles(
        title,
        titleMatches.filter(
          (item) => item.handbookCategoryId === handbookCategoryId
        )
      ),
    [handbookCategoryId, title, titleMatches]
  );

  return (
    <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link
            to="/handbook"
            className="text-sm font-semibold text-red-800 hover:underline"
          >
            ← Handbook
          </Link>
          <h1 className="mt-2 text-2xl font-semibold text-gray-950">
            {revisionMode
              ? "Improve Handbook article"
              : article
              ? "Edit Handbook draft"
              : "New Handbook article"}
          </h1>
        </div>
        {article ? (
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-semibold text-gray-700">
              {revisionMode
                ? "Proposed revision · current version stays live"
                : article.status === "PUBLISHED"
                ? "Published · draft edits are private"
                : article.status}
            </span>
            {article.status === "DRAFT" && article.versions.length === 0 ? (
              <details className="relative">
                <summary
                  aria-label="Draft actions"
                  className="flex size-9 cursor-pointer list-none items-center justify-center rounded text-gray-600 hover:bg-gray-100"
                >
                  ⋯
                </summary>
                <div className="absolute right-0 z-30 mt-1 w-48 rounded border border-gray-200 bg-white p-1 shadow-sm">
                  {article.pendingSubmissionId ? (
                    <HandbookRemovalButton
                      intent="withdraw-submission"
                      observationId={article.pendingSubmissionId}
                      actionPath="/handbook/my-work"
                    />
                  ) : (
                    <HandbookRemovalButton
                      intent="delete-draft"
                      articleId={article.id}
                      actionPath="/handbook/my-work"
                    />
                  )}
                </div>
              </details>
            ) : null}
          </div>
        ) : null}
      </div>
      <Form
        method="post"
        className="space-y-5 rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-6"
      >
        {revisionMode ? (
          <>
            <input type="hidden" name="revisionMode" value="1" />
            <input
              type="hidden"
              name="revisionBaseVersionId"
              value={article?.revisionBaseVersionId ?? ""}
            />
            <p className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-950">
              This proposal is based on the current published version. Readers
              will continue to see it until the new version is published.
            </p>
          </>
        ) : null}
        {errorMessage ? (
          <p
            role="alert"
            className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900"
          >
            {errorMessage}
          </p>
        ) : null}
        {saved ? (
          <p
            role="status"
            className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-900"
          >
            Draft saved. The published article is unchanged until you publish a
            new version.
          </p>
        ) : null}
        <label className="block text-sm font-semibold text-gray-800">
          Title
          <input
            required
            name="title"
            maxLength={180}
            value={title}
            onChange={(event) => setTitle(event.currentTarget.value)}
            className="mt-1 block h-10 w-full rounded-lg border border-gray-300 px-3 font-normal focus:border-red-700 focus:outline-none focus:ring-2 focus:ring-red-100"
          />
        </label>
        {!article && similarTitles.length ? (
          <aside className="rounded-lg border border-amber-200 bg-amber-50 p-3">
            <p className="text-sm font-semibold text-amber-950">
              Similar knowledge already exists in this category
            </p>
            <ul className="mt-2 space-y-2">
              {similarTitles.map((match) => (
                <li
                  key={match.slug}
                  className="flex flex-wrap items-center justify-between gap-2 text-sm"
                >
                  <span className="font-medium text-gray-900">
                    {match.title}
                  </span>
                  <span className="flex gap-3">
                    <Link
                      to={`/handbook/${encodeURIComponent(match.slug)}`}
                      className="font-semibold text-red-800 hover:underline"
                    >
                      View article
                    </Link>
                    <Link
                      to={`/handbook/${encodeURIComponent(
                        match.slug
                      )}/edit?improve=1`}
                      className="font-semibold text-red-800 hover:underline"
                    >
                      Improve this article
                    </Link>
                  </span>
                </li>
              ))}
            </ul>
          </aside>
        ) : null}
        <div className="block text-sm font-semibold text-gray-800">
          <span>Category</span>
          <HandbookCategoryPicker
            categories={availableCategories}
            value={handbookCategoryId}
            proposedName={proposedCategoryName}
            onChange={(id, proposal) => {
              setHandbookCategoryId(id);
              setProposedCategoryName(proposal);
            }}
            mode={isStudent ? "student" : "staff"}
            creating={categoryFetcher.state !== "idle"}
            createSucceeded={Boolean(categoryFetcher.data?.ok)}
            onCreateCategory={isStudent ? undefined : createCategory}
          />
          {categoryFetcher.data?.message ? (
            <p
              role={categoryFetcher.data.ok ? "status" : "alert"}
              className={
                categoryFetcher.data.ok
                  ? "mt-1 text-sm text-green-800"
                  : "mt-1 text-sm text-red-800"
              }
            >
              {categoryFetcher.data.message}
            </p>
          ) : null}
          <p className="mt-1 text-xs font-normal text-gray-500">
            {isStudent
              ? "Start typing to search existing categories. If no suitable category appears, type the new category name and choose “Propose”."
              : "Start typing to search existing categories. If no suitable category appears, type the new category name and choose “Create”."}
          </p>
        </div>
        <div className="block text-sm font-semibold text-gray-800">
          <span>Article content</span>
          <EditorV2
            name="content"
            label="Article content"
            defaultValue={article?.draftContent ?? ""}
            placeholder="Write practical instructions, lists, warnings, and tips."
            maxLength={30000}
            headingLevels={HANDBOOK_HEADING_LEVELS}
            enableHandbookBlocks
            allowRawBlockEditing={false}
            onUploadImage={uploadArticleImage}
            helpText="Use Section for a main article part and Subsection for a nested part. Type / to add blocks. Images may be up to 2 MB. Add HTTPS video links with Link."
          />
        </div>
        <label className="block text-sm font-semibold text-gray-800">
          External references{" "}
          <span className="font-normal text-gray-500">
            (one http(s) URL per line)
          </span>
          <textarea
            name="sourceUrls"
            rows={3}
            defaultValue={article?.draftSourceUrls.join("\n") ?? ""}
            placeholder="https://manufacturer.example/manual"
            className="mt-1 block w-full rounded-lg border border-gray-300 p-3 text-sm font-normal focus:border-red-700 focus:outline-none focus:ring-2 focus:ring-red-100"
          />
        </label>
        {article?.versions.length ? (
          <section className="rounded-lg bg-gray-50 p-3">
            <h2 className="text-sm font-semibold text-gray-800">
              Published history
            </h2>
            <ul className="mt-2 space-y-1 text-xs text-gray-600">
              {article.versions.map((version) => (
                <li key={version.versionNumber}>
                  v{version.versionNumber} · {version.title} ·{" "}
                  {new Date(version.publishedAt).toLocaleDateString()} ·{" "}
                  {version.publishedBy ?? "IOIO Staff"}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2 border-t border-gray-100 pt-4">
          <Link
            to="/handbook"
            className="inline-flex h-10 items-center rounded-lg border border-gray-300 px-4 text-sm font-semibold text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </Link>
          <button
            disabled={busy}
            name="intent"
            value="save-draft"
            className="inline-flex h-10 items-center rounded-lg border border-gray-300 bg-white px-4 text-sm font-semibold text-gray-800 disabled:opacity-60"
          >
            {busy ? "Saving…" : "Save draft"}
          </button>
          {isStudent ? (
            <button
              disabled={busy}
              name="intent"
              value="submit-for-review"
              className="inline-flex h-10 items-center rounded-lg bg-red-700 px-4 text-sm font-semibold text-white hover:bg-red-800 disabled:opacity-60"
            >
              {revisionMode
                ? "Submit improvement for Staff review"
                : "Submit for Staff review"}
            </button>
          ) : (
            <button
              disabled={busy}
              name="intent"
              value="publish"
              className="inline-flex h-10 items-center rounded-lg bg-red-700 px-4 text-sm font-semibold text-white hover:bg-red-800 disabled:opacity-60"
            >
              {revisionMode || article?.status === "PUBLISHED"
                ? "Publish new version"
                : "Publish article"}
            </button>
          )}
        </div>
      </Form>
    </main>
  );
}
