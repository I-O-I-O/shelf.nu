import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { data, Link, useLoaderData } from "react-router";
import { ErrorContent } from "~/components/errors";
import { requireIoioHandbookRead } from "~/modules/ioio-handbook/access.server";
import { getMyHandbookWork } from "~/modules/ioio-handbook/workflow.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { makeShelfError } from "~/utils/error";
import { error, payload } from "~/utils/http.server";

export async function loader({ context, request }: LoaderFunctionArgs) {
  const { userId } = context.getSession();
  try {
    const auth = await requireIoioHandbookRead({ context, request });
    const work = await getMyHandbookWork({
      organizationId: auth.organizationId,
      userId: auth.userId,
    });
    return payload({ work });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    throw data(error(reason), { status: reason.status });
  }
}

export const meta: MetaFunction = () => [
  { title: appendToMetaTitle("My Handbook work") },
];
export const handle = { breadcrumb: () => "My work" };

export default function HandbookMyWorkPage() {
  const { work } = useLoaderData<typeof loader>();
  return (
    <main className="mx-auto max-w-4xl px-4 py-6 sm:px-6 lg:px-8">
      <Link
        to="/handbook"
        className="text-sm font-semibold text-red-800 hover:underline"
      >
        ← Handbook
      </Link>
      <h1 className="mt-3 text-2xl font-semibold text-gray-950">
        My Handbook work
      </h1>
      <p className="mt-1 text-sm text-gray-600">
        Track drafts, submissions, and staff decisions.
      </p>
      {work.length ? (
        <ul className="mt-5 divide-y divide-gray-100 rounded-xl border border-gray-200 bg-white">
          {work.map((revision) => (
            <li
              key={revision.id}
              className="flex flex-wrap items-start justify-between gap-3 p-4"
            >
              <div>
                <h2 className="font-semibold text-gray-950">
                  {revision.title}
                </h2>
                <p className="mt-1 text-sm text-gray-600">
                  v{revision.revisionNumber} ·{" "}
                  {revision.status.replaceAll("_", " ")}
                  {revision.submittedAt
                    ? ` · Submitted ${new Date(
                        revision.submittedAt
                      ).toLocaleDateString()}`
                    : ""}
                </p>
                {revision.reviewNotes ? (
                  <p className="mt-2 max-w-2xl text-sm text-amber-900">
                    Staff note: {revision.reviewNotes}
                  </p>
                ) : null}
              </div>
              <div className="flex gap-2">
                {revision.status === "DRAFT" ? (
                  <Link
                    to={`/handbook/${revision.article.slug}/edit?revision=${revision.id}`}
                    className="inline-flex h-9 items-center rounded-lg border border-gray-300 px-3 text-sm font-semibold text-gray-800"
                  >
                    Continue draft
                  </Link>
                ) : null}
                {revision.status === "APPROVED" ? (
                  <Link
                    to={`/handbook/${revision.article.slug}`}
                    className="inline-flex h-9 items-center rounded-lg border border-gray-300 px-3 text-sm font-semibold text-gray-800"
                  >
                    View article
                  </Link>
                ) : null}
                {revision.status === "PENDING_REVIEW" ? (
                  <span className="inline-flex h-9 items-center rounded-lg bg-amber-50 px-3 text-sm font-semibold text-amber-900">
                    Awaiting staff
                  </span>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <section className="mt-5 rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center">
          <h2 className="font-semibold text-gray-950">
            No drafts or proposals yet
          </h2>
          <p className="mt-1 text-sm text-gray-600">
            Create a new article proposal or revise an existing page.
          </p>
          <Link
            to="/handbook/new"
            className="mt-4 inline-flex h-10 items-center rounded-lg bg-red-700 px-4 text-sm font-semibold text-white"
          >
            Start a proposal
          </Link>
        </section>
      )}
    </main>
  );
}

export const ErrorBoundary = () => <ErrorContent />;
