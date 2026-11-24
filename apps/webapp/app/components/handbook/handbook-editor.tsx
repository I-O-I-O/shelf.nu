import { useCallback, useEffect, useMemo, useState } from "react";
import { Form, Link, useFetcher } from "react-router";
import { EditorV2 } from "~/components/editor-v2/editor-v2";
import { HANDBOOK_ATTACHMENT_ACCEPT } from "~/modules/ioio-handbook/attachment.shared";
import { HandbookCategoryPicker } from "./handbook-category-picker";
import { HandbookRemovalMenu } from "./handbook-removal-button";

const HANDBOOK_HEADING_LEVELS = [2, 3];

type HandbookEditorArticle = {
  id: string;
  slug?: string;
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED";
  staffOnly?: boolean;
  draftTitle: string;
  draftContent: string;
  handbookCategoryId: string | null;
  proposedCategoryName?: string | null;
  revisionBaseVersionId?: string | null;
  revisionSubmitted?: boolean;
  pendingSubmissionId?: string | null;
  reviewFeedback?: string | null;
  draftSourceUrls: string[];
  attachments: Array<{
    id: string;
    title: string;
    fileName: string;
    fileSizeBytes: number;
    downloadVersionId?: string;
  }>;
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
  staffOnly?: boolean;
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

function formatAttachmentSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
  const [staffOnly, setStaffOnly] = useState(article?.staffOnly ?? false);
  const [attachments, setAttachments] = useState(article?.attachments ?? []);
  const [selectedFileCount, setSelectedFileCount] = useState(0);

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
    return {
      src: result.src,
      alt: /^(?:blob|image)(?:\.[^.]+)?$/iu.test(file.name)
        ? "Pasted image"
        : file.name.replace(/\.[^.]+$/u, ""),
    };
  }, []);

  useEffect(() => {
    setHandbookCategoryId(article?.handbookCategoryId ?? "");
    setProposedCategoryName(article?.proposedCategoryName ?? "");
    setTitle(article?.draftTitle ?? "");
    setStaffOnly(article?.staffOnly ?? false);
    setAttachments(article?.attachments ?? []);
    setSelectedFileCount(0);
  }, [
    article?.id,
    article?.attachments,
    article?.handbookCategoryId,
    article?.proposedCategoryName,
    article?.draftTitle,
    article?.staffOnly,
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
  const handbookArticles = useMemo(
    () =>
      titleMatches
        .filter((item) => item.slug !== article?.slug)
        .map(({ slug, title, categoryName, staffOnly }) => ({
          slug,
          title,
          categoryName,
          staffOnly,
        })),
    [article?.slug, titleMatches]
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
              ? "Edit Handbook article"
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
              <HandbookRemovalMenu
                menuLabel="Draft actions"
                intent={
                  article.pendingSubmissionId
                    ? "withdraw-submission"
                    : "delete-draft"
                }
                articleId={article.pendingSubmissionId ? undefined : article.id}
                observationId={article.pendingSubmissionId ?? undefined}
                actionPath="/handbook/my-work"
              />
            ) : null}
          </div>
        ) : null}
      </div>
      {article?.reviewFeedback ? (
        <p className="mb-4 whitespace-pre-wrap break-words rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm text-gray-700">
          <span className="font-semibold">Staff feedback: </span>
          {article.reviewFeedback}
        </p>
      ) : null}
      <Form
        method="post"
        encType="multipart/form-data"
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
                      Edit article
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
        <fieldset className="rounded-lg border border-gray-200 p-4">
          <legend className="px-1 text-sm font-semibold text-gray-900">
            Visibility
          </legend>
          {isStudent ? (
            <p className="text-sm text-gray-700">Everyone</p>
          ) : (
            <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-gray-800">
              <label className="inline-flex items-center gap-2">
                <input
                  type="radio"
                  name="visibility"
                  value="everyone"
                  checked={!staffOnly}
                  onChange={() => setStaffOnly(false)}
                />
                Everyone
              </label>
              <label className="inline-flex items-center gap-2">
                <input
                  type="radio"
                  name="visibility"
                  value="staff-only"
                  checked={staffOnly}
                  onChange={() => setStaffOnly(true)}
                />
                Staff only
              </label>
            </div>
          )}
          <p className="mt-1 text-xs font-normal text-gray-500">
            {isStudent
              ? "Student contributions are published for everyone after Staff approval."
              : "Staff-only articles are hidden from Students, search, and public article links."}
          </p>
        </fieldset>
        <div className="block text-sm font-semibold text-gray-800">
          <span>Article content</span>
          <EditorV2
            name="content"
            label="Article content"
            defaultValue={article?.draftContent ?? ""}
            placeholder="Write practical instructions, lists, warnings, and tips."
            headingLevels={HANDBOOK_HEADING_LEVELS}
            enableHandbookBlocks
            allowRawBlockEditing={false}
            onUploadImage={uploadArticleImage}
            allowClipboardImagePaste={!isStudent}
            handbookArticles={handbookArticles}
            helpText="Use Link for Handbook articles or external URLs. Use Section for a main article part and Subsection for a nested part. Type / to add blocks. Images may be up to 2 MB."
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
        <section className="rounded-lg border border-gray-200 p-4">
          <h2 className="text-sm font-semibold text-gray-900">Files</h2>
          <p className="mt-1 text-xs font-normal text-gray-600">
            Attach code and supporting documents for readers to download. Files
            are not run by IOIO Lab. Up to 5 files, 10 MB each.
          </p>
          {attachments.length ? (
            <ul className="mt-3 space-y-3">
              {attachments.map((attachment) => (
                <li
                  key={attachment.id}
                  className="flex flex-wrap items-end gap-2 rounded-lg bg-gray-50 p-3"
                >
                  <input
                    type="hidden"
                    name="attachmentSourceId"
                    value={attachment.id}
                  />
                  <div className="min-w-48 flex-1 text-xs font-semibold text-gray-700">
                    {attachment.title}
                    <span className="mt-1 block font-normal text-gray-500">
                      {attachment.title === attachment.fileName
                        ? formatAttachmentSize(attachment.fileSizeBytes)
                        : `${attachment.fileName} · ${formatAttachmentSize(
                            attachment.fileSizeBytes
                          )}`}
                    </span>
                  </div>
                  <a
                    href={`/api/handbook-attachment?sourceId=${encodeURIComponent(
                      attachment.id
                    )}${
                      attachment.downloadVersionId
                        ? `&versionId=${encodeURIComponent(
                            attachment.downloadVersionId
                          )}`
                        : ""
                    }`}
                    className="inline-flex h-9 items-center rounded-md border border-gray-300 bg-white px-3 text-xs font-semibold text-gray-800 hover:bg-gray-100"
                  >
                    Download
                  </a>
                  <button
                    type="button"
                    aria-label={`Remove ${attachment.fileName}`}
                    onClick={() =>
                      setAttachments((current) =>
                        current.filter((item) => item.id !== attachment.id)
                      )
                    }
                    className="inline-flex h-9 items-center rounded-md px-3 text-xs font-semibold text-red-800 hover:bg-red-50"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <label className="mt-3 block text-xs font-semibold text-gray-700">
            Upload files
            <input
              type="file"
              name="attachments"
              multiple
              accept={HANDBOOK_ATTACHMENT_ACCEPT}
              onChange={(event) =>
                setSelectedFileCount(event.currentTarget.files?.length ?? 0)
              }
              className="mt-1 block w-full text-sm font-normal text-gray-700 file:mr-3 file:rounded-md file:border-0 file:bg-gray-100 file:px-3 file:py-2 file:text-xs file:font-semibold file:text-gray-800"
            />
          </label>
          {selectedFileCount ? (
            <p className="mt-2 text-xs text-gray-600">
              {selectedFileCount} new file{selectedFileCount === 1 ? "" : "s"}{" "}
              selected.
            </p>
          ) : null}
        </section>
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
              Submit for review
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
