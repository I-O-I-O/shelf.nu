import { useState } from "react";
import { Form, Link } from "react-router";
import { EditorV2 } from "~/components/editor-v2/editor-v2";

type EditorValues = {
  title: string;
  summary: string;
  content: string;
  category: string;
  topic: string;
  articleType: string;
  locationId: string;
  videoUrls: string[];
  assetModelIds: string[];
  kitIds: string[];
  sourceUrls: string[];
};

export function HandbookEditor({
  article,
  revision,
  pendingRevision,
  initial,
  categories,
  topics,
  locations,
  assetModels,
  kits,
  articleTypes,
  isStaff,
  busy = false,
  errorMessage,
  saved = false,
}: {
  article: { id: string; slug: string; status: string } | null;
  revision: { id: string; revisionNumber: number } | null;
  pendingRevision: { id: string } | null;
  initial: EditorValues | null;
  categories: Array<{ id: string; name: string }>;
  topics: Array<{
    id: string;
    name: string;
    categoryId: string;
    category: { name: string };
  }>;
  locations: Array<{ id: string; name: string; parentId: string | null }>;
  assetModels: Array<{ id: string; name: string }>;
  kits: Array<{ id: string; name: string }>;
  articleTypes: readonly string[];
  isStaff: boolean;
  busy?: boolean;
  errorMessage?: string;
  saved?: boolean;
}) {
  const [imageUploadError, setImageUploadError] = useState<string | null>(null);

  async function uploadImage(file: File) {
    setImageUploadError(null);
    const formData = new FormData();
    formData.set("image", file);
    const response = await fetch("/api/handbook-image-upload", {
      method: "POST",
      body: formData,
    });
    const result = (await response.json()) as {
      success?: boolean;
      src?: string;
      message?: string;
    };
    if (!response.ok || !result.success || !result.src) {
      const message = result.message ?? "The image could not be uploaded.";
      setImageUploadError(message);
      throw new Error(message);
    }
    return { src: result.src, alt: file.name.replace(/\.[^.]+$/, "") };
  }

  const locationsById = new Map(
    locations.map((location) => [location.id, location])
  );
  const locationLabel = (location: (typeof locations)[number]) => {
    const parent = location.parentId
      ? locationsById.get(location.parentId)
      : null;
    return parent ? `${parent.name} · ${location.name}` : location.name;
  };

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
            {article
              ? `Propose a revision${
                  revision ? ` · v${revision.revisionNumber}` : ""
                }`
              : "Propose a Handbook article"}
          </h1>
          <p className="mt-1 text-sm text-gray-600">
            {isStaff
              ? "Save a draft, submit it for review, or publish directly as staff."
              : "Your work stays a draft until you submit it. Staff reviews every proposal before it becomes current."}
          </p>
        </div>
        <Link
          to="/handbook/my-work"
          className="text-sm font-semibold text-red-800 hover:underline"
        >
          My Handbook work
        </Link>
      </div>

      <Form
        method="post"
        className="space-y-5 rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-6"
      >
        {article ? (
          <input type="hidden" name="articleId" value={article.id} />
        ) : null}
        {revision ? (
          <input type="hidden" name="revisionId" value={revision.id} />
        ) : null}
        {errorMessage || imageUploadError ? (
          <p
            role="alert"
            className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900"
          >
            {errorMessage ?? imageUploadError}
          </p>
        ) : null}
        {saved ? (
          <p
            role="status"
            className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-900"
          >
            Draft saved. It is not part of the current Handbook until staff
            approves a revision.
          </p>
        ) : null}
        {article?.status === "PUBLISHED" ? (
          <p className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-950">
            The published version remains current while this revision is
            reviewed.
          </p>
        ) : null}
        {pendingRevision ? (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">
            Your revision is already awaiting staff review. You can continue
            work after staff returns it.
          </p>
        ) : null}

        <label className="block text-sm font-semibold text-gray-800">
          Article title
          <input
            required
            name="title"
            maxLength={180}
            defaultValue={initial?.title ?? ""}
            className="mt-1 block h-10 w-full rounded-lg border border-gray-300 px-3 font-normal"
          />
        </label>

        <div className="grid gap-4 md:grid-cols-2">
          <label className="block text-sm font-semibold text-gray-800">
            Category
            <input
              required
              name="category"
              list="handbook-categories"
              maxLength={80}
              defaultValue={initial?.category ?? categories[0]?.name ?? ""}
              className="mt-1 block h-10 w-full rounded-lg border border-gray-300 px-3 font-normal"
            />
            <datalist id="handbook-categories">
              {categories.map((category) => (
                <option key={category.id} value={category.name} />
              ))}
            </datalist>
          </label>
          <label className="block text-sm font-semibold text-gray-800">
            Topic
            <input
              required
              name="topic"
              list="handbook-topics"
              maxLength={100}
              defaultValue={initial?.topic ?? "General"}
              className="mt-1 block h-10 w-full rounded-lg border border-gray-300 px-3 font-normal"
            />
            <datalist id="handbook-topics">
              {topics.map((topic) => (
                <option key={topic.id} value={topic.name}>
                  {topic.category.name}
                </option>
              ))}
            </datalist>
          </label>
          <label className="block text-sm font-semibold text-gray-800">
            Article type
            <select
              name="articleType"
              defaultValue={initial?.articleType ?? "Guide"}
              className="mt-1 block h-10 w-full rounded-lg border border-gray-300 bg-white px-3 font-normal"
            >
              {articleTypes.map((type) => (
                <option key={type}>{type}</option>
              ))}
            </select>
          </label>
          <label className="block text-sm font-semibold text-gray-800">
            Shelf Location{" "}
            <span className="font-normal text-gray-500">(optional)</span>
            <select
              name="locationId"
              defaultValue={initial?.locationId ?? ""}
              className="mt-1 block h-10 w-full rounded-lg border border-gray-300 bg-white px-3 font-normal"
            >
              <option value="">No location</option>
              {locations.map((location) => (
                <option key={location.id} value={location.id}>
                  {locationLabel(location)}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="block text-sm font-semibold text-gray-800">
          Short summary
          <textarea
            name="summary"
            maxLength={700}
            rows={2}
            defaultValue={initial?.summary ?? ""}
            className="mt-1 block w-full rounded-lg border border-gray-300 p-3 font-normal"
          />
        </label>

        <EditorV2
          label="Article content"
          name="content"
          required
          maxLength={30_000}
          defaultValue={initial?.content ?? ""}
          placeholder="Write practical, structured knowledge…"
          onUploadImage={uploadImage}
        />
        <p className="text-xs text-gray-500">
          Images are stored in Shelf and must be 2 MB or smaller. Video uploads
          are not available; add HTTPS video links below.
        </p>

        <div className="grid gap-4 md:grid-cols-2">
          <label className="block text-sm font-semibold text-gray-800">
            Shelf products
            <select
              multiple
              name="assetModelIds"
              defaultValue={initial?.assetModelIds ?? []}
              className="mt-1 block h-36 w-full rounded-lg border border-gray-300 bg-white p-2 text-sm font-normal"
            >
              {assetModels.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm font-semibold text-gray-800">
            Shelf kits
            <select
              multiple
              name="kitIds"
              defaultValue={initial?.kitIds ?? []}
              className="mt-1 block h-36 w-full rounded-lg border border-gray-300 bg-white p-2 text-sm font-normal"
            >
              {kits.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <label className="block text-sm font-semibold text-gray-800">
            External video links{" "}
            <span className="font-normal text-gray-500">
              (one HTTPS URL per line)
            </span>
            <textarea
              name="videoUrls"
              rows={3}
              defaultValue={initial?.videoUrls.join("\n") ?? ""}
              placeholder="https://www.youtube.com/watch?v=…"
              className="mt-1 block w-full rounded-lg border border-gray-300 p-3 text-sm font-normal"
            />
          </label>
          <label className="block text-sm font-semibold text-gray-800">
            References{" "}
            <span className="font-normal text-gray-500">
              (one HTTP(S) URL per line)
            </span>
            <textarea
              name="sourceUrls"
              rows={3}
              defaultValue={initial?.sourceUrls.join("\n") ?? ""}
              placeholder="https://manufacturer.example/manual"
              className="mt-1 block w-full rounded-lg border border-gray-300 p-3 text-sm font-normal"
            />
          </label>
        </div>

        <div className="flex flex-wrap justify-end gap-2 border-t border-gray-100 pt-4">
          <Link
            to="/handbook"
            className="inline-flex h-10 items-center rounded-lg border border-gray-300 px-4 text-sm font-semibold text-gray-700"
          >
            Cancel
          </Link>
          <button
            disabled={busy || Boolean(pendingRevision)}
            name="intent"
            value="save"
            className="inline-flex h-10 items-center rounded-lg border border-gray-300 bg-white px-4 text-sm font-semibold text-gray-800 disabled:opacity-60"
          >
            Save draft
          </button>
          <button
            disabled={busy || Boolean(pendingRevision)}
            name="intent"
            value="submit"
            className="inline-flex h-10 items-center rounded-lg bg-amber-600 px-4 text-sm font-semibold text-white disabled:opacity-60"
          >
            Submit for staff review
          </button>
          {isStaff ? (
            <button
              disabled={busy || Boolean(pendingRevision)}
              name="intent"
              value="publish"
              className="inline-flex h-10 items-center rounded-lg bg-red-700 px-4 text-sm font-semibold text-white disabled:opacity-60"
            >
              Publish as staff
            </button>
          ) : null}
        </div>
      </Form>
    </main>
  );
}
