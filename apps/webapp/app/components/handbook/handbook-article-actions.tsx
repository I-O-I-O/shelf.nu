import type { ReactNode } from "react";
import { Form, Link } from "react-router";
import { HandbookRemovalButton } from "./handbook-removal-button";

export function HandbookArticleActions({
  articleId,
  slug,
  articleTitle,
  staffOnly = false,
  returnTo = "/handbook",
  children,
  menuLabel = "Article actions",
}: {
  articleId: string;
  slug: string;
  articleTitle: string;
  staffOnly?: boolean;
  returnTo?: string;
  children?: ReactNode;
  menuLabel?: string;
}) {
  return (
    <details className="relative">
      <summary
        aria-label={menuLabel}
        className="flex size-9 cursor-pointer list-none items-center justify-center rounded text-gray-600 hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-gray-500"
      >
        ⋯
      </summary>
      <div className="absolute right-0 z-30 mt-1 flex w-48 flex-col rounded border border-gray-200 bg-white p-1 shadow-sm">
        <Link
          to={`/handbook/${encodeURIComponent(slug)}/edit?improve=1`}
          className="rounded p-2 text-sm text-gray-700 hover:bg-gray-50"
        >
          Edit article
        </Link>
        <Form method="post" action="/handbook/manage">
          <input type="hidden" name="intent" value="set-visibility" />
          <input type="hidden" name="articleId" value={articleId} />
          <input
            type="hidden"
            name="staffOnly"
            value={staffOnly ? "false" : "true"}
          />
          <input type="hidden" name="returnTo" value={returnTo} />
          <button
            type="submit"
            className="w-full rounded p-2 text-left text-sm text-gray-700 hover:bg-gray-50"
          >
            {staffOnly ? "Make visible to everyone" : "Make staff only"}
          </button>
        </Form>
        <HandbookRemovalButton intent="archive-article" articleId={articleId} />
        <div className="mt-1 border-t border-gray-200 pt-1">
          <HandbookRemovalButton
            intent="delete-permanently"
            articleId={articleId}
            articleTitle={articleTitle}
          />
        </div>
        {children}
      </div>
    </details>
  );
}
