import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { data, Form, Link, useActionData, useLoaderData } from "react-router";
import { ErrorContent } from "~/components/errors";
import {
  HandbookWorkflowError,
  getHandbookReviewQueue,
  listArchivedHandbookArticles,
  restoreHandbookArticle,
} from "~/modules/ioio-handbook/workflow.server";
import { requireIoioStaffAccess } from "~/modules/ioio-staff/access.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { makeShelfError, ShelfError } from "~/utils/error";
import { error, payload } from "~/utils/http.server";

export async function loader({ context, request }: LoaderFunctionArgs) {
  const { userId } = context.getSession();
  try {
    const auth = await requireIoioStaffAccess({ context, request });
    if (auth.currentOrganization.type === "PERSONAL")
      throw new ShelfError({
        cause: null,
        message: "The Handbook is available in IOIO Lab workspaces only.",
        label: "Handbook",
        status: 403,
        shouldBeCaptured: false,
      });
    const [queue, archived] = await Promise.all([
      getHandbookReviewQueue(auth.organizationId),
      listArchivedHandbookArticles(auth.organizationId),
    ]);
    return payload({ queue, archived });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    throw data(error(reason), { status: reason.status });
  }
}

export async function action({ context, request }: ActionFunctionArgs) {
  const auth = await requireIoioStaffAccess({ context, request });
  const form = await request.formData();
  const intent = form.get("intent");
  if (intent === "restore") {
    try {
      await restoreHandbookArticle({
        organizationId: auth.organizationId,
        userId: auth.userId,
        articleId: String(form.get("articleId") ?? ""),
      });
      return payload({
        success: true as const,
        message: "Article restored to the Handbook.",
      });
    } catch (cause) {
      if (cause instanceof HandbookWorkflowError)
        return payload({ success: false as const, message: cause.message });
      const reason = makeShelfError(cause, { userId: auth.userId });
      throw data(error(reason), { status: reason.status });
    }
  }
  return data(
    payload({
      success: false as const,
      message: "Choose a valid review action.",
    }),
    { status: 400 }
  );
}

export const meta: MetaFunction = () => [
  { title: appendToMetaTitle("Handbook reviews") },
];
export const handle = { breadcrumb: () => "Handbook reviews" };

export default function HandbookReviewsPage() {
  const { queue, archived } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  return (
    <main className="mx-auto max-w-5xl px-4 py-6 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link
            to="/handbook"
            className="text-sm font-semibold text-red-800 hover:underline"
          >
            ← Handbook
          </Link>
          <h1 className="mt-2 text-2xl font-semibold text-gray-950">
            Handbook reviews
          </h1>
          <p className="mt-1 text-sm text-gray-600">
            Review submitted articles and revisions before they become current.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            to="/handbook/new"
            className="inline-flex h-10 items-center rounded-lg bg-red-700 px-4 text-sm font-semibold text-white"
          >
            New article
          </Link>
        </div>
      </div>
      {actionData && "message" in actionData ? (
        <p
          role={actionData.success ? "status" : "alert"}
          className="mt-4 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm"
        >
          {actionData.message}
        </p>
      ) : null}
      <section className="mt-7 rounded-xl border border-gray-200 bg-white">
        <div className="border-b border-gray-100 px-4 py-3">
          <h2 className="font-semibold text-gray-950">
            Pending proposals{" "}
            <span className="ml-1 text-sm font-normal text-gray-500">
              ({queue.length})
            </span>
          </h2>
        </div>
        {queue.length ? (
          <ul className="divide-y divide-gray-100">
            {queue.map((revision) => (
              <li
                key={revision.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              >
                <div>
                  <h3 className="font-semibold text-gray-950">
                    {revision.title}
                  </h3>
                  <p className="mt-1 text-xs text-gray-600">
                    {revision.article.publishedVersion
                      ? `Revision of ${revision.article.publishedVersion.title}`
                      : "New article"}{" "}
                    · {revision.category?.name ?? "No category"} ·{" "}
                    {revision.topic?.name ?? "No topic"} ·{" "}
                    {revision.articleType} ·{" "}
                    {revision.authorName ?? "Contributor"} · Submitted{" "}
                    {revision.submittedAt
                      ? new Date(revision.submittedAt).toLocaleDateString()
                      : "—"}
                  </p>
                </div>
                <Link
                  to={`/handbook/reviews/${revision.id}`}
                  className="inline-flex h-9 items-center rounded-lg border border-gray-300 px-3 text-sm font-semibold text-gray-800"
                >
                  Review
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-4 py-8 text-center text-sm text-gray-600">
            No proposals are waiting for review.
          </p>
        )}
      </section>
      <section className="mt-6 rounded-xl border border-gray-200 bg-white">
        <div className="border-b border-gray-100 px-4 py-3">
          <h2 className="font-semibold text-gray-950">Archived articles</h2>
          <p className="mt-1 text-xs text-gray-600">
            Archived content and its version history remain recoverable.
          </p>
        </div>
        {archived.length ? (
          <ul className="divide-y divide-gray-100">
            {archived.map((article) => (
              <li
                key={article.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              >
                <div>
                  <p className="font-medium text-gray-950">
                    {article.publishedVersion?.title ?? article.draftTitle}
                  </p>
                  <p className="mt-1 text-xs text-gray-500">
                    {article.publishedVersion
                      ? `Last published v${article.publishedVersion.versionNumber}`
                      : "Unpublished proposal"}{" "}
                    · Archived{" "}
                    {new Date(article.updatedAt).toLocaleDateString()}
                  </p>
                </div>
                <Form method="post">
                  <input type="hidden" name="articleId" value={article.id} />
                  <button
                    name="intent"
                    value="restore"
                    className="h-9 rounded-lg border border-gray-300 px-3 text-sm font-semibold text-gray-800"
                  >
                    Restore
                  </button>
                </Form>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-4 py-5 text-sm text-gray-600">
            No archived articles.
          </p>
        )}
      </section>
    </main>
  );
}

export const ErrorBoundary = () => <ErrorContent />;
