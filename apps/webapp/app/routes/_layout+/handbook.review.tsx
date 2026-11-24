import { useState } from "react";
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
  HandbookFileList,
  type HandbookFileAttachment,
} from "~/components/handbook/handbook-file-list";
import { MarkdownViewer } from "~/components/markdown/markdown-viewer";
import { Button } from "~/components/shared/button";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "~/components/shared/modal";
import { handbookAttachmentFilenameFromPath } from "~/modules/ioio-handbook/attachment.shared";
import { compareHandbookVersions } from "~/modules/ioio-handbook/document";
import { HANDBOOK_REVIEW_FEEDBACK_MAX_LENGTH } from "~/modules/ioio-handbook/review-feedback.shared";
import {
  approveHandbookArticleRevision,
  approveHandbookNewArticleSubmission,
  HandbookValidationError,
  listHandbookCategories,
  listHandbookObservations,
  rejectHandbookArticleRevision,
  resolveHandbookArticleSubmission,
  resolveHandbookObservationCategoryProposal,
} from "~/modules/ioio-handbook/service.server";
import { requireIoioStaffAccess } from "~/modules/ioio-staff/access.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { makeShelfError, ShelfError } from "~/utils/error";
import { error, payload } from "~/utils/http.server";

export async function loader({ context, request }: LoaderFunctionArgs) {
  const { userId } = context.getSession();
  try {
    const auth = await requireIoioStaffAccess({ context, request });
    if (auth.currentOrganization.type === "PERSONAL") {
      throw new ShelfError({
        cause: null,
        message: "Handbook review is available in IOIO Lab workspaces only.",
        label: "Handbook",
        status: 403,
        shouldBeCaptured: false,
      });
    }
    const [observations, categories] = await Promise.all([
      listHandbookObservations(auth.organizationId),
      listHandbookCategories(auth.organizationId),
    ]);
    return payload({ observations, categories });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    throw data(error(reason), { status: reason.status });
  }
}

export async function action({ context, request }: ActionFunctionArgs) {
  const auth = await requireIoioStaffAccess({ context, request });
  const form = await request.formData();
  const observationId = String(form.get("observationId") ?? "").trim();
  const intent = String(form.get("intent") ?? "");
  if (!observationId || observationId.length > 40) {
    return data(
      { success: false as const, message: "Choose a valid contribution." },
      { status: 400 }
    );
  }
  try {
    if (
      intent === "approve-category" ||
      intent === "replace-category" ||
      intent === "reject-category"
    ) {
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
            ? "Category proposal rejected. The article remains available for review."
            : "Category proposal resolved. Review the article before publishing.",
      });
    }
    if (intent === "approve-new") {
      const result = await approveHandbookNewArticleSubmission({
        organizationId: auth.organizationId,
        userId: auth.userId,
        observationId,
      });
      return payload({
        success: true as const,
        message: `Article approved and published as Version ${result.versionNumber}.`,
      });
    }
    if (intent === "approve-revision") {
      const result = await approveHandbookArticleRevision({
        organizationId: auth.organizationId,
        userId: auth.userId,
        observationId,
      });
      return payload({
        success: true as const,
        message: `Improvement approved and published as Version ${result.versionNumber}.`,
      });
    }
    if (intent === "return-for-changes") {
      await resolveHandbookArticleSubmission({
        organizationId: auth.organizationId,
        userId: auth.userId,
        observationId,
        resolution: "return-for-changes",
      });
      return payload({
        success: true as const,
        message:
          "Contribution returned for changes. The current published version remains live.",
      });
    }
    if (intent === "reject-new") {
      await resolveHandbookArticleSubmission({
        organizationId: auth.organizationId,
        userId: auth.userId,
        observationId,
        resolution: "reject",
        feedback: String(form.get("feedback") ?? ""),
      });
      return payload({
        success: true as const,
        message:
          "Contribution rejected. The student's draft remains available in My Work.",
      });
    }
    if (intent === "reject-revision") {
      await rejectHandbookArticleRevision({
        organizationId: auth.organizationId,
        userId: auth.userId,
        observationId,
        feedback: String(form.get("feedback") ?? ""),
      });
      return payload({
        success: true as const,
        message:
          "Improvement rejected. The student can edit and resubmit it; the current published version remains live.",
      });
    }
    return data(
      { success: false as const, message: "Choose a review action." },
      { status: 400 }
    );
  } catch (cause) {
    if (cause instanceof HandbookValidationError) {
      return data(
        { success: false as const, message: cause.message },
        { status: 400 }
      );
    }
    const reason = makeShelfError(cause, { userId: auth.userId });
    throw data(error(reason), { status: reason.status });
  }
}

