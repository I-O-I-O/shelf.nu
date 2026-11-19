import { useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  ChevronRight,
  ClipboardList,
  MoreHorizontal,
  Settings2,
  ShieldCheck,
} from "lucide-react";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { data, Form, Link, useLoaderData } from "react-router";
import { ErrorContent } from "~/components/errors";
import { HandbookArticleActions } from "~/components/handbook/handbook-article-actions";
import { IoioPageContainer } from "~/components/ioio-shared/page-container";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "~/components/shared/sheet";
import { requireIoioHandbookRead } from "~/modules/ioio-handbook/access.server";
import {
  listHandbookCategories,
  listHandbookCategoriesWithPublishedArticles,
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
        canReadStaffOnly: auth.canEdit,
      }),
      auth.canEdit
        ? listHandbookCategories(auth.organizationId)
        : listHandbookCategoriesWithPublishedArticles({
            organizationId: auth.organizationId,
          }),
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

function groupArticlesByCategory<
  T extends {
    id: string;
    handbookCategory: { id: string; name: string } | null;
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

type HandbookAction = {
  to: string;
  label: string;
  Icon: LucideIcon;
};

function HandbookMoreActions({ canEdit }: { canEdit: boolean }) {
  const [open, setOpen] = useState(false);
  const actions: HandbookAction[] = [
    {
      to: "/handbook/my-work",
      label: "My Work",
      Icon: ClipboardList,
    },
    ...(canEdit
      ? [
          {
            to: "/handbook/review",
            label: "Review contributions",
            Icon: ShieldCheck,
          },
          {
            to: "/handbook/manage",
            label: "Manage Handbook",
            Icon: Settings2,
          },
        ]
      : []),
  ];

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button
          type="button"
          aria-label="More actions"
          aria-controls="handbook-more-actions"
          aria-expanded={open}
          className="inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-lg border border-gray-300 bg-white px-3 text-sm font-semibold text-gray-800 shadow-sm hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-700"
        >
          <span>More actions</span>
          <MoreHorizontal aria-hidden="true" className="size-4" />
        </button>
      </SheetTrigger>
      <SheetContent
        id="handbook-more-actions"
        side="bottom"
        overlayClassName="bg-black/55"
        closeButtonClassName="right-3 top-3 flex size-11 items-center justify-center rounded-lg text-gray-600 opacity-100 transition-colors hover:bg-gray-100 focus:ring-red-700 dark:text-gray-200 dark:hover:bg-gray-800"
        className="max-h-[70dvh] w-full touch-pan-y overflow-y-auto overscroll-contain rounded-t-2xl border-gray-200 bg-white px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-5 text-gray-900 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-50"
      >
        <SheetHeader className="mb-3 pr-10 text-left">
          <SheetTitle className="text-base text-gray-950 dark:text-gray-50">
            More Handbook actions
          </SheetTitle>
          <SheetDescription className="text-xs">
            Other tools for your Handbook work.
          </SheetDescription>
        </SheetHeader>
        <nav aria-label="More Handbook actions" className="space-y-1">
          {actions.map(({ to, label, Icon }) => (
            <SheetClose asChild key={to}>
              <Link
                to={to}
                className="flex min-h-11 min-w-0 items-center gap-3 rounded-lg px-3 py-1.5 text-sm font-semibold text-gray-700 hover:bg-red-50 hover:text-red-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-700 dark:text-gray-200 dark:hover:bg-gray-800 dark:hover:text-white"
              >
                <Icon aria-hidden="true" className="size-4 shrink-0" />
                <span className="min-w-0 flex-1 break-words">{label}</span>
                <ChevronRight
                  aria-hidden="true"
                  className="size-3.5 shrink-0 text-gray-400"
                />
              </Link>
            </SheetClose>
          ))}
        </nav>
      </SheetContent>
    </Sheet>
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
  const seedCategories = query
    ? []
    : handbookCategoryId
    ? categories.filter((category) => category.id === handbookCategoryId)
    : categories;
  const articleGroups = groupArticlesByCategory(articles, seedCategories);
  return (
    <IoioPageContainer className="max-w-6xl px-0 py-3 md:px-4 md:py-6">
      <header className="mb-4 flex min-w-0 flex-wrap items-start justify-between gap-2 sm:mb-6 sm:gap-4">
        <div className="min-w-0">
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-red-700">
            IOIO LAB
          </p>
          <h1 className="mt-1 text-2xl font-semibold text-gray-950 sm:text-3xl">
            Handbook
          </h1>
          <p className="mt-1 max-w-2xl text-sm leading-5 text-gray-600 sm:mt-2 sm:leading-6">
            Practical, living knowledge from IOIO Lab. Shelf remains the source
            for current availability, locations, loans and other live inventory
            facts.
          </p>
        </div>
        <div
          data-testid="handbook-mobile-actions"
          className="flex w-full min-w-0 items-center gap-2 sm:hidden"
        >
          {canEdit ? (
            <Link
              to="/handbook/new"
              className="inline-flex h-11 min-w-0 flex-1 items-center justify-center rounded-lg bg-red-700 px-3 text-sm font-semibold text-white hover:bg-red-800"
            >
              New article
            </Link>
          ) : isStudent ? (
            <Link
              to="/handbook/new"
              className="inline-flex h-11 min-w-0 flex-1 items-center justify-center rounded-lg bg-red-700 px-3 text-sm font-semibold text-white hover:bg-red-800"
            >
              Contribute
            </Link>
          ) : null}
          <HandbookMoreActions canEdit={canEdit} />
        </div>
        <div
          data-testid="handbook-desktop-actions"
          className="hidden flex-wrap gap-2 sm:flex"
        >
          {isStudent ? (
            <Link
              to="/handbook/new"
              className="inline-flex h-10 items-center justify-center rounded-lg border border-gray-300 bg-white px-4 text-sm font-semibold text-gray-800 hover:bg-gray-50"
            >
              Contribute
            </Link>
          ) : null}
          {canEdit ? (
            <Link
              to="/handbook/new"
              className="inline-flex h-10 items-center justify-center rounded-lg bg-red-700 px-4 text-sm font-semibold text-white hover:bg-red-800"
            >
              New article
            </Link>
          ) : null}
          <Link
            to="/handbook/my-work"
            className="inline-flex h-10 items-center justify-center rounded-lg border border-gray-300 bg-white px-4 text-sm font-semibold text-gray-800 hover:bg-gray-50"
          >
            My Work
          </Link>
          {canEdit ? (
            <Link
              to="/handbook/review"
              className="inline-flex h-10 items-center justify-center rounded-lg border border-gray-300 bg-white px-4 text-sm font-semibold text-gray-800 hover:bg-gray-50"
            >
              Review contributions
            </Link>
          ) : null}
          {canEdit ? (
            <Link
              to="/handbook/manage"
              className="inline-flex h-10 items-center justify-center rounded-lg border border-gray-300 bg-white px-4 text-sm font-semibold text-gray-800 hover:bg-gray-50"
            >
              Manage Handbook
            </Link>
          ) : null}
        </div>
      </header>

      <Form
        method="get"
        className="mb-4 grid w-full min-w-0 grid-cols-1 gap-2 rounded-xl border border-gray-200 bg-white p-2.5 sm:mb-6 sm:grid-cols-[minmax(0,1fr)_220px_auto] sm:gap-3 sm:p-3"
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
          className="h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 text-sm focus:border-red-700 focus:outline-none focus:ring-2 focus:ring-red-200"
        />
        <label className="sr-only" htmlFor="handbook-category">
          Category
        </label>
        <select
          id="handbook-category"
          name="handbookCategoryId"
          defaultValue={handbookCategoryId}
          className="h-11 w-full min-w-0 rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-800 focus:border-red-700 focus:outline-none focus:ring-2 focus:ring-red-200"
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
          className="h-11 w-full rounded-lg border border-red-700 bg-red-700 px-4 text-sm font-semibold text-white hover:bg-red-800 sm:w-auto"
        >
          Search
        </button>
      </Form>

      {articleGroups.length ? (
        <div className="space-y-8">
          {articleGroups.map(({ category, articles: groupArticles }) => (
            <section
              key={category?.id ?? "uncategorized"}
              className="w-full min-w-0 rounded-2xl border border-gray-200 bg-white p-3 shadow-sm sm:p-5"
            >
              <header className="mb-3 flex flex-wrap items-end justify-between gap-3 border-b border-gray-100 pb-3">
                <div>
                  <h2 className="min-w-0 break-words text-sm font-bold uppercase tracking-[0.14em] text-gray-900">
                    {category?.name ?? "Other knowledge"}
                  </h2>
                  <p className="mt-1 text-xs text-gray-500">
                    {groupArticles.length}{" "}
                    {groupArticles.length === 1 ? "article" : "articles"}
                  </p>
                </div>
                {canEdit || isStudent ? (
                  <Link
                    to={
                      category
                        ? `/handbook/new?handbookCategoryId=${encodeURIComponent(
                            category.id
                          )}`
                        : "/handbook/new"
                    }
                    className="inline-flex h-9 items-center rounded-lg border border-red-700 bg-white px-3 text-sm font-semibold text-red-800 hover:bg-red-50"
                  >
                    {isStudent ? "Contribute" : "New article"}
                  </Link>
                ) : null}
              </header>
              <ul className="divide-y divide-gray-100">
                {groupArticles.map((article, index) => (
                  <li
                    key={article.id}
                    className="flex w-full min-w-0 items-center gap-3 py-2 first:pt-1 last:pb-1"
                  >
                    <span className="w-7 shrink-0 text-right text-sm font-medium tabular-nums text-gray-500">
                      {index + 1}.
                    </span>
                    <Link
                      to={`/handbook/${encodeURIComponent(article.slug)}`}
                      title={
                        article.publishedVersion?.title ?? "Untitled article"
                      }
                      className="block min-w-0 flex-1 truncate text-left text-sm font-medium text-gray-900 hover:text-gray-700"
                    >
                      {article.publishedVersion?.title ?? "Untitled article"}
                    </Link>
                    {canEdit && article.staffOnly ? (
                      <span className="shrink-0 rounded-full border border-amber-300 bg-amber-50 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-amber-900">
                        Staff only
                      </span>
                    ) : null}
                    {canEdit ? (
                      <HandbookArticleActions
                        articleId={article.id}
                        slug={article.slug}
                        articleTitle={
                          article.publishedVersion?.title ?? "article"
                        }
                        staffOnly={article.staffOnly}
                        returnTo="/handbook"
                        menuLabel={`Article actions for ${
                          article.publishedVersion?.title ?? "article"
                        }`}
                      />
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      ) : (
        <section className="w-full min-w-0 rounded-xl border border-dashed border-gray-300 bg-white px-4 py-8 text-center sm:px-5 sm:py-10">
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
              New article
            </Link>
          ) : null}
        </section>
      )}
    </IoioPageContainer>
  );
}

export const ErrorBoundary = () => <ErrorContent />;
