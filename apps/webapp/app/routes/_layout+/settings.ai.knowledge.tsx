import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import {
  data,
  Form,
  Link,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";
import { ErrorContent } from "~/components/errors";
import { HandbookRemovalButton } from "~/components/handbook/handbook-removal-button";
import {
  HandbookValidationError,
  approveHandbookArticleRevision,
  listHandbookArticlesForStaff,
  listHandbookCategories,
  listHandbookObservations,
  rejectHandbookArticleRevision,
  resolveHandbookObservationCategoryProposal,
  reviewHandbookObservation,
} from "~/modules/ioio-handbook/service.server";
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
        message: "Handbook knowledge is available in IOIO Lab workspaces only.",
        label: "Settings",
        status: 403,
        shouldBeCaptured: false,
      });
    const [articles, observations, categories] = await Promise.all([
      listHandbookArticlesForStaff(auth.organizationId),
      listHandbookObservations(auth.organizationId),
      listHandbookCategories(auth.organizationId),
    ]);
    return payload({ articles, observations, categories });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    throw data(error(reason), { status: reason.status });
  }
}

export async function action({ context, request }: ActionFunctionArgs) {
  const auth = await requireIoioStaffAccess({ context, request });
  const form = await request.formData();
  const observationId = String(form.get("observationId") ?? "");
  const intent = form.get("intent");
  if (
    observationId &&
    (intent === "approve-category" ||
      intent === "replace-category" ||
      intent === "reject-category")
  ) {
    try {
      await resolveHandbookObservationCategoryProposal({
        organizationId: auth.organizationId,
        observationId,
        resolution:
          intent === "approve-category"
            ? "approve"
            : intent === "replace-category"
            ? "replace"
            : "reject",
        handbookCategoryId:
          String(form.get("handbookCategoryId") ?? "") || undefined,
        categoryName: String(form.get("categoryName") ?? "") || undefined,
      });
      return payload({
        success: true as const,
        message:
          intent === "reject-category"
            ? "Category proposal rejected. The contribution is still available for review."
            : "Category proposal resolved for this contribution.",
      });
    } catch (cause) {
      if (cause instanceof HandbookValidationError)
        return payload({ success: false as const, message: cause.message });
      const reason = makeShelfError(cause, { userId: auth.userId });
      throw data(error(reason), { status: reason.status });
    }
  }
  if (observationId && intent === "approve-revision") {
    try {
      const result = await approveHandbookArticleRevision({
        organizationId: auth.organizationId,
        userId: auth.userId,
        observationId,
      });
      return payload({
        success: true as const,
        message: `Improvement approved and published as Version ${result.versionNumber}.`,
      });
    } catch (cause) {
      if (cause instanceof HandbookValidationError)
        return payload({ success: false as const, message: cause.message });
      const reason = makeShelfError(cause, { userId: auth.userId });
      throw data(error(reason), { status: reason.status });
    }
  }
  if (observationId && intent === "reject-revision") {
    try {
      await rejectHandbookArticleRevision({
        organizationId: auth.organizationId,
        userId: auth.userId,
        observationId,
      });
      return payload({
        success: true as const,
        message:
          "Revision rejected. The published article and version history remain unchanged.",
      });
    } catch (cause) {
      if (cause instanceof HandbookValidationError)
        return payload({ success: false as const, message: cause.message });
      const reason = makeShelfError(cause, { userId: auth.userId });
      throw data(error(reason), { status: reason.status });
    }
  }
  if (
    !observationId ||
    (intent !== "review" &&
      intent !== "dismiss" &&
      intent !== "return-for-changes")
  ) {
    return payload({
      success: false as const,
      message: "That contribution could not be updated.",
    });
  }
  try {
    await reviewHandbookObservation({
      organizationId: auth.organizationId,
      userId: auth.userId,
      observationId,
      status: intent === "review" ? "REVIEWED" : "DISMISSED",
    });
    return payload({
      success: true as const,
      message:
        intent === "review"
          ? "Marked reviewed. This did not publish or modify an article."
          : intent === "return-for-changes"
          ? "Revision returned to its author. The current published version remains live."
          : "Contribution dismissed.",
    });
  } catch (cause) {
    if (cause instanceof HandbookValidationError)
      return payload({ success: false as const, message: cause.message });
    const reason = makeShelfError(cause, { userId: auth.userId });
    throw data(error(reason), { status: reason.status });
  }
}

