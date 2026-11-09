import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import {
  data,
  Link,
  redirect,
  useActionData,
  useLoaderData,
  useLocation,
} from "react-router";
import { ErrorContent } from "~/components/errors";
import { HandbookRemovalButton } from "~/components/handbook/handbook-removal-button";
import { requireIoioHandbookRead } from "~/modules/ioio-handbook/access.server";
import {
  discardHandbookArticleRevisionDraft,
  withdrawHandbookSubmission,
  deleteHandbookDraft,
  HandbookValidationError,
  listMyHandbookDrafts,
} from "~/modules/ioio-handbook/service.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { makeShelfError } from "~/utils/error";
import { error, payload } from "~/utils/http.server";

export async function loader({ context, request }: LoaderFunctionArgs) {
  const { userId } = context.getSession();
  try {
    const auth = await requireIoioHandbookRead({ context, request });
    const drafts = await listMyHandbookDrafts({
      organizationId: auth.organizationId,
      userId: auth.userId,
      canReadStaffOnly: auth.canEdit,
    });
    return payload({ drafts, isStudent: auth.isStudent });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    throw data(error(reason), { status: reason.status });
  }
}

export async function action({ context, request }: ActionFunctionArgs) {
  const { userId } = context.getSession();
  try {
    const auth = await requireIoioHandbookRead({ context, request });
    const formData = await request.formData();
    const intent = formData.get("intent");
    if (
      intent !== "delete-draft" &&
      intent !== "discard-revision" &&
      intent !== "withdraw-submission"
    ) {
      return data(
        { ok: false as const, message: "Choose a draft action." },
        { status: 400 }
      );
    }
    if (intent === "withdraw-submission") {
      const observationId = String(formData.get("observationId") ?? "").trim();
      if (!observationId || observationId.length > 40)
        return data(
          { ok: false as const, message: "Choose a valid submission." },
          { status: 400 }
        );
      await withdrawHandbookSubmission({
        organizationId: auth.organizationId,
        observationId,
        userId: auth.userId,
        canManageAnySubmission: auth.canEdit,
      });
      return redirect("/handbook/my-work?withdrawn=1");
    }
    const articleId = String(formData.get("articleId") ?? "").trim();
    if (!articleId || articleId.length > 40) {
      return data(
        { ok: false as const, message: "Choose a valid Handbook draft." },
        { status: 400 }
      );
    }
    if (intent === "discard-revision") {
      await discardHandbookArticleRevisionDraft({
        organizationId: auth.organizationId,
        articleId,
        userId: auth.userId,
        canManageAnyDraft: auth.canEdit,
      });
      return redirect("/handbook/my-work?discarded=1");
    }
    await deleteHandbookDraft({
      organizationId: auth.organizationId,
      articleId,
      userId: auth.userId,
      canManageAnyDraft: auth.canEdit,
    });
    return redirect("/handbook/my-work?deleted=1");
  } catch (cause) {
    if (cause instanceof HandbookValidationError) {
      return data(
        { ok: false as const, message: cause.message },
        { status: 400 }
      );
    }
    const reason = makeShelfError(cause, { userId });
    return data(
      { ok: false as const, message: reason.message },
      { status: reason.status }
    );
  }
}

export const meta: MetaFunction = () => [
  { title: appendToMetaTitle("My Handbook work") },
];
export const handle = { breadcrumb: () => "My Work" };

