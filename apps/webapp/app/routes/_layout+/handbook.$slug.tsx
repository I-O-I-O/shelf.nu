import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { data, Form, Link, redirect, useLoaderData } from "react-router";
import { ErrorContent } from "~/components/errors";
import { MarkdownViewer } from "~/components/markdown/markdown-viewer";
import { requireIoioHandbookRead } from "~/modules/ioio-handbook/access.server";
import {
  archiveHandbookArticle,
  getHandbookArticleDetail,
  HandbookWorkflowError,
} from "~/modules/ioio-handbook/workflow.server";
import { requireIoioStaffAccess } from "~/modules/ioio-staff/access.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { makeShelfError, ShelfError } from "~/utils/error";
import { error, payload } from "~/utils/http.server";

export async function loader({ context, request, params }: LoaderFunctionArgs) {
  const { userId } = context.getSession();
  try {
    const auth = await requireIoioHandbookRead({ context, request });
    const versionId =
      new URL(request.url).searchParams.get("version") ?? undefined;
    const article = await getHandbookArticleDetail({
      organizationId: auth.organizationId,
      slug: params.slug ?? "",
      versionId,
    });
    if (!article)
      throw new ShelfError({
        cause: null,
        message: "This Handbook page is not available.",
        label: "Handbook",
        status: 404,
        shouldBeCaptured: false,
      });
    return payload({
      article,
      canEdit: auth.canEdit,
      isStudent: auth.isStudent,
    });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    throw data(error(reason), { status: reason.status });
  }
}

export async function action({ context, request, params }: ActionFunctionArgs) {
  const auth = await requireIoioStaffAccess({ context, request });
  const form = await request.formData();
  if (form.get("intent") !== "archive")
    return data(
      { ok: false as const, message: "Choose a valid Handbook action." },
      { status: 400 }
    );
  try {
    const article = await getHandbookArticleDetail({
      organizationId: auth.organizationId,
      slug: params.slug ?? "",
    });
    if (!article)
      throw new HandbookWorkflowError(
        "This Handbook page is not available.",
        404
      );
    await archiveHandbookArticle({
      organizationId: auth.organizationId,
      articleId: article.id,
      userId: auth.userId,
    });
    return redirect("/handbook");
  } catch (cause) {
    if (cause instanceof HandbookWorkflowError)
      return data(
        { ok: false as const, message: cause.message },
        { status: cause.status }
      );
    const reason = makeShelfError(cause, { userId: auth.userId });
    throw data(error(reason), { status: reason.status });
  }
}

export const meta: MetaFunction<typeof loader> = ({ data: loaded }) => [
  {
    title: appendToMetaTitle(loaded?.article.viewedVersion.title ?? "Handbook"),
  },
];
export const handle = {
  breadcrumb: ({
    match,
  }: {
    match: { data?: Awaited<ReturnType<typeof loader>> };
  }) => match.data?.article.viewedVersion.title ?? "Handbook page",
};

