import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import {
  data,
  Form,
  Link,
  redirect,
  useLoaderData,
  useLocation,
} from "react-router";
import { ErrorContent } from "~/components/errors";
import { requireIoioHandbookRead } from "~/modules/ioio-handbook/access.server";
import { findHandbookSearchMatch } from "~/modules/ioio-handbook/document";
import {
  HandbookValidationError,
  listHandbookCategories,
  listPublishedHandbookArticles,
  updateHandbookArticleNavigation,
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

export async function action({ context, request }: ActionFunctionArgs) {
  const { userId } = context.getSession();
  try {
    const auth = await requireIoioHandbookRead({ context, request });
    if (!auth.canEdit) {
      return data(
        { ok: false as const, message: "Only Staff can organize articles." },
        { status: 403 }
      );
    }
    const formData = await request.formData();
    const intent = String(formData.get("intent") ?? "");
    if (
      !["set-start-here", "unset-start-here", "move-up", "move-down"].includes(
        intent
      )
    ) {
      return data(
        { ok: false as const, message: "Choose an article ordering action." },
        { status: 400 }
      );
    }
    const articleId = String(formData.get("articleId") ?? "").trim();
    if (!articleId || articleId.length > 40) {
      return data(
        { ok: false as const, message: "Choose a valid Handbook article." },
        { status: 400 }
      );
    }
    await updateHandbookArticleNavigation({
      organizationId: auth.organizationId,
      articleId,
      intent: intent as
        | "set-start-here"
        | "unset-start-here"
        | "move-up"
        | "move-down",
    });
    const requestedReturnTo = String(formData.get("returnTo") ?? "/handbook");
    const returnUrl = new URL(requestedReturnTo, request.url);
    const destination =
      returnUrl.origin === new URL(request.url).origin &&
      returnUrl.pathname === "/handbook"
        ? `${returnUrl.pathname}${returnUrl.search}`
        : "/handbook";
    return redirect(destination);
  } catch (cause) {
    if (cause instanceof HandbookValidationError) {
      return data(
        { ok: false as const, message: cause.message },
        { status: 400 }
      );
    }
    const reason = makeShelfError(cause, { userId });
    throw data(error(reason), { status: reason.status });
  }
}

function groupArticlesByCategory<
  T extends {
    id: string;
    handbookCategory: { id: string; name: string } | null;
    isStartHere: boolean;
    position: number;
  },
>(articles: T[], seedCategories: Array<{ id: string; name: string }>) {
  const groups = new Map<
    string,
    { category: T["handbookCategory"]; articles: T[] }
  >();
  for (const category of seedCategories) {
    groups.set(category.id, { category, articles: [] });
  }
  for (const article of articles) {
    const key = article.handbookCategory?.id ?? "uncategorized";
    const group: {
      category: T["handbookCategory"];
      articles: T[];
    } = groups.get(key) ?? {
      category: article.handbookCategory,
      articles: [],
    };
    group.articles.push(article);
    groups.set(key, group);
  }
  return [...groups.values()].sort((left, right) =>
    (left.category?.name ?? "Other knowledge").localeCompare(
      right.category?.name ?? "Other knowledge"
    )
  );
}

function HandbookArticleRow({
  article,
  query,
  canEdit,
  returnTo,
  canMoveUp,
  canMoveDown,
}: {
  article: {
    id: string;
    slug: string;
    isStartHere: boolean;
    publishedVersion: {
      title: string;
      content: string;
      publishedAt: Date | string;
    } | null;
  };
  query: string;
  canEdit: boolean;
  returnTo: string;
  canMoveUp: boolean;
  canMoveDown: boolean;
}) {
  if (!article.publishedVersion) return null;
  const match = query
    ? findHandbookSearchMatch(article.publishedVersion.content, query)
    : null;
  const target = match ? `#${match.id}` : "";
  const action = (intent: string, label: string, disabled = false) => (
    <Form method="post" action={returnTo}>
      <input type="hidden" name="articleId" value={article.id} />
      <input type="hidden" name="intent" value={intent} />
      <input type="hidden" name="returnTo" value={returnTo} />
      <button
        type="submit"
        disabled={disabled}
        className="rounded border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {label}
      </button>
    </Form>
  );
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-3 first:pt-0 last:pb-0">
      <div>
        <h3 className="text-base font-semibold text-gray-950">
          <Link
            to={`/handbook/${article.slug}${target}`}
            className="hover:text-red-800"
          >
            {article.publishedVersion.title}
          </Link>
        </h3>
        {match ? (
          <p className="mt-1 text-xs text-gray-600">
            →{" "}
            <Link to={`/handbook/${article.slug}${target}`}>{match.title}</Link>
          </p>
        ) : null}
        <p className="mt-1 text-xs text-gray-500">
          Updated{" "}
          {new Date(article.publishedVersion.publishedAt).toLocaleDateString()}
        </p>
      </div>
      {canEdit ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {action(
            article.isStartHere ? "unset-start-here" : "set-start-here",
            article.isStartHere ? "Remove Start here" : "Start here"
          )}
          {canMoveUp ? action("move-up", "Move up") : null}
          {canMoveDown ? action("move-down", "Move down") : null}
        </div>
      ) : null}
    </li>
  );
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
  const location = useLocation();
  const returnTo = `${location.pathname}${location.search}`;
  const seedCategories = query
    ? []
    : handbookCategoryId
    ? categories.filter((category) => category.id === handbookCategoryId)
    : categories;
  const articleGroups = groupArticlesByCategory(articles, seedCategories);
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
            to="/handbook/my-work"
            className="inline-flex h-10 items-center justify-center rounded-lg border border-gray-300 bg-white px-4 text-sm font-semibold text-gray-800 hover:bg-gray-50"
          >
            My Work
          </Link>
          <Link
            to="/handbook/import"
            className="inline-flex h-10 items-center justify-center rounded-lg border border-red-700 bg-white px-4 text-sm font-semibold text-red-800 hover:bg-red-50"
          >
            Import PDF
          </Link>
          {isStudent ? (
            <Link
              to="/handbook/new"
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

      {articleGroups.length ? (
        <div className="space-y-8">
          {articleGroups.map(({ category, articles: groupArticles }) => (
            <section
              key={category?.id ?? "uncategorized"}
              className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5"
            >
              <header className="mb-3 flex flex-wrap items-end justify-between gap-3 border-b border-gray-100 pb-3">
                <div>
                  <h2 className="text-sm font-bold uppercase tracking-[0.14em] text-gray-900">
                    {category?.name ?? "Other knowledge"}
                  </h2>
                  <p className="mt-1 text-xs text-gray-500">
                    {groupArticles.length}{" "}
                    {groupArticles.length === 1 ? "article" : "articles"}
                  </p>
                </div>
                {category && (canEdit || isStudent) ? (
                  <Link
                    to={`/handbook/new?handbookCategoryId=${encodeURIComponent(
                      category.id
                    )}`}
                    className="inline-flex h-9 items-center rounded-lg border border-red-700 bg-white px-3 text-sm font-semibold text-red-800 hover:bg-red-50"
                  >
                    Contribute to {category.name}
                  </Link>
                ) : null}
              </header>
              <ul className="divide-y divide-gray-100">
                {groupArticles.some((article) => article.isStartHere) ? (
                  <li className="list-none py-3 first:pt-0">
                    <section
                      aria-labelledby={`start-here-${category?.id ?? "other"}`}
                    >
                      <h3
                        id={`start-here-${category?.id ?? "other"}`}
                        className="mb-2 text-xs font-bold uppercase tracking-[0.12em] text-red-800"
                      >
                        Start here
                      </h3>
                      <ul className="divide-y divide-gray-100">
                        {groupArticles
                          .filter((article) => article.isStartHere)
                          .map((article, index, articlesInGroup) => (
                            <HandbookArticleRow
                              key={article.id}
                              article={article}
                              query={query}
                              canEdit={canEdit}
                              returnTo={returnTo}
                              canMoveUp={!query && index > 0}
                              canMoveDown={
                                !query && index < articlesInGroup.length - 1
                              }
                            />
                          ))}
                      </ul>
                    </section>
                  </li>
                ) : null}
                {groupArticles
                  .filter((article) => !article.isStartHere)
                  .map((article, index, articlesInGroup) => (
                    <HandbookArticleRow
                      key={article.id}
                      article={article}
                      query={query}
                      canEdit={canEdit}
                      returnTo={returnTo}
                      canMoveUp={!query && index > 0}
                      canMoveDown={!query && index < articlesInGroup.length - 1}
                    />
                  ))}
              </ul>
            </section>
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
