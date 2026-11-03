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
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";
import { ErrorContent } from "~/components/errors";
import {
  HandbookImportReview,
  type HandbookImportDraft,
} from "~/components/handbook/handbook-import-review";
import { requireIoioHandbookRead } from "~/modules/ioio-handbook/access.server";
import { handbookEditorAction } from "~/modules/ioio-handbook/editor.server";
import {
  HANDBOOK_PDF_MAX_BYTES,
  HandbookPdfImportError,
  importHandbookPdf,
} from "~/modules/ioio-handbook/pdf-import.server";
import {
  HandbookValidationError,
  listHandbookCategories,
  submitHandbookObservation,
} from "~/modules/ioio-handbook/service.server";
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
    const categories = await listHandbookCategories(auth.organizationId);
    return payload({
      categories,
      isStudent: auth.isStudent,
      organizationId: auth.organizationId,
      userId: auth.userId,
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

function normalizedReferences(value: string) {
  const references = value
    .split(/\r?\n/u)
    .map((url) => url.trim())
    .filter(Boolean);
  if (references.length > 20) return null;
  const unique = [...new Set(references)];
  if (
    unique.some((url) => {
      if (url.length > 500) return true;
      try {
        const parsed = new URL(url);
        return parsed.protocol !== "http:" && parsed.protocol !== "https:";
      } catch {
        return true;
      }
    })
  ) {
    return null;
  }
  return unique;
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

function isSavedImportDraft(value: unknown): value is HandbookImportDraft {
  if (!value || typeof value !== "object") return false;
  const draft = value as Partial<HandbookImportDraft>;
  return (
    typeof draft.title === "string" &&
    typeof draft.content === "string" &&
    Array.isArray(draft.sourceUrls) &&
    draft.sourceUrls.every((url) => typeof url === "string") &&
    (draft.handbookCategoryId === undefined ||
      typeof draft.handbookCategoryId === "string") &&
    (draft.proposedCategoryName === undefined ||
      typeof draft.proposedCategoryName === "string")
  );
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

  if (
    intent === "create-category" ||
    intent === "save-draft" ||
    intent === "publish"
  ) {
    if (!auth.canEdit) {
      return data(
        payload({
          kind: "error" as const,
          message: "Only Staff can save or publish Handbook articles.",
        }),
        { status: 403 }
      );
    }
    return handbookEditorAction(args);
  }

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
      const imported = await importHandbookPdf(bytes);
      return data(payload({ kind: "preview" as const, draft: imported }));
    } catch (cause) {
      return data(
        payload({ kind: "error" as const, message: importErrorMessage(cause) }),
        { status: 400 }
      );
    }
  }

  if (intent === "submit-review") {
    if (!auth.isStudent) {
      return data(
        payload({
          kind: "error" as const,
          keepEditor: true,
          message:
            "Only Students can submit an imported article for Staff review.",
        }),
        { status: 403 }
      );
    }
    const title = String(form.get("title") ?? "").trim();
    const content = String(form.get("content") ?? "").trim();
    const handbookCategoryId = String(
      form.get("handbookCategoryId") ?? ""
    ).trim();
    const proposedCategoryName = String(
      form.get("proposedCategoryName") ?? ""
    ).trim();
    const references = normalizedReferences(
      String(form.get("sourceUrls") ?? "")
    );
    if (!title || title.length > 180 || !content || content.length > 30_000) {
      return data(
        payload({
          kind: "error" as const,
          keepEditor: true,
          message:
            "Add a title and article content within the Handbook field limits.",
        }),
        { status: 400 }
      );
    }
    if (references === null) {
      return data(
        payload({
          kind: "error" as const,
          keepEditor: true,
          message:
            "References must be up to 20 valid http(s) URLs, each no longer than 500 characters.",
        }),
        { status: 400 }
      );
    }
    if (
      (!handbookCategoryId && !proposedCategoryName) ||
      (handbookCategoryId && proposedCategoryName)
    ) {
      return data(
        payload({
          kind: "error" as const,
          keepEditor: true,
          message:
            "Choose a Handbook category or propose a new one before submitting.",
        }),
        { status: 400 }
      );
    }
    const reviewContent = references.length
      ? `${content}\n\nExternal references:\n${references
          .map((url) => `- ${url}`)
          .join("\n")}`
      : content;
    if (reviewContent.length > 4000) {
      return data(
        payload({
          kind: "error" as const,
          keepEditor: true,
          message:
            "Student review submissions support up to 4,000 characters, including references. Shorten the imported article before submitting.",
        }),
        { status: 400 }
      );
    }
    try {
      const result = await submitHandbookObservation({
        organizationId: auth.organizationId,
        userId: auth.userId,
        title,
        content: reviewContent,
        handbookCategoryId: handbookCategoryId || undefined,
        proposedCategoryName: proposedCategoryName || undefined,
      });
      return data(
        payload({
          kind: "submitted" as const,
          message: result.duplicate
            ? `This matches existing Handbook knowledge, “${result.duplicateTitle}”. No duplicate contribution was created.`
            : "Saved as a contribution for Staff review. It has not changed the Handbook.",
        })
      );
    } catch (cause) {
      if (cause instanceof HandbookValidationError) {
        return data(
          payload({
            kind: "error" as const,
            keepEditor: true,
            message: cause.message,
          }),
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
  const { categories, isStudent, organizationId, userId } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const preview =
    actionData && "kind" in actionData && actionData.kind === "preview"
      ? actionData.draft
      : null;
  const [draft, setDraft] = useState<HandbookImportDraft | null>(preview);
  const [submittedMessage, setSubmittedMessage] = useState("");
  const localDraftKey = `handbook-import-draft:${organizationId}:${userId}`;

  useEffect(() => {
    if (preview) {
      setDraft(preview);
      setSubmittedMessage("");
      return;
    }
    if (actionData && "kind" in actionData && actionData.kind === "submitted") {
      window.localStorage.removeItem(localDraftKey);
      setSubmittedMessage(actionData.message);
      setDraft(null);
      return;
    }
    if (!draft && !actionData) {
      try {
        const saved = window.localStorage.getItem(localDraftKey);
        if (saved) {
          const parsed: unknown = JSON.parse(saved);
          if (isSavedImportDraft(parsed)) setDraft(parsed);
          else window.localStorage.removeItem(localDraftKey);
        }
      } catch {
        window.localStorage.removeItem(localDraftKey);
      }
    }
  }, [actionData, draft, localDraftKey, preview]);

  const pageError =
    actionData && "kind" in actionData && actionData.kind === "error"
      ? actionData.message
      : actionData &&
        "ok" in actionData &&
        !actionData.ok &&
        "message" in actionData
      ? actionData.message
      : undefined;
  function importAnother() {
    window.localStorage.removeItem(localDraftKey);
    window.location.assign("/handbook/import");
  }

  if (submittedMessage) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
        <section className="rounded-xl border border-green-200 bg-green-50 p-6">
          <h1 className="text-xl font-semibold text-green-950">
            Sent for Staff review
          </h1>
          <p className="mt-2 text-sm text-green-900">{submittedMessage}</p>
          <Link
            to="/handbook"
            className="mt-4 inline-flex font-semibold text-green-950 underline"
          >
            Return to Handbook
          </Link>
        </section>
      </main>
    );
  }

  if (draft) {
    return (
      <HandbookImportReview
        draft={draft}
        categories={categories}
        isStudent={isStudent}
        organizationId={organizationId}
        userId={userId}
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
        Extract document text and structure into an editable article. Importing
        never publishes it. Text PDFs up to 5 MB and 50 pages are supported; OCR
        for scanned PDFs is limited to 20 pages.
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
