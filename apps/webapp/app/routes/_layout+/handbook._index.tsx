import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { data, Form, Link, useLoaderData } from "react-router";
import { ErrorContent } from "~/components/errors";
import { requireIoioHandbookRead } from "~/modules/ioio-handbook/access.server";
import { getHandbookIndex } from "~/modules/ioio-handbook/handbook-index.server";
import { HANDBOOK_ARTICLE_TYPES } from "~/modules/ioio-handbook/handbook.types";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { makeShelfError } from "~/utils/error";
import { error, payload } from "~/utils/http.server";

export async function loader({ context, request }: LoaderFunctionArgs) {
  const { userId } = context.getSession();
  try {
    const auth = await requireIoioHandbookRead({ context, request });
    const url = new URL(request.url);
    const home = await getHandbookIndex({
      organizationId: auth.organizationId,
      query: url.searchParams.get("q") ?? "",
      categoryId: url.searchParams.get("category") ?? undefined,
      topicId: url.searchParams.get("topic") ?? undefined,
      articleType: url.searchParams.get("type") ?? undefined,
    });
    return payload({
      ...home,
      canEdit: auth.canEdit,
      isStudent: auth.isStudent,
      articleTypes: HANDBOOK_ARTICLE_TYPES,
      filters: {
        query: url.searchParams.get("q") ?? "",
        category: url.searchParams.get("category") ?? "",
        topic: url.searchParams.get("topic") ?? "",
        type: url.searchParams.get("type") ?? "",
      },
    });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    throw data(error(reason), { status: reason.status });
  }
}

export const meta: MetaFunction = () => [
  { title: appendToMetaTitle("Handbook") },
];
export const handle = { breadcrumb: () => "Handbook" };

