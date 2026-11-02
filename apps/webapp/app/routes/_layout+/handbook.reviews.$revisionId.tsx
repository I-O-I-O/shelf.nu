import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { data, Form, Link, redirect, useLoaderData } from "react-router";
import { ErrorContent } from "~/components/errors";
import { MarkdownViewer } from "~/components/markdown/markdown-viewer";
import {
  HandbookWorkflowError,
  getHandbookReviewDetail,
  publishHandbookRevision,
  reviewHandbookRevision,
} from "~/modules/ioio-handbook/workflow.server";
import { requireIoioStaffAccess } from "~/modules/ioio-staff/access.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { makeShelfError } from "~/utils/error";
import { error, payload } from "~/utils/http.server";

export async function loader({ context, request, params }: LoaderFunctionArgs) {
  const { userId } = context.getSession();
  try {
    const auth = await requireIoioStaffAccess({ context, request });
    const review = await getHandbookReviewDetail({
      organizationId: auth.organizationId,
      revisionId: params.revisionId ?? "",
    });
    if (!review)
      throw new HandbookWorkflowError("This proposal is not available.", 404);
    return payload({ review });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    throw data(error(reason), { status: reason.status });
  }
}

export async function action({ context, request, params }: ActionFunctionArgs) {
  const auth = await requireIoioStaffAccess({ context, request });
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const revisionId = params.revisionId ?? "";
  try {
    if (intent === "approve" || intent === "publish-separately") {
      const result = await publishHandbookRevision({
        organizationId: auth.organizationId,
        userId: auth.userId,
        revisionId,
      });
      return redirect(`/handbook/${result.slug}`);
    }
    if (intent === "return" || intent === "reject") {
      await reviewHandbookRevision({
        organizationId: auth.organizationId,
        userId: auth.userId,
        revisionId,
        decision: intent,
        notes: String(form.get("notes") ?? ""),
      });
      return redirect("/handbook/reviews");
    }
    return data(
      payload({
        success: false as const,
        message: "Choose a valid review action.",
      }),
      { status: 400 }
    );
  } catch (cause) {
    if (cause instanceof HandbookWorkflowError)
      return data(
        payload({ success: false as const, message: cause.message }),
        { status: cause.status }
      );
    const reason = makeShelfError(cause, { userId: auth.userId });
    throw data(error(reason), { status: reason.status });
  }
}

export const meta: MetaFunction<typeof loader> = ({ data: loaded }) => [
  {
    title: appendToMetaTitle(
      loaded?.review.revision.title ?? "Review Handbook proposal"
    ),
  },
];
export const handle = { breadcrumb: () => "Review proposal" };

