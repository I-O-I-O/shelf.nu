import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Link,
  useFetcher,
  useLocation,
  useNavigate,
  useRevalidator,
} from "react-router";
import { CategoryBadge } from "~/components/assets/category-badge";
import { FakeCheckbox } from "~/components/forms/fake-checkbox";
import Input from "~/components/forms/input";
import { PartialCheckboxIcon } from "~/components/icons/library";
import { ImportLocationPicker } from "~/components/ioio-staff/import-location-picker";
import { Button } from "~/components/shared/button";
import { importProductImagePreview } from "~/modules/ioio-staff/import-product-image";
import {
  validateImportRowForApply,
  type ImportReviewIssue,
} from "~/modules/ioio-staff/import-review";
import type {
  StaffImportProposal,
  StaffImportProposalRow,
} from "~/modules/ioio-staff/inventory-import.server";
import type { ImportProductImageProposal } from "~/modules/ioio-staff/product-enrichment.server";

type StaffImportResult = {
  operationId: string;
  createdIds: string[];
  updatedIds: string[];
  reusedIds: string[];
  failedRows: Array<{ rowNumber: number; reason: string }>;
  conflictRows?: Array<{ rowNumber: number; reason: string }>;
  ignoredRows?: number;
  reviewedRows?: number;
  succeededRows?: number;
  remainingRows?: number;
};

type StaffImportActionResponse =
  | {
      error: null;
      kind: "import-review-blocked";
      readyCount: number;
      blockedCount: number;
      blockedRows: Array<{
        rowNumber: number;
        title: string;
        issues: ImportReviewIssue[];
      }>;
    }
  | { error: null; kind: "import-proposal"; proposal: StaffImportProposal }
  | {
      error: null;
      kind: "import-partial";
      proposal: StaffImportProposal;
      result: StaffImportResult;
    }
  | {
      error: null;
      kind: "import-complete";
      proposal: StaffImportProposal;
      result: StaffImportResult;
    }
  | {
      error: null;
      kind: "import-row-reverted";
      result: { operationId: string; rowNumber: number; reverted: true };
    }
  | {
      error: null;
      kind: "import-rows-reverted";
      proposal: StaffImportProposal;
      result: {
        operationId: string;
        revertedRowNumbers: number[];
        failedRows: Array<{ rowNumber: number; message: string }>;
      };
    }
  | { error: null; kind: "import-result"; result: StaffImportResult }
  | { error: null; kind: "import-draft-saved"; operationId: string }
  | {
      error: null;
      kind: "import-image-processed";
      rowNumber: number;
      proposal: ImportProductImageProposal;
    }
  | { error: null; kind: "import-in-progress"; operationId: string }
  | {
      error: null;
      kind: "import-duplicate";
      duplicate: {
        status: "DUPLICATE";
        code: "SAME_PROPOSAL" | "SAME_FILE_DIFFERENT_PROPOSAL";
        message: string;
        existingOperationId: string;
        canOverride: boolean;
      };
    }
  | {
      error: null;
      kind: "import-cancelled";
      result: { operationId: string; cancelled: true };
    }
  | { error: { message: string } };

const FORMAT_COPY = {
  csv: {
    label: "CSV",
    accept: ".csv,text/csv",
    description: "Structured comma-separated inventory data",
  },
  xlsx: {
    label: "Excel",
    accept:
      ".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    description: "Spreadsheet values from an .xlsx workbook",
  },
  pdf: {
    label: "PDF",
    accept: ".pdf,application/pdf",
    description: "Extract inventory information for staff review",
  },
} as const;

type ImportFormat = keyof typeof FORMAT_COPY;
const IMPORT_REVIEW_PAGE_SIZE = 50;
const IMPORT_REVIEW_SECTION_CLASS =
  "mt-4 overflow-hidden rounded-xl border border-gray-200 bg-white";
const IMPORT_REVIEW_SECTION_HEADER_CLASS =
  "flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 px-4 py-3";
const IMPORT_REVIEW_TABLE_CLASS =
  "w-full min-w-[920px] table-fixed text-left text-sm";
const IMPORT_REVIEW_TABLE_HEAD_CLASS =
  "border-b border-gray-200 bg-gray-50 text-xs uppercase tracking-wide text-gray-500";
const IMPORT_REVIEW_TABLE_BODY_CLASS = "divide-y divide-gray-100";

type ReviewDecision = {
  decision: "APPROVE" | "IGNORE" | null;
  title: string;
  assetId: string | null;
  categoryId: string | null;
  newCategoryName: string | null;
  approveNewCategory: boolean;
  locationId: string | null;
  quantity: number | null;
  type: "INDIVIDUAL" | "QUANTITY_TRACKED" | null;
  trackingModeConfirmed: boolean;
  trackingModeSelectedByStaff: boolean;
  productChoice: "EXISTING" | "NEW" | null;
  minQuantity: number | null;
  unitOfMeasure: string | null;
  consumptionType: "ONE_WAY" | "TWO_WAY" | null;
  assetModelDescription: string | null;
  acceptSuggestedImage: boolean;
  manualImage?: ImportProductImageProposal | null;
};

function serializeReviewDecision(
  rowNumber: number,
  decision: ReviewDecision | undefined
) {
  return {
    rowNumber,
    decision: decision?.decision,
    title: decision?.title,
    assetId: decision?.assetId,
    categoryId: decision?.categoryId,
    newCategoryName: decision?.newCategoryName,
    approveNewCategory: decision?.approveNewCategory,
    locationId: decision?.locationId,
    quantity: decision?.quantity,
    type: decision?.type,
    trackingModeConfirmed: decision?.trackingModeConfirmed,
    trackingModeSelectedByStaff: decision?.trackingModeSelectedByStaff,
    productChoice: decision?.productChoice,
    minQuantity: decision?.minQuantity,
    unitOfMeasure: decision?.unitOfMeasure,
    consumptionType: decision?.consumptionType,
    assetModelDescription: decision?.assetModelDescription,
    acceptSuggestedImage: decision?.acceptSuggestedImage,
    manualImage: decision?.manualImage,
  };
}

function actionLabel(action: string) {
  return action
    .replaceAll("_", " ")
    .toLocaleLowerCase()
    .replace(/(^|\s)\S/g, (character) => character.toUpperCase());
}

function descriptionSourceLabel(source: string | undefined) {
  switch (source) {
    case "SOURCE":
      return "Import document";
    case "SHELF_EXISTING":
      return "Existing Shelf description";
    case "GENERATED":
      return "AI generated";
    case "NONE":
      return "No description provided";
    default:
      return "Manual";
  }
}

function imageFailureMessage(reason: string | undefined) {
  switch (reason) {
    case "SEARCH_PROVIDER_NOT_CONFIGURED":
      return "Image search is unavailable right now.";
    case "SEARCH_FAILED":
      return "We couldn't search for a product image.";
    case "SEARCH_NO_RESULTS":
    case "NO_TRUSTED_PRODUCT_MATCH":
    case "NO_PRODUCT_IMAGE_METADATA":
    case "IDENTITY_MISMATCH":
      return "No matching product image was found.";
    case "IMAGE_DOWNLOAD_FAILED":
    case "IMAGE_PROCESSING_FAILED":
    case "PROPOSAL_IMAGE_PERSIST_FAILED":
    case "APPLY_IMAGE_UPLOAD_FAILED":
      return "The product image could not be loaded.";
    case "IMAGE_TOO_LARGE":
      return "The product image is too large.";
    default:
      return null;
  }
}

const EDIT_FORM_LABEL_CLASS = "mb-[6px] text-text-sm font-medium text-gray-700";
const EDIT_FORM_SELECT_CLASS =
  "mt-[6px] flex min-h-10 w-full items-center justify-between rounded border border-gray-300 bg-white px-3 py-2.5 text-left text-[14px] text-gray-900 focus:border-primary-300 focus:outline-none focus:ring-2 focus:ring-primary-25 disabled:cursor-not-allowed disabled:opacity-50";

function getReviewBadge(
  row: StaffImportProposalRow,
  state: "READY" | "NEEDS_REVIEW" | "CONFLICT" | "INVALID" | "SKIPPED",
  decision: ReviewDecision | undefined
) {
  if (decision?.decision === "IGNORE" || state === "SKIPPED") {
    return { label: "Ignored", className: "bg-gray-100 text-gray-600" };
  }
  if (
    state !== "READY" &&
    (row.action === "POSSIBLE_DUPLICATE" || row.action === "AMBIGUOUS") &&
    (row.matchCandidates?.length ?? 0) > 0
  ) {
    return {
      label: "Possible match",
      className: "bg-amber-100 text-amber-800",
    };
  }
  if (state === "READY") {
    return { label: "Ready", className: "bg-green-100 text-green-800" };
  }
  return { label: "Review", className: "bg-amber-100 text-amber-800" };
}

function trackingLabel(type: ReviewDecision["type"]) {
  if (type === "INDIVIDUAL") return "Individual";
  if (type === "QUANTITY_TRACKED") return "Quantity";
  return "Needs review";
}

function isImportFormat(value: string | null): value is ImportFormat {
  return value === "csv" || value === "xlsx" || value === "pdf";
}

