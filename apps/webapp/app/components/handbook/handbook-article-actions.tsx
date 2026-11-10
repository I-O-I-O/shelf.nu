import type { ReactElement, ReactNode } from "react";
import { Form, Link } from "react-router";
import { Button } from "~/components/shared/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/shared/dropdown";
import { HandbookRemovalButton } from "./handbook-removal-button";

export function HandbookArticleActions({
  articleId,
  slug,
  articleTitle,
  staffOnly = false,
  returnTo = "/handbook",
  children,
  menuLabel = "Article actions",
  portaled = false,
}: {
  articleId: string;
  slug: string;
  articleTitle: string;
  staffOnly?: boolean;
  returnTo?: string;
  children?: ReactNode;
  menuLabel?: string;
  portaled?: boolean;
}) {
  function item(child: ReactElement, keepOpen = false) {
    return portaled ? (
      <DropdownMenuItem
        asChild
        onSelect={keepOpen ? (event) => event.preventDefault() : undefined}
      >
        {child}
      </DropdownMenuItem>
    ) : (
      child
    );
  }
  const contents = (
    <>
      {item(
        <Link
          to={`/handbook/${encodeURIComponent(slug)}/edit?improve=1`}
          className="rounded p-2 text-sm text-gray-700 hover:bg-gray-50"
        >
          Edit article
        </Link>
      )}
      <Form method="post" action="/handbook/manage">
        <input type="hidden" name="intent" value="set-visibility" />
        <input type="hidden" name="articleId" value={articleId} />
        <input
          type="hidden"
          name="staffOnly"
          value={staffOnly ? "false" : "true"}
        />
        <input type="hidden" name="returnTo" value={returnTo} />
        {item(
          <button
            type="submit"
            className="w-full rounded p-2 text-left text-sm text-gray-700 hover:bg-gray-50"
          >
            {staffOnly ? "Make visible to everyone" : "Make staff only"}
          </button>,
          true
        )}
      </Form>
      <HandbookRemovalButton
        menuItem={portaled}
        intent="archive-article"
        articleId={articleId}
      />
      <div className="mt-1 border-t border-gray-200 pt-1">
        <HandbookRemovalButton
          menuItem={portaled}
          intent="delete-permanently"
          articleId={articleId}
          articleTitle={articleTitle}
        />
      </div>
      {children}
    </>
  );
  if (portaled) {
    return (
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="size-9 shrink-0 p-0"
            aria-label={menuLabel}
          >
            <span aria-hidden="true">⋯</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56 p-1">
          {contents}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }
  return (
    <details className="relative">
      <summary
        aria-label={menuLabel}
        className="flex size-9 cursor-pointer list-none items-center justify-center rounded text-gray-600 hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-gray-500"
      >
        ⋯
      </summary>
      <div className="absolute right-0 z-30 mt-1 flex w-48 flex-col rounded border border-gray-200 bg-white p-1 shadow-sm">
        {contents}
      </div>
    </details>
  );
}
