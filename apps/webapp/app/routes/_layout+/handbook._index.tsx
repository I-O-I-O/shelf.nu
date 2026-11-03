import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { data, Form, Link, useLoaderData } from "react-router";
import { ErrorContent } from "~/components/errors";
import { requireIoioHandbookRead } from "~/modules/ioio-handbook/access.server";
import {
  listHandbookCategories,
  listPublishedHandbookArticles,
} from "~/modules/ioio-handbook/service.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { makeShelfError } from "~/utils/error";
import { error, payload } from "~/utils/http.server";

export async function loader({ context, request }: LoaderFunctionArgs) {
  const { userId } = context.getSession();
  try {
    const auth = await requireIoioHandbookRead({ context, request });
    const url = new URL(request.url);
    const query = url.searchParams.get("q")?.trim().slice(0, 120) ?? "";
    const handbookCategoryId =
      url.searchParams.get("handbookCategoryId")?.trim() || undefined;
    const [articles, categories] = await Promise.all([
      listPublishedHandbookArticles({
        organizationId: auth.organizationId,
        query,
        handbookCategoryId,
      }),
      listHandbookCategories(auth.organizationId),
    ]);
    return payload({
      articles,
      categories,
      query,
      handbookCategoryId: handbookCategoryId ?? "",
      canEdit: auth.canEdit,
      isStudent: auth.isStudent,
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
    query,
    handbookCategoryId,
    canEdit,
    isStudent,
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
            Practical, living knowledge from IOIO Lab. Shelf remains the source
            for current availability, locations, loans and other live inventory
            facts.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            to="/handbook/import"
            className="inline-flex h-10 items-center justify-center rounded-lg border border-red-700 bg-white px-4 text-sm font-semibold text-red-800 hover:bg-red-50"
          >
            Import PDF
          </Link>
          {isStudent ? (
            <Link
              to="/handbook/contribute"
              className="inline-flex h-10 items-center justify-center rounded-lg border border-gray-300 bg-white px-4 text-sm font-semibold text-gray-800 hover:bg-gray-50"
            >
              Contribute knowledge
            </Link>
          ) : null}
          {canEdit ? (
            <>
              <Link
                to="/settings/ai/knowledge"
                className="inline-flex h-10 items-center justify-center rounded-lg border border-gray-300 bg-white px-4 text-sm font-semibold text-gray-800 hover:bg-gray-50"
              >
                Review contributions
              </Link>
              <Link
                to="/handbook/new"
                className="inline-flex h-10 items-center justify-center rounded-lg bg-red-700 px-4 text-sm font-semibold text-white hover:bg-red-800"
              >
                New article
              </Link>
            </>
          ) : null}
        </div>
      </header>

      <Form
        method="get"
        className="mb-6 grid gap-3 rounded-xl border border-gray-200 bg-white p-3 sm:grid-cols-[minmax(0,1fr)_220px_auto]"
      >
        <label className="sr-only" htmlFor="handbook-search">
          Search Handbook
        </label>
        <input
          id="handbook-search"
          name="q"
          type="search"
          defaultValue={query}
          placeholder="Search procedures, equipment, troubleshooting…"
          className="h-10 rounded-lg border border-gray-300 px-3 text-sm focus:border-red-700 focus:outline-none focus:ring-2 focus:ring-red-200"
        />
        <label className="sr-only" htmlFor="handbook-category">
          Category
        </label>
        <select
          id="handbook-category"
          name="handbookCategoryId"
          defaultValue={handbookCategoryId}
          className="h-10 rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-800 focus:border-red-700 focus:outline-none focus:ring-2 focus:ring-red-200"
        >
          <option value="">All categories</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </select>
        <button
          type="submit"
          className="h-10 rounded-lg border border-red-700 bg-red-700 px-4 text-sm font-semibold text-white hover:bg-red-800"
        >
          Search
        </button>
      </Form>

      {articles.length ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {articles.map(({ id, slug, handbookCategory, publishedVersion }) => (
            <article
              key={id}
              className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm"
            >
              <div className="p-4">
                {handbookCategory ? (
                  <p className="text-xs font-semibold uppercase tracking-wide text-red-700">
                    {handbookCategory.name}
                  </p>
                ) : null}
                <h2 className="mt-1 text-lg font-semibold text-gray-950">
                  <Link to={`/handbook/${slug}`} className="hover:text-red-800">
                    {publishedVersion.title}
                  </Link>
                </h2>
                <p className="mt-3 text-xs text-gray-500">
                  Updated{" "}
                  {new Date(publishedVersion.publishedAt).toLocaleDateString()}
                </p>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <section className="rounded-xl border border-dashed border-gray-300 bg-white px-5 py-10 text-center">
          <h2 className="text-lg font-semibold text-gray-900">
            No published articles yet
          </h2>
          <p className="mt-2 text-sm text-gray-600">
            Useful procedures and equipment knowledge will appear here after
            Staff review and publication.
          </p>
          {canEdit ? (
            <Link
              to="/handbook/new"
              className="mt-4 inline-flex h-10 items-center rounded-lg bg-red-700 px-4 text-sm font-semibold text-white hover:bg-red-800"
            >
              Create the first article
            </Link>
          ) : null}
        </section>
      )}
    </main>
  );
}

export const ErrorBoundary = () => <ErrorContent />;