export default function HandbookIndexPage() {
  const {
    articles,
    categories,
    topics,
    canEdit,
    isStudent,
    articleTypes,
    filters,
  } = useLoaderData<typeof loader>();
  return (
    <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-red-700">
            IOIO Lab
          </p>
          <h1 className="mt-1 text-3xl font-semibold text-gray-950">
            Handbook
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-gray-600">
            Practical knowledge for learning and working in IOIO Lab. Current
            published versions are reviewed by staff.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            to="/handbook/my-work"
            className="inline-flex h-10 items-center rounded-lg border border-gray-300 bg-white px-4 text-sm font-semibold text-gray-800 hover:bg-gray-50"
          >
            My Handbook work
          </Link>
          {canEdit ? (
            <>
              <Link
                to="/handbook/reviews"
                className="inline-flex h-10 items-center rounded-lg border border-gray-300 bg-white px-4 text-sm font-semibold text-gray-800 hover:bg-gray-50"
              >
                Review proposals
              </Link>
              <Link
                to="/handbook/new"
                className="inline-flex h-10 items-center rounded-lg bg-red-700 px-4 text-sm font-semibold text-white hover:bg-red-800"
              >
                New article
              </Link>
            </>
          ) : isStudent ? (
            <Link
              to="/handbook/new"
              className="inline-flex h-10 items-center rounded-lg bg-red-700 px-4 text-sm font-semibold text-white hover:bg-red-800"
            >
              Propose knowledge
            </Link>
          ) : null}
        </div>
      </header>

      <section className="mb-6 rounded-xl border border-gray-200 bg-white p-4">
        <Form method="get" className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          <label className="sr-only" htmlFor="handbook-search">
            Search Handbook
          </label>
          <input
            id="handbook-search"
            name="q"
            type="search"
            defaultValue={filters.query}
            placeholder="Search titles and article text"
            className="h-10 rounded-lg border border-gray-300 px-3 text-sm xl:col-span-2"
          />
          <label className="sr-only" htmlFor="handbook-category">
            Category
          </label>
          <select
            id="handbook-category"
            name="category"
            defaultValue={filters.category}
            className="h-10 rounded-lg border border-gray-300 bg-white px-3 text-sm"
          >
            <option value="">All categories</option>
            {categories.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          <label className="sr-only" htmlFor="handbook-topic">
            Topic
          </label>
          <select
            id="handbook-topic"
            name="topic"
            defaultValue={filters.topic}
            className="h-10 rounded-lg border border-gray-300 bg-white px-3 text-sm"
          >
            <option value="">All topics</option>
            {topics.map((item) => (
              <option key={item.id} value={item.id}>
                {item.category.name} · {item.name}
              </option>
            ))}
          </select>
          <label className="sr-only" htmlFor="handbook-type">
            Article type
          </label>
          <select
            id="handbook-type"
            name="type"
            defaultValue={filters.type}
            className="h-10 rounded-lg border border-gray-300 bg-white px-3 text-sm"
          >
            <option value="">All types</option>
            {articleTypes.map((type) => (
              <option key={type}>{type}</option>
            ))}
          </select>
          <button
            type="submit"
            className="h-10 rounded-lg bg-red-700 px-4 text-sm font-semibold text-white hover:bg-red-800 md:col-span-2 xl:col-span-5"
          >
            Search Handbook
          </button>
        </Form>
      </section>

      <section className="mb-7 grid gap-5 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div>
          <h2 className="mb-3 text-lg font-semibold text-gray-950">
            Current knowledge
          </h2>
          {articles.length ? (
            <div className="grid gap-4 md:grid-cols-2">
              {articles.map((article) => {
                const publishedVersion = article.publishedVersion;
                if (!publishedVersion) return null;
                return (
                  <article
                    key={article.id}
                    className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm"
                  >
                    <p className="text-xs font-semibold uppercase tracking-wide text-red-700">
                      {publishedVersion.category?.name ?? "General"} ·{" "}
                      {publishedVersion.topic?.name ?? "General"}
                    </p>
                    <h3 className="mt-1 text-lg font-semibold text-gray-950">
                      <Link
                        to={`/handbook/${article.slug}`}
                        className="hover:text-red-800"
                      >
                        {publishedVersion.title}
                      </Link>
                    </h3>
                    <p className="mt-1 text-xs text-gray-500">
                      {publishedVersion.articleType}
                      {publishedVersion.location
                        ? ` · ${publishedVersion.location.name}`
                        : ""}{" "}
                      · v{publishedVersion.versionNumber}
                    </p>
                    {publishedVersion.summary ? (
                      <p className="mt-2 line-clamp-3 text-sm leading-6 text-gray-600">
                        {publishedVersion.summary}
                      </p>
                    ) : null}
                    <p className="mt-3 text-xs text-gray-500">
                      Updated{" "}
                      {new Date(
                        publishedVersion.publishedAt
                      ).toLocaleDateString()}
                    </p>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-gray-300 bg-white px-5 py-10 text-center">
              <h3 className="text-lg font-semibold text-gray-900">
                {Object.values(filters).some(Boolean)
                  ? "No matching current articles"
                  : "No articles yet"}
              </h3>
              <p className="mt-2 text-sm text-gray-600">
                {Object.values(filters).some(Boolean)
                  ? "Try another search or browse a category."
                  : "Approved Handbook knowledge will appear here after staff review."}
              </p>
            </div>
          )}
        </div>
        <aside className="rounded-xl border border-gray-200 bg-white p-4">
          <h2 className="font-semibold text-gray-950">Categories and topics</h2>
          {categories.length ? (
            <ul className="mt-3 space-y-3">
              {categories.map((category) => (
                <li key={category.id}>
                  <Link
                    to={`/handbook?category=${category.id}`}
                    className="font-medium text-red-800 hover:underline"
                  >
                    {category.name}
                  </Link>
                  <ul className="ml-3 mt-1 space-y-1 border-l border-gray-200 pl-3">
                    {topics
                      .filter((topic) => topic.categoryId === category.id)
                      .map((topic) => (
                        <li key={topic.id}>
                          <Link
                            to={`/handbook?category=${category.id}&topic=${topic.id}`}
                            className="text-sm text-gray-700 hover:text-red-800"
                          >
                            {topic.name}
                          </Link>
                        </li>
                      ))}
                  </ul>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-gray-600">
              Categories will appear as knowledge is added.
            </p>
          )}
        </aside>
      </section>
    </main>
  );
}

export const ErrorBoundary = () => <ErrorContent />;
