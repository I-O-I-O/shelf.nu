import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { data, Link, useLoaderData } from "react-router";
import { ErrorContent } from "~/components/errors";
import { MarkdownViewer } from "~/components/markdown/markdown-viewer";
import { getPublishedHandbookArticle } from "~/modules/ioio-handbook/service.server";
import { requireStudentRead } from "~/modules/ioio-student/route.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { makeShelfError, ShelfError } from "~/utils/error";
import { error, payload } from "~/utils/http.server";

export async function loader({ context, request, params }: LoaderFunctionArgs) {
  const { userId } = context.getSession();
  try {
    const auth = await requireStudentRead({ context, request });
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
      canEdit: auth.role === "ADMIN" || auth.role === "OWNER",
      isStudent: auth.role === "SELF_SERVICE",
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
  const related = [...version.assetModels, ...version.kits];
  return (
    <main className="mx-auto max-w-5xl px-4 py-6 sm:px-6 lg:px-8">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <Link
          to="/handbook"
          className="text-sm font-semibold text-red-800 hover:underline"
        >
          ← Handbook
        </Link>
        <div className="flex gap-2">
          <Link
            to="/handbook/contribute"
            className="inline-flex h-9 items-center rounded-lg border border-gray-300 bg-white px-3 text-sm font-semibold text-gray-800 hover:bg-gray-50"
          >
            Contribute knowledge
          </Link>
          {canEdit ? (
            <Link
              to={`/handbook/${article.slug}/edit`}
              className="inline-flex h-9 items-center rounded-lg bg-red-700 px-3 text-sm font-semibold text-white hover:bg-red-800"
            >
              Edit draft
            </Link>
          ) : null}
        </div>
      </div>

      {viewingHistorical ? (
        <div
          role="status"
          className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950"
        >
          You are viewing a previous published version. Current Shelf facts may
          have changed since this was written.
        </div>
      ) : null}
      <article className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm sm:p-8">
        <header className="border-b border-gray-100 pb-5">
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-red-700">
            {version.section}
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-gray-950">
            {version.title}
          </h1>
          {version.summary ? (
            <p className="mt-3 max-w-3xl text-base leading-7 text-gray-600">
              {version.summary}
            </p>
          ) : null}
          <p className="mt-4 text-xs text-gray-500">
            Version {version.versionNumber} · Published{" "}
            {new Date(version.publishedAt).toLocaleDateString()} by{" "}
            {version.publishedByName ?? "IOIO Staff"}
          </p>
        </header>

        {related.length ? (
          <section className="my-5 rounded-xl bg-gray-50 p-4">
            <h2 className="text-sm font-semibold text-gray-900">
              Related Shelf equipment
            </h2>
            <ul className="mt-3 grid gap-3 sm:grid-cols-2">
              {related.map((item) => (
                <li
                  key={item.id}
                  className="flex min-w-0 items-center gap-3 rounded-lg border border-gray-200 bg-white p-2.5"
                >
                  {item.imageUrl ? (
                    <img
                      src={item.imageUrl}
                      alt=""
                      className="size-14 shrink-0 rounded-md object-cover"
                    />
                  ) : (
                    <div
                      aria-hidden="true"
                      className="size-14 shrink-0 rounded-md bg-gray-100"
                    />
                  )}
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-gray-900">
                      {item.name}
                    </p>
                    <Link
                      to={
                        item.kind === "kit"
                          ? isStudent
                            ? "/ioio/kits"
                            : "/kits"
                          : isStudent
                          ? "/ioio"
                          : "/assets"
                      }
                      className="text-xs font-medium text-red-800 hover:underline"
                    >
                      View in Shelf
                    </Link>
                  </div>
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

        {version.sources.length ? (
          <section className="border-t border-gray-100 pt-5">
            <h2 className="text-sm font-semibold text-gray-900">References</h2>
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
    </main>
  );
}

export const ErrorBoundary = () => <ErrorContent />;