export default function HandbookArticlePage() {
  const { article, canEdit, isStudent } = useLoaderData<typeof loader>();
  const version = article.viewedVersion;
  const currentVersion = article.currentVersion;
  const related = [
    ...(version.assetModels ?? []).map((item: any) => ({
      kind: "asset-model",
      ...item.assetModel,
    })),
    ...(version.kits ?? []).map((item: any) => ({ kind: "kit", ...item.kit })),
  ];
  return (
    <main className="mx-auto max-w-5xl px-4 py-6 sm:px-6 lg:px-8">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <Link
          to="/handbook"
          className="text-sm font-semibold text-red-800 hover:underline"
        >
          ← Handbook
        </Link>
        <div className="flex flex-wrap gap-2">
          <Link
            to="/handbook/my-work"
            className="inline-flex h-9 items-center rounded-lg border border-gray-300 bg-white px-3 text-sm font-semibold text-gray-800 hover:bg-gray-50"
          >
            My work
          </Link>
          <Link
            to={`/handbook/${article.slug}/edit`}
            className="inline-flex h-9 items-center rounded-lg bg-red-700 px-3 text-sm font-semibold text-white hover:bg-red-800"
          >
            {isStudent ? "Propose a revision" : "Create revision"}
          </Link>
          {canEdit ? (
            <Form
              method="post"
              onSubmit={(event) => {
                if (
                  !confirm(
                    "Archive this article? Its current and previous versions will remain available to staff."
                  )
                )
                  event.preventDefault();
              }}
            >
              <button
                name="intent"
                value="archive"
                className="inline-flex h-9 items-center rounded-lg border border-gray-300 bg-white px-3 text-sm font-semibold text-gray-700 hover:bg-gray-50"
              >
                Archive
              </button>
            </Form>
          ) : null}
        </div>
      </div>

      {article.isHistorical ? (
        <div
          role="status"
          className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950"
        >
          <span>
            You are viewing an older version of this article. This content is
            marked Outdated.
          </span>
          <Link
            to={`/handbook/${article.slug}`}
            className="font-semibold underline"
          >
            View current version
          </Link>
        </div>
      ) : null}
      <article className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm sm:p-8">
        <header className="border-b border-gray-100 pb-5">
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-red-700">
            {version.category?.name ?? version.section} ·{" "}
            {version.topic?.name ?? "General"} · {version.articleType}
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-gray-950">
            {version.title}
          </h1>
          {version.summary ? (
            <p className="mt-3 max-w-3xl text-base leading-7 text-gray-600">
              {version.summary}
            </p>
          ) : null}
          <p className="mt-4 text-sm text-gray-600">
            {version.locationPath ? `Location: ${version.locationPath} · ` : ""}
            v{version.versionNumber} ·{" "}
            {article.isHistorical ? "Outdated · " : "Current · Updated "}
            {new Date(version.publishedAt).toLocaleDateString()}
            {version.authorName
              ? ` · Contributed by ${version.authorName}`
              : ""}
          </p>
        </header>

        {related.length ? (
          <section className="my-5 rounded-xl bg-gray-50 p-4">
            <h2 className="text-sm font-semibold text-gray-900">
              Related Shelf equipment
            </h2>
            <ul className="mt-2 grid gap-2 sm:grid-cols-2">
              {related.map((item: any) => (
                <li
                  key={`${item.kind}:${item.id}`}
                  className="rounded-lg border border-gray-200 bg-white p-3 text-sm font-medium text-gray-900"
                >
                  {item.name}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <div className="py-5">
          <MarkdownViewer
            content={version.content}
            className="prose max-w-none"
            allowExternalLinks
          />
        </div>

        {version.videoUrls?.length ? (
          <section className="border-t border-gray-100 pt-5">
            <h2 className="text-sm font-semibold text-gray-900">
              Video resources
            </h2>
            <ul className="mt-2 space-y-1">
              {version.videoUrls.map((url: string) => (
                <li key={url}>
                  <a
                    href={url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sm text-red-800 underline underline-offset-2"
                  >
                    {new URL(url).hostname}
                  </a>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {version.sources?.length ? (
          <section className="mt-5 border-t border-gray-100 pt-5">
            <h2 className="text-sm font-semibold text-gray-900">References</h2>
            <ul className="mt-2 space-y-1">
              {version.sources.map(({ source }: any) =>
                source.url ? (
                  <li key={source.id}>
                    <a
                      href={source.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-sm text-red-800 underline underline-offset-2"
                    >
                      {source.title}
                    </a>
                  </li>
                ) : null
              )}
            </ul>
          </section>
        ) : null}

        {article.history.length > 1 ? (
          <details
            className="mt-5 border-t border-gray-100 pt-4"
            open={article.isHistorical}
          >
            <summary className="cursor-pointer text-sm font-semibold text-gray-700">
              Version history
            </summary>
            <ul className="mt-3 space-y-2">
              {article.history.map((item: any) => (
                <li key={item.id}>
                  <Link
                    to={`/handbook/${article.slug}?version=${item.id}`}
                    className={`text-sm ${
                      item.id === version.id
                        ? "font-semibold text-gray-950"
                        : "text-red-800 hover:underline"
                    }`}
                  >
                    v{item.versionNumber} ·{" "}
                    {item.id === currentVersion.id ? "Current" : "Outdated"} ·{" "}
                    {item.title} ·{" "}
                    {new Date(item.publishedAt).toLocaleDateString()}
                  </Link>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </article>
    </main>
  );
}

export const ErrorBoundary = () => <ErrorContent />;
