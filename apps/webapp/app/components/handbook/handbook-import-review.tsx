import { useEffect, useState } from "react";
import { Form, Link, useFetcher, useNavigation } from "react-router";
import { HandbookCategoryPicker } from "./handbook-category-picker";

export type HandbookImportDraft = {
  title: string;
  content: string;
  sourceUrls: string[];
  handbookCategoryId?: string;
  proposedCategoryName?: string;
};

export function HandbookImportReview({
  draft,
  categories,
  isStudent,
  organizationId,
  userId,
  errorMessage,
  onImportAnother,
}: {
  draft: HandbookImportDraft;
  categories: Array<{ id: string; name: string }>;
  isStudent: boolean;
  organizationId: string;
  userId: string;
  errorMessage?: string;
  onImportAnother: () => void;
}) {
  const [title, setTitle] = useState(draft.title);
  const [content, setContent] = useState(draft.content);
  const [sourceUrls, setSourceUrls] = useState(draft.sourceUrls.join("\n"));
  const [handbookCategoryId, setHandbookCategoryId] = useState(
    draft.handbookCategoryId ?? ""
  );
  const [proposedCategoryName, setProposedCategoryName] = useState(
    draft.proposedCategoryName ?? ""
  );
  const [availableCategories, setAvailableCategories] = useState(categories);
  const [savedDraft, setSavedDraft] = useState(false);
  const categoryFetcher = useFetcher<{
    ok: boolean;
    category?: { id: string; name: string };
    message?: string;
  }>();
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";
  const localDraftKey = `handbook-import-draft:${organizationId}:${userId}`;

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
      { method: "post", action: "/handbook/import" }
    );
  }

  function saveStudentDraft() {
    window.localStorage.setItem(
      localDraftKey,
      JSON.stringify({
        title,
        content,
        sourceUrls: sourceUrls
          .split(/\r?\n/u)
          .map((url) => url.trim())
          .filter(Boolean),
        handbookCategoryId,
        proposedCategoryName,
      } satisfies HandbookImportDraft)
    );
    setSavedDraft(true);
  }

  return (
    <main className="mx-auto max-w-5xl px-4 py-6 sm:px-6 lg:px-8">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link
            to="/handbook"
            className="text-sm font-semibold text-red-800 hover:underline"
          >
            ← Handbook
          </Link>
          <h1 className="mt-2 text-2xl font-semibold text-gray-950">
            Review imported article
          </h1>
          <p className="mt-1 text-sm text-gray-600">
            Review and edit the extracted text before saving or sending it for
            Staff review. Import never publishes automatically.
          </p>
        </div>
      </div>
      <Form
        method="post"
        action="/handbook/import"
        className="space-y-5 rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-6"
      >
        {errorMessage ? (
          <p
            role="alert"
            className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900"
          >
            {errorMessage}
          </p>
        ) : null}
        {savedDraft ? (
          <p
            role="status"
            className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-900"
          >
            Draft saved on this device. You can return to this import review in
            this browser.
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
        <div className="block text-sm font-semibold text-gray-800">
          <span>Category</span>
          <HandbookCategoryPicker
            categories={availableCategories}
            value={handbookCategoryId}
            proposedName={proposedCategoryName}
            mode={isStudent ? "student" : "staff"}
            creating={categoryFetcher.state !== "idle"}
            onChange={(id, proposal) => {
              setHandbookCategoryId(id);
              setProposedCategoryName(proposal);
            }}
            onCreateCategory={createCategory}
          />
          <p className="mt-1 text-xs font-normal text-gray-500">
            {isStudent
              ? "Choose an existing Handbook category or propose one for Staff review."
              : "Choose an existing Handbook category or create one here."}
          </p>
          {categoryFetcher.data?.message ? (
            <p
              role={categoryFetcher.data.ok ? "status" : "alert"}
              className={
                categoryFetcher.data.ok
                  ? "mt-1 text-sm font-normal text-green-800"
                  : "mt-1 text-sm font-normal text-red-800"
              }
            >
              {categoryFetcher.data.message}
            </p>
          ) : null}
        </div>
        <label className="block text-sm font-semibold text-gray-800">
          Article content{" "}
          <span className="font-normal text-gray-500">
            (Markdown supported)
          </span>
          <textarea
            required
            name="content"
            maxLength={30_000}
            rows={18}
            value={content}
            onChange={(event) => setContent(event.currentTarget.value)}
            className="mt-1 block w-full rounded-lg border border-gray-300 p-3 font-mono text-sm font-normal leading-6 focus:border-red-700 focus:outline-none focus:ring-2 focus:ring-red-100"
          />
        </label>
        <label className="block text-sm font-semibold text-gray-800">
          External references{" "}
          <span className="font-normal text-gray-500">
            (one http(s) URL per line)
          </span>
          <textarea
            name="sourceUrls"
            rows={4}
            value={sourceUrls}
            onChange={(event) => setSourceUrls(event.currentTarget.value)}
            placeholder="https://manufacturer.example/manual"
            className="mt-1 block w-full rounded-lg border border-gray-300 p-3 text-sm font-normal focus:border-red-700 focus:outline-none focus:ring-2 focus:ring-red-100"
          />
        </label>
        {isStudent && content.length > 4000 ? (
          <p role="status" className="text-sm text-amber-800">
            Student submissions use the existing 4,000-character review form.
            Shorten the article before submitting it for Staff review.
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2 border-t border-gray-100 pt-4">
          <button
            type="button"
            onClick={onImportAnother}
            className="inline-flex h-10 items-center rounded-lg border border-gray-300 px-4 text-sm font-semibold text-gray-700 hover:bg-gray-50"
          >
            Import another PDF
          </button>
          <Link
            to="/handbook"
            className="inline-flex h-10 items-center rounded-lg border border-gray-300 px-4 text-sm font-semibold text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </Link>
          {isStudent ? (
            <button
              type="button"
              onClick={saveStudentDraft}
              className="inline-flex h-10 items-center rounded-lg border border-gray-300 bg-white px-4 text-sm font-semibold text-gray-800"
            >
              Save draft
            </button>
          ) : (
            <button
              disabled={busy}
              name="intent"
              value="save-draft"
              className="inline-flex h-10 items-center rounded-lg border border-gray-300 bg-white px-4 text-sm font-semibold text-gray-800 disabled:opacity-60"
            >
              {busy ? "Saving…" : "Save draft"}
            </button>
          )}
          <button
            disabled={busy}
            name="intent"
            value={isStudent ? "submit-review" : "publish"}
            className="inline-flex h-10 items-center rounded-lg bg-red-700 px-4 text-sm font-semibold text-white hover:bg-red-800 disabled:opacity-60"
          >
            {isStudent ? "Submit for review" : "Publish article"}
          </button>
        </div>
      </Form>
    </main>
  );
}