export default function HandbookMyWorkPage() {
  const { drafts, isStudent } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const location = useLocation();
  const withdrawn = new URLSearchParams(location.search).has("withdrawn");
  const submitted = new URLSearchParams(location.search).has("submitted");
  const deleted = new URLSearchParams(location.search).has("deleted");
  const discarded = new URLSearchParams(location.search).has("discarded");
  const actionMessage =
    actionData && "message" in actionData ? actionData.message : undefined;

  return (
    <main className="mx-auto max-w-5xl px-4 py-6 sm:px-6 lg:px-8">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link
            to="/handbook"
            className="text-sm font-semibold text-red-800 hover:underline"
          >
            ← Handbook
          </Link>
          <h1 className="mt-2 text-2xl font-semibold text-gray-950">My Work</h1>
          <p className="mt-1 text-sm text-gray-600">
            New articles and improvements you are drafting or have submitted.
          </p>
        </div>
        <Link
          to="/handbook/new"
          className="inline-flex h-10 items-center rounded-lg bg-red-700 px-4 text-sm font-semibold text-white hover:bg-red-800"
        >
          {isStudent ? "Contribute" : "New article"}
        </Link>
      </div>

      {withdrawn ? (
        <p
          role="status"
          className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-900"
        >
          Submission withdrawn. Your draft and review record have been retained.
        </p>
      ) : null}
      {submitted ? (
        <p
          role="status"
          className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-900"
        >
          Draft submitted for Staff review. It remains unpublished.
        </p>
      ) : null}

      {deleted ? (
        <p
          role="status"
          className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-900"
        >
          Draft deleted.
        </p>
      ) : null}

      {discarded ? (
        <p
          role="status"
          className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-900"
        >
          Draft improvement discarded. The published article and its history
          remain unchanged.
        </p>
      ) : null}

      {actionMessage ? (
        <p
          role="alert"
          className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900"
        >
          {actionMessage}
        </p>
      ) : null}

      <section className="rounded-xl border border-gray-200 bg-white">
        {drafts.length ? (
          <ul className="divide-y divide-gray-100">
            {drafts.map((draft) => (
              <li
                key={draft.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              >
                <div className="min-w-0">
                  <h2 className="font-medium text-gray-950">
                    {draft.draftTitle}
                  </h2>
                  <p className="mt-0.5 text-xs text-gray-500">
                    {draft.contributionStatus === "PENDING_REVIEW"
                      ? "Pending review"
                      : draft.contributionStatus === "RETURNED_FOR_CHANGES"
                      ? "Returned for changes"
                      : draft.contributionStatus === "APPROVED"
                      ? "Approved"
                      : draft.contributionStatus === "REJECTED"
                      ? "Rejected"
                      : "Draft"}
                    {draft.workType === "IMPROVEMENT_DRAFT" ||
                    draft.workType === "IMPROVEMENT_PENDING"
                      ? ` · Improvement based on Version ${draft.baseVersionNumber}`
                      : draft.workType === "OUTCOME" && draft.baseVersionNumber
                      ? ` · Improvement based on Version ${draft.baseVersionNumber}`
                      : " · New article"}
                    {draft.handbookCategory?.name
                      ? ` · ${draft.handbookCategory.name}`
                      : ""}{" "}
                    ·{" "}
                    {draft.submittedAt
                      ? `Submitted ${new Date(
                          draft.submittedAt
                        ).toLocaleDateString()}`
                      : `Updated ${new Date(
                          draft.updatedAt
                        ).toLocaleDateString()}`}
                  </p>
                </div>
                <Link
                  to={
                    draft.workType === "OUTCOME"
                      ? `/handbook/${encodeURIComponent(draft.slug)}`
                      : draft.workType === "NEW_ARTICLE"
                      ? `/handbook/${encodeURIComponent(draft.slug)}/edit`
                      : draft.workType === "IMPROVEMENT_PENDING"
                      ? `/handbook/${encodeURIComponent(draft.slug)}`
                      : `/handbook/${encodeURIComponent(
                          draft.slug
                        )}/edit?improve=1`
                  }
                  className="inline-flex h-9 items-center rounded-lg border border-gray-300 px-3 text-sm font-semibold text-gray-700 hover:bg-gray-50"
                >
                  {draft.workType === "OUTCOME"
                    ? "View article"
                    : draft.workType === "IMPROVEMENT_PENDING"
                    ? "View current article"
                    : draft.submittedForReview
                    ? "View submission"
                    : "Edit draft"}
                </Link>
                {draft.workType !== "OUTCOME" &&
                draft.submittedForReview &&
                draft.submissionId ? (
                  <HandbookRemovalButton
                    intent="withdraw-submission"
                    observationId={draft.submissionId}
                    actionPath="/handbook/my-work"
                  />
                ) : draft.workType === "NEW_ARTICLE" &&
                  !draft.submittedForReview ? (
                  <HandbookRemovalButton
                    intent="delete-draft"
                    articleId={draft.id}
                    actionPath="/handbook/my-work"
                  />
                ) : draft.workType === "IMPROVEMENT_DRAFT" ? (
                  <HandbookRemovalButton
                    intent="discard-revision"
                    articleId={draft.articleId}
                    actionPath="/handbook/my-work"
                  />
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-4 py-6 text-sm text-gray-600">
            You have no Handbook drafts yet.
          </p>
        )}
      </section>
    </main>
  );
}

export const ErrorBoundary = () => <ErrorContent />;