export const meta: MetaFunction = () => [
  { title: appendToMetaTitle("AI knowledge") },
];
export const handle = { breadcrumb: () => "Knowledge" };

export default function AiKnowledgePage() {
  const { articles, observations, categories } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  return (
    <main className="mx-auto w-full max-w-5xl px-4 pb-8">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-950">
            Knowledge administration
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-gray-600">
            Manage published Handbook knowledge and review contributions.
            Observations can be reviewed without publication; approved article
            improvements publish as a new version.
          </p>
        </div>
        <Link
          to="/handbook/new"
          className="inline-flex h-10 items-center rounded-lg bg-red-700 px-4 text-sm font-semibold text-white hover:bg-red-800"
        >
          New Handbook article
        </Link>
      </header>
      {actionData && "message" in actionData ? (
        <p
          role={actionData.success ? "status" : "alert"}
          className={
            actionData.success
              ? "mb-4 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-900"
              : "mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900"
          }
        >
          {actionData.message}
        </p>
      ) : null}
      <section className="mb-5 rounded-xl border border-gray-200 bg-white">
        <div className="border-b border-gray-100 px-4 py-3">
          <h2 className="font-semibold text-gray-900">Handbook articles</h2>
        </div>
        {articles.length ? (
          <ul className="divide-y divide-gray-100">
            {articles.map((article) => (
              <li
                key={article.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="font-medium text-gray-950">
                    {article.publishedVersion?.title ?? article.draftTitle}
                  </p>
                  <p className="mt-0.5 text-xs text-gray-500">
                    {article.publishedVersion
                      ? "Published v" + article.publishedVersion.versionNumber
                      : article.handbookCategory?.name ?? "Draft"}
                    {" · "}
                    {article.status.toLowerCase()}
                    {" · Updated "}
                    {new Date(article.updatedAt).toLocaleDateString()}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  {article.status === "PUBLISHED" ? (
                    <Link
                      to={"/handbook/" + article.slug}
                      className="inline-flex h-9 items-center rounded-lg border border-gray-300 px-3 text-sm font-semibold text-gray-700 hover:bg-gray-50"
                    >
                      View
                    </Link>
                  ) : null}
                  {article.status === "ARCHIVED" ? (
                    <>
                      <HandbookRemovalButton
                        intent="restore-article"
                        articleId={article.id}
                      />
                      <HandbookRemovalButton
                        intent="delete-permanently"
                        articleId={article.id}
                        articleTitle={
                          article.publishedVersion?.title ?? article.draftTitle
                        }
                      />
                    </>
                  ) : (
                    <Link
                      to={
                        article.status === "PUBLISHED"
                          ? "/handbook/" + article.slug + "/edit?improve=1"
                          : "/handbook/" + article.slug + "/edit"
                      }
                      className="inline-flex h-9 items-center rounded-lg border border-gray-300 px-3 text-sm font-semibold text-gray-700 hover:bg-gray-50"
                    >
                      {article.status === "PUBLISHED"
                        ? "Improve this article"
                        : "Edit draft"}
                    </Link>
                  )}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-4 py-6 text-sm text-gray-500">
            No Handbook articles yet.
          </p>
        )}
      </section>
      <section className="rounded-xl border border-gray-200 bg-white">
        <div className="border-b border-gray-100 px-4 py-3">
          <h2 className="font-semibold text-gray-900">
            Contributions awaiting review{" "}
            <span className="ml-1 text-sm font-normal text-gray-500">
              {observations.length}
            </span>
          </h2>
        </div>
        {observations.length ? (
          <ul className="divide-y divide-gray-100">
            {observations.map((item) => (
              <li key={item.id} className="p-4">
                {item.publishedVersionId && item.article ? (
                  <div className="mb-3 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-950">
                    <p className="font-semibold">
                      Proposed improvement to Version{" "}
                      {item.article.publishedVersion?.versionNumber ?? "?"}
                    </p>
                    <p className="mt-1">
                      Current:{" "}
                      {item.article.publishedVersion?.title ??
                        "Published article"}
                      {" · "}Proposed: {item.article.draftTitle}
                    </p>
                    <details className="mt-2">
                      <summary className="cursor-pointer font-medium">
                        Preview proposed content
                      </summary>
                      <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap font-sans text-xs leading-5">
                        {item.article.draftContent}
                      </pre>
                      {item.article.draftSourceUrls.length ? (
                        <ul className="mt-2 space-y-1 text-xs">
                          {item.article.draftSourceUrls.map((url) => (
                            <li key={url}>
                              <a
                                href={url}
                                target="_blank"
                                rel="noreferrer"
                                className="text-red-800 underline underline-offset-2"
                              >
                                {url}
                              </a>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </details>
                  </div>
                ) : null}
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <h3 className="font-semibold text-gray-950">
                      {item.title}
                    </h3>
                    <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-gray-700">
                      {item.content}
                    </p>
                    <p className="mt-2 text-xs text-gray-500">
                      From {item.contributorName || "IOIO user"} ·{" "}
                      {new Date(item.createdAt).toLocaleString()}
                    </p>
                    <p className="mt-1 text-xs text-gray-500">
                      Linked context:{" "}
                      {[
                        item.article?.publishedVersion?.title ??
                          item.article?.draftTitle,
                        item.assetModel?.name,
                        item.kit?.name,
                      ]
                        .filter(Boolean)
                        .join(" · ") || "none"}
                    </p>
                    {item.proposedCategoryName ? (
                      <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
                        <p className="text-sm font-semibold text-amber-950">
                          Proposed Handbook category:{" "}
                          {item.proposedCategoryName}
                        </p>
                        <Form method="post" className="mt-2 space-y-2">
                          <input
                            type="hidden"
                            name="observationId"
                            value={item.id}
                          />
                          <label className="block text-xs font-medium text-gray-700">
                            Approve or rename proposal
                            <input
                              name="categoryName"
                              maxLength={80}
                              defaultValue={item.proposedCategoryName}
                              className="mt-1 block h-9 w-full rounded-md border border-gray-300 bg-white px-2 text-sm font-normal"
                            />
                          </label>
                          <label className="block text-xs font-medium text-gray-700">
                            Replace with an existing Handbook category
                            <select
                              name="handbookCategoryId"
                              defaultValue=""
                              className="mt-1 block h-9 w-full rounded-md border border-gray-300 bg-white px-2 text-sm font-normal"
                            >
                              <option value="">Choose a category</option>
                              {categories.map((category) => (
                                <option key={category.id} value={category.id}>
                                  {category.name}
                                </option>
                              ))}
                            </select>
                          </label>
                          <div className="flex flex-wrap gap-2">
                            <button
                              name="intent"
                              value="approve-category"
                              disabled={navigation.state === "submitting"}
                              className="inline-flex h-8 items-center rounded-md bg-red-700 px-3 text-xs font-semibold text-white disabled:opacity-60"
                            >
                              Approve category
                            </button>
                            <button
                              name="intent"
                              value="replace-category"
                              disabled={navigation.state === "submitting"}
                              className="inline-flex h-8 items-center rounded-md border border-gray-300 bg-white px-3 text-xs font-semibold text-gray-800 disabled:opacity-60"
                            >
                              Use existing category
                            </button>
                            <button
                              name="intent"
                              value="reject-category"
                              disabled={navigation.state === "submitting"}
                              className="inline-flex h-8 items-center rounded-md px-3 text-xs font-semibold text-gray-600 hover:bg-white disabled:opacity-60"
                            >
                              Reject proposal
                            </button>
                          </div>
                        </Form>
                      </div>
                    ) : item.handbookCategory ? (
                      <p className="mt-2 text-xs text-gray-500">
                        Handbook category: {item.handbookCategory.name}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2">
                    {item.article ? (
                      <Link
                        to={
                          item.article.status === "PUBLISHED"
                            ? "/handbook/" + item.article.slug
                            : "/handbook/" + item.article.slug + "/edit"
                        }
                        className="inline-flex h-9 items-center rounded-lg border border-gray-300 px-3 text-sm font-semibold text-gray-700 hover:bg-gray-50"
                      >
                        {item.article.status === "PUBLISHED"
                          ? "Open article"
                          : "Review draft"}
                      </Link>
                    ) : null}
                    {item.publishedVersionId && !item.proposedCategoryName ? (
                      <Form method="post">
                        <input
                          type="hidden"
                          name="observationId"
                          value={item.id}
                        />
                        <button
                          name="intent"
                          value="approve-revision"
                          disabled={navigation.state === "submitting"}
                          className="inline-flex h-9 items-center rounded-lg bg-red-700 px-3 text-sm font-semibold text-white hover:bg-red-800 disabled:opacity-60"
                        >
                          Approve revision
                        </button>
                      </Form>
                    ) : null}
                    {item.publishedVersionId ? (
                      <Form method="post">
                        <input
                          type="hidden"
                          name="observationId"
                          value={item.id}
                        />
                        <button
                          name="intent"
                          value="reject-revision"
                          disabled={navigation.state === "submitting"}
                          className="inline-flex h-9 items-center rounded-lg px-3 text-sm font-semibold text-gray-600 hover:bg-gray-100 disabled:opacity-60"
                        >
                          Reject revision
                        </button>
                      </Form>
                    ) : null}
                    <Form method="post">
                      <input
                        type="hidden"
                        name="observationId"
                        value={item.id}
                      />
                      <button
                        name="intent"
                        value="review"
                        disabled={
                          navigation.state === "submitting" ||
                          Boolean(item.proposedCategoryName) ||
                          Boolean(item.publishedVersionId)
                        }
                        className="inline-flex h-9 items-center rounded-lg border border-gray-300 bg-white px-3 text-sm font-semibold text-gray-800 disabled:opacity-60"
                      >
                        Mark reviewed
                      </button>
                    </Form>
                    <Form method="post">
                      <input
                        type="hidden"
                        name="observationId"
                        value={item.id}
                      />
                      <button
                        name="intent"
                        value={
                          item.publishedVersionId
                            ? "return-for-changes"
                            : "dismiss"
                        }
                        disabled={navigation.state === "submitting"}
                        className="inline-flex h-9 items-center rounded-lg px-3 text-sm font-semibold text-gray-600 hover:bg-gray-100 disabled:opacity-60"
                      >
                        {item.publishedVersionId
                          ? "Return for changes"
                          : "Dismiss"}
                      </button>
                    </Form>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <div className="px-4 py-10 text-center">
            <p className="font-medium text-gray-900">
              No contributions waiting for review.
            </p>
            <p className="mt-1 text-sm text-gray-500">
              Student and Staff observations will appear here without changing
              the published Handbook.
            </p>
          </div>
        )}
      </section>
      <p className="mt-4 text-xs leading-5 text-gray-500">
        External references can be attached while editing an article. Document
        upload, content extraction, and AI-proposed article diffs are not
        enabled in this first slice.
      </p>
    </main>
  );
}

export const ErrorBoundary = () => <ErrorContent />;
