import { useState } from "react";
import { useFetcher } from "react-router";
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

const actions = {
  "delete-draft": {
    label: "Delete draft",
    title: "Delete this draft?",
    description: "This will permanently remove the unpublished draft.",
  },
  "archive-article": {
    label: "Archive article",
    title: "Archive this article?",
    description:
      "It will no longer appear in normal Handbook navigation or search, but its history will be preserved.",
  },
  "restore-article": {
    label: "Restore article",
    title: "Restore this article?",
    description:
      "The published article will appear in Handbook navigation and search again.",
  },
  "delete-permanently": {
    label: "Delete permanently",
    title: (articleTitle: string) => `Delete “${articleTitle}” permanently?`,
    description:
      "This will permanently remove the article and its Handbook revision history. This action cannot be undone.",
  },
  "withdraw-submission": {
    label: "Withdraw submission",
    title: "Withdraw this submission?",
    description:
      "It will leave the review queue. Your draft and the submission record will be retained. Published articles and version history will stay unchanged.",
  },
  "discard-revision": {
    label: "Discard draft improvement",
    title: "Discard this draft improvement?",
    description:
      "The draft changes will be removed. The published article and version history will stay unchanged.",
  },
};

export function HandbookRemovalButton({
  intent,
  articleId,
  observationId,
  articleTitle,
  actionPath = "/handbook/manage",
}: {
  intent: keyof typeof actions;
  articleId?: string;
  observationId?: string;
  articleTitle?: string;
  actionPath?: string;
}) {
  const [open, setOpen] = useState(false);
  const [confirmationTitle, setConfirmationTitle] = useState("");
  const fetcher = useFetcher<{ ok: boolean; message?: string }>();
  const busy = fetcher.state !== "idle";
  const copy = actions[intent];
  const isPermanentDelete = intent === "delete-permanently";
  const dialogTitle =
    intent === "delete-permanently"
      ? actions["delete-permanently"].title(articleTitle ?? "this article")
      : actions[intent].title;
  const deleteEnabled =
    !isPermanentDelete ||
    Boolean(articleTitle && confirmationTitle.trim() === articleTitle);
  return (
    <>
      <AlertDialog
        open={open}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (nextOpen) setConfirmationTitle("");
        }}
      >
        <AlertDialogTrigger asChild>
          <button
            type="button"
            disabled={busy}
            className={`min-h-9 rounded px-2 text-left text-sm hover:bg-gray-50 disabled:opacity-50 ${
              isPermanentDelete ? "font-medium text-red-800" : "text-gray-700"
            }`}
          >
            {copy.label}
          </button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{dialogTitle}</AlertDialogTitle>
            <AlertDialogDescription>{copy.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <fetcher.Form method="post" action={actionPath}>
            <input type="hidden" name="intent" value={intent} />
            {articleId ? (
              <input type="hidden" name="articleId" value={articleId} />
            ) : null}
            {observationId ? (
              <input type="hidden" name="observationId" value={observationId} />
            ) : null}
            {isPermanentDelete ? (
              <div className="mb-4">
                <label
                  htmlFor={`confirm-handbook-delete-${articleId}`}
                  className="mb-1 block text-sm font-medium text-gray-800"
                >
                  Type “{articleTitle ?? "the article title"}” to confirm:
                </label>
                <input
                  id={`confirm-handbook-delete-${articleId}`}
                  type="text"
                  name="confirmationTitle"
                  autoComplete="off"
                  value={confirmationTitle}
                  onChange={(event) => setConfirmationTitle(event.target.value)}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-red-600 focus:outline-none focus:ring-2 focus:ring-red-200"
                />
              </div>
            ) : null}
            <AlertDialogFooter>
              <AlertDialogCancel asChild>
                <Button type="button" variant="secondary">
                  Cancel
                </Button>
              </AlertDialogCancel>
              <Button
                type="submit"
                variant={intent === "restore-article" ? "secondary" : "danger"}
                disabled={busy || !deleteEnabled}
              >
                {copy.label}
              </Button>
            </AlertDialogFooter>
          </fetcher.Form>
        </AlertDialogContent>
      </AlertDialog>
      {fetcher.data?.message ? (
        <p role="alert" className="text-sm text-red-800">
          {fetcher.data.message}
        </p>
      ) : null}
    </>
  );
}
