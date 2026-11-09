import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";

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
} from "~/components/shared/modal";

import { sanitizeHref } from "../helpers";
import type {
  HandbookArticleLinkTarget,
  LinkDialogState,
  RawBlockDialogState,
} from "../types";

interface LinkDialogProps {
  state: LinkDialogState;
  onClose: () => void;
  onHrefChange: (href: string) => void;
  onApply: () => void;
  handbookArticles?: HandbookArticleLinkTarget[];
}

export function LinkDialog({
  state,
  onClose,
  onHrefChange,
  onApply,
  handbookArticles,
}: LinkDialogProps) {
  const [linkTo, setLinkTo] = useState<"handbook" | "external">("external");
  const [search, setSearch] = useState("");
  const wasOpen = useRef(false);
  const hasHandbookPicker = handbookArticles !== undefined;

  useEffect(() => {
    if (!state.open) {
      wasOpen.current = false;
      return;
    }
    if (wasOpen.current) return;
    wasOpen.current = true;
    setLinkTo(state.href.startsWith("/handbook/") ? "handbook" : "external");
    const existingSlug = state.href
      .split(/[?#]/u)[0]
      ?.match(/^\/handbook\/([^/]+)$/u)?.[1];
    let decodedSlug = "";
    try {
      decodedSlug = decodeURIComponent(existingSlug ?? "");
    } catch {
      decodedSlug = "";
    }
    const existingArticle = handbookArticles?.find(
      (article) => article.slug === decodedSlug
    );
    setSearch(existingArticle?.title ?? "");
  }, [handbookArticles, state.href, state.open]);

  const matchingArticles = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return (handbookArticles ?? [])
      .filter((article) =>
        query
          ? `${article.title} ${article.categoryName}`
              .toLocaleLowerCase()
              .includes(query)
          : true
      )
      .sort(
        (left, right) =>
          left.categoryName.localeCompare(right.categoryName) ||
          left.title.localeCompare(right.title)
      )
      .slice(0, 10);
  }, [handbookArticles, search]);

  const sanitizedHref = sanitizeHref(state.href);
  const validHandbookHref =
    state.href.startsWith("/handbook/") && sanitizedHref === state.href;
  const validExternalHref = Boolean(
    sanitizedHref && !state.href.startsWith("/handbook/")
  );
  return (
    <AlertDialog
      open={state.open}
      onOpenChange={(open) => (open ? null : onClose())}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Edit link</AlertDialogTitle>
          <AlertDialogDescription>
            Add a destination to the selected text. The selected text stays as
            the link label.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-3">
          {hasHandbookPicker ? (
            <label className="block text-sm font-medium text-gray-700">
              Link to
              <select
                aria-label="Link to"
                value={linkTo}
                onChange={(event: ChangeEvent<HTMLSelectElement>) => {
                  const next = event.currentTarget.value as
                    | "handbook"
                    | "external";
                  setLinkTo(next);
                  setSearch("");
                  onHrefChange("");
                }}
                className="mt-1 h-10 w-full rounded border border-gray-300 bg-white px-2 text-[16px] focus:border-gray-500 focus:outline-none focus:ring-2 focus:ring-gray-200"
              >
                <option value="handbook">Handbook article</option>
                <option value="external">External URL</option>
              </select>
            </label>
          ) : null}
          {hasHandbookPicker && linkTo === "handbook" ? (
            <div>
              <label className="block text-sm font-medium text-gray-700">
                Search Handbook articles
                <input
                  type="search"
                  value={search}
                  onChange={(event: ChangeEvent<HTMLInputElement>) =>
                    setSearch(event.currentTarget.value)
                  }
                  className="mt-1 w-full rounded border border-gray-300 p-2 text-[16px] focus:border-gray-500 focus:outline-none focus:ring-2 focus:ring-gray-200"
                  placeholder="Search by title or category"
                />
              </label>
              <ul
                aria-label="Handbook article results"
                className="mt-2 max-h-56 space-y-1 overflow-y-auto"
              >
                {matchingArticles.map((article) => {
                  const href = `/handbook/${encodeURIComponent(article.slug)}`;
                  const selected = state.href === href;
                  return (
                    <li key={article.slug}>
                      <button
                        type="button"
                        aria-pressed={selected}
                        onClick={() => onHrefChange(href)}
                        className={`block w-full rounded-md border px-3 py-2 text-left ${
                          selected
                            ? "border-red-300 bg-red-50"
                            : "border-transparent hover:bg-gray-50"
                        }`}
                      >
                        <span className="block text-xs font-medium text-gray-500">
                          {article.categoryName || "Uncategorized"}
                        </span>
                        <span className="block text-sm font-semibold text-gray-900">
                          {article.title}
                        </span>
                        {article.staffOnly ? (
                          <span className="mt-1 inline-flex rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-900">
                            Staff only
                          </span>
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
              {matchingArticles.length === 0 ? (
                <p className="mt-2 text-sm text-gray-500">
                  No published Handbook articles match that search.
                </p>
              ) : null}
            </div>
          ) : (
            <label className="block text-sm font-medium text-gray-700">
              External URL
              <input
                type="url"
                value={state.href}
                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                  onHrefChange(event.target.value)
                }
                className="mt-1 w-full rounded border border-gray-300 p-2 text-[16px] focus:border-gray-500 focus:outline-none focus:ring-2 focus:ring-gray-200"
                placeholder="https://example.com"
              />
            </label>
          )}
        </div>
        <AlertDialogFooter className="gap-2">
          <AlertDialogCancel asChild>
            <Button variant="secondary" type="button">
              Cancel
            </Button>
          </AlertDialogCancel>
          <AlertDialogAction asChild>
            <Button
              type="button"
              onClick={onApply}
              disabled={
                Boolean(state.href.trim()) &&
                (linkTo === "handbook"
                  ? !validHandbookHref
                  : !validExternalHref)
              }
              className={"ml-0"}
            >
              Apply
            </Button>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

interface RawBlockDialogProps {
  state: RawBlockDialogState;
  onClose: () => void;
  onChange: (raw: string) => void;
  onSave: () => void;
}

export function RawBlockDialog({
  state,
  onClose,
  onChange,
  onSave,
}: RawBlockDialogProps) {
  return (
    <AlertDialog
      open={state.open}
      onOpenChange={(open) => (open ? null : onClose())}
    >
      <AlertDialogContent className="max-w-2xl">
        <AlertDialogHeader>
          <AlertDialogTitle>Edit raw Markdoc block</AlertDialogTitle>
          <AlertDialogDescription>
            Unsupported Markdoc content is preserved as raw blocks. Updating the
            source will replace the block contents.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-3">
          <textarea
            className="h-48 w-full rounded border border-gray-300 p-2 font-mono text-sm focus:border-gray-500 focus:outline-none focus:ring-2 focus:ring-gray-200"
            value={state.raw}
            onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
              onChange(event.target.value)
            }
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel asChild>
            <Button variant="secondary" type="button">
              Cancel
            </Button>
          </AlertDialogCancel>
          <AlertDialogAction asChild>
            <Button type="button" onClick={onSave}>
              Save raw block
            </Button>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
