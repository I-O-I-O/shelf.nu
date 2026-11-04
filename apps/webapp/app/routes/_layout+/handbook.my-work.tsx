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
  useNavigation,
} from "react-router";
import { Form } from "~/components/custom-form";
import { ErrorContent } from "~/components/errors";
import { Button } from "~/components/shared/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "~/components/shared/modal";
import { requireIoioHandbookRead } from "~/modules/ioio-handbook/access.server";
import {
  discardHandbookArticleRevisionDraft,
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
    if (intent !== "delete-draft" && intent !== "discard-revision") {
      return data(
        { ok: false as const, message: "Choose a draft action." },
        { status: 400 }
      );
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
  const navigation = useNavigation();
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
          {isStudent ? "Contribute knowledge" : "New article"}
        </Link>
      </div>

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
                    {draft.workType === "NEW_ARTICLE"
                      ? draft.submittedForReview
                        ? "Pending review · New article"
                        : "Draft · New article"
                      : draft.workType === "IMPROVEMENT_PENDING"
                      ? `Pending review · Improvement based on Version ${draft.baseVersionNumber}`
                      : `Draft improvement · Based on Version ${draft.baseVersionNumber}`}
                    {draft.handbookCategory?.name
                      ? ` · ${draft.handbookCategory.name}`
                      : ""}{" "}
                    · Updated {new Date(draft.updatedAt).toLocaleDateString()}
                  </p>
                </div>
                <Link
                  to={
                    draft.workType === "NEW_ARTICLE"
                      ? `/handbook/${encodeURIComponent(draft.slug)}/edit`
                      : draft.workType === "IMPROVEMENT_PENDING"
                      ? `/handbook/${encodeURIComponent(draft.slug)}`
                      : `/handbook/${encodeURIComponent(
                          draft.slug
                        )}/edit?improve=1`
                  }
                  className="inline-flex h-9 items-center rounded-lg border border-gray-300 px-3 text-sm font-semibold text-gray-700 hover:bg-gray-50"
                >
                  {draft.workType === "IMPROVEMENT_PENDING"
                    ? "View current article"
                    : "Edit draft"}
                </Link>
                {draft.workType === "NEW_ARTICLE" &&
                !draft.submittedForReview ? (
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        type="button"
                        variant="danger"
                        size="sm"
                        disabled={navigation.state === "submitting"}
                      >
                        Delete draft
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Delete this draft?</AlertDialogTitle>
                        <AlertDialogDescription>
                          This draft will be removed.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel asChild>
                          <Button
                            type="button"
                            variant="secondary"
                            disabled={navigation.state === "submitting"}
                          >
                            Cancel
                          </Button>
                        </AlertDialogCancel>
                        <Form method="post">
                          <input
                            type="hidden"
                            name="intent"
                            value="delete-draft"
                          />
                          <input
                            type="hidden"
                            name="articleId"
                            value={draft.id}
                          />
                          <AlertDialogAction asChild>
                            <Button
                              type="submit"
                              variant="danger"
                              disabled={navigation.state === "submitting"}
                            >
                              Delete draft
                            </Button>
                          </AlertDialogAction>
                        </Form>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                ) : null}
                {draft.workType === "IMPROVEMENT_DRAFT" ? (
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        type="button"
                        variant="danger"
                        size="sm"
                        disabled={navigation.state === "submitting"}
                      >
                        Discard draft improvement
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>
                          Discard this draft improvement?
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                          The draft changes will be removed. The published
                          article and version history will stay unchanged.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel asChild>
                          <Button
                            type="button"
                            variant="secondary"
                            disabled={navigation.state === "submitting"}
                          >
                            Cancel
                          </Button>
                        </AlertDialogCancel>
                        <Form method="post">
                          <input
                            type="hidden"
                            name="intent"
                            value="discard-revision"
                          />
                          <input
                            type="hidden"
                            name="articleId"
                            value={draft.articleId}
                          />
                          <AlertDialogAction asChild>
                            <Button
                              type="submit"
                              variant="danger"
                              disabled={navigation.state === "submitting"}
                            >
                              Discard draft improvement
                            </Button>
                          </AlertDialogAction>
                        </Form>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
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
