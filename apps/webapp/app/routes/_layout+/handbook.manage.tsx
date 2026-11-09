import { useEffect, useState } from "react";
import type { DragEvent as ReactDragEvent } from "react";
import { GripVertical } from "lucide-react";
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
  useActionData,
  useFetcher,
  useLoaderData,
  useNavigation,
} from "react-router";
import { ErrorContent } from "~/components/errors";
import { requireIoioHandbookRead } from "~/modules/ioio-handbook/access.server";
import {
  archiveHandbookArticle,
  createHandbookCategory,
  deleteHandbookArticlePermanently,
  HandbookValidationError,
  listHandbookCategoriesForManagement,
  listPublishedHandbookArticles,
  renameHandbookCategory,
  updateHandbookArticleNavigation,
} from "~/modules/ioio-handbook/service.server";
import { requireIoioStaffAccess } from "~/modules/ioio-staff/access.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { makeShelfError, ShelfError } from "~/utils/error";
import { error, payload } from "~/utils/http.server";

const COLLAPSED_CATEGORIES_STORAGE_KEY = "ioio-handbook-manage-collapsed";

export async function loader({ context, request }: LoaderFunctionArgs) {
  const { userId } = context.getSession();
  try {
    const auth = await requireIoioStaffAccess({ context, request });
    if (auth.currentOrganization.type === "PERSONAL") {
      throw new ShelfError({
        cause: null,
        message:
          "Handbook management is available in IOIO Lab workspaces only.",
        label: "Handbook",
        status: 403,
        shouldBeCaptured: false,
      });
    }
    const [categories, articles] = await Promise.all([
      listHandbookCategoriesForManagement(auth.organizationId),
      listPublishedHandbookArticles({ organizationId: auth.organizationId }),
    ]);
    return payload({
      categories: categories.map((category) => ({
        ...category,
        articles: articles.filter(
          (article) => article.handbookCategory?.id === category.id
        ),
      })),
    });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    throw data(error(reason), { status: reason.status });
  }
}

export async function action({ context, request }: ActionFunctionArgs) {
  const { userId } = context.getSession();
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const handbookManagementIntent =
    intent === "create-category" ||
    intent === "rename-category" ||
    intent === "move-before" ||
    intent === "move-after";

  try {
    if (handbookManagementIntent) {
      const auth = await requireIoioStaffAccess({ context, request });
      if (auth.currentOrganization.type === "PERSONAL") {
        return data(
          {
            success: false as const,
            intent,
            message:
              "Handbook management is available in IOIO Lab workspaces only.",
          },
          { status: 403 }
        );
      }

      if (intent === "create-category") {
        const category = await createHandbookCategory({
          organizationId: auth.organizationId,
          name: String(form.get("name") ?? ""),
        });
        return payload({
          success: true as const,
          intent,
          message: category.alreadyExists
            ? `“${category.name}” already exists in this Handbook.`
            : `Added “${category.name}” to this Handbook.`,
        });
      }

      if (intent === "rename-category") {
        const category = await renameHandbookCategory({
          organizationId: auth.organizationId,
          categoryId: String(form.get("categoryId") ?? ""),
          name: String(form.get("name") ?? ""),
        });
        return payload({
          success: true as const,
          intent,
          message: category.unchanged
            ? `“${category.name}” is already the category name.`
            : `Renamed category to “${category.name}”.`,
        });
      }

      if (intent !== "move-before" && intent !== "move-after") {
        return payload({
          success: false as const,
          intent,
          message: "Choose a Handbook management action.",
        });
      }

      const articleId = String(form.get("articleId") ?? "").trim();
      const targetArticleId = String(form.get("targetArticleId") ?? "").trim();
      if (
        !articleId ||
        articleId.length > 40 ||
        !targetArticleId ||
        targetArticleId.length > 40
      ) {
        return data(
          {
            success: false as const,
            intent,
            message: "Choose a valid article position.",
          },
          { status: 400 }
        );
      }
      await updateHandbookArticleNavigation({
        organizationId: auth.organizationId,
        articleId,
        targetArticleId,
        intent,
      });
      return payload({
        success: true as const,
        intent,
        message: "Article order saved.",
      });
    }

    // Published-article archive/delete controls still post to this Handbook route.
    const auth = await requireIoioHandbookRead({ context, request });
    if (!auth.canEdit) {
      return data(
        {
          ok: false as const,
          message: "Only Staff can manage published Handbook articles.",
        },
        { status: 403 }
      );
    }
    const articleId = String(form.get("articleId") ?? "").trim();
    const confirmationTitle = String(form.get("confirmationTitle") ?? "");
    if (
      !["archive-article", "restore-article", "delete-permanently"].includes(
        intent
      ) ||
      !articleId ||
      articleId.length > 40 ||
      (intent === "delete-permanently" && !confirmationTitle.trim())
    ) {
      return data(
        { ok: false as const, message: "Choose a valid article action." },
        { status: 400 }
      );
    }
    if (intent === "delete-permanently") {
      await deleteHandbookArticlePermanently({
        organizationId: auth.organizationId,
        articleId,
        userId: auth.userId,
        canManageArticles: auth.canEdit,
        confirmationTitle,
      });
    } else {
      await archiveHandbookArticle({
        organizationId: auth.organizationId,
        articleId,
        userId: auth.userId,
        canManageArticles: auth.canEdit,
        restore: intent === "restore-article",
      });
    }
    return redirect(
      intent === "restore-article" || intent === "delete-permanently"
        ? "/handbook"
        : "/handbook?archived=1"
    );
  } catch (cause) {
    if (cause instanceof HandbookValidationError) {
      return handbookManagementIntent
        ? payload({
            success: false as const,
            intent,
            message: cause.message,
          })
        : data({ ok: false as const, message: cause.message }, { status: 400 });
    }
    const reason = makeShelfError(cause, { userId });
    if (handbookManagementIntent) {
      return data(
        { success: false as const, intent, message: reason.message },
        { status: reason.status }
      );
    }
    throw data(error(reason), { status: reason.status });
  }
}

