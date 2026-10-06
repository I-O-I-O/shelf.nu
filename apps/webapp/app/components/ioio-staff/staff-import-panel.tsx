import { useCallback, useEffect, useRef, useState } from "react";
import { useFetcher, useLocation, useNavigate } from "react-router";
import type {
  StaffImportProposal,
  StaffImportProposalRow,
} from "~/modules/ioio-staff/inventory-import.server";

type StaffImportResult = {
  operationId: string;
  createdIds: string[];
  updatedIds: string[];
  reusedIds: string[];
  failedRows: Array<{ rowNumber: number; reason: string }>;
  ignoredRows?: number;
  reviewedRows?: number;
};

type StaffImportActionResponse =
  | { error: null; kind: "import-proposal"; proposal: StaffImportProposal }
  | { error: null; kind: "import-result"; result: StaffImportResult }
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
  locationId: string | null;
  quantity: number | null;
};

function isSafeReviewAction(row: StaffImportProposalRow) {
  return [
    "CREATE",
    "INCREASE_QUANTITY",
    "NO_CHANGE",
    "UPDATE_QUANTITY",
    "UPDATE_CATEGORY",
    "UPDATE_LOCATION",
  ].includes(row.action);
}

function actionLabel(action: string) {
  return action
    .replaceAll("_", " ")
    .toLocaleLowerCase()
    .replace(/(^|\s)\S/g, (character) => character.toUpperCase());
}

function isImportFormat(value: string | null): value is ImportFormat {
  return value === "csv" || value === "xlsx" || value === "pdf";
}

export function StaffImportPanel({
  actionPath,
  initialProposal = null,
  initialNotice = null,
}: {
  actionPath: string;
  initialProposal?: StaffImportProposal | null;
  initialNotice?: string | null;
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
    response?.error === null && response.kind === "import-proposal"
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
      {result ? (
        <p className="mt-3 text-sm text-green-700">
          Applied. Created {result.createdIds.length}, updated{" "}
          {result.updatedIds.length}, reused {result.reusedIds.length}.
        </p>
      ) : null}
      {proposal ? (
        <StaffImportProposalView
          key={proposal.operationId}
          proposal={proposal}
          actionPath={actionPath}
          onReset={resetImportState}
        />
      ) : null}
    </section>
  );
}