export default function HandbookReviewDetailPage() {
  const { review } = useLoaderData<typeof loader>();
  const { revision, diff } = review;
  const current = revision.article.publishedVersion;
  const isNewProposal = !current;
  return (
    <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link
            to="/handbook/reviews"
            className="text-sm font-semibold text-red-800 hover:underline"
          >
            ← Review queue
          </Link>
          <h1 className="mt-2 text-2xl font-semibold text-gray-950">
            Review: {revision.title}
          </h1>
          <p className="mt-1 text-sm text-gray-600">
            {isNewProposal
              ? "New article proposal"
              : `Revision proposal for ${current.title}`}{" "}
            · v{revision.revisionNumber} ·{" "}
            {revision.category?.name ?? "No category"} ·{" "}
            {revision.topic?.name ?? "No topic"} · {revision.articleType} ·{" "}
            {revision.authorName ?? "Contributor"} · Submitted{" "}
            {revision.submittedAt
              ? new Date(revision.submittedAt).toLocaleDateString()
              : "—"}
          </p>
        </div>
        {current ? (
          <Link
            to={`/handbook/${revision.article.slug}`}
            className="inline-flex h-9 items-center rounded-lg border border-gray-300 px-3 text-sm font-semibold text-gray-800"
          >
            View current article
          </Link>
        ) : null}
      </div>

      <section className="mb-5 grid gap-4 lg:grid-cols-2">
        {current ? (
          <article className="rounded-xl border border-gray-200 bg-white p-4">
            <h2 className="mb-3 font-semibold text-gray-950">
              Current approved version · v{current.versionNumber}
            </h2>
            <div className="max-h-[650px] overflow-auto">
              <MarkdownViewer content={current.content} allowExternalLinks />
            </div>
          </article>
        ) : (
          <article className="rounded-xl border border-dashed border-gray-300 bg-white p-4">
            <h2 className="font-semibold text-gray-950">
              Current approved version
            </h2>
            <p className="mt-2 text-sm text-gray-600">
              This is a new article proposal with no published version yet.
            </p>
          </article>
        )}
        <article className="rounded-xl border border-blue-200 bg-blue-50 p-4">
          <h2 className="mb-3 font-semibold text-blue-950">
            Proposed v{revision.revisionNumber}
          </h2>
          <div className="max-h-[650px] overflow-auto rounded-lg bg-white p-3">
            <MarkdownViewer content={revision.content} allowExternalLinks />
          </div>
        </article>
      </section>

      <section className="mb-5 rounded-xl border border-gray-200 bg-white p-4">
        <h2 className="font-semibold text-gray-950">
          Canonical text change summary
        </h2>
        <p className="mt-1 text-sm text-gray-600">
          {diff.added.length} added line(s), {diff.removed.length} removed
          line(s); {diff.changedPairs} paired change(s). This summary is
          computed from stored article text.
        </p>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          {diff.removed.length ? (
            <div>
              <h3 className="text-sm font-semibold text-red-800">Removed</h3>
              <ul className="mt-1 space-y-1 text-sm text-red-900">
                {diff.removed.map((line: string, index: number) => (
                  <li
                    key={`${index}:${line}`}
                    className="rounded bg-red-50 p-2"
                  >
                    − {line}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {diff.added.length ? (
            <div>
              <h3 className="text-sm font-semibold text-green-800">Added</h3>
              <ul className="mt-1 space-y-1 text-sm text-green-900">
                {diff.added.map((line: string, index: number) => (
                  <li
                    key={`${index}:${line}`}
                    className="rounded bg-green-50 p-2"
                  >
                    + {line}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </section>

      <section className="mt-5 rounded-xl border border-gray-200 bg-white p-4">
        <h2 className="font-semibold text-gray-950">Staff decision</h2>
        <p className="mt-1 text-sm text-gray-600">
          Approving this proposal makes it the current Handbook version.
        </p>
        <Form method="post" className="mt-3 space-y-3">
          <label className="block text-sm font-medium text-gray-800">
            Review note{" "}
            <textarea
              name="notes"
              rows={3}
              maxLength={4000}
              defaultValue={revision.reviewNotes ?? ""}
              className="mt-1 block w-full rounded-lg border border-gray-300 p-3 font-normal"
              placeholder="Add a note for the contributor when returning or rejecting."
            />
          </label>
          <div className="flex flex-wrap justify-end gap-2">
            <button
              name="intent"
              value="return"
              className="h-10 rounded-lg border border-gray-300 px-4 text-sm font-semibold text-gray-800"
            >
              Return to author
            </button>
            <button
              name="intent"
              value="reject"
              className="h-10 rounded-lg border border-red-300 px-4 text-sm font-semibold text-red-800"
            >
              Reject
            </button>
            <button
              name="intent"
              value={isNewProposal ? "publish-separately" : "approve"}
              className="h-10 rounded-lg bg-red-700 px-4 text-sm font-semibold text-white"
            >
              {isNewProposal
                ? "Publish as separate article"
                : "Approve revision"}
            </button>
          </div>
        </Form>
      </section>
    </main>
  );
}

export const ErrorBoundary = () => <ErrorContent />;