export function StaffImportPanel({
  actionPath,
  initialProposal = null,
  initialNotice = null,
  canCreateCategory = true,
  savedDrafts = [],
}: {
  actionPath: string;
  initialProposal?: StaffImportProposal | null;
  initialNotice?: string | null;
  canCreateCategory?: boolean;
  savedDrafts?: Array<{
    operationId: string;
    filename: string;
    rowCount: number;
    createdAt: string;
  }>;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { search } = location;
  const searchParams = new URLSearchParams(search);
  const formatParam = searchParams.get("format");
  const format: ImportFormat = isImportFormat(formatParam)
    ? formatParam
    : "csv";
  const copy = FORMAT_COPY[format];
  const fetcher = useFetcher<StaffImportActionResponse>();
  const response = fetcher.data;
  const responseProposal =
    response?.error === null &&
    (response.kind === "import-proposal" ||
      response.kind === "import-partial" ||
      response.kind === "import-complete")
      ? response.proposal
      : null;
  const [dismissedOperationId, setDismissedOperationId] = useState<
    string | null
  >(null);
  const pendingUploadPreviousProposalRef = useRef<StaffImportProposal | null>(
    null
  );
  const [notice, setNotice] = useState<string | null>(initialNotice);
  const [dismissedError, setDismissedError] = useState(false);
  const storedProposal = responseProposal ?? initialProposal;
  const proposal =
    storedProposal?.operationId === dismissedOperationId
      ? null
      : storedProposal;
  const result =
    response?.error === null &&
    (response.kind === "import-result" || response.kind === "import-complete")
      ? response.result
      : null;
  const errorMessage = response?.error?.message;
  const visibleErrorMessage = dismissedError ? null : errorMessage;
  const resetImportState = useCallback(
    (nextNotice: string | null = null) => {
      const activeOperationId =
        responseProposal?.operationId ?? initialProposal?.operationId ?? null;
      pendingUploadPreviousProposalRef.current = null;
      setDismissedOperationId(activeOperationId);
      setNotice(nextNotice);
      setDismissedError(true);
      if (fileInputRef.current) fileInputRef.current.value = "";
      const params = new URLSearchParams(location.search);
      params.delete("importOperation");
      const nextSearch = params.toString();
      void navigate(
        `${location.pathname}${nextSearch ? `?${nextSearch}` : ""}${
          location.hash
        }`,
        { replace: true }
      );
    },
    [
      initialProposal?.operationId,
      location.hash,
      location.pathname,
      location.search,
      navigate,
      responseProposal?.operationId,
    ]
  );

  useEffect(() => {
    if (!responseProposal) return;
    if (dismissedOperationId === "__pending__") {
      if (
        responseProposal === pendingUploadPreviousProposalRef.current ||
        fetcher.state !== "idle"
      ) {
        return;
      }
      pendingUploadPreviousProposalRef.current = null;
    }
    if (dismissedOperationId === responseProposal.operationId) return;
    setDismissedOperationId(null);
    setNotice(null);
    setDismissedError(false);
    const params = new URLSearchParams(location.search);
    if (params.get("importOperation") === responseProposal.operationId) return;
    params.set("importOperation", responseProposal.operationId);
    const nextSearch = params.toString();
    void navigate(
      `${location.pathname}${nextSearch ? `?${nextSearch}` : ""}${
        location.hash
      }`,
      { replace: true }
    );
  }, [
    dismissedOperationId,
    fetcher.state,
    location,
    navigate,
    responseProposal,
  ]);

  useEffect(() => {
    if (!visibleErrorMessage || !proposal) return;
    if (visibleErrorMessage.includes("no longer available")) {
      resetImportState(
        "This import proposal expired or is no longer available. Start a new import to continue."
      );
    }
  }, [proposal, resetImportState, visibleErrorMessage]);

  return (
    <section
      id="staff-inventory-import"
      className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm"
      aria-labelledby="staff-import-heading"
    >
      <div>
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-red-700">
          Staff import
        </p>
        <h2
          id="staff-import-heading"
          className="mt-1 text-xl font-black text-gray-950"
        >
          Import inventory
        </h2>
        <p className="mt-1 text-sm text-gray-600">
          Upload a file to prepare a review proposal. Nothing changes until a
          staff member confirms it.
        </p>
      </div>

      <div className="mt-4 flex flex-wrap gap-2" aria-label="Import format">
        {(Object.keys(FORMAT_COPY) as ImportFormat[]).map((option) => (
          <a
            key={option}
            href={`${actionPath}?format=${option}#staff-inventory-import`}
            className={
              option === format
                ? "rounded-xl bg-red-700 px-3 py-2 text-sm font-bold text-white"
                : "rounded-xl border border-gray-200 px-3 py-2 text-sm font-bold text-gray-700 hover:border-red-200 hover:bg-red-50 hover:text-red-800"
            }
          >
            {FORMAT_COPY[option].label}
          </a>
        ))}
      </div>

      <fetcher.Form
        method="post"
        action={actionPath}
        encType="multipart/form-data"
        className="mt-4 flex flex-wrap items-center gap-3"
      >
        <input type="hidden" name="intent" value="analyze-file" />
        {format !== "pdf" ? (
          <details className="w-full text-sm text-gray-600">
            <summary>Spreadsheet options</summary>
            <p className="my-2">
              Leave blank to detect inventory tables automatically. If a table
              needs review, choose its sheet and header row here, then upload
              the file again.
            </p>
            <label>
              Sheet name{" "}
              <input
                name="spreadsheetSheet"
                type="text"
                maxLength={100}
                className="mx-2 rounded border px-2 py-1"
              />
            </label>
            <label>
              Header row{" "}
              <input
                name="spreadsheetHeaderRow"
                type="number"
                min={1}
                max={1000}
                className="mx-2 w-24 rounded border px-2 py-1"
              />
            </label>
          </details>
        ) : null}
        <label className="inline-flex cursor-pointer items-center rounded-xl bg-red-700 px-4 py-2.5 text-sm font-bold text-white transition focus-within:ring-2 focus-within:ring-red-700 focus-within:ring-offset-2 hover:bg-red-800">
          Choose {copy.label} file
          <input
            ref={fileInputRef}
            name="file"
            type="file"
            accept={copy.accept}
            className="sr-only"
            onChange={(event) => {
              pendingUploadPreviousProposalRef.current = storedProposal;
              setDismissedOperationId("__pending__");
              setNotice(null);
              setDismissedError(false);
              const form = event.currentTarget.form;
              if (form) form.requestSubmit();
            }}
          />
        </label>
        <span className="text-xs text-gray-500">{copy.description}</span>
      </fetcher.Form>

      {fetcher.state !== "idle" ? (
        <p className="mt-3 text-sm text-gray-500" role="status">
          Preparing a Shelf review proposal...
        </p>
      ) : null}
      {visibleErrorMessage ? (
        <p className="mt-3 text-sm text-red-700" role="alert">
          {visibleErrorMessage}
        </p>
      ) : null}
      {notice ? (
        <div className="mt-3 flex flex-wrap items-center gap-3 text-sm text-gray-700">
          <span role="status">{notice}</span>
          <button
            type="button"
            onClick={() => resetImportState(null)}
            className="rounded-lg border border-gray-300 px-3 py-1.5 font-bold text-gray-700 hover:bg-gray-50"
          >
            Start over
          </button>
        </div>
      ) : null}
      {!proposal && savedDrafts.length > 0 ? (
        <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50 p-3">
          <h3 className="text-sm font-bold text-gray-900">
            Continue saved import
          </h3>
          <ul className="mt-2 space-y-2">
            {savedDrafts.map((draft) => (
              <li key={draft.operationId}>
                <Link
                  to={`${actionPath}?importOperation=${encodeURIComponent(
                    draft.operationId
                  )}#staff-inventory-import`}
                  className="text-sm font-semibold text-red-800 underline hover:text-red-950"
                >
                  {draft.filename} · {draft.rowCount}{" "}
                  {draft.rowCount === 1 ? "row" : "rows"} · Draft
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {result ? (
        <p
          className={`mt-3 text-sm ${
            result.failedRows.length || result.conflictRows?.length
              ? "text-amber-700"
              : "text-green-700"
          }`}
        >
          Import finished. Created {result.createdIds.length}, updated{" "}
          {result.updatedIds.length}, reused {result.reusedIds.length}, failed{" "}
          {result.failedRows.length}, conflicts{" "}
          {result.conflictRows?.length ?? 0}.
        </p>
      ) : null}
      {proposal ? (
        <StaffImportProposalView
          key={`${proposal.operationId}:${
            proposal.appliedRowNumbers?.join(",") ?? ""
          }:${proposal.ignoredRowNumbers?.join(",") ?? ""}:${
            proposal.revertedRowNumbers?.join(",") ?? ""
          }`}
          proposal={proposal}
          actionPath={actionPath}
          onReset={resetImportState}
          canCreateCategory={canCreateCategory}
        />
      ) : null}
    </section>
  );
}

function StaffImportProposalView({
  proposal,
  actionPath,
  onReset,
  canCreateCategory,
}: {
  proposal: StaffImportProposal;
  actionPath: string;
  onReset: (notice?: string | null) => void;
  canCreateCategory: boolean;
}) {
  const fetcher = useFetcher<StaffImportActionResponse>();
  const draftFetcher = useFetcher<StaffImportActionResponse>();
  const revertFetcher = useFetcher<StaffImportActionResponse>();
  const { revalidate } = useRevalidator();
  const {
    data: draftResponse,
    state: draftState,
    submit: submitDraft,
  } = draftFetcher;
  const imageFetcher = useFetcher<StaffImportActionResponse>();
  const response = fetcher.data;
  const isMouserInvoice =
    proposal.source.extractionProvider?.startsWith("mouser-") ?? false;
  const [proposalState, setProposalState] = useState<
    "review" | "in-progress" | "applied" | "cancelled" | "expired" | "error"
  >("review");
  const [reviewPage, setReviewPage] = useState(0);
  const [allowSameFileReimport, setAllowSameFileReimport] = useState(false);
  const [editRowNumber, setEditRowNumber] = useState<number | null>(null);
  const [selectedImplementedRowNumbers, setSelectedImplementedRowNumbers] =
    useState<number[]>([]);
  const savedDecisionByRow = new Map(
    (proposal.savedReviewDecisions ?? []).map((decision) => [
      decision.rowNumber,
      decision,
    ])
  );
  const [reviewDecisions, setReviewDecisions] = useState<
    Record<number, ReviewDecision>
  >(() =>
    Object.fromEntries(
      proposal.rows.map((row) => {
        const savedDecision = savedDecisionByRow.get(row.rowNumber);
        const resetLegacyIndividualDefault =
          savedDecision?.type === "INDIVIDUAL" &&
          row.trackingSource !== "EXISTING_MODEL" &&
          row.trackingSource !== "MANUAL_OVERRIDE" &&
          savedDecision.trackingModeConfirmed !== true &&
          savedDecision.trackingModeSelectedByStaff !== true;
        const restoredSavedDecision = resetLegacyIndividualDefault
          ? {
              ...savedDecision,
              type: "QUANTITY_TRACKED" as const,
              trackingModeConfirmed: false,
              trackingModeSelectedByStaff: false,
            }
          : savedDecision;
        const defaultTrackingType =
          row.trackingSource === "EXISTING_MODEL" ||
          row.trackingSource === "MANUAL_OVERRIDE"
            ? row.type ?? "QUANTITY_TRACKED"
            : "QUANTITY_TRACKED";
        const defaults = {
          decision: row.action === "IGNORE" ? "IGNORE" : null,
          title: row.title,
          assetId: row.assetId,
          categoryId: row.categoryId,
          newCategoryName: row.proposedCategoryName ?? null,
          approveNewCategory: false,
          locationId: row.locationId,
          quantity: row.receivedQuantity ?? row.quantity ?? null,
          type: defaultTrackingType,
          trackingModeConfirmed: false,
          trackingModeSelectedByStaff: false,
          productChoice:
            row.action === "POSSIBLE_DUPLICATE" || row.action === "AMBIGUOUS"
              ? null
              : row.assetId
              ? "EXISTING"
              : "NEW",
          minQuantity:
            typeof row.helperCandidate?.settingsSuggestions.find(
              (setting) => setting.key === "minQuantity"
            )?.value === "number"
              ? (row.helperCandidate.settingsSuggestions.find(
                  (setting) => setting.key === "minQuantity"
                )?.value as number)
              : null,
          unitOfMeasure:
            (row.helperCandidate?.settingsSuggestions.find(
              (setting) => setting.key === "unitOfMeasure"
            )?.value as string | undefined) ??
            (defaultTrackingType === "QUANTITY_TRACKED" ? "pcs" : null),
          consumptionType:
            (row.helperCandidate?.settingsSuggestions.find(
              (setting) => setting.key === "consumptionType"
            )?.value as "ONE_WAY" | "TWO_WAY" | undefined) ??
            (defaultTrackingType === "QUANTITY_TRACKED" ? "TWO_WAY" : null),
          assetModelDescription: row.assetModelDescription ?? null,
          acceptSuggestedImage:
            row.productImageProposal?.status === "IMAGE_FOUND" &&
            row.productImageProposal.autoAccepted === true,
        } satisfies ReviewDecision;
        return [row.rowNumber, { ...defaults, ...restoredSavedDecision }];
      })
    )
  );
  const [serverIssues, setServerIssues] = useState<
    Record<number, ImportReviewIssue[]>
  >({});
  const activeBlockedRows =
    response?.error === null && response.kind === "import-review-blocked"
      ? response.blockedRows.filter(
          (row) => serverIssues[row.rowNumber]?.length
        )
      : [];
  const reviewStates = Object.fromEntries(
    proposal.rows.map((row) => {
      const decision = reviewDecisions[row.rowNumber];
      return [
        row.rowNumber,
        (() => {
          const result = validateImportRowForApply({
            row: { ...row, categoryOptional: row.mouserLineItem === true },
            decision,
            categoryAvailable: Boolean(
              (decision?.categoryId &&
                proposal.categoryOptions?.some(
                  (category) =>
                    category.id === decision.categoryId && !category.archived
                )) ||
                (decision?.approveNewCategory && decision.newCategoryName)
            ),
            categoryPermission: canCreateCategory,
            locationAvailable:
              !decision?.locationId ||
              Boolean(
                proposal.locationOptions?.some(
                  (location) => location.id === decision.locationId
                )
              ),
          });
          return result.state === "IGNORED" ? "SKIPPED" : result.state;
        })(),
      ];
    })
  ) as Record<
    number,
    "READY" | "NEEDS_REVIEW" | "CONFLICT" | "INVALID" | "SKIPPED"
  >;
  const reviewBadges = Object.fromEntries(
    proposal.rows.map((row) => [
      row.rowNumber,
      getReviewBadge(
        row,
        reviewStates[row.rowNumber],
        reviewDecisions[row.rowNumber]
      ),
    ])
  );
  const appliedRowNumbers = new Set(proposal.appliedRowNumbers ?? []);
  const ignoredRowNumbers = new Set(proposal.ignoredRowNumbers ?? []);
  const revertedRowNumbers = new Set(proposal.revertedRowNumbers ?? []);
  const revertibleRowNumbers = new Set(proposal.revertibleRowNumbers ?? []);
  const isAppliedRow = (rowNumber: number) =>
    appliedRowNumbers.has(rowNumber) && !revertedRowNumbers.has(rowNumber);
  const isResolvedRow = (rowNumber: number) =>
    proposal.reviewClosed ||
    isAppliedRow(rowNumber) ||
    ignoredRowNumbers.has(rowNumber);
  const approvedCount = proposal.rows.filter(
    (row) =>
      !isResolvedRow(row.rowNumber) &&
      reviewDecisions[row.rowNumber]?.decision === "APPROVE" &&
      reviewStates[row.rowNumber] === "READY" &&
      !serverIssues[row.rowNumber]?.length
  ).length;
  const duplicateResponse =
    response?.error === null && response.kind === "import-duplicate"
      ? response.duplicate
      : null;
  const duplicateBlocksApply =
    duplicateResponse !== null &&
    (!duplicateResponse.canOverride || !allowSameFileReimport);
  const serializeReviewDecisions = () =>
    JSON.stringify(
      proposal.rows.map((row) =>
        serializeReviewDecision(row.rowNumber, reviewDecisions[row.rowNumber])
      )
    );
  const serializedReviewDecisions = serializeReviewDecisions();
  const [lastAutoSavedDecisions, setLastAutoSavedDecisions] = useState(
    serializedReviewDecisions
  );
  const pendingAutoSave = useRef<string | null>(null);
  const canApply =
    approvedCount > 0 &&
    !proposal.reviewClosed &&
    serializedReviewDecisions === lastAutoSavedDecisions &&
    fetcher.state === "idle" &&
    draftFetcher.state === "idle" &&
    (proposalState === "review" || proposalState === "error");
  const totalReviewPages = Math.max(
    1,
    Math.ceil(
      proposal.rows.filter((row) => !isAppliedRow(row.rowNumber)).length /
        IMPORT_REVIEW_PAGE_SIZE
    )
  );
  const pendingReviewRows = proposal.rows.filter(
    (row) => !isAppliedRow(row.rowNumber)
  );
  const reviewRows = pendingReviewRows.slice(
    reviewPage * IMPORT_REVIEW_PAGE_SIZE,
    (reviewPage + 1) * IMPORT_REVIEW_PAGE_SIZE
  );
  const approvableReviewRows = reviewRows.filter(
    (row) =>
      !isResolvedRow(row.rowNumber) &&
      reviewDecisions[row.rowNumber]?.decision !== "IGNORE" &&
      reviewStates[row.rowNumber] === "READY" &&
      !serverIssues[row.rowNumber]?.length
  );
  const approvedVisibleRowsCount = approvableReviewRows.filter(
    (row) => reviewDecisions[row.rowNumber]?.decision === "APPROVE"
  ).length;
  const allApprovableRowsApproved =
    approvableReviewRows.length > 0 &&
    approvedVisibleRowsCount === approvableReviewRows.length;
  const someApprovableRowsApproved =
    approvedVisibleRowsCount > 0 && !allApprovableRowsApproved;
  const implementedRows = proposal.rows.filter((row) =>
    isAppliedRow(row.rowNumber)
  );
  const selectedRevertibleRows = selectedImplementedRowNumbers.filter(
    (rowNumber) => revertibleRowNumbers.has(rowNumber)
  );
  const revertibleImplementedRows = implementedRows.filter((row) =>
    revertibleRowNumbers.has(row.rowNumber)
  );
  const allRevertibleRowsSelected =
    revertibleImplementedRows.length > 0 &&
    selectedRevertibleRows.length === revertibleImplementedRows.length;
  const someRevertibleRowsSelected =
    selectedRevertibleRows.length > 0 && !allRevertibleRowsSelected;
  const firstReviewRow = pendingReviewRows.length
    ? reviewPage * IMPORT_REVIEW_PAGE_SIZE + 1
    : 0;
  const lastReviewRow = Math.min(
    (reviewPage + 1) * IMPORT_REVIEW_PAGE_SIZE,
    pendingReviewRows.length
  );

  useEffect(() => {
    if (
      proposal.reviewClosed ||
      draftState !== "idle" ||
      serializedReviewDecisions === lastAutoSavedDecisions ||
      (draftResponse?.error === null &&
        draftResponse.kind === "import-draft-saved" &&
        pendingAutoSave.current === serializedReviewDecisions) ||
      (draftResponse?.error &&
        pendingAutoSave.current === serializedReviewDecisions)
    ) {
      return;
    }
    const decisionsToSave = serializedReviewDecisions;
    const timer = window.setTimeout(() => {
      const formData = new FormData();
      formData.set("intent", "save-draft");
      formData.set("operationId", proposal.operationId);
      formData.set("reviewDecisions", decisionsToSave);
      pendingAutoSave.current = decisionsToSave;
      void submitDraft(formData, {
        method: "post",
        action: actionPath,
      });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [
    actionPath,
    draftResponse,
    draftState,
    lastAutoSavedDecisions,
    proposal.operationId,
    proposal.reviewClosed,
    serializedReviewDecisions,
    submitDraft,
  ]);

  useEffect(() => {
    if (
      draftResponse?.error === null &&
      draftResponse.kind === "import-draft-saved" &&
      pendingAutoSave.current
    ) {
      setLastAutoSavedDecisions(pendingAutoSave.current);
    }
  }, [draftResponse]);

  const updateDecision = (
    rowNumber: number,
    changes: Partial<ReviewDecision>
  ) => {
    setServerIssues((current) => {
      const next = { ...current };
      delete next[rowNumber];
      return next;
    });
    setReviewDecisions((current) => {
      const nextDecision = { ...current[rowNumber], ...changes };
      const row = proposal.rows.find((item) => item.rowNumber === rowNumber);
      if (row && nextDecision.decision === "APPROVE") {
        const validation = validateImportRowForApply({
          row: { ...row, categoryOptional: row.mouserLineItem === true },
          decision: nextDecision,
          categoryAvailable: Boolean(
            (nextDecision.categoryId &&
              proposal.categoryOptions?.some(
                (category) =>
                  category.id === nextDecision.categoryId && !category.archived
              )) ||
              (nextDecision.approveNewCategory &&
                nextDecision.newCategoryName?.trim())
          ),
          locationAvailable:
            !nextDecision.locationId ||
            Boolean(
              proposal.locationOptions?.some(
                (location) => location.id === nextDecision.locationId
              )
            ),
          categoryPermission: canCreateCategory,
        });
        if (!validation.ready) nextDecision.decision = null;
      }
      return { ...current, [rowNumber]: nextDecision };
    });
  };

  const uploadProductImage = (rowNumber: number, file?: File) => {
    if (!file) return;
    const formData = new FormData();
    formData.set("intent", "process-import-image");
    formData.set("rowNumber", String(rowNumber));
    formData.set("file", file);
    void imageFetcher.submit(formData, {
      method: "post",
      action: actionPath,
      encType: "multipart/form-data",
    });
  };

  useEffect(() => {
    const result = imageFetcher.data;
    if (!result || result.error || result.kind !== "import-image-processed") {
      return;
    }
    setReviewDecisions((current) => ({
      ...current,
      [result.rowNumber]: {
        ...current[result.rowNumber],
        manualImage: result.proposal,
        acceptSuggestedImage: true,
      },
    }));
  }, [imageFetcher.data]);

  useEffect(() => {
    if (!fetcher.data) return;
    if (!fetcher.data.error && fetcher.data.kind === "import-review-blocked") {
      const blockedRows = fetcher.data.blockedRows;
      setServerIssues(
        Object.fromEntries(
          blockedRows.map((row) => [row.rowNumber, row.issues])
        )
      );
      setReviewDecisions((current) => {
        const next = { ...current };
        blockedRows.forEach(({ rowNumber }) => {
          next[rowNumber] = { ...next[rowNumber], decision: null };
        });
        return next;
      });
      setProposalState("review");
      return;
    }
    if (fetcher.data.error) {
      if (fetcher.data.error.message.includes("no longer available")) {
        setProposalState("expired");
        onReset(
          "This import proposal expired or is no longer available. Start a new import to continue."
        );
      } else {
        setProposalState("error");
      }
      return;
    }
    if (fetcher.data.kind === "import-result") {
      setProposalState("applied");
      onReset(
        `Import finished. Created ${
          fetcher.data.result.createdIds.length
        }, updated ${fetcher.data.result.updatedIds.length}, reused ${
          fetcher.data.result.reusedIds.length
        }, failed ${fetcher.data.result.failedRows.length}, conflicts ${
          fetcher.data.result.conflictRows?.length ?? 0
        }.`
      );
      return;
    }
    if (fetcher.data.kind === "import-complete") {
      setProposalState("applied");
      void revalidate();
      return;
    }
    if (fetcher.data.kind === "import-partial") {
      setProposalState("review");
      void revalidate();
      return;
    }
    if (fetcher.data.kind === "import-in-progress") {
      setProposalState("in-progress");
      return;
    }
    if (fetcher.data.kind === "import-duplicate") {
      setProposalState("review");
      setAllowSameFileReimport(false);
      return;
    }
    if (fetcher.data.kind === "import-cancelled") {
      setProposalState("cancelled");
      onReset("Import cancelled. No inventory changes were applied.");
    }
  }, [fetcher.data, onReset, revalidate]);

  useEffect(() => {
    if (revertFetcher.data?.error === null) {
      if (revertFetcher.data.kind === "import-rows-reverted") {
        setSelectedImplementedRowNumbers([]);
        if (revertFetcher.data.result.revertedRowNumbers.length > 0) {
          void revalidate();
        }
      } else if (revertFetcher.data.kind === "import-row-reverted") {
        void revalidate();
      }
    }
  }, [revalidate, revertFetcher.data]);

  return (
    <div className="mt-5 border-t border-gray-100 pt-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h3 className="max-w-2xl break-words text-lg font-black text-gray-950">
            {proposal.source.filename}
          </h3>
          <p className="mt-1 text-sm font-semibold text-gray-700">
            {proposal.rows.length}{" "}
            {proposal.rows.length === 1 ? "product" : "products"} found
          </p>
          <p className="mt-1 text-xs text-gray-500">
            {proposal.reviewClosed
              ? "Review closed. Applied rows appear below."
              : "Draft · Review edits save automatically. Nothing changes in Shelf until Apply."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <fetcher.Form method="post" action={actionPath}>
            <input type="hidden" name="intent" value="apply-import" />
            <input
              type="hidden"
              name="operationId"
              value={proposal.operationId}
            />
            <input
              type="hidden"
              name="proposalHash"
              value={proposal.proposalHash}
            />
            <input
              type="hidden"
              name="allowSameFileReimport"
              value={allowSameFileReimport ? "true" : "false"}
            />
            <Button
              type="submit"
              variant="primary"
              size="md"
              disabled={
                !canApply || duplicateBlocksApply || fetcher.state !== "idle"
              }
              className="whitespace-nowrap"
            >
              Apply approved changes
            </Button>
            <input
              type="hidden"
              name="reviewDecisions"
              value={serializedReviewDecisions}
            />
          </fetcher.Form>
          {!proposal.reviewClosed ? (
            <fetcher.Form
              method="post"
              action={actionPath}
              onSubmit={() => {
                setProposalState("cancelled");
                setTimeout(
                  () =>
                    onReset(
                      "Import cancelled. No inventory changes were applied."
                    ),
                  0
                );
              }}
            >
              <input type="hidden" name="intent" value="cancel-import" />
              <input
                type="hidden"
                name="operationId"
                value={proposal.operationId}
              />
              <Button
                type="submit"
                variant="secondary"
                size="md"
                disabled={
                  fetcher.state !== "idle" || proposalState !== "review"
                }
                className="whitespace-nowrap"
              >
                Cancel
              </Button>
            </fetcher.Form>
          ) : null}
        </div>
      </div>

      {fetcher.state !== "idle" ? (
        <p className="mt-3 text-sm text-gray-500" role="status">
          {fetcher.formData?.get("intent") === "cancel-import"
            ? "Cancelling import proposal..."
            : "Applying approved changes..."}
        </p>
      ) : null}
      {draftFetcher.state !== "idle" ? (
        <p className="mt-3 text-sm text-gray-500" role="status">
          Saving draft automatically...
        </p>
      ) : null}
      {draftFetcher.data?.error ? (
        <p className="mt-3 text-sm text-red-700" role="alert">
          {draftFetcher.data.error.message}
        </p>
      ) : null}
      {response?.error === null &&
      response.kind === "import-review-blocked" &&
      activeBlockedRows.length > 0 ? (
        <div role="alert" className="mt-3 text-sm text-amber-800">
          <p>No rows were applied. Resolve these issues and try again.</p>
          <ul>
            {activeBlockedRows.map((row) => (
              <li key={row.rowNumber}>
                {row.issues.map((issue) => issue.message).join(" ")}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {response?.error === null && response.kind === "import-partial" ? (
        <p role="status" className="mt-3 text-sm text-green-700">
          Applied {response.result.succeededRows} approved{" "}
          {response.result.succeededRows === 1 ? "item" : "items"}.{" "}
          {response.result.remainingRows ?? 0} rows remain in this draft.
        </p>
      ) : null}
      {proposalState === "in-progress" ? (
        <p role="status" className="mt-3 text-sm text-amber-700">
          This import is still being processed. Wait a moment before checking
          again.
        </p>
      ) : null}
      {fetcher.data?.error ? (
        <p className="mt-3 text-sm text-red-700" role="alert">
          {fetcher.data.error.message}
        </p>
      ) : null}
      {response?.error === null && response.kind === "import-duplicate" ? (
        <div
          className="mt-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950"
          role="alert"
        >
          <p>{response.duplicate.message}</p>
          {response.duplicate.canOverride ? (
            <label className="mt-2 flex items-start gap-2 font-semibold">
              <input
                type="checkbox"
                checked={allowSameFileReimport}
                onChange={(event) =>
                  setAllowSameFileReimport(event.currentTarget.checked)
                }
              />
              I reviewed the changed decisions and intend to apply this PDF
              again.
            </label>
          ) : null}
        </div>
      ) : null}

      {isMouserInvoice ? (
        <p className="mt-1 text-xs text-gray-500">
          Location assignment is optional when applying the import.
        </p>
      ) : null}

      {(proposal.pdfSummary?.unresolvedLines ?? 0) > 0 ? (
        <p className="mt-2 text-sm text-amber-800">
          {proposal.pdfSummary?.unresolvedLines} invoice lines could not be
          reconstructed.
        </p>
      ) : null}

      <section
        className={IMPORT_REVIEW_SECTION_CLASS}
        aria-labelledby="pending-import-rows"
      >
        <ImportReviewSectionHeader
          id="pending-import-rows"
          title="Pending review"
          count={pendingReviewRows.length}
          selectedCount={approvedCount}
          selectedLabel="approved"
        />
        <div
          hidden={pendingReviewRows.length === 0}
          className="overflow-x-auto"
        >
          <table className={IMPORT_REVIEW_TABLE_CLASS}>
            <thead className={IMPORT_REVIEW_TABLE_HEAD_CLASS}>
              <tr>
                <th className="w-10 p-2">
                  <ImportReviewCheckbox
                    ariaLabel="Approve all ready rows on this page for import"
                    checked={allApprovableRowsApproved}
                    indeterminate={someApprovableRowsApproved}
                    disabled={
                      approvableReviewRows.length === 0 ||
                      fetcher.state !== "idle"
                    }
                    onChange={(checked) =>
                      approvableReviewRows.forEach((row) =>
                        updateDecision(row.rowNumber, {
                          decision: checked ? "APPROVE" : null,
                        })
                      )
                    }
                  />
                </th>
                <th className="w-[190px] p-2">Product</th>
                <th className="w-16 p-2">Qty</th>
                <th className="w-[148px] p-2">Category</th>
                <th className="w-[188px] p-2">Location</th>
                <th className="w-20 p-2">Image</th>
                <th className="w-28 p-2">Status</th>
                <th className="w-[88px] p-2">Edit</th>
              </tr>
            </thead>
            <tbody className={IMPORT_REVIEW_TABLE_BODY_CLASS}>
              {reviewRows.map((row) => {
                const isApplied = isAppliedRow(row.rowNumber);
                const isIgnored = ignoredRowNumbers.has(row.rowNumber);
                const isResolved =
                  proposal.reviewClosed || isApplied || isIgnored;
                const decision = reviewDecisions[row.rowNumber];
                const selectedLocation = decision?.locationId
                  ? proposal.locationOptions?.find(
                      (location) => location.id === decision.locationId
                    )
                  : null;
                const selectedNewCategory = decision?.approveNewCategory
                  ? decision.newCategoryName?.trim()
                  : null;
                const rowCategoryLabel =
                  selectedNewCategory ||
                  row.suggestedCategory ||
                  row.category ||
                  null;
                const selectedCategoryOption =
                  proposal.categoryOptions?.find(
                    (category) =>
                      category.id ===
                      (decision ? decision.categoryId : row.categoryId)
                  ) ??
                  proposal.categoryOptions?.find(
                    (category) =>
                      (!decision || decision.categoryId) &&
                      rowCategoryLabel &&
                      category.name === rowCategoryLabel
                  );
                const selectedCategoryBadge = selectedCategoryOption?.color
                  ? {
                      id: selectedCategoryOption.id,
                      name: selectedCategoryOption.name,
                      color: selectedCategoryOption.color,
                    }
                  : null;
                const helperMatchCandidate = row.matchCandidates?.find(
                  (candidate) =>
                    candidate.id ===
                    row.helperCandidate?.productMatch.candidateId
                );
                const selectedExistingCandidate =
                  decision?.productChoice === "EXISTING" && decision.assetId
                    ? row.matchCandidates?.find(
                        (candidate) => candidate.id === decision.assetId
                      )
                    : null;
                const isExistingTrackingSelection =
                  Boolean(selectedExistingCandidate) ||
                  (row.trackingSource === "EXISTING_MODEL" &&
                    decision?.productChoice !== "NEW");
                const effectiveTrackingType =
                  selectedExistingCandidate?.type ?? decision?.type ?? row.type;
                const individualTrackingRequiresConfirmation =
                  effectiveTrackingType === "INDIVIDUAL" &&
                  !isExistingTrackingSelection;
                const badge = reviewBadges[row.rowNumber];
                const rowValidation = validateImportRowForApply({
                  row: {
                    ...row,
                    categoryOptional: row.mouserLineItem === true,
                  },
                  decision,
                  alreadyImported: isApplied,
                  categoryAvailable: Boolean(
                    (decision?.categoryId &&
                      proposal.categoryOptions?.some(
                        (category) =>
                          category.id === decision.categoryId &&
                          !category.archived
                      )) ||
                      (decision?.approveNewCategory &&
                        decision.newCategoryName?.trim())
                  ),
                  locationAvailable:
                    !decision?.locationId ||
                    Boolean(
                      proposal.locationOptions?.some(
                        (location) => location.id === decision.locationId
                      )
                    ),
                  categoryPermission: canCreateCategory,
                });
                const rowCanImport =
                  !isResolved &&
                  decision?.decision !== "IGNORE" &&
                  rowValidation.ready &&
                  !serverIssues[row.rowNumber]?.length;
                const statusLabel = isApplied
                  ? "Imported"
                  : isIgnored || badge.label === "Ignored"
                  ? "Ignored"
                  : rowCanImport
                  ? "Ready"
                  : "Needs review";
                const statusClassName =
                  statusLabel === "Ready" || statusLabel === "Imported"
                    ? "bg-green-100 text-green-800"
                    : statusLabel === "Ignored"
                    ? "bg-gray-100 text-gray-600"
                    : "bg-amber-100 text-amber-800";
                const suggestedCategory = row.suggestedCategoryId
                  ? proposal.categoryOptions?.find(
                      (category) => category.id === row.suggestedCategoryId
                    )
                  : null;
                const suggestedLocation = row.suggestedLocationId
                  ? proposal.locationOptions?.find(
                      (location) => location.id === row.suggestedLocationId
                    )
                  : null;
                const quantity =
                  decision && decision.quantity !== undefined
                    ? decision.quantity
                    : row.receivedQuantity ?? row.quantity ?? null;
                const proposedImage =
                  decision?.manualImage === null
                    ? null
                    : decision?.manualImage ?? row.productImageProposal;
                const descriptionSource =
                  (decision?.assetModelDescription ?? null) !==
                  (row.assetModelDescription ?? null)
                    ? "MANUAL"
                    : row.assetModelDescriptionSource ??
                      (row.assetModelDescription ? "MANUAL" : "NONE");
                return (
                  <Fragment key={row.rowNumber}>
                    <tr
                      className={`align-top ${
                        isIgnored ? "" : "bg-amber-50/40"
                      }`}
                    >
                      <td className="w-10 p-2 align-top">
                        <ImportReviewCheckbox
                          ariaLabel={`Approve ${
                            row.title || `row ${row.rowNumber}`
                          } for import`}
                          checked={decision?.decision === "APPROVE"}
                          disabled={
                            isResolved ||
                            fetcher.state !== "idle" ||
                            !rowCanImport
                          }
                          onChange={(checked) =>
                            updateDecision(row.rowNumber, {
                              decision: checked ? "APPROVE" : null,
                            })
                          }
                        />
                      </td>
                      <td className="break-words p-2 align-top">
                        <div className="break-words font-semibold leading-5 text-gray-950">
                          {row.title || "Unresolved item name"}
                        </div>
                        {effectiveTrackingType === "INDIVIDUAL" ? (
                          <span className="mt-1 inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900">
                            Individual tracking
                          </span>
                        ) : null}
                        <details className="mt-1 text-xs text-gray-500">
                          <summary className="w-fit cursor-pointer select-none hover:text-gray-800">
                            Details
                          </summary>
                          <div className="mt-2 max-w-md space-y-1.5 rounded-md bg-gray-50 p-2 text-xs leading-4 text-gray-700">
                            {row.manufacturer ? (
                              <p>
                                <span className="font-semibold">
                                  Manufacturer:
                                </span>{" "}
                                {row.manufacturer}
                              </p>
                            ) : null}
                            {row.sourceDescription &&
                            row.sourceDescription !== row.title ? (
                              <p>
                                <span className="font-semibold">
                                  Description:
                                </span>{" "}
                                {row.sourceDescription}
                              </p>
                            ) : null}
                            {row.assetModelDescription ? (
                              <p>
                                <span className="font-semibold">
                                  AssetModel description:
                                </span>{" "}
                                {row.assetModelDescription}
                              </p>
                            ) : null}
                            {row.productImageProposal?.status ===
                              "IMAGE_FOUND" &&
                            importProductImagePreview(
                              row.productImageProposal
                            ) ? (
                              <img
                                src={importProductImagePreview(
                                  row.productImageProposal
                                )}
                                alt={`Suggested product for ${row.title}`}
                                className="size-16 rounded border border-gray-200 bg-white object-contain"
                              />
                            ) : row.existingAssetModelImageUrl ? (
                              <img
                                src={
                                  row.existingAssetModelThumbnailUrl ??
                                  row.existingAssetModelImageUrl
                                }
                                alt={`Shelf model for ${row.title}`}
                                className="size-16 rounded border border-gray-200 bg-white object-contain"
                              />
                            ) : null}
                            {row.unitDescription ? (
                              <p>
                                <span className="font-semibold">Unit:</span>{" "}
                                {row.unitDescription}
                              </p>
                            ) : null}
                            {row.sourceNotes ? (
                              <p>
                                <span className="font-semibold">
                                  Source notes:
                                </span>{" "}
                                {row.sourceNotes}
                              </p>
                            ) : null}
                            {row.supplierPartNumber ? (
                              <p>
                                <span className="font-semibold">
                                  Supplier SKU:
                                </span>{" "}
                                {row.supplierPartNumber}
                              </p>
                            ) : null}
                            {row.manufacturerPartNumber ? (
                              <p>
                                <span className="font-semibold">MPN:</span>{" "}
                                {row.manufacturerPartNumber}
                              </p>
                            ) : null}
                            {effectiveTrackingType ? (
                              <p>
                                <span className="font-semibold">Tracking:</span>{" "}
                                {effectiveTrackingType === "INDIVIDUAL"
                                  ? "Individual / QR tracked"
                                  : "Quantity tracked"}
                              </p>
                            ) : null}
                            {effectiveTrackingType ? (
                              <p>
                                <span className="font-semibold">Reason:</span>{" "}
                                {decision?.type && decision.type !== row.type
                                  ? "Staff selected this tracking mode during review."
                                  : row.trackingReason ??
                                    "Default for identical stock and component inventory."}
                              </p>
                            ) : null}
                            {row.helperCandidate ? (
                              <>
                                <p>
                                  <span className="font-semibold">
                                    Product match:
                                  </span>{" "}
                                  {row.helperCandidate.productMatch.matchType.toLocaleLowerCase()}{" "}
                                  ·{" "}
                                  {Math.round(
                                    row.helperCandidate.productMatch
                                      .confidence * 100
                                  )}
                                  % confidence
                                  {helperMatchCandidate
                                    ? ` · ${helperMatchCandidate.title}`
                                    : row.helperCandidate.productMatch
                                        .candidateId
                                    ? ` · ${row.helperCandidate.productMatch.candidateId}`
                                    : ""}
                                </p>
                                <p>
                                  <span className="font-semibold">
                                    Tracking suggestion:
                                  </span>{" "}
                                  {trackingLabel(
                                    row.helperCandidate.trackingSuggestion.mode
                                  )}{" "}
                                  ·{" "}
                                  {Math.round(
                                    row.helperCandidate.trackingSuggestion
                                      .confidence * 100
                                  )}
                                  % confidence
                                </p>
                                {row.helperCandidate.kitHint.isKit ? (
                                  <p>
                                    <span className="font-semibold">
                                      Kit suggestion:
                                    </span>{" "}
                                    {row.helperCandidate.kitHint.name ??
                                      "Possible kit"}{" "}
                                    ·{" "}
                                    {Math.round(
                                      row.helperCandidate.kitHint.confidence *
                                        100
                                    )}
                                    % confidence
                                  </p>
                                ) : null}
                                {row.helperCandidate.questions.map(
                                  (question) => (
                                    <p key={question}>
                                      <span className="font-semibold">
                                        Question:
                                      </span>{" "}
                                      {question}
                                    </p>
                                  )
                                )}
                                {row.helperCandidate.settingsSuggestions
                                  .length > 0 ? (
                                  <p>
                                    <span className="font-semibold">
                                      Suggested settings:
                                    </span>{" "}
                                    {row.helperCandidate.settingsSuggestions
                                      .map(
                                        ({ key, value }) =>
                                          `${key}: ${String(value)}`
                                      )
                                      .join(", ")}
                                  </p>
                                ) : null}
                                {row.helperCandidate.locationSuggestions
                                  .length > 0 ? (
                                  <p>
                                    <span className="font-semibold">
                                      Location suggestions:
                                    </span>{" "}
                                    {row.helperCandidate.locationSuggestions
                                      .map(({ locationId, confidence }) => {
                                        const location =
                                          proposal.locationOptions?.find(
                                            (option) => option.id === locationId
                                          );
                                        return `${
                                          location?.pathLabel ?? locationId
                                        } (${Math.round(confidence * 100)}%)`;
                                      })
                                      .join(", ")}
                                  </p>
                                ) : null}
                              </>
                            ) : null}
                            {row.matchCandidates?.map((candidate) => (
                              <p key={candidate.id}>
                                <span className="font-semibold">
                                  Match candidate:
                                </span>{" "}
                                {candidate.title} · {candidate.id}
                                {candidate.quantity != null
                                  ? ` · quantity ${candidate.quantity}`
                                  : ""}
                                {candidate.category
                                  ? ` · ${candidate.category}`
                                  : ""}
                                {candidate.location
                                  ? ` · ${candidate.location}`
                                  : ""}
                              </p>
                            ))}
                            {row.enrichmentConfidence !== undefined ? (
                              <p>
                                <span className="font-semibold">
                                  Enrichment confidence:
                                </span>{" "}
                                {Math.round(row.enrichmentConfidence * 100)}%
                              </p>
                            ) : null}
                            {row.categoryConfidence ? (
                              <p>
                                <span className="font-semibold">
                                  Category confidence:
                                </span>{" "}
                                {row.categoryConfidence}
                                {row.categoryReason
                                  ? ` · ${row.categoryReason}`
                                  : ""}
                              </p>
                            ) : null}
                            {row.categoryResolution ? (
                              <p>
                                <span className="font-semibold">
                                  Category match state:
                                </span>{" "}
                                {actionLabel(row.categoryResolution)}
                              </p>
                            ) : null}
                            {row.locationResolution ? (
                              <p>
                                <span className="font-semibold">
                                  Location match state:
                                </span>{" "}
                                {actionLabel(row.locationResolution)}
                              </p>
                            ) : null}
                            {row.uncertainFields?.length ? (
                              <p>
                                <span className="font-semibold">
                                  Unresolved fields:
                                </span>{" "}
                                {row.uncertainFields.join(", ")}
                              </p>
                            ) : null}
                            {row.pdfClassification ? (
                              <p>
                                <span className="font-semibold">
                                  PDF row classification:
                                </span>{" "}
                                {actionLabel(row.pdfClassification)}
                              </p>
                            ) : null}
                            {row.orderedQuantity != null ? (
                              <p>Ordered quantity: {row.orderedQuantity}</p>
                            ) : null}
                            {row.receivedQuantity != null ? (
                              <p>Received quantity: {row.receivedQuantity}</p>
                            ) : null}
                            {quantity != null ? (
                              <p>Proposed quantity: {quantity}</p>
                            ) : null}
                            {row.quantityStatus ? (
                              <p>
                                Quantity status:{" "}
                                {actionLabel(row.quantityStatus)}
                              </p>
                            ) : null}
                            {selectedLocation || row.locationContext ? (
                              <p>
                                Location capacity context:{" "}
                                {selectedLocation?.currentUnits ??
                                  row.locationContext?.currentUnits ??
                                  0}{" "}
                                current units;{" "}
                                {row.locationContext?.proposedUnits ??
                                  row.quantity ??
                                  quantity ??
                                  0}{" "}
                                proposed units; capacity not configured.
                              </p>
                            ) : null}
                            <p>
                              <span className="font-semibold">
                                Review reason:
                              </span>{" "}
                              {row.reviewConflictReason || row.reason}
                            </p>
                            <p>
                              <span className="font-semibold">
                                Import action:
                              </span>{" "}
                              {actionLabel(row.action)}
                            </p>
                            {row.sourceEvidence?.map((evidence, index) => (
                              <p
                                key={`${evidence.sourceRef}-${index}`}
                                className="break-words"
                              >
                                <span className="font-semibold">
                                  Source page {evidence.page}:
                                </span>{" "}
                                {evidence.text}
                              </p>
                            ))}
                          </div>
                        </details>
                      </td>
                      <td className="whitespace-nowrap p-2 align-top font-semibold tabular-nums">
                        {quantity ?? "—"}
                      </td>
                      <td className="min-w-36 p-2 align-top">
                        {isResolved ? (
                          <span>
                            {selectedCategoryBadge?.name ??
                              selectedCategoryOption?.name ??
                              rowCategoryLabel ??
                              "Unassigned"}
                          </span>
                        ) : proposal.categoryOptions?.length ? (
                          <label className="relative inline-flex items-center rounded-md focus-within:ring-2 focus-within:ring-red-200">
                            {selectedCategoryBadge ? (
                              <CategoryBadge category={selectedCategoryBadge} />
                            ) : selectedCategoryOption ? (
                              <span>{selectedCategoryOption.name}</span>
                            ) : suggestedCategory &&
                              (row.categorySuggestionConfidence ?? 0) >= 0.5 ? (
                              <span className="text-amber-700">
                                Suggested: {suggestedCategory.name} · choose
                              </span>
                            ) : (
                              <span className="text-amber-700">
                                Choose category
                              </span>
                            )}
                            <span
                              aria-hidden="true"
                              className="px-1 text-gray-500"
                            >
                              ▾
                            </span>
                            <select
                              aria-label={`Category for ${row.title}`}
                              value={
                                (decision
                                  ? decision.categoryId
                                  : row.categoryId) ?? ""
                              }
                              onChange={(event) =>
                                updateDecision(row.rowNumber, {
                                  categoryId: event.currentTarget.value || null,
                                  approveNewCategory: false,
                                })
                              }
                              className="absolute inset-0 size-full cursor-pointer opacity-0"
                            >
                              <option value="">Choose a category</option>
                              {proposal.categoryOptions.map((category) => (
                                <option
                                  key={category.id}
                                  value={category.id}
                                  disabled={category.archived}
                                >
                                  {category.name}
                                  {category.archived ? " (archived)" : ""}
                                </option>
                              ))}
                            </select>
                          </label>
                        ) : (
                          <CategoryBadge category={selectedCategoryBadge} />
                        )}
                      </td>
                      <td className="break-words p-2 align-top text-gray-700">
                        {isResolved ? (
                          selectedLocation?.pathLabel ??
                          row.locationLabel ??
                          "Unassigned"
                        ) : (
                          <ImportLocationPicker
                            label={`Location for ${row.title}`}
                            locations={proposal.locationOptions ?? []}
                            selectedId={decision?.locationId ?? null}
                            suggestedId={suggestedLocation?.id ?? null}
                            onSelect={(locationId) =>
                              updateDecision(row.rowNumber, { locationId })
                            }
                          />
                        )}
                      </td>
                      <td className="p-2 align-top">
                        {proposedImage?.status === "IMAGE_FOUND" &&
                        importProductImagePreview(proposedImage) ? (
                          <img
                            src={importProductImagePreview(proposedImage)}
                            alt={`Proposed: ${row.title}`}
                            className="size-12 rounded border border-gray-200 bg-white object-contain"
                          />
                        ) : row.existingAssetModelThumbnailUrl ||
                          row.existingAssetModelImageUrl ? (
                          <img
                            src={
                              row.existingAssetModelThumbnailUrl ??
                              row.existingAssetModelImageUrl ??
                              ""
                            }
                            alt={`Shelf model: ${row.title}`}
                            className="size-12 rounded border border-gray-200 bg-white object-contain"
                          />
                        ) : (
                          <span className="text-xs text-gray-500">
                            No reliable image found
                          </span>
                        )}
                      </td>
                      <td className="p-2 align-top">
                        <span
                          className={`inline-flex rounded-full px-2 py-1 text-xs font-bold ${statusClassName}`}
                          role="status"
                        >
                          {statusLabel}
                        </span>
                        {(serverIssues[row.rowNumber] ?? rowValidation.issues)
                          .filter(
                            (issue) =>
                              !["IGNORED", "ALREADY_IMPORTED"].includes(
                                issue.code
                              )
                          )
                          .map((issue) => (
                            <p
                              key={issue.code}
                              className="mt-1 text-xs text-amber-800"
                            >
                              {issue.message}
                            </p>
                          ))}
                      </td>
                      <td className="p-2 align-top">
                        {isResolved ? null : (
                          <button
                            type="button"
                            aria-expanded={editRowNumber === row.rowNumber}
                            aria-controls={
                              editRowNumber === row.rowNumber
                                ? `import-row-editor-${row.rowNumber}`
                                : undefined
                            }
                            onClick={() =>
                              setEditRowNumber((current) =>
                                current === row.rowNumber ? null : row.rowNumber
                              )
                            }
                            className="w-full max-w-[68px] rounded-md border border-gray-300 px-2 py-1.5 text-xs font-bold text-gray-700 hover:bg-gray-50"
                          >
                            Edit
                          </button>
                        )}
                      </td>
                    </tr>
                    {editRowNumber === row.rowNumber ? (
                      <tr className="border-b border-gray-100 bg-white">
                        <td colSpan={8} className="p-2">
                          <div
                            id={`import-row-editor-${row.rowNumber}`}
                            role="group"
                            aria-label={`Edit ${
                              row.title || `row ${row.rowNumber}`
                            }`}
                            className="w-full rounded-lg border border-gray-200 bg-white p-3 text-sm font-normal sm:p-4"
                          >
                            <h4 className="mb-4 text-sm font-semibold text-gray-900">
                              Edit asset
                            </h4>
                            <div className="grid grid-cols-1 items-start gap-x-6 gap-y-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(220px,0.8fr)]">
                              <Input
                                label="Item name"
                                name={`review-title-${row.rowNumber}`}
                                value={
                                  reviewDecisions[row.rowNumber]?.title ?? ""
                                }
                                onChange={(event) =>
                                  updateDecision(row.rowNumber, {
                                    title: event.target.value,
                                  })
                                }
                                className="w-full min-w-0"
                                inputClassName="min-w-0"
                              />
                              <Input
                                label="Inventory quantity"
                                name={`review-quantity-${row.rowNumber}`}
                                type="number"
                                min={1}
                                value={
                                  reviewDecisions[row.rowNumber]?.quantity ?? ""
                                }
                                onChange={(event) =>
                                  updateDecision(row.rowNumber, {
                                    quantity: event.target.value
                                      ? Number(event.target.value)
                                      : null,
                                  })
                                }
                                className="w-full min-w-0 max-w-48"
                                inputClassName="min-w-0"
                              />

                              <div className="min-w-0">
                                <p className={EDIT_FORM_LABEL_CLASS}>
                                  Location
                                </p>
                                <div className="flex min-h-10 w-full min-w-0 items-center rounded-[4px] border border-gray-300 bg-white px-3 py-2 focus-within:border-primary-300 focus-within:ring-2 focus-within:ring-primary-25">
                                  <ImportLocationPicker
                                    label="Location"
                                    locations={proposal.locationOptions ?? []}
                                    className="w-full justify-between"
                                    selectedId={
                                      reviewDecisions[row.rowNumber]
                                        ?.locationId ?? null
                                    }
                                    suggestedId={suggestedLocation?.id ?? null}
                                    onSelect={(locationId) =>
                                      updateDecision(row.rowNumber, {
                                        locationId,
                                      })
                                    }
                                  />
                                </div>
                              </div>

                              <div className="min-w-0">
                                {proposal.categoryOptions?.length ? (
                                  <label className="block min-w-0">
                                    <span className={EDIT_FORM_LABEL_CLASS}>
                                      Category
                                    </span>
                                    <select
                                      value={
                                        reviewDecisions[row.rowNumber]
                                          ?.categoryId ?? ""
                                      }
                                      onChange={(event) =>
                                        updateDecision(row.rowNumber, {
                                          categoryId:
                                            event.target.value || null,
                                          approveNewCategory: false,
                                        })
                                      }
                                      className={EDIT_FORM_SELECT_CLASS}
                                    >
                                      <option value="">
                                        Choose a category
                                      </option>
                                      {proposal.categoryOptions.map(
                                        (category) => (
                                          <option
                                            key={category.id}
                                            value={category.id}
                                            disabled={category.archived}
                                          >
                                            {category.name}
                                            {category.archived
                                              ? " (archived)"
                                              : ""}
                                          </option>
                                        )
                                      )}
                                    </select>
                                  </label>
                                ) : (
                                  <p className={EDIT_FORM_LABEL_CLASS}>
                                    Category
                                  </p>
                                )}
                                {!isMouserInvoice &&
                                !reviewDecisions[row.rowNumber]?.categoryId ? (
                                  <div className="mt-3 min-w-0">
                                    <Input
                                      label="Proposed category"
                                      name={`review-category-${row.rowNumber}`}
                                      value={
                                        reviewDecisions[row.rowNumber]
                                          ?.newCategoryName ??
                                        row.proposedCategoryName ??
                                        ""
                                      }
                                      onChange={(event) =>
                                        updateDecision(row.rowNumber, {
                                          newCategoryName: event.target.value,
                                          approveNewCategory: false,
                                        })
                                      }
                                      className="w-full min-w-0"
                                      inputClassName="min-w-0"
                                    />
                                    <label className="mt-2 flex items-start gap-2 text-xs text-gray-600">
                                      <input
                                        type="checkbox"
                                        checked={
                                          reviewDecisions[row.rowNumber]
                                            ?.approveNewCategory ?? false
                                        }
                                        onChange={(event) =>
                                          updateDecision(row.rowNumber, {
                                            approveNewCategory:
                                              event.target.checked,
                                          })
                                        }
                                        disabled={!canCreateCategory}
                                      />
                                      <span>
                                        Allow creating this category
                                        {!canCreateCategory
                                          ? ". Choose an active category instead; your role cannot create categories."
                                          : ""}
                                      </span>
                                    </label>
                                  </div>
                                ) : null}
                              </div>

                              <div className="min-w-0">
                                <label className="block min-w-0">
                                  <span className={EDIT_FORM_LABEL_CLASS}>
                                    Tracking mode
                                  </span>
                                  <select
                                    value={effectiveTrackingType ?? ""}
                                    disabled={isExistingTrackingSelection}
                                    onChange={(event) =>
                                      updateDecision(row.rowNumber, {
                                        type:
                                          event.target.value === "INDIVIDUAL" ||
                                          event.target.value ===
                                            "QUANTITY_TRACKED"
                                            ? event.target.value
                                            : null,
                                        trackingModeConfirmed: false,
                                        trackingModeSelectedByStaff: true,
                                        decision: null,
                                      })
                                    }
                                    className={EDIT_FORM_SELECT_CLASS}
                                  >
                                    <option value="QUANTITY_TRACKED">
                                      Quantity
                                    </option>
                                    <option value="INDIVIDUAL">
                                      Individual (manual)
                                    </option>
                                  </select>
                                </label>
                                <p className="mt-1 text-xs text-gray-500">
                                  {isExistingTrackingSelection
                                    ? "Inherited from this existing Shelf model."
                                    : "New products use Quantity tracking by default."}
                                </p>
                                {individualTrackingRequiresConfirmation ? (
                                  <label className="mt-2 flex items-start gap-2 text-xs text-gray-600">
                                    <input
                                      type="checkbox"
                                      checked={
                                        reviewDecisions[row.rowNumber]
                                          ?.trackingModeConfirmed ?? false
                                      }
                                      onChange={(event) =>
                                        updateDecision(row.rowNumber, {
                                          trackingModeConfirmed:
                                            event.currentTarget.checked,
                                          decision: null,
                                        })
                                      }
                                    />
                                    <span>
                                      Confirm separate individual QR-tracked
                                      assets on Apply.
                                    </span>
                                  </label>
                                ) : null}
                              </div>

                              {reviewDecisions[row.rowNumber]?.type ===
                              "QUANTITY_TRACKED" ? (
                                <label className="block min-w-0">
                                  <span className={EDIT_FORM_LABEL_CLASS}>
                                    Consumption type
                                  </span>
                                  <select
                                    value={
                                      reviewDecisions[row.rowNumber]
                                        ?.consumptionType ?? ""
                                    }
                                    onChange={(event) =>
                                      updateDecision(row.rowNumber, {
                                        consumptionType:
                                          event.target.value === "ONE_WAY" ||
                                          event.target.value === "TWO_WAY"
                                            ? event.target.value
                                            : null,
                                      })
                                    }
                                    className={EDIT_FORM_SELECT_CLASS}
                                  >
                                    <option value="">
                                      Choose consumption type
                                    </option>
                                    <option value="TWO_WAY">Returnable</option>
                                    <option value="ONE_WAY">Consumable</option>
                                  </select>
                                </label>
                              ) : null}

                              <div className="min-w-0 max-w-xl lg:col-span-2">
                                <p className={`${EDIT_FORM_LABEL_CLASS} mb-2`}>
                                  Image
                                </p>
                                <div className="grid min-w-0 grid-cols-1 items-start gap-3 sm:grid-cols-[80px_minmax(0,1fr)]">
                                  <div className="flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-[4px] border border-gray-300 bg-white">
                                    {row.existingAssetModelImageUrl ? (
                                      <img
                                        src={
                                          row.existingAssetModelThumbnailUrl ??
                                          row.existingAssetModelImageUrl
                                        }
                                        alt={`Existing Shelf model for ${row.title}`}
                                        className="size-full object-contain"
                                      />
                                    ) : proposedImage?.status ===
                                        "IMAGE_FOUND" &&
                                      importProductImagePreview(
                                        proposedImage
                                      ) ? (
                                      <img
                                        src={importProductImagePreview(
                                          proposedImage
                                        )}
                                        alt={`Proposed: ${row.title}`}
                                        className="size-full object-contain"
                                      />
                                    ) : (
                                      <span className="px-2 text-center text-xs text-gray-500">
                                        No image
                                      </span>
                                    )}
                                  </div>
                                  <div className="min-w-0 space-y-2">
                                    {row.existingAssetModelImageUrl ? (
                                      <p className="text-sm text-gray-600">
                                        Using the image from this existing Shelf
                                        model.
                                      </p>
                                    ) : proposedImage?.status ===
                                        "IMAGE_FOUND" &&
                                      importProductImagePreview(
                                        proposedImage
                                      ) ? (
                                      <>
                                        <p className="text-sm text-gray-700">
                                          {proposedImage.source ===
                                          "MANUAL_UPLOAD"
                                            ? "Selected image"
                                            : "Product image found"}
                                        </p>
                                        <p className="break-words text-xs text-gray-500">
                                          {proposedImage.sourceName ??
                                            "Product image"}
                                          {proposedImage.source
                                            ? ` · ${actionLabel(
                                                proposedImage.source
                                              )}`
                                            : ""}
                                          {proposedImage.license
                                            ? ` · ${proposedImage.license}`
                                            : ""}
                                          {proposedImage.sourceUrl &&
                                          /^https?:\/\//i.test(
                                            proposedImage.sourceUrl
                                          ) ? (
                                            <>
                                              {" · "}
                                              <a
                                                href={proposedImage.sourceUrl}
                                                target="_blank"
                                                rel="noreferrer"
                                                className="underline"
                                              >
                                                source
                                              </a>
                                            </>
                                          ) : null}
                                        </p>
                                        <label className="flex items-start gap-2 text-xs text-gray-600">
                                          <input
                                            type="checkbox"
                                            checked={
                                              reviewDecisions[row.rowNumber]
                                                ?.acceptSuggestedImage ?? false
                                            }
                                            onChange={(event) =>
                                              updateDecision(row.rowNumber, {
                                                acceptSuggestedImage:
                                                  event.target.checked,
                                              })
                                            }
                                          />
                                          <span>
                                            Use this image for the Shelf product
                                          </span>
                                        </label>
                                        <button
                                          type="button"
                                          onClick={() =>
                                            updateDecision(row.rowNumber, {
                                              manualImage: null,
                                              acceptSuggestedImage: false,
                                            })
                                          }
                                          className="text-xs font-medium text-gray-600 underline"
                                        >
                                          Remove image
                                        </button>
                                      </>
                                    ) : (
                                      <>
                                        <p className="text-sm text-gray-700">
                                          No reliable image found.
                                        </p>
                                        {imageFailureMessage(
                                          proposedImage?.failureReason
                                        ) ? (
                                          <p className="text-xs text-gray-500">
                                            {imageFailureMessage(
                                              proposedImage?.failureReason
                                            )}
                                          </p>
                                        ) : null}
                                        {decision?.manualImage === null ? (
                                          <p className="text-xs text-gray-500">
                                            No image selected.
                                          </p>
                                        ) : null}
                                      </>
                                    )}
                                    {!row.existingAssetModelImageUrl ? (
                                      <label className="block text-sm text-gray-700">
                                        {proposedImage?.status === "IMAGE_FOUND"
                                          ? "Replace image"
                                          : "Upload image"}
                                        <input
                                          type="file"
                                          accept="image/jpeg,image/png,image/webp"
                                          disabled={
                                            imageFetcher.state !== "idle"
                                          }
                                          onChange={(event) => {
                                            uploadProductImage(
                                              row.rowNumber,
                                              event.currentTarget.files?.[0]
                                            );
                                            event.currentTarget.value = "";
                                          }}
                                          className="mt-1 block w-full text-xs text-gray-700 file:mr-3 file:rounded-[4px] file:border-0 file:bg-gray-100 file:px-3 file:py-2 file:text-xs file:font-medium file:text-gray-700 hover:file:bg-gray-200"
                                        />
                                      </label>
                                    ) : null}
                                    {imageFetcher.data?.error ? (
                                      <p
                                        role="alert"
                                        className="text-sm text-red-700"
                                      >
                                        {imageFetcher.data.error.message}
                                      </p>
                                    ) : imageFetcher.state !== "idle" ? (
                                      <p className="text-xs text-gray-500">
                                        Processing image…
                                      </p>
                                    ) : null}
                                  </div>
                                </div>
                              </div>

                              <div className="min-w-0 lg:col-span-2">
                                <Input
                                  label="Description"
                                  name={`review-description-${row.rowNumber}`}
                                  inputType="textarea"
                                  rows={4}
                                  maxLength={600}
                                  value={
                                    reviewDecisions[row.rowNumber]
                                      ?.assetModelDescription ?? ""
                                  }
                                  onChange={(event) =>
                                    updateDecision(row.rowNumber, {
                                      assetModelDescription:
                                        event.target.value || null,
                                    })
                                  }
                                  className="w-full min-w-0 max-w-[512px]"
                                  inputClassName="min-h-[100px] min-w-0 resize-y"
                                />
                                <p className="mt-2">
                                  <span className="inline-flex rounded-[4px] bg-gray-100 px-2 py-1 text-xs font-medium text-gray-600">
                                    Source:{" "}
                                    {descriptionSourceLabel(descriptionSource)}
                                  </span>
                                </p>
                              </div>
                            </div>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
      {totalReviewPages > 1 ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-sm text-gray-600">
          <span>
            Rows {firstReviewRow} to {lastReviewRow} of {proposal.rows.length}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={reviewPage === 0}
              onClick={() => setReviewPage((page) => Math.max(0, page - 1))}
              className="rounded-lg border border-gray-300 px-3 py-1.5 font-bold text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Previous
            </button>
            <span className="px-2 py-1.5 font-bold text-gray-700">
              Page {reviewPage + 1} of {totalReviewPages}
            </span>
            <button
              type="button"
              disabled={reviewPage >= totalReviewPages - 1}
              onClick={() =>
                setReviewPage((page) =>
                  Math.min(totalReviewPages - 1, page + 1)
                )
              }
              className="rounded-lg border border-gray-300 px-3 py-1.5 font-bold text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Next
            </button>
          </div>
        </div>
      ) : null}
      {implementedRows.length > 0 ? (
        <section
          className={IMPORT_REVIEW_SECTION_CLASS}
          aria-labelledby="implemented-import-rows"
        >
          <ImportReviewSectionHeader
            id="implemented-import-rows"
            title="Implemented"
            count={implementedRows.length}
            selectedCount={selectedRevertibleRows.length}
            selectedLabel="selected"
            actions={
              selectedRevertibleRows.length > 0 ? (
                <revertFetcher.Form
                  method="post"
                  action={actionPath}
                  className="flex min-w-0 flex-wrap items-center gap-2"
                >
                  <input type="hidden" name="intent" value="revert-selected" />
                  <input
                    type="hidden"
                    name="operationId"
                    value={proposal.operationId}
                  />
                  <input
                    type="hidden"
                    name="rowNumbers"
                    value={JSON.stringify(selectedRevertibleRows)}
                  />
                  <Button
                    type="submit"
                    variant="danger"
                    size="md"
                    disabled={revertFetcher.state !== "idle"}
                    className="whitespace-nowrap"
                  >
                    {revertFetcher.state !== "idle"
                      ? "Reverting…"
                      : "Revert selected"}
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="md"
                    className="whitespace-nowrap"
                    onClick={() => setSelectedImplementedRowNumbers([])}
                  >
                    Cancel
                  </Button>
                </revertFetcher.Form>
              ) : null
            }
          />
          <div className="overflow-x-auto">
            <table className={IMPORT_REVIEW_TABLE_CLASS}>
              <thead className={IMPORT_REVIEW_TABLE_HEAD_CLASS}>
                <tr>
                  <th className="w-10 p-2">
                    <ImportReviewCheckbox
                      ariaLabel="Select all implemented rows that can be reverted"
                      checked={allRevertibleRowsSelected}
                      indeterminate={someRevertibleRowsSelected}
                      disabled={
                        revertibleImplementedRows.length === 0 ||
                        revertFetcher.state !== "idle"
                      }
                      onChange={(checked) =>
                        setSelectedImplementedRowNumbers(
                          checked
                            ? revertibleImplementedRows.map(
                                (row) => row.rowNumber
                              )
                            : []
                        )
                      }
                    />
                  </th>
                  <th className="w-[190px] p-2">Product</th>
                  <th className="w-16 p-2">Qty</th>
                  <th className="w-[148px] p-2">Category</th>
                  <th className="w-[188px] p-2">Location</th>
                  <th className="w-20 p-2">Image</th>
                  <th className="w-28 p-2">Status</th>
                  <th className="w-[88px] p-2">
                    <span className="sr-only">No row action</span>
                  </th>
                </tr>
              </thead>
              <tbody className={IMPORT_REVIEW_TABLE_BODY_CLASS}>
                {implementedRows.map((row) => {
                  const decision = reviewDecisions[row.rowNumber];
                  const canRevert = revertibleRowNumbers.has(row.rowNumber);
                  const location = proposal.locationOptions?.find(
                    (option) =>
                      option.id === (decision?.locationId ?? row.locationId)
                  );
                  const category =
                    decision?.categoryId && proposal.categoryOptions
                      ? proposal.categoryOptions.find(
                          (option) => option.id === decision.categoryId
                        )?.name
                      : null;
                  const checked = selectedImplementedRowNumbers.includes(
                    row.rowNumber
                  );
                  const imageSource =
                    row.productImageProposal?.status === "IMAGE_FOUND"
                      ? importProductImagePreview(row.productImageProposal)
                      : row.existingAssetModelThumbnailUrl ??
                        row.existingAssetModelImageUrl;
                  return (
                    <tr key={row.rowNumber}>
                      <td className="w-10 p-2 align-top">
                        <ImportReviewCheckbox
                          ariaLabel={`Select ${
                            row.title || `row ${row.rowNumber}`
                          } to revert`}
                          checked={checked}
                          disabled={
                            !canRevert || revertFetcher.state !== "idle"
                          }
                          onChange={(nextChecked) =>
                            setSelectedImplementedRowNumbers((current) =>
                              nextChecked
                                ? [...current, row.rowNumber]
                                : current.filter(
                                    (number) => number !== row.rowNumber
                                  )
                            )
                          }
                        />
                      </td>
                      <td className="break-words p-2 align-top font-semibold text-gray-950">
                        {row.title || `Row ${row.rowNumber}`}
                      </td>
                      <td className="whitespace-nowrap p-2 align-top font-semibold tabular-nums text-gray-700">
                        {decision?.quantity ??
                          row.receivedQuantity ??
                          row.quantity ??
                          "—"}
                      </td>
                      <td className="break-words p-2 align-top text-gray-700">
                        {category ||
                          row.category ||
                          row.suggestedCategory ||
                          "—"}
                      </td>
                      <td className="break-words p-2 align-top text-gray-700">
                        {location?.pathLabel ?? row.locationLabel ?? "—"}
                      </td>
                      <td className="p-2 align-top">
                        {imageSource ? (
                          <img
                            src={imageSource}
                            alt={`Shelf model: ${row.title}`}
                            className="size-12 rounded border border-gray-200 bg-white object-contain"
                          />
                        ) : (
                          <span className="text-xs text-gray-500">—</span>
                        )}
                      </td>
                      <td className="p-2 align-top text-xs font-semibold text-gray-600">
                        {canRevert ? "Implemented" : "Revert unavailable"}
                      </td>
                      <td aria-hidden="true" className="p-2 align-top" />
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {revertFetcher.data?.error ? (
            <p className="mt-2 text-sm text-red-700" role="alert">
              {revertFetcher.data.error.message}
            </p>
          ) : revertFetcher.data?.kind === "import-rows-reverted" &&
            revertFetcher.data.result.failedRows.length > 0 ? (
            <p className="mt-2 text-sm text-amber-800" role="status">
              Reverted {revertFetcher.data.result.revertedRowNumbers.length};{" "}
              {revertFetcher.data.result.failedRows.length} could not be
              reverted.
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

function ImportReviewSectionHeader({
  id,
  title,
  count,
  selectedCount = 0,
  selectedLabel = "selected",
  actions,
}: {
  id: string;
  title: string;
  count: number;
  selectedCount?: number;
  selectedLabel?: string;
  actions?: ReactNode;
}) {
  const hasActions = selectedCount > 0 || actions;

  return (
    <div className={IMPORT_REVIEW_SECTION_HEADER_CLASS}>
      <h4 id={id} className="min-w-0 text-sm font-bold text-gray-900">
        {title} <span className="font-semibold text-gray-500">({count})</span>
      </h4>
      {hasActions ? (
        <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-3">
          {selectedCount > 0 ? (
            <span className="text-sm font-medium tabular-nums text-gray-500">
              {selectedCount} {selectedLabel}
            </span>
          ) : null}
          {actions}
        </div>
      ) : null}
    </div>
  );
}

function ImportReviewCheckbox({
  ariaLabel,
  checked,
  indeterminate = false,
  disabled = false,
  onChange,
}: {
  ariaLabel: string;
  checked: boolean;
  indeterminate?: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-label={ariaLabel}
      aria-checked={indeterminate ? "mixed" : checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="inline-flex size-6 shrink-0 items-center justify-center rounded hover:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
    >
      {indeterminate ? (
        <PartialCheckboxIcon className="size-5" />
      ) : (
        <FakeCheckbox
          checked={checked}
          className={`size-5 ${checked ? "text-primary" : "text-white"}`}
        />
      )}
    </button>
  );
}
