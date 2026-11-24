import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { data, Link, useLoaderData, useLocation } from "react-router";
import { ErrorContent } from "~/components/errors";
import { HandbookArticleActions } from "~/components/handbook/handbook-article-actions";
import {
  HandbookFileList,
  type HandbookFileAttachment,
} from "~/components/handbook/handbook-file-list";
import { ChevronRight } from "~/components/icons/library";
import { MarkdownViewer } from "~/components/markdown/markdown-viewer";
import { requireIoioHandbookRead } from "~/modules/ioio-handbook/access.server";
import { handbookAttachmentFilenameFromPath } from "~/modules/ioio-handbook/attachment.shared";
import {
  assignHandbookHeadingIds,
  compareHandbookVersions,
  getHandbookDocument,
  getHandbookOutline,
} from "~/modules/ioio-handbook/document";
import {
  getPublishedHandbookArticle,
  listRelatedHandbookArticles,
} from "~/modules/ioio-handbook/service.server";
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
    const compareVersionId =
      new URL(request.url).searchParams.get("compare") ?? undefined;
    const article = await getPublishedHandbookArticle({
      organizationId: auth.organizationId,
      slug,
      versionId,
      compareVersionId,
      canReadStaffOnly: auth.canEdit,
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
    const related = article.handbookCategory
      ? await listRelatedHandbookArticles({
          organizationId: auth.organizationId,
          handbookCategoryId: article.handbookCategory.id,
          articleId: article.id,
          canReadStaffOnly: auth.canEdit,
        })
      : { articles: [], hasMore: false };
    return payload({
      article,
      related,
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
  const {
    article,
    canEdit,
    isStudent,
    related = { articles: [], hasMore: false },
  } = useLoaderData<typeof loader>();
  const location = useLocation();
  const version = article.publishedVersion;
  const referenceSources = version.sources.filter(({ source }) => source.url);
  const fileAttachments: HandbookFileAttachment[] = version.sources.flatMap(
    ({ source }) =>
      source.kind === "UPLOADED_DOCUMENT" && source.storageObjectPath
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
  );
  const currentVersion = article.versions[0]?.id;
  const viewingHistorical = currentVersion !== version.id;
  const document = useMemo(
    () => getHandbookDocument(version.content),
    [version.content]
  );
  const headingOutline = useMemo(
    () => getHandbookOutline(version.content),
    [version.content]
  );
  const outline = useMemo(
    () => [
      ...(document.introduction &&
      (document.sections.length > 0 || referenceSources.length > 0)
        ? [
            {
              level: 2 as const,
              title: "Introduction",
              id: document.introductionId ?? "introduction",
            },
          ]
        : []),
      ...headingOutline,
      ...(referenceSources.length &&
      !headingOutline.some((item) => /^references?$/iu.test(item.title.trim()))
        ? [
            {
              level: 2 as const,
              title: "References",
              id: (() => {
                const usedIds = new Set([
                  ...(document.introductionId ? [document.introductionId] : []),
                  ...headingOutline.map((item) => item.id),
                ]);
                let id = "references";
                let suffix = 2;
                while (usedIds.has(id)) id = `references-${suffix++}`;
                return id;
              })(),
            },
          ]
        : []),
    ],
    [document, headingOutline, referenceSources.length]
  );
  const contentRef = useRef<HTMLDivElement | null>(null);
  const showOutline = outline.length > 1;
  const showNavigation = showOutline || related.articles.length > 0;
  const [activeOutlineId, setActiveOutlineId] = useState(outline[0]?.id ?? "");
  const differences = useMemo(
    () =>
      article.comparisonVersion
        ? compareHandbookVersions(
            article.comparisonVersion.content,
            version.content
          )
        : [],
    [article.comparisonVersion, version.content]
  );

  useEffect(() => {
    setActiveOutlineId(outline[0]?.id ?? "");
    if (!contentRef.current || !outline.length) return;
    const targets = outline
      .map((item) => window.document.getElementById(item.id))
      .filter((target): target is HTMLElement => Boolean(target));
    const Observer = window.IntersectionObserver;
    if (typeof Observer !== "function") return;
    const observer = new Observer(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort(
            (left, right) =>
              left.boundingClientRect.top - right.boundingClientRect.top
          );
        const active = visible[0]?.target;
        if (active instanceof HTMLElement) setActiveOutlineId(active.id);
      },
      { rootMargin: "-96px 0px -68% 0px", threshold: 0 }
    );
    targets.forEach((target) => observer.observe(target));
    return () => observer.disconnect();
  }, [outline]);

  useEffect(() => {
    if (contentRef.current) {
      assignHandbookHeadingIds(contentRef.current, headingOutline);
    }
    if (!location.hash) return;
    const id = decodeURIComponent(location.hash.slice(1));
    const target = window.document.getElementById(id);
    if (!target) return;
    setActiveOutlineId(id);
    window.requestAnimationFrame(() => {
      if (typeof target.scrollIntoView === "function") {
        target.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  }, [headingOutline, location.hash]);

  function goToOutlineItem(event: MouseEvent<HTMLAnchorElement>, id: string) {
    event.preventDefault();
    const target = window.document.getElementById(id);
    if (!target) return;
    setActiveOutlineId(id);
    window.history.pushState(
      null,
      "",
      `${window.location.pathname}${window.location.search}#${id}`
    );
    window.requestAnimationFrame(() => {
      if (typeof target.scrollIntoView === "function") {
        target.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  }

  return (
    <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <Link
          to="/handbook"
          className="text-sm font-semibold text-red-800 hover:underline"
        >
          ← Handbook
        </Link>
        <div className="flex items-center gap-2">
          {isStudent ? (
            <Link
              to={`/handbook/${encodeURIComponent(
                article.slug
              )}/edit?improve=1`}
              className="inline-flex h-9 items-center rounded-lg bg-red-700 px-3 text-sm font-semibold text-white hover:bg-red-800"
            >
              Edit article
            </Link>
          ) : null}
          {canEdit ? (
            <HandbookArticleActions
              articleId={article.id}
              slug={article.slug}
              articleTitle={article.publishedVersion.title}
              staffOnly={article.staffOnly}
              returnTo={`/handbook/${encodeURIComponent(article.slug)}`}
            />
          ) : null}
        </div>
      </div>

      {canEdit && article.staffOnly ? (
        <p className="mb-4 inline-flex rounded-full border border-amber-300 bg-amber-50 px-3 py-1 text-xs font-bold uppercase tracking-wide text-amber-900">
          Staff only
        </p>
      ) : null}

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
            showNavigation ? "" : "lg:col-span-2"
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

          <div ref={contentRef} className="handbook-document space-y-8 py-6">
            {document.introduction ? (
              <section className="scroll-mt-28">
                {outline.some((item) => item.title === "Introduction") ? (
                  <h2
                    id={
                      outline.find((item) => item.title === "Introduction")?.id
                    }
                    className="mb-3 scroll-mt-28 text-2xl font-semibold tracking-tight text-gray-950"
                  >
                    Introduction
                  </h2>
                ) : null}
                <MarkdownViewer
                  content={document.introduction}
                  className="prose max-w-none"
                  allowExternalLinks
                />
              </section>
            ) : null}
            {document.sections.map((section) => {
              const includesReferences = /^references?$/iu.test(
                section.title.trim()
              );
              return (
                <section
                  key={section.id}
                  className="scroll-mt-28 border-t border-gray-200 pt-6"
                >
                  <h2
                    id={section.id}
                    className="mb-3 scroll-mt-28 text-2xl font-semibold tracking-tight text-gray-950"
                  >
                    {section.title}
                  </h2>
                  {section.content ? (
                    <MarkdownViewer
                      content={section.content}
                      className="prose max-w-none"
                      allowExternalLinks
                    />
                  ) : null}
                  {section.subsections.map((subsection) => (
                    <section
                      key={subsection.id}
                      className="mt-6 border-l-2 border-gray-200 pl-4 sm:pl-5"
                    >
                      <h3
                        id={subsection.id}
                        className="mb-2 scroll-mt-28 text-lg font-semibold text-gray-900"
                      >
                        {subsection.title}
                      </h3>
                      {subsection.content ? (
                        <MarkdownViewer
                          content={subsection.content}
                          className="prose max-w-none"
                          allowExternalLinks
                        />
                      ) : null}
                    </section>
                  ))}
                  {includesReferences && referenceSources.length ? (
                    <HandbookSourceList sources={referenceSources} />
                  ) : null}
                </section>
              );
            })}
            {referenceSources.length &&
            !headingOutline.some((item) =>
              /^references?$/iu.test(item.title.trim())
            ) ? (
              <section className="scroll-mt-28 border-t border-gray-200 pt-6">
                <h2
                  id={outline.find((item) => item.title === "References")?.id}
                  className="mb-3 scroll-mt-28 text-2xl font-semibold tracking-tight text-gray-950"
                >
                  References
                </h2>
                <HandbookSourceList sources={referenceSources} />
              </section>
            ) : null}
            <HandbookFileList files={fileAttachments} versionId={version.id} />
          </div>

          {article.versions.length > 0 ? (
            <details className="mt-5 border-t border-gray-100 pt-4">
              <summary className="cursor-pointer text-sm font-semibold text-gray-700">
                Version history
              </summary>
              <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-gray-500">
                Current version: v{article.versions[0]?.versionNumber}
              </p>
              <ul className="mt-2 space-y-3">
                {article.versions.map((item, index) => {
                  const older = article.versions[index + 1];
                  const isCurrent = item.id === currentVersion;
                  return (
                    <li
                      key={item.id}
                      className="rounded-lg border border-gray-200 p-3"
                    >
                      <p className="text-sm font-semibold text-gray-900">
                        v{item.versionNumber}
                        {isCurrent ? " — Current" : ""}
                        {index === article.versions.length - 1
                          ? " — Original version"
                          : ""}
                      </p>
                      <p className="mt-1 text-sm text-gray-800">{item.title}</p>
                      <p className="mt-1 text-xs text-gray-600">
                        {new Date(item.publishedAt).toLocaleDateString()} ·{" "}
                        {item.publishedBy ?? "IOIO Staff"}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-3 text-sm">
                        {!isCurrent ? (
                          <Link
                            to={`/handbook/${article.slug}?version=${item.id}`}
                            className="font-semibold text-red-800 hover:underline"
                          >
                            View
                          </Link>
                        ) : null}
                        {older ? (
                          <Link
                            to={`/handbook/${article.slug}?version=${item.id}&compare=${older.id}`}
                            className="font-semibold text-red-800 hover:underline"
                          >
                            Compare with v{older.versionNumber}
                          </Link>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </details>
          ) : null}

          {article.comparisonVersion ? (
            <HandbookVersionComparison
              fromVersion={article.comparisonVersion.versionNumber}
              toVersion={version.versionNumber}
              differences={differences}
            />
          ) : null}
        </article>
        {showNavigation ? (
          <aside
            aria-label="Article navigation"
            className="order-first h-fit space-y-5 border-l border-gray-200 pl-4 lg:sticky lg:top-24 lg:order-none lg:max-h-[calc(100vh-7rem)] lg:overflow-auto"
          >
            {showOutline ? (
              <HandbookNavigationPanel
                title="Contents"
                preferenceKey="handbook.contents.collapsed"
              >
                <HandbookContents
                  outline={outline}
                  onNavigate={goToOutlineItem}
                  activeId={activeOutlineId}
                />
              </HandbookNavigationPanel>
            ) : null}
            {related.articles.length && article.handbookCategory ? (
              <div
                className={
                  showOutline ? "border-t border-gray-200 pt-5" : undefined
                }
              >
                <HandbookNavigationPanel
                  title={`Related in ${article.handbookCategory.name}`}
                  preferenceKey="handbook.related.collapsed"
                >
                  <nav aria-label="Related articles">
                    <ul className="space-y-1.5">
                      {related.articles.map((item) => (
                        <li key={item.id}>
                          <Link
                            to={`/handbook/${encodeURIComponent(item.slug)}`}
                            className="block rounded px-2 py-1 text-sm text-gray-700 hover:text-red-800 hover:underline"
                          >
                            {item.title}
                          </Link>
                        </li>
                      ))}
                    </ul>
                    {related.hasMore ? (
                      <Link
                        to={`/handbook?handbookCategoryId=${encodeURIComponent(
                          article.handbookCategory.id
                        )}`}
                        className="mt-3 block px-2 text-sm font-semibold text-red-800 hover:underline"
                      >
                        View all in {article.handbookCategory.name}
                      </Link>
                    ) : null}
                  </nav>
                </HandbookNavigationPanel>
              </div>
            ) : null}
          </aside>
        ) : null}
      </div>
    </main>
  );
}

function HandbookNavigationPanel({
  title,
  preferenceKey,
  children,
}: {
  title: string;
  preferenceKey: string;
  children: ReactNode;
}) {
  const id = useId();
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = window.localStorage.getItem(preferenceKey);
    } catch {
      /* Storage may be disabled. */
    }
    setCollapsed(
      saved === "true" ||
        (saved !== "false" && window.matchMedia("(max-width: 1023px)").matches)
    );
  }, [preferenceKey]);
  function toggle() {
    const next = !collapsed;
    setCollapsed(next);
    try {
      window.localStorage.setItem(preferenceKey, String(next));
    } catch {
      /* Keep navigation usable without storage. */
    }
  }
  return (
    <section>
      <h2>
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-controls={id}
          onClick={toggle}
          className="flex w-full items-center gap-2 rounded text-left text-xs font-bold uppercase tracking-[0.12em] text-gray-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-red-700"
        >
          <ChevronRight
            aria-hidden="true"
            className={`shrink-0 transition-transform ${
              collapsed ? "" : "rotate-90"
            }`}
          />
          {title}
        </button>
      </h2>
      <div id={id} hidden={collapsed} className="mt-3">
        {children}
      </div>
    </section>
  );
}

function HandbookContents({
  outline,
  className = "",
  onNavigate,
  activeId,
}: {
  outline: ReturnType<typeof getHandbookOutline>;
  className?: string;
  onNavigate: (event: MouseEvent<HTMLAnchorElement>, id: string) => void;
  activeId: string;
}) {
  return (
    <nav aria-label="Article contents" className={className}>
      <ol className="space-y-1.5">
        {outline.map((item) => (
          <li key={item.id} className={item.level === 3 ? "pl-3" : undefined}>
            <a
              href={`#${item.id}`}
              onClick={(event) => onNavigate(event, item.id)}
              aria-current={item.id === activeId ? "location" : undefined}
              className={`block rounded px-2 py-1 text-sm hover:text-red-800 hover:underline ${
                item.id === activeId
                  ? "border-l-2 border-red-700 bg-red-50 font-semibold text-red-900"
                  : "text-gray-700"
              }`}
            >
              {item.title}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

function HandbookSourceList({
  sources,
}: {
  sources: Array<{
    source: { id: string; title: string; url: string | null };
  }>;
}) {
  return (
    <ul className="mt-4 list-disc space-y-1 pl-6 text-sm">
      {sources.map(({ source }) => (
        <li key={source.id}>
          {source.url ? (
            <a
              href={source.url}
              target="_blank"
              rel="noreferrer"
              className="text-red-800 underline underline-offset-2"
            >
              {source.title}
            </a>
          ) : (
            source.title
          )}
        </li>
      ))}
    </ul>
  );
}

function HandbookVersionComparison({
  fromVersion,
  toVersion,
  differences,
}: {
  fromVersion: number;
  toVersion: number;
  differences: ReturnType<typeof compareHandbookVersions>;
}) {
  return (
    <section className="mt-5 rounded-xl border border-blue-200 bg-blue-50/50 p-4">
      <h2 className="text-sm font-bold text-gray-900">
        v{fromVersion} → v{toVersion} comparison
      </h2>
      {differences.length ? (
        <ul className="mt-3 divide-y divide-blue-100">
          {differences.map((difference) => (
            <li key={difference.key} className="py-2 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span
                  className={
                    difference.level === 3
                      ? "pl-4 text-sm"
                      : "text-sm font-semibold"
                  }
                >
                  {difference.path}
                </span>
                <span className="text-xs font-semibold text-gray-600">
                  {difference.status}
                </span>
              </div>
              {difference.status !== "Unchanged" ? (
                <details className="mt-1">
                  <summary className="cursor-pointer text-xs font-medium text-red-800 hover:underline">
                    Show text change
                  </summary>
                  <div className="mt-2 grid gap-3 md:grid-cols-2">
                    {difference.status !== "Added" ? (
                      <div className="rounded-lg border border-red-200 bg-red-50 p-3">
                        <p className="mb-2 text-xs font-bold uppercase text-red-900">
                          Before
                        </p>
                        {difference.beforeContent ? (
                          <MarkdownViewer
                            content={difference.beforeContent}
                            className="prose prose-sm max-w-none"
                            allowExternalLinks
                          />
                        ) : (
                          <p className="text-sm text-gray-500">Empty</p>
                        )}
                      </div>
                    ) : null}
                    {difference.status !== "Removed" ? (
                      <div className="rounded-lg border border-green-200 bg-green-50 p-3">
                        <p className="mb-2 text-xs font-bold uppercase text-green-900">
                          After
                        </p>
                        {difference.afterContent ? (
                          <MarkdownViewer
                            content={difference.afterContent}
                            className="prose prose-sm max-w-none"
                            allowExternalLinks
                          />
                        ) : (
                          <p className="text-sm text-gray-500">Empty</p>
                        )}
                      </div>
                    ) : null}
                  </div>
                </details>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-gray-600">
          No section-level changes were found.
        </p>
      )}
    </section>
  );
}

export const ErrorBoundary = () => <ErrorContent />;
