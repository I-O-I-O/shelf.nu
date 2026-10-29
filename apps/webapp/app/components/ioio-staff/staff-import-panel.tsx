import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useFetcher, useLocation, useNavigate } from "react-router";
import { CategoryBadge } from "~/components/assets/category-badge";
import { ImportLocationPicker } from "~/components/ioio-staff/import-location-picker";
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
  decision: ReviewDecision | undefined,
  decisionOverride?: ReviewDecision["decision"]
) {
  return {
    rowNumber,
    decision: decisionOverride ?? decision?.decision,
    title: decision?.title,
    assetId: decision?.assetId,
    categoryId: decision?.categoryId,
    newCategoryName: decision?.newCategoryName,
    approveNewCategory: decision?.approveNewCategory,
    locationId: decision?.locationId,
    quantity: decision?.quantity,
    type: decision?.type,
    trackingModeConfirmed: decision?.trackingModeConfirmed,
    productChoice: decision?.productChoice,
    minQuantity: decision?.minQuantity,
    unitOfMeasure: decision?.unitOfMeasure,
    consumptionType: decision?.consumptionType,
    assetModelDescription: decision?.assetModelDescription,
    acceptSuggestedImage: decision?.acceptSuggestedImage,
    manualImage: decision?.manualImage,
  };
}

function isSafeReviewAction(
  row: StaffImportProposalRow,
  decision?: ReviewDecision
) {
  const selectedExisting =
    decision?.productChoice === "EXISTING" && Boolean(decision.assetId);
  const effectiveType = decision?.type ?? row.type;
  return (
    (effectiveType !== "INDIVIDUAL" ||
      row.trackingSource === "EXISTING_MODEL" ||
      selectedExisting) &&
    [
      "CREATE",
      "INCREASE_QUANTITY",
      "NO_CHANGE",
      "UPDATE_QUANTITY",
      "UPDATE_CATEGORY",
      "UPDATE_LOCATION",
    ].includes(row.action)
  );
}