function StaffImportProposalView({
  proposal,
  actionPath,
  onReset,
}: {
  proposal: StaffImportProposal;
  actionPath: string;
  onReset: (notice?: string | null) => void;
}) {
  const fetcher = useFetcher<StaffImportActionResponse>();
  const [proposalState, setProposalState] = useState<
    "review" | "applying" | "applied" | "cancelled" | "expired" | "error"
  >("review");
  const [reviewPage, setReviewPage] = useState(0);
  const [editRowNumber, setEditRowNumber] = useState<number | null>(null);
  const [reviewDecisions, setReviewDecisions] = useState<
    Record<number, ReviewDecision>
  >(() =>
    Object.fromEntries(
      proposal.rows.map((row) => [
        row.rowNumber,
        {
          decision:
            row.action === "IGNORE"
              ? "IGNORE"
              : isSafeReviewAction(row)
              ? "APPROVE"
              : null,
          title: row.title,
          assetId: row.assetId,
          categoryId: row.categoryId,
          locationId: row.locationId,
          quantity:
            row.receivedQuantity ??
            (row.quantityStatus === "RECEIVED" ? row.quantity : null),
        },
      ])
    )
  );
  const approvedRows = proposal.rows.filter(
    (row) => reviewDecisions[row.rowNumber]?.decision === "APPROVE"
  );
  const allRowsReviewed = proposal.rows.every((row) =>
    Boolean(reviewDecisions[row.rowNumber]?.decision)
  );
  const allApprovedRowsHaveNames = approvedRows.every(
    (row) => reviewDecisions[row.rowNumber]?.title.trim().length > 0
  );
  const canApply =
    allRowsReviewed &&
    allApprovedRowsHaveNames &&
    approvedRows.length > 0 &&
    fetcher.state === "idle" &&
    (proposalState === "review" || proposalState === "error");
  const serializedReviewDecisions = JSON.stringify(
    proposal.rows
      .map((row) => {
        const decision = reviewDecisions[row.rowNumber];
        return {
          rowNumber: row.rowNumber,
          decision: decision?.decision,
          title: decision?.title,
          assetId: decision?.assetId,
          categoryId: decision?.categoryId,
          locationId: decision?.locationId,
          quantity: decision?.quantity,
        };
      })
      .filter((decision) => decision.decision)
  );
  const totalReviewPages = Math.max(
    1,
    Math.ceil(proposal.rows.length / IMPORT_REVIEW_PAGE_SIZE)
  );
  const reviewRows = proposal.rows.slice(
    reviewPage * IMPORT_REVIEW_PAGE_SIZE,
    (reviewPage + 1) * IMPORT_REVIEW_PAGE_SIZE
  );
  const firstReviewRow = reviewPage * IMPORT_REVIEW_PAGE_SIZE + 1;
  const lastReviewRow = Math.min(
    (reviewPage + 1) * IMPORT_REVIEW_PAGE_SIZE,
    proposal.rows.length
  );

  const updateDecision = (
    rowNumber: number,
    changes: Partial<ReviewDecision>
  ) => {
    setReviewDecisions((current) => ({
      ...current,
      [rowNumber]: {
        ...current[rowNumber],
        ...changes,
      },
    }));
  };

  const approveSafeRows = () => {
    setReviewDecisions((current) => {
      const next = { ...current };
      proposal.rows.forEach((row) => {
        if (isSafeReviewAction(row)) {
          next[row.rowNumber] = {
            ...next[row.rowNumber],
            decision: "APPROVE",
          };
        }
      });
      return next;
    });
  };

  useEffect(() => {
    if (!fetcher.data) return;
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
        `Import applied. Created ${fetcher.data.result.createdIds.length}, updated ${fetcher.data.result.updatedIds.length}, reused ${fetcher.data.result.reusedIds.length}.`
      );
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
          <h3 className="text-lg font-black text-gray-950">
            Review inventory change proposal
          </h3>
          <p className="mt-1 text-sm text-gray-500">
            {proposal.source.filename}, {proposal.rows.length} rows, no changes
            have been applied.
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
            <button
              type="submit"
              disabled={!canApply}
              onClick={() => setProposalState("applying")}
              className="rounded-xl bg-red-700 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Apply approved changes
            </button>
            <input
              type="hidden"
              name="reviewDecisions"
              value={serializedReviewDecisions}
            />
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

      {proposalState === "applying" || fetcher.state !== "idle" ? (
        <p className="mt-3 text-sm text-gray-500" role="status">
          {proposalState === "applying"
            ? "Applying approved changes..."
            : "Cancelling import proposal..."}
        </p>
      ) : null}
      {fetcher.data?.error ? (
        <p className="mt-3 text-sm text-red-700" role="alert">
          {fetcher.data.error.message}
        </p>
      ) : null}

      <div className="mt-4 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        {Object.entries(proposal.counts).map(([action, count]) => (
          <div
            key={action}
            className="rounded-lg bg-gray-50 px-3 py-2 text-gray-700"
          >
            <span className="font-bold">{action}</span>: {count}
          </div>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-gray-200 bg-gray-50 p-3 text-sm">
        <span className="text-gray-600">
          Approve safe matches first, then review duplicate and uncertain rows.
        </span>
        <button
          type="button"
          onClick={approveSafeRows}
          className="rounded-lg border border-red-200 px-3 py-2 font-bold text-red-800 hover:bg-red-50"
        >
          Approve safe matches
        </button>
      </div>

      {proposal.pdfSummary ? (
        <div className="mt-4 rounded-xl border border-red-100 bg-red-50 p-3 text-sm text-gray-700">
          <p className="font-bold text-gray-950">PDF review</p>
          <p className="mt-1">
            Valid inventory rows: {proposal.pdfSummary.validItemRows}. Needs
            review: {proposal.pdfSummary.needsReview}. Ignored non-inventory
            rows: {proposal.pdfSummary.ignoredRows}.
          </p>
          {proposal.pdfSummary.needsReview > 0 ? (
            <p className="mt-1 text-red-800">
              Some rows need review before import.
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="mt-4 overflow-x-auto">
        <table className="min-w-full text-left text-sm">
          <thead className="border-b border-gray-200 text-xs uppercase tracking-wide text-gray-500">
            <tr>
              <th className="p-2">Row</th>
              <th className="p-2">Item</th>
              <th className="p-2">Quantity</th>
              <th className="p-2">Category</th>
              <th className="p-2">Location</th>
              <th className="p-2">Review</th>
              <th className="p-2">Action</th>
              <th className="p-2">Reason</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {reviewRows.map((row) => (
              <tr key={row.rowNumber}>
                <td className="p-2">{row.rowNumber}</td>
                <td className="p-2 font-semibold">
                  {row.title || "Unresolved item name"}
                  {row.sourceDescription &&
                  row.sourceDescription !== row.title ? (
                    <p className="mt-1 text-xs font-normal text-gray-500">
                      Source: {row.sourceDescription}
                    </p>
                  ) : null}
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
                          value={reviewDecisions[row.rowNumber]?.assetId ?? ""}
                          onChange={(event) =>
                            updateDecision(row.rowNumber, {
                              assetId: event.target.value || null,
                            })
                          }
                          className="mt-1 w-full rounded-lg border border-gray-300 px-2 py-1"
                        >
                          <option value="">New Shelf asset</option>
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
                          value={reviewDecisions[row.rowNumber]?.quantity ?? ""}
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
                              })
                            }
                            className="mt-1 w-full rounded-lg border border-gray-300 px-2 py-1"
                          >
                            <option value="">Choose a category</option>
                            {proposal.categoryOptions.map((category) => (
                              <option key={category.id} value={category.id}>
                                {category.name}
                              </option>
                            ))}
                          </select>
                        </label>
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
                                {location.name}
                              </option>
                            ))}
                          </select>
                        </label>
                      ) : null}
                    </div>
                  ) : null}
                </td>
                <td className="p-2">
                  <div>Ordered: {row.orderedQuantity ?? "Unknown"}</div>
                  <div>Received: {row.receivedQuantity ?? "Unknown"}</div>
                  <div>
                    Proposed:{" "}
                    {row.proposedQuantity ?? row.quantity ?? "Unknown"}
                  </div>
                </td>
                <td className="p-2">
                  <div>
                    {row.suggestedCategory ?? row.category ?? "Needs review"}
                  </div>
                  {row.categoryConfidence ? (
                    <div className="text-xs text-gray-500">
                      {row.categoryConfidence}: {row.categoryReason}
                    </div>
                  ) : null}
                </td>
                <td className="p-2">
                  {row.location ?? row.locationLabel ?? "Unassigned"}
                </td>
                <td className="p-2">
                  <div className="mb-2 font-bold">
                    {reviewDecisions[row.rowNumber]?.decision === "APPROVE"
                      ? "Approved"
                      : reviewDecisions[row.rowNumber]?.decision === "IGNORE"
                      ? "Ignored"
                      : "Needs review"}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={!reviewDecisions[row.rowNumber]?.title.trim()}
                      onClick={() =>
                        updateDecision(row.rowNumber, { decision: "APPROVE" })
                      }
                      className="rounded-lg bg-red-700 px-2 py-1 text-xs font-bold text-white hover:bg-red-800 disabled:opacity-50"
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setEditRowNumber((current) =>
                          current === row.rowNumber ? null : row.rowNumber
                        )
                      }
                      className="rounded-lg border border-gray-300 px-2 py-1 text-xs font-bold text-gray-700 hover:bg-gray-50"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        updateDecision(row.rowNumber, { decision: "IGNORE" })
                      }
                      className="rounded-lg border border-gray-300 px-2 py-1 text-xs font-bold text-gray-700 hover:bg-gray-50"
                    >
                      Ignore
                    </button>
                  </div>
                </td>
                <td className="p-2">{actionLabel(row.action)}</td>
                <td className="p-2 text-gray-500">{row.reason}</td>
              </tr>
            ))}
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
