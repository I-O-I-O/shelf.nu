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
import {
  HandbookValidationError,
  listHandbookArticlesForStaff,
  listHandbookObservations,
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
    const [articles, observations] = await Promise.all([
      listHandbookArticlesForStaff(auth.organizationId),
      listHandbookObservations(auth.organizationId),
    ]);
    return payload({ articles, observations });
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
  if (!observationId || (intent !== "review" && intent !== "dismiss")) {
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
  const { articles, observations } = useLoaderData<typeof loader>();
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
            Reviewing a note is not the same as publishing it.
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
                      : article.draftSection}
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
                  <Link
                    to={"/handbook/" + article.slug + "/edit"}
                    className="inline-flex h-9 items-center rounded-lg border border-gray-300 px-3 text-sm font-semibold text-gray-700 hover:bg-gray-50"
                  >
                    Edit draft
                  </Link>
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
                        item.article?.publishedVersion?.title,
                        item.assetModel?.name,
                        item.kit?.name,
                      ]
                        .filter(Boolean)
                        .join(" · ") || "none"}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2">
                    {item.article ? (
                      <Link
                        to={"/handbook/" + item.article.slug}
                        className="inline-flex h-9 items-center rounded-lg border border-gray-300 px-3 text-sm font-semibold text-gray-700 hover:bg-gray-50"
                      >
                        Open article
                      </Link>
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
                        disabled={navigation.state === "submitting"}
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
                        value="dismiss"
                        disabled={navigation.state === "submitting"}
                        className="inline-flex h-9 items-center rounded-lg px-3 text-sm font-semibold text-gray-600 hover:bg-gray-100 disabled:opacity-60"
                      >
                        Dismiss
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
