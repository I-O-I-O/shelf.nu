import { useEffect, useMemo, useRef } from "react";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { data, Link, useLoaderData } from "react-router";
import { ErrorContent } from "~/components/errors";
import { MarkdownViewer } from "~/components/markdown/markdown-viewer";
import { requireIoioHandbookRead } from "~/modules/ioio-handbook/access.server";
import {
  assignHandbookHeadingIds,
  getHandbookOutline,
} from "~/modules/ioio-handbook/document";
import { getPublishedHandbookArticle } from "~/modules/ioio-handbook/service.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { makeShelfError, ShelfError } from "~/utils/error";
import { error, payload } from "~/utils/http.server";

export async function loader({ context, request, params }: LoaderFunctionArgs) {
  const { userId } = context.getSession();
  try {
    const auth = await requireIoioHandbookRead({ context, request });
    const slug = params.slug ?? "";
    const versionId =
      new URL(request.url).searchParams.get("version") ?? undefined;
    const article = await getPublishedHandbookArticle({
      organizationId: auth.organizationId,
      slug,
      versionId,
    });
    if (!article) {
      throw new ShelfError({
        cause: null,
        message: "This Handbook page is not available.",
        label: "Handbook",
        status: 404,
        shouldBeCaptured: false,
      });
    }
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

export const meta: MetaFunction<typeof loader> = ({ data: loaded }) => [
  {
    title: appendToMetaTitle(
      loaded?.article.publishedVersion.title ?? "Handbook"
    ),
  },
];
export const handle = {
  breadcrumb: ({
    match,
  }: {
    match: { data?: Awaited<ReturnType<typeof loader>> };
  }) => match.data?.article.publishedVersion.title ?? "Handbook page",
};

export default function HandbookArticlePage() {
  const { article, canEdit, isStudent } = useLoaderData<typeof loader>();
  const version = article.publishedVersion;
  const currentVersion = article.versions[0]?.id;
  const viewingHistorical = currentVersion !== version.id;
  const outline = useMemo(
    () => getHandbookOutline(version.content),
    [version.content]
  );
  const contentRef = useRef<HTMLDivElement | null>(null);
  const showOutline = outline.length >= 3;

  useEffect(() => {
    if (contentRef.current) {
      assignHandbookHeadingIds(contentRef.current, outline);
    }
  }, [outline]);

  return (
    <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <Link
          to="/handbook"
          className="text-sm font-semibold text-red-800 hover:underline"
        >
          ← Handbook
        </Link>
        {canEdit || isStudent ? (
          <Link
            to={`/handbook/${encodeURIComponent(article.slug)}/edit?improve=1`}
            className="inline-flex h-9 items-center rounded-lg bg-red-700 px-3 text-sm font-semibold text-white hover:bg-red-800"
          >
            Improve this article
          </Link>
        ) : null}
      </div>

      {viewingHistorical ? (
        <div
          role="status"
          className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950"
        >
          You are viewing a previous published version. Current Shelf facts may
          have changed since this was written.{" "}
          <Link
            to={`/handbook/${encodeURIComponent(article.slug)}`}
            className="font-semibold underline underline-offset-2"
          >
            View current version
          </Link>
        </div>
      ) : null}
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_16rem]">
        <article
          className={`rounded-2xl border border-gray-200 bg-white p-5 shadow-sm sm:p-8 ${
            showOutline ? "" : "lg:col-span-2"
          }`}
        >
          <header className="border-b border-gray-100 pb-5">
            {article.handbookCategory ? (
              <p className="text-xs font-bold uppercase tracking-[0.16em] text-red-700">
                {article.handbookCategory.name}
              </p>
            ) : null}
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-gray-950">
              {version.title}
            </h1>
            <p className="mt-4 text-xs text-gray-500">
              Version {version.versionNumber} · Published{" "}
              {new Date(version.publishedAt).toLocaleDateString()} by{" "}
              {version.publishedByName ?? "IOIO Staff"}
            </p>
          </header>

          {showOutline ? (
            <details className="my-4 rounded-lg border border-gray-200 bg-gray-50 p-3 lg:hidden">
              <summary className="cursor-pointer text-sm font-semibold text-gray-800">
                Contents
              </summary>
              <HandbookContents outline={outline} className="mt-3" />
            </details>
          ) : null}
          <div ref={contentRef} className="py-5">
            <MarkdownViewer
              content={version.content}
              className="handbook-document prose max-w-none"
              allowExternalLinks
            />
          </div>

          {version.sources.length ? (
            <section className="border-t border-gray-100 pt-5">
              <h2 className="text-sm font-semibold text-gray-900">
                References
              </h2>
              <ul className="mt-2 space-y-1">
                {version.sources.map(({ source }) => (
                  <li key={source.id}>
                    <a
                      href={source.url ?? undefined}
                      target="_blank"
                      rel="noreferrer"
                      className="text-sm text-red-800 underline underline-offset-2"
                    >
                      {source.title}
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {article.versions.length > 1 ? (
            <details className="mt-5 border-t border-gray-100 pt-4">
              <summary className="cursor-pointer text-sm font-semibold text-gray-700">
                Version history
              </summary>
              <ul className="mt-3 space-y-2">
                {article.versions.map((item) => (
                  <li key={item.id}>
                    <Link
                      to={`/handbook/${article.slug}?version=${item.id}`}
                      className={`text-sm ${
                        item.id === version.id
                          ? "font-semibold text-gray-950"
                          : "text-red-800 hover:underline"
                      }`}
                    >
                      Version {item.versionNumber} · {item.title} ·{" "}
                      {new Date(item.publishedAt).toLocaleDateString()}
                    </Link>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </article>
        {showOutline ? (
          <aside className="sticky top-6 hidden h-fit max-h-[calc(100vh-3rem)] overflow-auto rounded-xl border border-gray-200 bg-white p-4 shadow-sm lg:block">
            <h2 className="text-xs font-bold uppercase tracking-[0.12em] text-gray-500">
              Contents
            </h2>
            <HandbookContents outline={outline} className="mt-3" />
          </aside>
        ) : null}
      </div>
    </main>
  );
}

function HandbookContents({
  outline,
  className = "",
}: {
  outline: ReturnType<typeof getHandbookOutline>;
  className?: string;
}) {
  return (
    <nav aria-label="Article contents" className={className}>
      <ol className="space-y-1.5">
        {outline.map((item) => (
          <li key={item.id} className={item.level === 3 ? "pl-3" : undefined}>
            <a
              href={`#${item.id}`}
              className="block text-sm text-gray-700 hover:text-red-800 hover:underline"
            >
              {item.title}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

export const ErrorBoundary = () => <ErrorContent />;
