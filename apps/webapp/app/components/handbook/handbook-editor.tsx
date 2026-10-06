import { Form, Link } from "react-router";

type HandbookEditorArticle = {
  id: string;
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED";
  draftTitle: string;
  draftSummary: string;
  draftContent: string;
  draftSection: string;
  draftAssetModelIds: string[];
  draftKitIds: string[];
  draftSourceUrls: string[];
  versions: Array<{
    versionNumber: number;
    title: string;
    publishedAt: Date | string;
    publishedBy: string | null;
  }>;
};

export function HandbookEditor({
  article,
  assetModels,
  kits,
  busy = false,
  errorMessage,
  saved = false,
}: {
  article: HandbookEditorArticle | null;
  assetModels: Array<{ id: string; name: string }>;
  kits: Array<{ id: string; name: string }>;
  busy?: boolean;
  errorMessage?: string;
  saved?: boolean;
}) {
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
            {article ? "Edit Handbook draft" : "New Handbook article"}
          </h1>
        </div>
        {article ? (
          <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-semibold text-gray-700">
            {article.status === "PUBLISHED"
              ? "Published · draft edits are private"
              : article.status}
          </span>
        ) : null}
      </div>
      <Form
        method="post"
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
            defaultValue={article?.draftTitle ?? ""}
            className="mt-1 block h-10 w-full rounded-lg border border-gray-300 px-3 font-normal focus:border-red-700 focus:outline-none focus:ring-2 focus:ring-red-100"
          />
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm font-semibold text-gray-800">
            Section
            <input
              name="section"
              maxLength={80}
              defaultValue={article?.draftSection ?? "General"}
              placeholder="Equipment & Kits, Procedures, Troubleshooting…"
              className="mt-1 block h-10 w-full rounded-lg border border-gray-300 px-3 font-normal focus:border-red-700 focus:outline-none focus:ring-2 focus:ring-red-100"
            />
          </label>
          <label className="block text-sm font-semibold text-gray-800">
            Short summary
            <textarea
              name="summary"
              maxLength={700}
              rows={2}
              defaultValue={article?.draftSummary ?? ""}
              className="mt-1 block w-full rounded-lg border border-gray-300 p-3 font-normal focus:border-red-700 focus:outline-none focus:ring-2 focus:ring-red-100"
            />
          </label>
        </div>
        <label className="block text-sm font-semibold text-gray-800">
          Article content{" "}
          <span className="font-normal text-gray-500">
            (Markdown supported)
          </span>
          <textarea
            required
            name="content"
            maxLength={30000}
            rows={16}
            defaultValue={article?.draftContent ?? ""}
            placeholder="# What it is&#10;&#10;Practical instructions, component lists, common problems, or tips…"
            className="mt-1 block w-full rounded-lg border border-gray-300 p-3 font-mono text-sm font-normal leading-6 focus:border-red-700 focus:outline-none focus:ring-2 focus:ring-red-100"
          />
        </label>
        <div className="grid gap-4 md:grid-cols-2">
          <label className="block text-sm font-semibold text-gray-800">
            Related Shelf products{" "}
            <span className="font-normal text-gray-500">
              (select any that apply)
            </span>
            <select
              multiple
              name="assetModelIds"
              defaultValue={article?.draftAssetModelIds ?? []}
              className="mt-1 block h-40 w-full rounded-lg border border-gray-300 bg-white p-2 text-sm font-normal focus:border-red-700 focus:outline-none focus:ring-2 focus:ring-red-100"
            >
              {assetModels.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm font-semibold text-gray-800">
            Related Shelf Kits{" "}
            <span className="font-normal text-gray-500">
              (select any that apply)
            </span>
            <select
              multiple
              name="kitIds"
              defaultValue={article?.draftKitIds ?? []}
              className="mt-1 block h-40 w-full rounded-lg border border-gray-300 bg-white p-2 text-sm font-normal focus:border-red-700 focus:outline-none focus:ring-2 focus:ring-red-100"
            >
              {kits.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
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
          <button
            disabled={busy}
            name="intent"
            value="publish"
            className="inline-flex h-10 items-center rounded-lg bg-red-700 px-4 text-sm font-semibold text-white hover:bg-red-800 disabled:opacity-60"
          >
            {article?.status === "PUBLISHED"
              ? "Publish new version"
              : "Publish article"}
          </button>
        </div>
      </Form>
    </main>
  );
}