export const meta: MetaFunction = () => [
  { title: appendToMetaTitle("Review contributions") },
];
export const handle = { breadcrumb: () => "Review contributions" };

function ArticleReferences({ urls }: { urls: string[] }) {
  return urls.length ? (
    <section className="mt-4">
      <h4 className="text-sm font-semibold text-gray-900">
        External references
      </h4>
      <ul className="mt-1 list-inside list-disc space-y-1 text-sm">
        {urls.map((url) => (
          <li key={url}>
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="break-all text-red-800 underline underline-offset-2"
            >
              {url}
            </a>
          </li>
        ))}
      </ul>
    </section>
  ) : (
    <p className="mt-4 text-sm text-gray-500">No external references.</p>
  );
}

function CategoryResolution({
  observation,
  categories,
}: {
  observation: Awaited<ReturnType<typeof loader>>["observations"][number];
  categories: Awaited<ReturnType<typeof loader>>["categories"];
}) {
  if (!observation.proposedCategoryName) return null;
  return (
    <section className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3">
      <h4 className="text-sm font-semibold text-amber-950">
        Proposed category: {observation.proposedCategoryName}
      </h4>
      <p className="mt-1 text-xs text-amber-900">
        Resolve the category before publishing this contribution.
      </p>
      <Form method="post" className="mt-3 space-y-2">
        <input type="hidden" name="observationId" value={observation.id} />
        <label className="block text-xs font-medium text-gray-700">
          Approve or rename the category
          <input
            name="categoryName"
            maxLength={80}
            defaultValue={observation.proposedCategoryName}
            className="mt-1 block h-9 w-full rounded-md border border-gray-300 bg-white px-2 text-sm font-normal"
          />
        </label>
        <label className="block text-xs font-medium text-gray-700">
          Or use an existing category
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
            className="rounded-md bg-red-700 px-3 py-2 text-xs font-semibold text-white"
          >
            Approve category
          </button>
          <button
            name="intent"
            value="replace-category"
            className="rounded-md border border-gray-300 bg-white px-3 py-2 text-xs font-semibold text-gray-800"
          >
            Use existing category
          </button>
        </div>
      </Form>
    </section>
  );
}

