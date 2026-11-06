import { useEffect, useState } from "react";
import {
  FormDataParseError,
  MaxFileSizeExceededError,
  parseFormData,
} from "@remix-run/form-data-parser";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import {
  data,
  Form,
  Link,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";
import { ErrorContent } from "~/components/errors";
import { HandbookImportReview } from "~/components/handbook/handbook-import-review";
import { requireIoioHandbookRead } from "~/modules/ioio-handbook/access.server";
import {
  HANDBOOK_PDF_MAX_BYTES,
  HandbookPdfImportError,
  importHandbookPdf,
} from "~/modules/ioio-handbook/pdf-import.server";
import type {
  HandbookImportArticle,
  HandbookImportDraft,
} from "~/modules/ioio-handbook/pdf-import.shared";
import {
  createHandbookImportDrafts,
  HandbookValidationError,
  listHandbookArticleTitles,
  listHandbookCategories,
} from "~/modules/ioio-handbook/service.server";
import {
  HandbookStructureAnalysisError,
  improveHandbookStructureWithClaude,
  isHandbookStructureAnalysisAvailable,
} from "~/modules/ioio-handbook/structure-analysis.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { makeShelfError, ShelfError } from "~/utils/error";
import { error, payload } from "~/utils/http.server";

export async function loader({ context, request }: LoaderFunctionArgs) {
  const { userId } = context.getSession();
  try {
    const auth = await requireIoioHandbookRead({ context, request });
    if (!auth.canEdit && !auth.isStudent) {
      throw new ShelfError({
        cause: null,
        title: "Handbook PDF import unavailable",
        message:
          "The Handbook PDF import is only available to Staff and Students.",
        status: 403,
        label: "Permission",
        shouldBeCaptured: false,
      });
    }
    const [categories, existingArticles] = await Promise.all([
      listHandbookCategories(auth.organizationId),
      listHandbookArticleTitles({ organizationId: auth.organizationId }),
    ]);
    return payload({
      categories,
      existingArticles,
      isStudent: auth.isStudent,
      claudeAvailable: isHandbookStructureAnalysisAvailable(),
    });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    throw data(error(reason), { status: reason.status });
  }
}

function isUploadedFile(value: FormDataEntryValue | null): value is File {
  return (
    typeof File !== "undefined" &&
    value instanceof File &&
    typeof value.arrayBuffer === "function"
  );
}

function safeImportName(value: string) {
  const basename = value.replace(/\\/gu, "/").split("/").pop()?.trim() ?? "";
  return (
    basename
      .replace(/[\p{Cc}<>:"|?*]/gu, "")
      .replace(/\s+/gu, " ")
      .slice(0, 180) || "Imported PDF"
  );
}

function isImportSection(value: unknown) {
  if (!value || typeof value !== "object") return false;
  const section = value as Record<string, unknown>;
  return (
    typeof section.id === "string" &&
    typeof section.sourceOrder === "number" &&
    typeof section.title === "string" &&
    (section.level === 2 || section.level === 3) &&
    typeof section.markdown === "string" &&
    Array.isArray(section.sourceUrls) &&
    section.sourceUrls.every((url) => typeof url === "string") &&
    (section.possibleAuthorNote === undefined ||
      typeof section.possibleAuthorNote === "boolean") &&
    (section.sourceHeadingIds === undefined ||
      (Array.isArray(section.sourceHeadingIds) &&
        section.sourceHeadingIds.every((id) => typeof id === "string"))) &&
    (section.sourcePage === undefined ||
      (typeof section.sourcePage === "number" && section.sourcePage > 0))
  );
}

function isSourceOutlineHeading(value: unknown) {
  if (!value || typeof value !== "object") return false;
  const heading = value as Record<string, unknown>;
  return (
    typeof heading.id === "string" &&
    typeof heading.sourceOrder === "number" &&
    typeof heading.title === "string" &&
    (heading.level === 2 || heading.level === 3) &&
    (heading.sourcePage === undefined ||
      (typeof heading.sourcePage === "number" && heading.sourcePage > 0))
  );
}

function isSavedImportDraft(value: unknown): value is HandbookImportDraft {
  if (!value || typeof value !== "object") return false;
  const draft = value as Partial<HandbookImportDraft>;
  return (
    typeof draft.title === "string" &&
    draft.title.length <= 180 &&
    typeof draft.content === "string" &&
    draft.content.length <= 300_000 &&
    Array.isArray(draft.sourceUrls) &&
    draft.sourceUrls.every((url) => typeof url === "string") &&
    typeof draft.sourceName === "string" &&
    typeof draft.categorySuggestion === "string" &&
    draft.referencesByHeading !== null &&
    typeof draft.referencesByHeading === "object" &&
    Array.isArray(draft.sourceOutline) &&
    draft.sourceOutline.every(isSourceOutlineHeading) &&
    Array.isArray(draft.sections) &&
    draft.sections.every(isImportSection) &&
    Array.isArray(draft.articles) &&
    draft.articles.every(
      (article) =>
        Boolean(article) &&
        typeof article === "object" &&
        typeof (article as HandbookImportArticle).id === "string" &&
        typeof (article as HandbookImportArticle).title === "string" &&
        Array.isArray((article as HandbookImportArticle).sections) &&
        (article as HandbookImportArticle).sections.every(isImportSection)
    ) &&
    typeof draft.hierarchyDetected === "boolean" &&
    typeof draft.fallback === "boolean" &&
    (draft.imageDetectedPages === undefined ||
      (Array.isArray(draft.imageDetectedPages) &&
        draft.imageDetectedPages.every(
          (page) => typeof page === "number" && page > 0
        )))
  );
}

function importErrorMessage(cause: unknown) {
  if (cause instanceof HandbookPdfImportError) return cause.message;
  if (cause instanceof Error) {
    if (/OCR|page limit|PDF contains more than/iu.test(cause.message)) {
      return cause.message;
    }
  }
  return "This PDF could not be read. Try exporting it again as a standard PDF and retry.";
}

function parseImportDraft(value: FormDataEntryValue | null) {
  if (typeof value !== "string" || value.length > 1_400_000) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isSavedImportDraft(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

type ApprovedImportArticle = {
  title: string;
  content: string;
  sourceUrls: string[];
  existingArticleSlug?: string;
  revisionBaseVersionId?: string;
};

function parseApprovedArticles(
  value: FormDataEntryValue | null
): ApprovedImportArticle[] | null {
  if (typeof value !== "string" || value.length > 1_000_000) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 30) {
      return null;
    }
    const articles: Array<ApprovedImportArticle | null> = parsed.map((item) => {
      if (!item || typeof item !== "object") return null;
      const article = item as Record<string, unknown>;
      if (
        typeof article.title !== "string" ||
        typeof article.content !== "string" ||
        !Array.isArray(article.sourceUrls) ||
        !article.sourceUrls.every((url) => typeof url === "string") ||
        (article.existingArticleSlug !== undefined &&
          typeof article.existingArticleSlug !== "string") ||
        (article.revisionBaseVersionId !== undefined &&
          typeof article.revisionBaseVersionId !== "string")
      ) {
        return null;
      }
      return {
        title: article.title,
        content: article.content,
        sourceUrls: article.sourceUrls as string[],
        ...(typeof article.existingArticleSlug === "string"
          ? {
              existingArticleSlug: article.existingArticleSlug,
              revisionBaseVersionId:
                typeof article.revisionBaseVersionId === "string"
                  ? article.revisionBaseVersionId
                  : undefined,
            }
          : {}),
      };
    });
    if (articles.some((article) => article === null)) return null;
    return articles as ApprovedImportArticle[];
  } catch {
    return null;
  }
}

export async function action(args: ActionFunctionArgs) {
  const { context, request } = args;
  const { userId } = context.getSession();
  let auth: Awaited<ReturnType<typeof requireIoioHandbookRead>>;
  try {
    auth = await requireIoioHandbookRead({ context, request });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    throw data(error(reason), { status: reason.status });
  }
  if (!auth.canEdit && !auth.isStudent) {
    return data(
      payload({
        kind: "error" as const,
        message: "Staff or Student access is required.",
      }),
      { status: 403 }
    );
  }

  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > HANDBOOK_PDF_MAX_BYTES + 64 * 1024) {
    return data(
      payload({
        kind: "error" as const,
        message: "PDF files must be 5 MB or smaller.",
      }),
      { status: 413 }
    );
  }

  let form: FormData;
  try {
    form = await parseFormData(request.clone(), {
      maxFileSize: HANDBOOK_PDF_MAX_BYTES,
      maxFiles: 1,
    });
  } catch (cause) {
    if (
      cause instanceof MaxFileSizeExceededError ||
      (cause instanceof FormDataParseError &&
        cause.cause instanceof MaxFileSizeExceededError)
    ) {
      return data(
        payload({
          kind: "error" as const,
          message: "PDF files must be 5 MB or smaller.",
        }),
        { status: 413 }
      );
    }
    return data(
      payload({
        kind: "error" as const,
        message: "Choose a PDF file to import.",
      }),
      { status: 400 }
    );
  }
  const intent = String(form.get("intent") ?? "");

  if (intent === "upload-pdf") {
    const file = form.get("file");
    if (!isUploadedFile(file) || !file.name) {
      return data(
        payload({
          kind: "error" as const,
          message: "Choose a PDF file to import.",
        }),
        { status: 400 }
      );
    }
    if (file.size > HANDBOOK_PDF_MAX_BYTES) {
      return data(
        payload({
          kind: "error" as const,
          message: "PDF files must be 5 MB or smaller.",
        }),
        { status: 413 }
      );
    }
    try {
      const bytes = Buffer.from(await file.arrayBuffer());
      if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
        return data(
          payload({
            kind: "error" as const,
            message: "Only PDF files are supported.",
          }),
          { status: 400 }
        );
      }
      const imported = await importHandbookPdf(bytes, file.name);
      return data(payload({ kind: "preview" as const, draft: imported }));
    } catch (cause) {
      return data(
        payload({ kind: "error" as const, message: importErrorMessage(cause) }),
        { status: 400 }
      );
    }
  }

  if (intent === "improve-structure") {
    const draft = parseImportDraft(form.get("draft"));
    if (!draft) {
      return data(
        payload({
          kind: "error" as const,
          message:
            "The extracted structure is unavailable. Upload the PDF again.",
        }),
        { status: 400 }
      );
    }
    try {
      const suggestion = await improveHandbookStructureWithClaude(draft);
      return data(
        payload({
          kind: "structure-suggestion" as const,
          ...suggestion,
        })
      );
    } catch (cause) {
      const message =
        cause instanceof HandbookStructureAnalysisError
          ? cause.message
          : "Claude is unavailable. The deterministic proposal is still available.";
      return data(payload({ kind: "error" as const, message }), {
        status: 400,
      });
    }
  }

  if (intent === "approve-structure") {
    const articles = parseApprovedArticles(form.get("articles"));
    if (!articles) {
      return data(
        payload({
          kind: "error" as const,
          message: "Review the suggested articles and try again.",
        }),
        { status: 400 }
      );
    }
    const newCategoryName = String(form.get("newCategoryName") ?? "").trim();
    if (newCategoryName && !auth.canEdit) {
      return data(
        payload({
          kind: "error" as const,
          message: "Only Staff can create a Handbook category during import.",
        }),
        { status: 403 }
      );
    }
    const sourceName = safeImportName(
      String(form.get("sourceName") ?? "Imported PDF")
    );
    const provenance = `> [!NOTE] Imported from: ${sourceName}`;
    try {
      const result = await createHandbookImportDrafts({
        organizationId: auth.organizationId,
        userId: auth.userId,
        handbookCategoryId:
          String(form.get("handbookCategoryId") ?? "").trim() || undefined,
        newCategoryName: auth.canEdit
          ? newCategoryName || undefined
          : undefined,
        articles: articles.map((article) => ({
          ...article,
          content: `${article.content.trim()}\n\n${provenance}`,
        })),
      });
      return redirect(`/handbook/my-work?imported=${result.created.length}`);
    } catch (cause) {
      if (cause instanceof HandbookValidationError) {
        return data(
          payload({ kind: "error" as const, message: cause.message }),
          { status: 400 }
        );
      }
      const reason = makeShelfError(cause, { userId: auth.userId });
      throw data(error(reason), { status: reason.status });
    }
  }

  return data(
    payload({
      kind: "error" as const,
      message: "Choose a PDF file to import.",
    }),
    { status: 400 }
  );
}

export const meta: MetaFunction = () => [
  { title: appendToMetaTitle("Import PDF to Handbook") },
];
export const handle = { breadcrumb: () => "Import PDF" };

export default function HandbookPdfImportPage() {
  const { categories, existingArticles, isStudent, claudeAvailable } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const preview =
    actionData && "kind" in actionData && actionData.kind === "preview"
      ? actionData.draft
      : null;
  const [draft, setDraft] = useState<HandbookImportDraft | null>(preview);

  useEffect(() => {
    if (preview) setDraft(preview);
  }, [preview]);

  const errorCandidate =
    actionData && typeof actionData === "object" && "message" in actionData
      ? actionData.message
      : undefined;
  const pageError =
    typeof errorCandidate === "string" ? errorCandidate : undefined;
  function importAnother() {
    window.location.assign("/handbook/import");
  }

  if (draft) {
    return (
      <HandbookImportReview
        draft={draft}
        categories={categories}
        existingArticles={existingArticles}
        isStudent={isStudent}
        claudeAvailable={claudeAvailable}
        errorMessage={pageError}
        onImportAnother={importAnother}
      />
    );
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-6 sm:px-6 lg:px-8">
      <Link
        to="/handbook"
        className="text-sm font-semibold text-red-800 hover:underline"
      >
        ← Handbook
      </Link>
      <h1 className="mt-2 text-2xl font-semibold text-gray-950">
        Import a PDF to the Handbook
      </h1>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-gray-600">
        Extract headings, sections, lists, and references, then review the
        proposed article structure. No article or category is created until you
        approve the structure. Staff and Students can save drafts; publishing
        remains part of the normal Handbook workflow.
      </p>
      {pageError ? (
        <p
          role="alert"
          className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900"
        >
          {pageError}
        </p>
      ) : null}
      <Form
        method="post"
        encType="multipart/form-data"
        className="mt-5 space-y-4 rounded-xl border border-gray-200 bg-white p-5 shadow-sm"
      >
        <input type="hidden" name="intent" value="upload-pdf" />
        <label className="block text-sm font-semibold text-gray-800">
          PDF file
          <input
            required
            name="file"
            type="file"
            accept="application/pdf,.pdf"
            className="mt-2 block w-full text-sm font-normal text-gray-700 file:mr-3 file:rounded-lg file:border-0 file:bg-red-50 file:px-4 file:py-2 file:font-semibold file:text-red-800 hover:file:bg-red-100"
          />
        </label>
        <p className="text-xs text-gray-500">
          Text PDFs and scanned PDFs are supported when local OCR is available.
          Text PDFs up to 5 MB and 50 pages are supported; OCR for scanned PDFs
          is limited to 20 pages.
        </p>
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={navigation.state === "submitting"}
            className="inline-flex h-10 items-center rounded-lg bg-red-700 px-4 text-sm font-semibold text-white hover:bg-red-800 disabled:opacity-60"
          >
            {navigation.state === "submitting"
              ? "Processing PDF…"
              : "Upload PDF"}
          </button>
        </div>
      </Form>
    </main>
  );
}

export const ErrorBoundary = () => <ErrorContent />;