export const meta: MetaFunction = () => [
  { title: appendToMetaTitle("Manage Handbook") },
];
export const handle = { breadcrumb: () => "Manage Handbook" };

type DraggedArticle = { articleId: string; categoryId: string } | null;
type DropTarget = {
  articleId: string;
  categoryId: string;
  after: boolean;
} | null;

export default function HandbookManagePage() {
  const { categories } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const fetcher = useFetcher<typeof action>();
  const navigation = useNavigation();
  const [adding, setAdding] = useState(false);
  const [editingCategoryId, setEditingCategoryId] = useState<string | null>(
    null
  );
  const [collapsedCategoryIds, setCollapsedCategoryIds] = useState<Set<string>>(
    () => new Set()
  );
  const [collapsePreferencesLoaded, setCollapsePreferencesLoaded] =
    useState(false);
  const [draggedArticle, setDraggedArticle] = useState<DraggedArticle>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget>(null);
  const formBusy = navigation.state === "submitting";
  const dragBusy = fetcher.state !== "idle";

  useEffect(() => {
    try {
      const saved = localStorage.getItem(COLLAPSED_CATEGORIES_STORAGE_KEY);
      if (saved) {
        const ids: unknown = JSON.parse(saved);
        if (Array.isArray(ids) && ids.every((id) => typeof id === "string")) {
          setCollapsedCategoryIds(new Set(ids));
        }
      }
    } catch {
      // Ignore unavailable or invalid local preferences.
    }
    setCollapsePreferencesLoaded(true);
  }, []);

  useEffect(() => {
    if (!collapsePreferencesLoaded) return;
    try {
      localStorage.setItem(
        COLLAPSED_CATEGORIES_STORAGE_KEY,
        JSON.stringify([...collapsedCategoryIds])
      );
    } catch {
      // Management remains usable when local storage is unavailable.
    }
  }, [collapsePreferencesLoaded, collapsedCategoryIds]);

  useEffect(() => {
    if (actionData && "success" in actionData && actionData.success) {
      if (actionData.intent === "create-category") setAdding(false);
      if (actionData.intent === "rename-category") setEditingCategoryId(null);
    }
  }, [actionData]);

  function toggleCategory(categoryId: string) {
    setCollapsedCategoryIds((current) => {
      const next = new Set(current);
      if (next.has(categoryId)) next.delete(categoryId);
      else next.add(categoryId);
      return next;
    });
  }

  function handleDragOver(
    event: ReactDragEvent<HTMLLIElement>,
    categoryId: string,
    articleId: string
  ) {
    if (
      !draggedArticle ||
      draggedArticle.categoryId !== categoryId ||
      draggedArticle.articleId === articleId
    ) {
      setDropTarget(null);
      return;
    }
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    setDropTarget({
      articleId,
      categoryId,
      after: event.clientY >= bounds.top + bounds.height / 2,
    });
  }

  function handleDrop(
    event: ReactDragEvent<HTMLLIElement>,
    categoryId: string
  ) {
    event.preventDefault();
    if (
      !draggedArticle ||
      !dropTarget ||
      draggedArticle.categoryId !== categoryId ||
      dropTarget.categoryId !== categoryId ||
      draggedArticle.articleId === dropTarget.articleId ||
      dragBusy
    ) {
      setDraggedArticle(null);
      setDropTarget(null);
      return;
    }
    void fetcher.submit(
      {
        articleId: draggedArticle.articleId,
        targetArticleId: dropTarget.articleId,
        intent: dropTarget.after ? "move-after" : "move-before",
      },
      { method: "post", action: "/handbook/manage" }
    );
    setDraggedArticle(null);
    setDropTarget(null);
  }

  const actionMessage =
    actionData && "message" in actionData ? actionData.message : undefined;
  const actionSucceeded =
    actionData && "success" in actionData ? actionData.success : undefined;
  const fetcherMessage =
    fetcher.data && "message" in fetcher.data
      ? fetcher.data.message
      : undefined;
  const fetcherSucceeded =
    fetcher.data && "success" in fetcher.data
      ? fetcher.data.success
      : undefined;

  return (
    <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link
            to="/handbook"
            className="text-sm font-semibold text-red-800 hover:underline"
          >
            ← Handbook
          </Link>
          <h1 className="mt-2 text-2xl font-semibold text-gray-950">
            Manage Handbook
          </h1>
          <p className="mt-1 text-sm text-gray-600">
            Manage categories and set article order within each category.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setAdding((current) => !current)}
          className="inline-flex h-10 items-center rounded-lg bg-red-700 px-4 text-sm font-semibold text-white hover:bg-red-800"
        >
          + New category
        </button>
      </header>

      {actionMessage ? (
        <p
          role={actionSucceeded ? "status" : "alert"}
          className={
            actionSucceeded
              ? "mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-900"
              : "mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900"
          }
        >
          {actionMessage}
        </p>
      ) : null}
      {fetcherMessage ? (
        <p
          role={fetcherSucceeded ? "status" : "alert"}
          className={
            fetcherSucceeded
              ? "mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-900"
              : "mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900"
          }
        >
          {fetcherMessage}
        </p>
      ) : null}

      {adding ? (
        <Form
          method="post"
          className="mb-5 rounded-xl border border-gray-200 bg-white p-4 shadow-sm"
        >
          <input type="hidden" name="intent" value="create-category" />
          <label className="block text-sm font-semibold text-gray-800">
            Category name
            <input
              required
              name="name"
              maxLength={80}
              autoFocus
              className="mt-1 block h-10 w-full rounded-lg border border-gray-300 px-3 font-normal focus:border-red-700 focus:outline-none focus:ring-2 focus:ring-red-100"
            />
          </label>
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setAdding(false)}
              className="inline-flex h-9 items-center rounded-lg border border-gray-300 px-3 text-sm font-semibold text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              disabled={formBusy}
              className="inline-flex h-9 items-center rounded-lg bg-red-700 px-3 text-sm font-semibold text-white disabled:opacity-60"
            >
              Create category
            </button>
          </div>
        </Form>
      ) : null}

      {categories.length ? (
        <div className="space-y-4">
          {categories.map((category) => {
            const collapsed = collapsedCategoryIds.has(category.id);
            const articles = category.articles;
            return (
              <section
                id={`handbook-category-${category.id}`}
                key={category.id}
                className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm"
              >
                <div className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <button
                    type="button"
                    aria-expanded={!collapsed}
                    aria-controls={`handbook-category-articles-${category.id}`}
                    aria-label={`${collapsed ? "Expand" : "Collapse"} ${
                      category.name
                    }`}
                    onClick={() => toggleCategory(category.id)}
                    className="min-w-0 flex-1 text-left font-semibold text-gray-950 hover:text-red-800"
                  >
                    <span aria-hidden="true" className="mr-2 inline-block w-4">
                      {collapsed ? "▶" : "▼"}
                    </span>
                    {category.name}
                    <span className="ml-2 font-normal text-gray-500">
                      · {category._count.articles}{" "}
                      {category._count.articles === 1 ? "article" : "articles"}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingCategoryId(category.id)}
                    className="inline-flex h-9 items-center rounded-lg border border-gray-300 px-3 text-sm font-semibold text-gray-800 hover:bg-gray-50"
                  >
                    Rename
                  </button>
                </div>

                {editingCategoryId === category.id ? (
                  <Form
                    method="post"
                    className="flex flex-wrap items-end gap-3 border-t border-gray-100 bg-gray-50 px-4 py-3"
                  >
                    <input
                      type="hidden"
                      name="intent"
                      value="rename-category"
                    />
                    <input
                      type="hidden"
                      name="categoryId"
                      value={category.id}
                    />
                    <label className="min-w-56 flex-1 text-sm font-semibold text-gray-800">
                      Category name
                      <input
                        required
                        name="name"
                        maxLength={80}
                        defaultValue={category.name}
                        autoFocus
                        aria-label={`Name for ${category.name}`}
                        className="mt-1 block h-10 w-full rounded-lg border border-gray-300 bg-white px-3 font-normal focus:border-red-700 focus:outline-none focus:ring-2 focus:ring-red-100"
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() => setEditingCategoryId(null)}
                      className="inline-flex h-9 items-center rounded-lg border border-gray-300 px-3 text-sm font-semibold text-gray-700 hover:bg-white"
                    >
                      Cancel
                    </button>
                    <button
                      disabled={formBusy}
                      className="inline-flex h-9 items-center rounded-lg bg-red-700 px-3 text-sm font-semibold text-white hover:bg-red-800 disabled:opacity-60"
                    >
                      Save
                    </button>
                  </Form>
                ) : null}

                {!collapsed ? (
                  <div
                    id={`handbook-category-articles-${category.id}`}
                    className="border-t border-gray-100"
                  >
                    {articles.length ? (
                      <ol className="divide-y divide-gray-100">
                        {articles.map((article, index) => {
                          const title =
                            article.publishedVersion?.title ??
                            "Untitled article";
                          const isDragged =
                            draggedArticle?.articleId === article.id;
                          const indicatorBefore =
                            dropTarget?.categoryId === category.id &&
                            dropTarget.articleId === article.id &&
                            !dropTarget.after;
                          const indicatorAfter =
                            dropTarget?.categoryId === category.id &&
                            dropTarget.articleId === article.id &&
                            dropTarget.after;
                          return (
                            <li
                              key={article.id}
                              onDragOver={(event) =>
                                handleDragOver(event, category.id, article.id)
                              }
                              onDrop={(event) => handleDrop(event, category.id)}
                              className={`relative flex min-h-14 items-center gap-3 px-3 py-2 sm:px-4 ${
                                isDragged ? "bg-red-50 opacity-60" : "bg-white"
                              }`}
                            >
                              {indicatorBefore ? (
                                <DropIndicator after={false} />
                              ) : null}
                              <button
                                type="button"
                                aria-label={`Reorder article: ${title}`}
                                draggable={articles.length > 1 && !dragBusy}
                                onDragStart={(event) => {
                                  event.dataTransfer.effectAllowed = "move";
                                  event.dataTransfer.setData(
                                    "text/plain",
                                    article.id
                                  );
                                  setDraggedArticle({
                                    articleId: article.id,
                                    categoryId: category.id,
                                  });
                                  setDropTarget(null);
                                }}
                                onDragEnd={() => {
                                  setDraggedArticle(null);
                                  setDropTarget(null);
                                }}
                                onClick={(event) => event.preventDefault()}
                                className={`flex size-9 shrink-0 items-center justify-center rounded text-gray-500 hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 ${
                                  articles.length > 1
                                    ? "cursor-grab active:cursor-grabbing"
                                    : "cursor-default"
                                }`}
                                title={
                                  articles.length > 1
                                    ? "Drag to reorder"
                                    : undefined
                                }
                              >
                                <GripVertical
                                  aria-hidden="true"
                                  className="size-5"
                                />
                              </button>
                              <span className="w-8 shrink-0 text-right text-sm font-semibold tabular-nums text-gray-500">
                                {index + 1}.
                              </span>
                              <h3 className="min-w-0 flex-1 font-medium text-gray-950">
                                <Link
                                  to={`/handbook/${encodeURIComponent(
                                    article.slug
                                  )}`}
                                  draggable={false}
                                  className="hover:text-red-800 hover:underline"
                                >
                                  {title}
                                </Link>
                              </h3>
                              {indicatorAfter ? <DropIndicator after /> : null}
                            </li>
                          );
                        })}
                      </ol>
                    ) : (
                      <p className="p-4 text-sm text-gray-600">
                        No published articles to order in this category.
                      </p>
                    )}
                  </div>
                ) : null}
              </section>
            );
          })}
        </div>
      ) : (
        <section className="rounded-xl border border-dashed border-gray-300 bg-white px-5 py-10 text-center">
          <h2 className="text-lg font-semibold text-gray-900">
            No Handbook categories yet
          </h2>
          <p className="mt-2 text-sm text-gray-600">
            Create a category to organize Handbook articles.
          </p>
        </section>
      )}
    </main>
  );
}

function DropIndicator({ after }: { after: boolean }) {
  return (
    <div
      className={`pointer-events-none absolute inset-x-2 z-10 flex items-center gap-2 rounded bg-red-700 px-2 py-1 text-xs font-semibold text-white shadow sm:inset-x-4 ${
        after ? "bottom-0 translate-y-1/2" : "top-0 -translate-y-1/2"
      }`}
    >
      <span className="h-0.5 flex-1 bg-white" />
      Drop here
      <span className="h-0.5 flex-1 bg-white" />
    </div>
  );
}

export const ErrorBoundary = () => <ErrorContent />;