function ReviewActions({
  observationId,
  improvement,
  categoryPending,
}: {
  observationId: string;
  improvement: boolean;
  categoryPending: boolean;
}) {
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";
  const [rejectOpen, setRejectOpen] = useState(false);
  return (
    <div className="mt-5 flex flex-wrap gap-2 border-t border-gray-100 pt-4">
      <Form method="post">
        <input type="hidden" name="observationId" value={observationId} />
        <Button
          type="submit"
          name="intent"
          value={improvement ? "approve-revision" : "approve-new"}
          disabled={busy || categoryPending}
        >
          Approve
        </Button>
      </Form>
      <AlertDialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <AlertDialogTrigger asChild>
          <Button type="button" variant="secondary" disabled={busy}>
            Reject
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reject contribution</AlertDialogTitle>
            <AlertDialogDescription>
              The student can edit and submit it for review again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Form method="post">
            <input type="hidden" name="observationId" value={observationId} />
            <label className="mb-4 block text-sm font-medium text-gray-800">
              Reason (optional)
              <textarea
                name="feedback"
                maxLength={HANDBOOK_REVIEW_FEEDBACK_MAX_LENGTH}
                rows={3}
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2"
              />
            </label>
            <AlertDialogFooter>
              <AlertDialogCancel asChild>
                <Button type="button" variant="secondary">
                  Cancel
                </Button>
              </AlertDialogCancel>
              <Button
                type="submit"
                variant="danger"
                name="intent"
                value={improvement ? "reject-revision" : "reject-new"}
                disabled={busy}
              >
                Reject
              </Button>
            </AlertDialogFooter>
          </Form>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default function HandbookReviewPage() {
  const { observations, categories } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const newArticles = observations.filter(
    (item) => item.article?.status === "DRAFT" && !item.publishedVersionId
  );
  const improvements = observations.filter((item) =>
    Boolean(item.publishedVersionId && item.article)
  );
  return (
    <main className="mx-auto max-w-5xl px-4 py-6 sm:px-6 lg:px-8">
      <header className="mb-6">
        <Link
          to="/handbook"
          className="text-sm font-semibold text-red-800 hover:underline"
        >
          ← Handbook
        </Link>
        <h1 className="mt-2 text-3xl font-semibold text-gray-950">
          Review contributions
        </h1>
        <p className="mt-2 text-sm text-gray-600">
          Pending student contributions: {observations.length}
        </p>
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
      <section className="mb-8">
        <h2 className="mb-3 text-lg font-semibold text-gray-950">
          New article submissions
        </h2>
        {newArticles.length ? (
          <ul className="space-y-3">
            {newArticles.map((item) => {
              const article = item.article!;
              return (
                <li key={item.id}>
                  <details className="rounded-xl border border-gray-200 bg-white shadow-sm">
                    <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-3 p-4">
                      <div>
                        <h3 className="font-semibold text-gray-950">
                          {article.draftTitle}
                        </h3>
                        <p className="mt-1 text-xs text-gray-500">
                          {item.contributorName || "Student"} ·{" "}
                          {item.handbookCategory?.name ?? "Category pending"} ·
                          Submitted{" "}
                          {new Date(item.createdAt).toLocaleDateString()}
                        </p>
                      </div>
                      <span className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-semibold text-gray-800">
                        Review
                      </span>
                    </summary>
                    <div className="border-t border-gray-100 p-4">
                      <p className="text-xs font-bold uppercase tracking-wide text-gray-500">
                        Student: {item.contributorName || "IOIO student"}
                      </p>
                      <p className="mt-2 text-sm text-gray-700">
                        Category:{" "}
                        {item.handbookCategory?.name ?? "Not assigned"}
                      </p>
                      <h4 className="mt-4 text-lg font-semibold text-gray-950">
                        {article.draftTitle}
                      </h4>
                      <div className="prose mt-3 max-w-none">
                        <MarkdownViewer
                          content={article.draftContent}
                          allowExternalLinks
                        />
                      </div>
                      <ArticleReferences urls={article.draftSourceUrls} />
                      <HandbookFileList files={article.draftAttachments} />
                      <CategoryResolution
                        observation={item}
                        categories={categories}
                      />
                      <ReviewActions
                        observationId={item.id}
                        improvement={false}
                        categoryPending={Boolean(item.proposedCategoryName)}
                      />
                    </div>
                  </details>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="rounded-xl border border-gray-200 bg-white px-4 py-6 text-sm text-gray-600">
            No new article submissions are waiting for review.
          </p>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold text-gray-950">
          Article improvements
        </h2>
        {improvements.length ? (
          <ul className="space-y-3">
            {improvements.map((item) => {
              const article = item.article!;
              const current = article.publishedVersion;
              const currentFiles: HandbookFileAttachment[] =
                current?.sources.flatMap(({ source }) =>
                  source.kind === "UPLOADED_DOCUMENT" &&
                  source.storageObjectPath
                    ? [
                        {
                          id: source.id,
                          title: source.title,
                          fileName: handbookAttachmentFilenameFromPath(
                            source.storageObjectPath
                          ),
                          fileSizeBytes: source.fileSizeBytes ?? 0,
                        },
                      ]
                    : []
                ) ?? [];
              const differences = current
                ? compareHandbookVersions(current.content, article.draftContent)
                : [];
              return (
                <li key={item.id}>
                  <details className="rounded-xl border border-gray-200 bg-white shadow-sm">
                    <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-3 p-4">
                      <div>
                        <h3 className="font-semibold text-gray-950">
                          {article.draftTitle}
                        </h3>
                        <p className="mt-1 text-xs text-gray-500">
                          {item.contributorName || "Student"} ·{" "}
                          {article.publishedVersion?.title ??
                            "Published article"}{" "}
                          · Submitted{" "}
                          {new Date(item.createdAt).toLocaleDateString()}
                        </p>
                      </div>
                      <span className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-semibold text-gray-800">
                        Review
                      </span>
                    </summary>
                    <div className="border-t border-gray-100 p-4">
                      <p className="text-xs font-bold uppercase tracking-wide text-gray-500">
                        Student: {item.contributorName || "IOIO student"}
                      </p>
                      <p className="mt-2 text-sm text-gray-700">
                        Category:{" "}
                        {item.handbookCategory?.name ?? "Not assigned"}
                      </p>
                      {current ? (
                        <>
                          <div className="mt-4 grid gap-4 lg:grid-cols-2">
                            <section className="rounded-lg border border-gray-200 p-3">
                              <h4 className="font-semibold text-gray-900">
                                Current published version · v
                                {current.versionNumber}
                              </h4>
                              <p className="mt-1 text-sm font-medium text-gray-800">
                                {current.title}
                              </p>
                              <div className="prose mt-3 max-w-none text-sm">
                                <MarkdownViewer
                                  content={current.content}
                                  allowExternalLinks
                                />
                              </div>
                              <ArticleReferences
                                urls={current.sources
                                  .map(({ source }) => source.url)
                                  .filter((url): url is string => Boolean(url))}
                              />
                              {current ? (
                                <HandbookFileList
                                  files={currentFiles}
                                  versionId={current.id}
                                  title="Current version files"
                                />
                              ) : null}
                            </section>
                            <section className="rounded-lg border border-blue-200 bg-blue-50/40 p-3">
                              <h4 className="font-semibold text-gray-900">
                                Proposed version
                              </h4>
                              <p className="mt-1 text-sm font-medium text-gray-800">
                                {article.draftTitle}
                              </p>
                              <div className="prose mt-3 max-w-none text-sm">
                                <MarkdownViewer
                                  content={article.draftContent}
                                  allowExternalLinks
                                />
                              </div>
                              <ArticleReferences
                                urls={article.draftSourceUrls}
                              />
                              <HandbookFileList
                                files={article.draftAttachments}
                                title="Proposed files"
                              />
                            </section>
                          </div>
                          <section className="mt-4 rounded-lg border border-gray-200 p-3">
                            <h4 className="font-semibold text-gray-900">
                              Section comparison
                            </h4>
                            <ul className="mt-2 divide-y divide-gray-100">
                              {differences.map((difference) => (
                                <li key={difference.key} className="py-3">
                                  <p className="text-sm font-semibold text-gray-900">
                                    {difference.path} · {difference.status}
                                  </p>
                                  {difference.beforeContent ? (
                                    <div className="mt-2 rounded bg-red-50 p-2">
                                      <p className="mb-1 text-xs font-bold uppercase text-red-800">
                                        Current
                                      </p>
                                      <MarkdownViewer
                                        content={difference.beforeContent}
                                        allowExternalLinks
                                      />
                                    </div>
                                  ) : null}
                                  {difference.afterContent ? (
                                    <div className="mt-2 rounded bg-green-50 p-2">
                                      <p className="mb-1 text-xs font-bold uppercase text-green-800">
                                        Proposed
                                      </p>
                                      <MarkdownViewer
                                        content={difference.afterContent}
                                        allowExternalLinks
                                      />
                                    </div>
                                  ) : null}
                                </li>
                              ))}
                            </ul>
                          </section>
                        </>
                      ) : (
                        <p className="mt-4 text-sm text-red-800">
                          The published version linked to this proposal is no
                          longer available. Reopen the article before reviewing.
                        </p>
                      )}
                      <CategoryResolution
                        observation={item}
                        categories={categories}
                      />
                      <ReviewActions
                        observationId={item.id}
                        improvement
                        categoryPending={
                          Boolean(item.proposedCategoryName) || !current
                        }
                      />
                    </div>
                  </details>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="rounded-xl border border-gray-200 bg-white px-4 py-6 text-sm text-gray-600">
            No article improvements are waiting for review.
          </p>
        )}
      </section>
    </main>
  );
}

export const ErrorBoundary = () => <ErrorContent />;