function actionLabel(action: string) {
  return action
    .replaceAll("_", " ")
    .toLocaleLowerCase()
    .replace(/(^|\s)\S/g, (character) => character.toUpperCase());
}

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
    (response.kind === "import-proposal" || response.kind === "import-partial")
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
    response?.error === null && response.kind === "import-result"
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
          }:${proposal.ignoredRowNumbers?.join(",") ?? ""}`}
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
  const [selectedRowNumbers, setSelectedRowNumbers] = useState<number[]>([]);
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
        const defaults = {
          decision: row.action === "IGNORE" ? "IGNORE" : null,
          title: row.title,
          assetId: row.assetId,
          categoryId: row.categoryId,
          newCategoryName: row.proposedCategoryName ?? null,
          approveNewCategory: false,
          locationId: row.locationId,
          quantity: row.receivedQuantity ?? row.quantity ?? null,
          type: row.type ?? "QUANTITY_TRACKED",
          trackingModeConfirmed: false,
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
            ((row.type ?? "QUANTITY_TRACKED") === "QUANTITY_TRACKED"
              ? "pcs"
              : null),
          consumptionType:
            (row.helperCandidate?.settingsSuggestions.find(
              (setting) => setting.key === "consumptionType"
            )?.value as "ONE_WAY" | "TWO_WAY" | undefined) ??
            ((row.type ?? "QUANTITY_TRACKED") === "QUANTITY_TRACKED"
              ? "TWO_WAY"
              : null),
          assetModelDescription: row.assetModelDescription ?? null,
          acceptSuggestedImage:
            row.productImageProposal?.status === "IMAGE_FOUND" &&
            row.productImageProposal.autoAccepted === true,
        } satisfies ReviewDecision;
        return [
          row.rowNumber,
          { ...defaults, ...savedDecisionByRow.get(row.rowNumber) },
        ];
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
  const isResolvedRow = (rowNumber: number) =>
    appliedRowNumbers.has(rowNumber) || ignoredRowNumbers.has(rowNumber);
  const isSavedDraft =
    Boolean(proposal.savedReviewDecisions?.length) ||
    (response?.error === null && response.kind === "import-draft-saved");
  const reviewCount = proposal.rows.filter(
    (row) =>
      !isResolvedRow(row.rowNumber) &&
      ["Review", "Possible match", "Conflict"].includes(
        reviewBadges[row.rowNumber].label
      )
  ).length;
  const approvedCount = proposal.rows.filter(
    (row) =>
      !isResolvedRow(row.rowNumber) &&
      reviewDecisions[row.rowNumber]?.decision === "APPROVE" &&
      reviewStates[row.rowNumber] === "READY"
  ).length;
  const readyCount = proposal.rows.filter((row) => {
    if (isResolvedRow(row.rowNumber)) return false;
    if (reviewBadges[row.rowNumber].label !== "Ready") return false;
    if (!isMouserInvoice) return true;
    const decision = reviewDecisions[row.rowNumber];
    const hasCategory = Boolean(
      decision?.categoryId ||
        (decision?.approveNewCategory && decision.newCategoryName?.trim())
    );
    return hasCategory && Boolean(decision?.locationId);
  }).length;
  const unresolvedCategoryCount = isMouserInvoice
    ? proposal.rows.filter((row) => {
        const decision = reviewDecisions[row.rowNumber];
        return (
          decision?.decision !== "IGNORE" &&
          !decision?.categoryId &&
          !(decision?.approveNewCategory && decision.newCategoryName?.trim())
        );
      }).length
    : 0;
  const unresolvedLocationCount = isMouserInvoice
    ? proposal.rows.filter(
        (row) =>
          reviewDecisions[row.rowNumber]?.decision !== "IGNORE" &&
          !reviewDecisions[row.rowNumber]?.locationId
      ).length
    : 0;
  const ignoredCount = proposal.rows.filter(
    (row) =>
      !isResolvedRow(row.rowNumber) &&
      reviewBadges[row.rowNumber].label === "Ignored"
  ).length;
  const applyableCount = proposal.rows.filter(
    (row) =>
      !isResolvedRow(row.rowNumber) &&
      (reviewDecisions[row.rowNumber]?.decision === "IGNORE" ||
        (reviewDecisions[row.rowNumber]?.decision === "APPROVE" &&
          reviewStates[row.rowNumber] === "READY"))
  ).length;
  const selectedSafeRows = proposal.rows.filter(
    (row) =>
      !isResolvedRow(row.rowNumber) &&
      selectedRowNumbers.includes(row.rowNumber) &&
      isSafeReviewAction(row, reviewDecisions[row.rowNumber])
  );
  const canApply =
    applyableCount > 0 &&
    fetcher.state === "idle" &&
    (proposalState === "review" ||
      proposalState === "error" ||
      proposalState === "in-progress");
  const duplicateResponse =
    response?.error === null && response.kind === "import-duplicate"
      ? response.duplicate
      : null;
  const duplicateBlocksApply =
    duplicateResponse !== null &&
    (!duplicateResponse.canOverride || !allowSameFileReimport);
  const serializeReviewDecisions = (approveRowNumber?: number) =>
    JSON.stringify(
      proposal.rows.map((row) =>
        serializeReviewDecision(
          row.rowNumber,
          reviewDecisions[row.rowNumber],
          row.rowNumber === approveRowNumber ? "APPROVE" : undefined
        )
      )
    );
  const serializedReviewDecisions = serializeReviewDecisions();
  const totalReviewPages = Math.max(
    1,
    Math.ceil(proposal.rows.length / IMPORT_REVIEW_PAGE_SIZE)
  );
  const reviewRows = proposal.rows.slice(
    reviewPage * IMPORT_REVIEW_PAGE_SIZE,
    (reviewPage + 1) * IMPORT_REVIEW_PAGE_SIZE
  );
  const selectableReviewRows = reviewRows.filter(
    (row) => !isResolvedRow(row.rowNumber)
  );
  const selectedVisibleCount = selectableReviewRows.filter((row) =>
    selectedRowNumbers.includes(row.rowNumber)
  ).length;
  const allVisibleSelected =
    selectableReviewRows.length > 0 &&
    selectedVisibleCount === selectableReviewRows.length;
  const firstReviewRow = reviewPage * IMPORT_REVIEW_PAGE_SIZE + 1;
  const lastReviewRow = Math.min(
    (reviewPage + 1) * IMPORT_REVIEW_PAGE_SIZE,
    proposal.rows.length
  );

  const updateDecision = (
    rowNumber: number,
    changes: Partial<ReviewDecision>
  ) => {
    setServerIssues((current) => {
      const next = { ...current };
      delete next[rowNumber];
      return next;
    });
    setReviewDecisions((current) => ({
      ...current,
      [rowNumber]: {
        ...current[rowNumber],
        ...changes,
      },
    }));
  };

  const importRows = (rowNumbers: number[]) => {
    const formData = new FormData();
    formData.set(
      "intent",
      rowNumbers.length === 1 ? "apply-row" : "apply-selected"
    );
    formData.set("operationId", proposal.operationId);
    formData.set("proposalHash", proposal.proposalHash);
    formData.set("allowSameFileReimport", String(allowSameFileReimport));
    formData.set("rowNumber", String(rowNumbers[0]));
    formData.set("rowNumbers", JSON.stringify(rowNumbers));
    formData.set(
      "reviewDecisions",
      JSON.stringify(
        proposal.rows.map((row) =>
          serializeReviewDecision(
            row.rowNumber,
            reviewDecisions[row.rowNumber],
            rowNumbers.includes(row.rowNumber) &&
              reviewDecisions[row.rowNumber]?.decision !== "IGNORE"
              ? "APPROVE"
              : undefined
          )
        )
      )
    );
    void fetcher.submit(formData, { method: "post", action: actionPath });
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

  const toggleSelectedRow = (rowNumber: number, checked: boolean) => {
    setSelectedRowNumbers((current) =>
      checked
        ? current.includes(rowNumber)
          ? current
          : [...current, rowNumber]
        : current.filter((number) => number !== rowNumber)
    );
  };

  const toggleVisibleRows = (checked: boolean) => {
    const visibleNumbers = selectableReviewRows.map((row) => row.rowNumber);
    setSelectedRowNumbers((current) =>
      checked
        ? [...new Set([...current, ...visibleNumbers])]
        : current.filter((number) => !visibleNumbers.includes(number))
    );
  };

  const approveSelectedSafeRows = () => {
    setReviewDecisions((current) => {
      const next = { ...current };
      selectedSafeRows.forEach((row) => {
        next[row.rowNumber] = { ...next[row.rowNumber], decision: "APPROVE" };
      });
      return next;
    });
  };

  const ignoreSelectedRows = () => {
    setReviewDecisions((current) => {
      const next = { ...current };
      selectedRowNumbers.forEach((rowNumber) => {
        if (!isResolvedRow(rowNumber)) {
          next[rowNumber] = { ...next[rowNumber], decision: "IGNORE" };
        }
      });
      return next;
    });
  };

  useEffect(() => {
    if (!fetcher.data) return;
    if (!fetcher.data.error && fetcher.data.kind === "import-review-blocked") {
      setServerIssues(
        Object.fromEntries(
          fetcher.data.blockedRows.map((row) => [row.rowNumber, row.issues])
        )
      );
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
    if (fetcher.data.kind === "import-partial") {
      setProposalState("review");
      setSelectedRowNumbers([]);
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
  }, [fetcher.data, onReset]);

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
          <p className="mt-0.5 text-xs text-gray-500">
            {isSavedDraft
              ? "Draft · Nothing changes in Shelf until Apply."
              : "Nothing changes until you confirm the import."}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
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
            <button
              type="submit"
              disabled={
                !canApply || duplicateBlocksApply || fetcher.state !== "idle"
              }
              className="rounded-xl bg-red-700 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {allowSameFileReimport
                ? "Apply changed proposal anyway"
                : approvedCount === 1
                ? "Apply 1 approved item"
                : approvedCount > 1
                ? `Apply ${approvedCount} approved items`
                : ignoredCount > 0
                ? `Confirm ${ignoredCount} ignored ${
                    ignoredCount === 1 ? "row" : "rows"
                  }`
                : "Apply approved changes"}
            </button>
            <input
              type="hidden"
              name="reviewDecisions"
              value={serializedReviewDecisions}
            />
          </fetcher.Form>
          <fetcher.Form method="post" action={actionPath}>
            <input type="hidden" name="intent" value="save-draft" />
            <input
              type="hidden"
              name="operationId"
              value={proposal.operationId}
            />
            <input
              type="hidden"
              name="reviewDecisions"
              value={serializedReviewDecisions}
            />
            <button
              type="submit"
              disabled={
                fetcher.state !== "idle" ||
                !["review", "error"].includes(proposalState)
              }
              className="rounded-xl border border-gray-300 px-4 py-2.5 text-sm font-bold text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Save for later
            </button>
          </fetcher.Form>
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
            <button
              type="submit"
              disabled={fetcher.state !== "idle" || proposalState !== "review"}
              className="rounded-xl border border-gray-300 px-4 py-2.5 text-sm font-bold text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
          </fetcher.Form>
        </div>
      </div>

      {fetcher.state !== "idle" ? (
        <p className="mt-3 text-sm text-gray-500" role="status">
          {fetcher.formData?.get("intent") === "save-draft"
            ? "Saving draft..."
            : fetcher.formData?.get("intent") === "cancel-import"
            ? "Cancelling import proposal..."
            : "Applying approved changes..."}
        </p>
      ) : null}
      {response?.error === null &&
      response.kind === "import-review-blocked" &&
      activeBlockedRows.length > 0 ? (
        <div role="alert" className="mt-3 text-sm text-amber-800">
          <p>
            {response.readyCount +
              response.blockedCount -
              activeBlockedRows.length}{" "}
            ready · {activeBlockedRows.length} need review. No selected products
            were imported.
          </p>
          <ul>
            {activeBlockedRows.map((row) => (
              <li key={row.rowNumber}>
                {row.issues.map((issue) => issue.message).join(" ")}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {response?.error === null && response.kind === "import-draft-saved" ? (
        <p role="status" className="mt-3 text-sm text-green-700">
          Draft saved. Nothing changes in Shelf until Apply.
        </p>
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

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm font-semibold text-gray-700" aria-live="polite">
          {proposal.rows.length}{" "}
          {proposal.rows.length === 1 ? "product" : "products"} found ·{" "}
          {approvedCount} approved · {reviewCount} need review
          {readyCount > approvedCount
            ? ` · ${readyCount - approvedCount} ready`
            : ""}
          {unresolvedCategoryCount > 0
            ? ` · ${unresolvedCategoryCount} unassigned category`
            : ""}
          {unresolvedLocationCount > 0
            ? ` · ${unresolvedLocationCount} unassigned location`
            : ""}
          {ignoredCount > 0 ? ` · ${ignoredCount} ignored` : ""}
        </p>
      </div>
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

      {selectedRowNumbers.length > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-gray-50 px-3 py-2 text-sm">
          <span className="mr-2 text-gray-600">
            {selectedRowNumbers.length} selected
          </span>
          <button
            type="button"
            disabled={selectedSafeRows.length === 0}
            onClick={approveSelectedSafeRows}
            className="rounded-md bg-red-700 px-2.5 py-1.5 text-xs font-bold text-white hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Approve selected safe rows
          </button>
          <button
            type="button"
            disabled={fetcher.state !== "idle" || duplicateBlocksApply}
            onClick={() => importRows(selectedRowNumbers)}
            className="rounded-md bg-red-700 px-2.5 py-1.5 text-xs font-bold text-white disabled:opacity-50"
          >
            Import selected
          </button>
          <button
            type="button"
            onClick={ignoreSelectedRows}
            className="rounded-md border border-gray-300 px-2.5 py-1.5 text-xs font-bold text-gray-700 hover:bg-white"
          >
            Ignore selected
          </button>
        </div>
      ) : null}

      <div className="mt-3 overflow-x-auto rounded-lg border border-gray-200">
        <table className="w-full min-w-[1060px] text-left text-sm">
          <thead className="border-b border-gray-200 bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
            <tr>
              <th className="w-10 p-2">
                <span className="sr-only">Select</span>
                <input
                  type="checkbox"
                  aria-label="Select all products on this page"
                  checked={allVisibleSelected}
                  onChange={(event) =>
                    toggleVisibleRows(event.currentTarget.checked)
                  }
                />
              </th>
              <th className="p-2">Product</th>
              <th className="w-16 p-2">Qty</th>
              <th className="p-2">Category</th>
              <th className="p-2">Location</th>
              <th className="w-20 p-2">Image</th>
              <th className="w-28 p-2">Status</th>
              <th className="p-2">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {reviewRows.map((row) => {
              const isApplied = appliedRowNumbers.has(row.rowNumber);
              const isIgnored = ignoredRowNumbers.has(row.rowNumber);
              const isResolved = isApplied || isIgnored;
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
                  candidate.id === row.helperCandidate?.productMatch.candidateId
              );
              const selectedExistingCandidate =
                decision?.productChoice === "EXISTING" && decision.assetId
                  ? row.matchCandidates?.find(
                      (candidate) => candidate.id === decision.assetId
                    )
                  : null;
              const isExistingTrackingSelection =
                row.trackingSource === "EXISTING_MODEL" ||
                Boolean(selectedExistingCandidate);
              const effectiveTrackingType =
                selectedExistingCandidate?.type ?? decision?.type ?? row.type;
              const individualTrackingRequiresConfirmation =
                effectiveTrackingType === "INDIVIDUAL" &&
                !isExistingTrackingSelection;
              const badge = reviewBadges[row.rowNumber];
              const rowValidation = validateImportRowForApply({
                row: { ...row, categoryOptional: row.mouserLineItem === true },
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
              return (
                <tr key={row.rowNumber} className="align-top">
                  <td className="p-2">
                    <input
                      type="checkbox"
                      aria-label={`Select ${
                        row.title || `row ${row.rowNumber}`
                      }`}
                      checked={selectedRowNumbers.includes(row.rowNumber)}
                      disabled={isResolved}
                      onChange={(event) =>
                        toggleSelectedRow(
                          row.rowNumber,
                          event.currentTarget.checked
                        )
                      }
                    />
                  </td>
                  <td className="max-w-[280px] p-2">
                    <div className="line-clamp-2 break-words font-semibold leading-5 text-gray-950">
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
                            <span className="font-semibold">Manufacturer:</span>{" "}
                            {row.manufacturer}
                          </p>
                        ) : null}
                        {row.sourceDescription &&
                        row.sourceDescription !== row.title ? (
                          <p>
                            <span className="font-semibold">Description:</span>{" "}
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
                        {row.productImageProposal?.status === "IMAGE_FOUND" &&
                        importProductImagePreview(row.productImageProposal) ? (
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
                            <span className="font-semibold">Source notes:</span>{" "}
                            {row.sourceNotes}
                          </p>
                        ) : null}
                        {row.supplierPartNumber ? (
                          <p>
                            <span className="font-semibold">Supplier SKU:</span>{" "}
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
                                row.helperCandidate.productMatch.confidence *
                                  100
                              )}
                              % confidence
                              {helperMatchCandidate
                                ? ` · ${helperMatchCandidate.title}`
                                : row.helperCandidate.productMatch.candidateId
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
                                  row.helperCandidate.kitHint.confidence * 100
                                )}
                                % confidence
                              </p>
                            ) : null}
                            {row.helperCandidate.questions.map((question) => (
                              <p key={question}>
                                <span className="font-semibold">Question:</span>{" "}
                                {question}
                              </p>
                            ))}
                            {row.helperCandidate.settingsSuggestions.length >
                            0 ? (
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
                            {row.helperCandidate.locationSuggestions.length >
                            0 ? (
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
                            Quantity status: {actionLabel(row.quantityStatus)}
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
                          <span className="font-semibold">Review reason:</span>{" "}
                          {row.reviewConflictReason || row.reason}
                        </p>
                        <p>
                          <span className="font-semibold">Import action:</span>{" "}
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
                    {editRowNumber === row.rowNumber ? (
                      <div className="mt-2 min-w-64 space-y-2 rounded-lg bg-gray-50 p-2 text-xs font-normal">
                        <label className="block">
                          Item name
                          <input
                            value={reviewDecisions[row.rowNumber]?.title ?? ""}
                            onChange={(event) =>
                              updateDecision(row.rowNumber, {
                                title: event.target.value,
                              })
                            }
                            className="mt-1 w-full rounded-lg border border-gray-300 px-2 py-1 focus:border-red-600 focus:outline-none focus:ring-2 focus:ring-red-100"
                          />
                        </label>
                        <label className="block">
                          Shelf match
                          <select
                            value={
                              reviewDecisions[row.rowNumber]?.productChoice ===
                              "NEW"
                                ? "__new__"
                                : reviewDecisions[row.rowNumber]?.assetId ?? ""
                            }
                            onChange={(event) => {
                              const value = event.target.value;
                              updateDecision(row.rowNumber, {
                                assetId:
                                  value && value !== "__new__" ? value : null,
                                productChoice: value
                                  ? value === "__new__"
                                    ? "NEW"
                                    : "EXISTING"
                                  : null,
                                type:
                                  value && value !== "__new__"
                                    ? row.matchCandidates?.find(
                                        (candidate) => candidate.id === value
                                      )?.type ?? row.type
                                    : row.type ?? "QUANTITY_TRACKED",
                                trackingModeConfirmed: false,
                                decision: null,
                              });
                            }}
                            className="mt-1 w-full rounded-lg border border-gray-300 px-2 py-1"
                          >
                            {row.action === "POSSIBLE_DUPLICATE" ||
                            row.action === "AMBIGUOUS" ? (
                              <option value="">Choose product decision</option>
                            ) : null}
                            <option value="__new__">Create new product</option>
                            {(row.matchCandidates ?? []).map((candidate) => (
                              <option key={candidate.id} value={candidate.id}>
                                {candidate.title}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="block">
                          Received quantity
                          <input
                            type="number"
                            min="1"
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
                            className="mt-1 w-full rounded-lg border border-gray-300 px-2 py-1"
                          />
                        </label>
                        <label className="block">
                          Tracking mode
                          <select
                            value={effectiveTrackingType ?? ""}
                            disabled={isExistingTrackingSelection}
                            onChange={(event) => {
                              updateDecision(row.rowNumber, {
                                type:
                                  event.target.value === "INDIVIDUAL" ||
                                  event.target.value === "QUANTITY_TRACKED"
                                    ? event.target.value
                                    : null,
                                trackingModeConfirmed: false,
                                decision: null,
                              });
                            }}
                            className="mt-1 w-full rounded-lg border border-gray-300 px-2 py-1 disabled:bg-gray-100"
                          >
                            <option value="">Choose tracking mode</option>
                            <option value="QUANTITY_TRACKED">
                              Quantity tracked
                            </option>
                            <option value="INDIVIDUAL">Individual + QR</option>
                          </select>
                        </label>
                        {individualTrackingRequiresConfirmation ? (
                          <label className="flex items-start gap-2 rounded border border-amber-200 bg-amber-50 p-2 text-amber-950">
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
                              Confirm that Apply should create separate
                              individual QR-tracked assets.
                            </span>
                          </label>
                        ) : null}
                        {reviewDecisions[row.rowNumber]?.type ===
                        "QUANTITY_TRACKED" ? (
                          <fieldset className="space-y-2 rounded border border-gray-200 p-2">
                            <legend className="px-1 font-bold">
                              Quantity settings
                            </legend>
                            <label className="block">
                              Unit of measure
                              <input
                                value={
                                  reviewDecisions[row.rowNumber]
                                    ?.unitOfMeasure ?? ""
                                }
                                maxLength={100}
                                onChange={(event) =>
                                  updateDecision(row.rowNumber, {
                                    unitOfMeasure: event.target.value || null,
                                  })
                                }
                                className="mt-1 w-full rounded-lg border border-gray-300 px-2 py-1"
                              />
                            </label>
                            <label className="block">
                              Consumption type
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
                                className="mt-1 w-full rounded-lg border border-gray-300 px-2 py-1"
                              >
                                <option value="">
                                  Choose consumption type
                                </option>
                                <option value="TWO_WAY">Returnable</option>
                                <option value="ONE_WAY">Consumable</option>
                              </select>
                            </label>
                            <label className="block">
                              Minimum quantity
                              <input
                                type="number"
                                min="0"
                                step="1"
                                value={
                                  reviewDecisions[row.rowNumber]?.minQuantity ??
                                  ""
                                }
                                onChange={(event) =>
                                  updateDecision(row.rowNumber, {
                                    minQuantity: event.target.value
                                      ? Number(event.target.value)
                                      : null,
                                  })
                                }
                                className="mt-1 w-full rounded-lg border border-gray-300 px-2 py-1"
                              />
                            </label>
                          </fieldset>
                        ) : null}
                        <section className="space-y-2 rounded border border-gray-200 p-2">
                          <label className="block font-semibold">
                            AssetModel description
                            <textarea
                              value={
                                reviewDecisions[row.rowNumber]
                                  ?.assetModelDescription ?? ""
                              }
                              maxLength={600}
                              rows={3}
                              onChange={(event) =>
                                updateDecision(row.rowNumber, {
                                  assetModelDescription:
                                    event.target.value || null,
                                })
                              }
                              className="mt-1 w-full rounded-lg border border-gray-300 px-2 py-1 font-normal"
                            />
                          </label>
                          {row.assetModelDescriptionSource ? (
                            <p className="text-gray-500">
                              Description source:{" "}
                              {actionLabel(row.assetModelDescriptionSource)}
                            </p>
                          ) : null}
                          {row.existingAssetModelImageUrl ? (
                            <div>
                              <p className="mb-1 font-semibold">
                                Existing Shelf image
                              </p>
                              <img
                                src={
                                  row.existingAssetModelThumbnailUrl ??
                                  row.existingAssetModelImageUrl
                                }
                                alt={`Existing Shelf model for ${row.title}`}
                                className="size-20 rounded border border-gray-200 object-contain"
                              />
                              <p className="mt-1 text-gray-500">
                                The existing model image will be kept.
                              </p>
                            </div>
                          ) : proposedImage?.status === "IMAGE_FOUND" &&
                            importProductImagePreview(proposedImage) ? (
                            <div>
                              <p className="mb-1 font-semibold">
                                {proposedImage.source === "MANUAL_UPLOAD"
                                  ? "Selected image"
                                  : "Found automatically"}
                              </p>
                              <img
                                src={importProductImagePreview(proposedImage)}
                                alt={`Proposed: ${row.title}`}
                                className="size-20 rounded border border-gray-200 object-contain"
                              />
                              <p className="mt-1 text-gray-600">
                                {proposedImage.sourceName ?? "Product image"}
                                {proposedImage.source
                                  ? ` · ${actionLabel(proposedImage.source)}`
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
                              <label className="mt-2 flex items-start gap-2">
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
                                className="mt-2 text-sm text-gray-600 underline"
                              >
                                Remove image
                              </button>
                            </div>
                          ) : (
                            <p className="text-gray-500">
                              No reliable image found.{" "}
                              {proposedImage?.failureReason
                                ? `Reason: ${actionLabel(
                                    proposedImage.failureReason
                                  )}.`
                                : ""}{" "}
                              {decision?.manualImage === null
                                ? "No image selected"
                                : actionLabel(
                                    row.productImageProposal?.status ??
                                      "IMAGE_NOT_FOUND"
                                  )}
                            </p>
                          )}
                          {!row.existingAssetModelImageUrl ? (
                            <label className="block text-sm font-medium">
                              Upload another image
                              <input
                                type="file"
                                accept="image/jpeg,image/png,image/webp"
                                disabled={imageFetcher.state !== "idle"}
                                onChange={(event) => {
                                  uploadProductImage(
                                    row.rowNumber,
                                    event.currentTarget.files?.[0]
                                  );
                                  event.currentTarget.value = "";
                                }}
                                className="mt-1 block w-full text-sm font-normal"
                              />
                            </label>
                          ) : null}
                          {imageFetcher.data?.error ? (
                            <p role="alert" className="text-sm text-red-700">
                              {imageFetcher.data.error.message}
                            </p>
                          ) : imageFetcher.state !== "idle" ? (
                            <p className="text-sm text-gray-500">
                              Processing image…
                            </p>
                          ) : null}
                        </section>
                        {proposal.categoryOptions?.length ? (
                          <label className="block">
                            Category
                            <select
                              value={
                                reviewDecisions[row.rowNumber]?.categoryId ?? ""
                              }
                              onChange={(event) =>
                                updateDecision(row.rowNumber, {
                                  categoryId: event.target.value || null,
                                  approveNewCategory: false,
                                })
                              }
                              className="mt-1 w-full rounded-lg border border-gray-300 px-2 py-1"
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
                        ) : null}
                        {!isMouserInvoice &&
                        !reviewDecisions[row.rowNumber]?.categoryId ? (
                          <div className="rounded border border-amber-200 bg-amber-50 p-2">
                            <label className="block">
                              Proposed new category
                              <input
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
                                className="mt-1 w-full rounded-lg border border-gray-300 px-2 py-1"
                              />
                            </label>
                            <label className="mt-2 flex items-start gap-2">
                              <input
                                type="checkbox"
                                checked={
                                  reviewDecisions[row.rowNumber]
                                    ?.approveNewCategory ?? false
                                }
                                onChange={(event) =>
                                  updateDecision(row.rowNumber, {
                                    approveNewCategory: event.target.checked,
                                  })
                                }
                                disabled={!canCreateCategory}
                              />
                              <span>
                                Approve creating this category (requires Shelf
                                category:create permission)
                                {!canCreateCategory
                                  ? ". Your role cannot create categories; choose an active category instead."
                                  : ""}
                              </span>
                            </label>
                          </div>
                        ) : null}
                        {proposal.locationOptions?.length ? (
                          <label className="block">
                            Location
                            <select
                              value={
                                reviewDecisions[row.rowNumber]?.locationId ?? ""
                              }
                              onChange={(event) =>
                                updateDecision(row.rowNumber, {
                                  locationId: event.target.value || null,
                                })
                              }
                              className="mt-1 w-full rounded-lg border border-gray-300 px-2 py-1"
                            >
                              <option value="">Unassigned</option>
                              {proposal.locationOptions.map((location) => (
                                <option key={location.id} value={location.id}>
                                  {location.pathLabel}
                                  {location.operational ? " (operational)" : ""}
                                </option>
                              ))}
                            </select>
                          </label>
                        ) : null}
                      </div>
                    ) : null}
                  </td>
                  <td className="whitespace-nowrap p-2 font-semibold tabular-nums">
                    {quantity ?? "—"}
                  </td>
                  <td className="min-w-36 p-2">
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
                        <span aria-hidden="true" className="px-1 text-gray-500">
                          ▾
                        </span>
                        <select
                          aria-label={`Category for ${row.title}`}
                          value={
                            (decision ? decision.categoryId : row.categoryId) ??
                            ""
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
                  <td className="max-w-64 p-2 text-gray-700">
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
                  <td className="p-2">
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
                  <td className="p-2">
                    <span
                      className={`inline-flex rounded-full px-2 py-1 text-xs font-bold ${statusClassName}`}
                      role="status"
                    >
                      {statusLabel}
                    </span>
                    {(serverIssues[row.rowNumber] ?? rowValidation.issues)
                      .filter(
                        (issue) =>
                          !["IGNORED", "ALREADY_IMPORTED"].includes(issue.code)
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
                  <td className="p-2">
                    {isResolved ? null : (
                      <div className="flex flex-wrap gap-1.5">
                        {rowCanImport ? (
                          <button
                            type="button"
                            disabled={
                              fetcher.state !== "idle" || duplicateBlocksApply
                            }
                            onClick={() => importRows([row.rowNumber])}
                            className="rounded-md bg-red-700 px-2 py-1 text-xs font-bold text-white transition hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            Import
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() =>
                              setEditRowNumber((current) =>
                                current === row.rowNumber ? null : row.rowNumber
                              )
                            }
                            className="rounded-md bg-red-700 px-2 py-1 text-xs font-bold text-white transition hover:bg-red-800"
                          >
                            Fix
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={
                            !decision?.title.trim() ||
                            (individualTrackingRequiresConfirmation &&
                              !decision?.trackingModeConfirmed)
                          }
                          onClick={() =>
                            updateDecision(row.rowNumber, {
                              decision: "APPROVE",
                            })
                          }
                          className="rounded-md border border-gray-300 px-2 py-1 text-xs font-bold text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          Approve
                        </button>
                        {rowCanImport ? (
                          <button
                            type="button"
                            onClick={() =>
                              setEditRowNumber((current) =>
                                current === row.rowNumber ? null : row.rowNumber
                              )
                            }
                            className="rounded-md border border-gray-300 px-2 py-1 text-xs font-bold text-gray-700 hover:bg-gray-50"
                          >
                            Edit
                          </button>
                        ) : null}
                        <button
                          type="button"
                          onClick={() =>
                            updateDecision(row.rowNumber, {
                              decision: "IGNORE",
                            })
                          }
                          className="rounded-md border border-gray-300 px-2 py-1 text-xs font-bold text-gray-700 hover:bg-gray-50"
                        >
                          Ignore
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
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
    </div>
  );
}
