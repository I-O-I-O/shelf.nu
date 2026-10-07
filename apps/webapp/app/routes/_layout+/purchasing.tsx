import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useSetAtom } from "jotai";
import {
  ChevronDown,
  ExternalLink,
  FileText,
  MoreHorizontal,
  Plus,
  UserRound,
  X,
} from "lucide-react";
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
  useFetcher,
  useLoaderData,
  useNavigate,
  useLocation,
} from "react-router";
import { showNotificationAtom } from "~/atoms/notifications";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/forms/select";
import { SelectableRow } from "~/components/ioio-staff/selectable-row";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/shared/dropdown";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/shared/modal";
import { db } from "~/database/db.server";
import {
  createPurchaseRequest,
  getPurchasingPageData,
  getReceiptDraft,
  isPurchaseRequestStatus,
  parseAcademicYear,
  recordPlannedPurchases,
  recordPurchase,
  resetAnnualBudget,
  removePurchaseFromPurchased,
  requirePurchasingAccess,
  setPurchaseRequestsStatus,
  setPurchaseRequestStatus,
  updateAnnualBudget,
  updatePurchaseRequest,
  uploadPurchaseReceipt,
} from "~/modules/ioio-staff/purchasing.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { ShelfError } from "~/utils/error";

const pageTitle = "Purchasing";
const PURCHASING_CURRENCY = "SEK";
type LoaderData = Awaited<ReturnType<typeof getPurchasingPageData>> & {
  receiptDraft: Awaited<ReturnType<typeof getReceiptDraft>>;
  notice: string | null;
  requestForPurchase: {
    id: string;
    title: string;
    quantity: number;
    estimatedCost: string | null;
    status: string;
  } | null;
};

export const meta: MetaFunction = () => [
  { title: appendToMetaTitle(pageTitle) },
];

export async function loader({ context, request }: LoaderFunctionArgs) {
  const { userId } = context.getSession();
  const access = await requirePurchasingAccess({ userId, request });
  const url = new URL(request.url);
  const academicYear = parseAcademicYear(url.searchParams.get("year"));
  const [purchasing, receiptDraft, requestForPurchase] = await Promise.all([
    getPurchasingPageData({
      organizationId: access.organizationId,
      academicYear,
    }),
    url.searchParams.get("receiptDraft")
      ? getReceiptDraft({
          organizationId: access.organizationId,
          userId,
          draftId: url.searchParams.get("receiptDraft")!,
        })
      : Promise.resolve(null),
    url.searchParams.get("purchaseFor")
      ? (async () => {
          const request = await db.purchaseRequest.findFirst({
            where: {
              id: url.searchParams.get("purchaseFor")!,
              organizationId: access.organizationId,
              budget: { academicYear },
              status: { in: ["PLANNED", "RESERVED"] },
            },
            select: {
              id: true,
              title: true,
              quantity: true,
              estimatedCost: true,
              status: true,
            },
          });
          return request
            ? {
                ...request,
                estimatedCost: request.estimatedCost?.toString() ?? null,
              }
            : null;
        })()
      : Promise.resolve(null),
  ]);
  return data({
    ...purchasing,
    receiptDraft,
    requestForPurchase,
    notice: url.searchParams.get("notice"),
  });
}

function parseItems(form: FormData, fieldName = "items") {
  const raw = String(form.get(fieldName) ?? "[]");
  try {
    const items: unknown = JSON.parse(raw);
    if (!Array.isArray(items)) throw new Error("invalid lines");
    return items;
  } catch {
    throw new ShelfError({
      cause: null,
      message: "Review the purchase lines and try again.",
      label: "Purchasing",
      status: 400,
      shouldBeCaptured: false,
    });
  }
}

export async function action({ context, request }: ActionFunctionArgs) {
  const { userId } = context.getSession();
  const access = await requirePurchasingAccess({ userId, request });
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const academicYear = parseAcademicYear(
    String(
      form.get("academicYear") ?? new URL(request.url).searchParams.get("year")
    )
  );
  const query = `?year=${encodeURIComponent(academicYear)}`;
  const page = await getPurchasingPageData({
    organizationId: access.organizationId,
    academicYear,
  });
  const budgetId = page.budget.id;
  let temporaryBulkReceiptDraftId: string | null = null;
  let affectedPurchaseId: string | null = null;

  try {
    if (intent === "saveBudget") {
      await updateAnnualBudget({
        organizationId: access.organizationId,
        academicYear,
        userId,
        amount: form.get("amount"),
        reason: null,
        confirmedOverBudget: form.get("confirmedOverBudget") === "1",
      });
      return redirect(`/purchasing${query}&notice=budget-saved`);
    }
    if (intent === "resetBudget") {
      await resetAnnualBudget({
        organizationId: access.organizationId,
        budgetId,
        userId,
      });
      return redirect(`/purchasing${query}&notice=budget-reset`);
    }
    if (intent === "createRequest") {
      const reserveBudget = form.getAll("reserveBudget").includes("1");
      await createPurchaseRequest({
        organizationId: access.organizationId,
        budgetId,
        userId,
        title: form.get("title"),
        quantity: form.get("quantity"),
        estimatedCost: form.get("estimatedCost"),
        priority: form.get("priority"),
        note: form.get("note"),
        link: form.get("link"),
        reserveBudget,
        confirmedOverBudget: form.get("confirmedOverBudget") === "1",
      });
      return redirect(
        `/purchasing${query}&notice=${
          reserveBudget ? "reserved" : "plan-added"
        }`
      );
    }
    if (intent === "updateRequest") {
      await updatePurchaseRequest({
        organizationId: access.organizationId,
        requestId: String(form.get("requestId") ?? ""),
        title: form.get("title"),
        quantity: form.get("quantity"),
        estimatedCost: form.get("estimatedCost"),
        priority: form.get("priority"),
        note: form.get("note"),
        link: form.get("link"),
        reserveBudget: form.getAll("reserveBudget").includes("1"),
        confirmedOverBudget: form.get("confirmedOverBudget") === "1",
      });
      return redirect(`/purchasing${query}&notice=plan-updated`);
    }
    if (intent === "cancelRequest") {
      await setPurchaseRequestStatus({
        organizationId: access.organizationId,
        requestId: String(form.get("requestId") ?? ""),
        status: "CANCELLED",
      });
      return redirect(`/purchasing${query}&notice=cancelled`);
    }
    if (intent === "requestStatus") {
      const status = String(form.get("status") ?? "");
      if (!isPurchaseRequestStatus(status))
        throw new ShelfError({
          cause: null,
          message: "Choose a valid purchase status.",
          label: "Purchasing",
          status: 400,
          shouldBeCaptured: false,
        });
      await setPurchaseRequestStatus({
        organizationId: access.organizationId,
        requestId: String(form.get("requestId") ?? ""),
        status,
        confirmedOverBudget: form.get("confirmedOverBudget") === "1",
      });
      return redirect(
        `/purchasing${query}&notice=${
          status === "RESERVED"
            ? "reserved"
            : status === "CANCELLED"
            ? "cancelled"
            : "released"
        }`
      );
    }
    if (intent === "bulkRequestStatus") {
      const status = String(form.get("status") ?? "");
      if (status !== "PLANNED" && status !== "RESERVED") {
        throw new ShelfError({
          cause: null,
          message: "Choose a valid bulk purchase action.",
          label: "Purchasing",
          status: 400,
          shouldBeCaptured: false,
        });
      }
      const result = await setPurchaseRequestsStatus({
        organizationId: access.organizationId,
        budgetId,
        requestIds: parseItems(form, "requestIds"),
        status,
        confirmedOverBudget: form.get("confirmedOverBudget") === "1",
      });
      return data({ intent, bulkStatusResult: { ...result, status } });
    }
    if (intent === "bulkRecordPurchases") {
      const purchaseLines = parseItems(form, "purchaseLines");
      const receiptEntry = form.get("receipt");
      if (
        receiptEntry &&
        typeof receiptEntry !== "string" &&
        receiptEntry.size > 0
      ) {
        const draft = await uploadPurchaseReceipt({
          organizationId: access.organizationId,
          userId,
          academicYear,
          file: receiptEntry,
        });
        temporaryBulkReceiptDraftId = draft.id;
      }
      const result = await recordPlannedPurchases({
        organizationId: access.organizationId,
        budgetId,
        userId,
        purchaseLines,
        purchaseDate: form.get("purchaseDate"),
        receiptDraftId: temporaryBulkReceiptDraftId,
        // This action records an already completed purchase, not a proposed
        // expense. The saved estimate is factual spend and must be recorded.
        confirmedOverBudget: true,
      });
      if (!result.recorded.length && temporaryBulkReceiptDraftId) {
        await db.purchaseReceiptDraft.deleteMany({
          where: {
            id: temporaryBulkReceiptDraftId,
            organizationId: access.organizationId,
            uploadedByUserId: userId,
          },
        });
      }
      temporaryBulkReceiptDraftId = null;
      if (result.recorded.length > 0) {
        return redirect(
          `/purchasing${query}&notice=purchases-marked#purchased`
        );
      }
      return data({ intent, bulkPurchaseResult: result });
    }
    if (intent === "markRequestPurchased") {
      const result = await recordPlannedPurchases({
        organizationId: access.organizationId,
        budgetId,
        userId,
        purchaseLines: [
          {
            requestId: String(form.get("requestId") ?? ""),
          },
        ],
        purchaseDate: form.get("purchaseDate"),
        // The purchase has already happened; record its canonical estimate even
        // if doing so takes the budget below zero.
        confirmedOverBudget: true,
      });
      const failed = result.failed[0];
      if (failed) {
        throw new ShelfError({
          cause: null,
          message: `Could not mark this purchase as purchased: ${failed.reason}.`,
          label: "Purchasing",
          status: 409,
          shouldBeCaptured: false,
        });
      }
      return redirect(`/purchasing${query}&notice=request-purchased#purchased`);
    }
    if (intent === "recordPurchase") {
      const purchase = await recordPurchase({
        organizationId: access.organizationId,
        budgetId,
        userId,
        requestId: String(form.get("requestId") ?? "") || null,
        vendor: form.get("vendor"),
        purchaseDate: form.get("purchaseDate"),
        actualTotal: form.get("actualTotal"),
        note: form.get("note"),
        items: parseItems(form),
        receiptDraftId: String(form.get("receiptDraftId") ?? "") || null,
        confirmedOverBudget: form.get("confirmedOverBudget") === "1",
      });
      return redirect(
        `/purchasing${query}&notice=purchase-recorded&purchaseId=${encodeURIComponent(
          purchase.id
        )}`
      );
    }
    if (intent === "removePurchase") {
      affectedPurchaseId = String(form.get("purchaseId") ?? "");
      await removePurchaseFromPurchased({
        organizationId: access.organizationId,
        budgetId,
        purchaseId: affectedPurchaseId,
      });
      return redirect(`/purchasing${query}&notice=purchase-hidden`);
    }
    if (intent === "uploadReceipt") {
      const entry = form.get("receipt");
      if (!entry || typeof entry === "string")
        throw new ShelfError({
          cause: null,
          message: "Choose a PDF, JPG, or PNG receipt to upload.",
          label: "Purchasing",
          status: 400,
          shouldBeCaptured: false,
        });
      const draft = await uploadPurchaseReceipt({
        organizationId: access.organizationId,
        userId,
        academicYear,
        file: entry,
      });
      const requestId = String(form.get("requestId") ?? "");
      return redirect(
        `/purchasing${query}&receiptDraft=${encodeURIComponent(draft.id)}${
          requestId ? `&purchaseFor=${encodeURIComponent(requestId)}` : ""
        }`
      );
    }
    throw new ShelfError({
      cause: null,
      message: "That purchasing action is not available.",
      label: "Purchasing",
      status: 400,
      shouldBeCaptured: false,
    });
  } catch (cause) {
    if (temporaryBulkReceiptDraftId) {
      await db.purchaseReceiptDraft.deleteMany({
        where: {
          id: temporaryBulkReceiptDraftId,
          organizationId: access.organizationId,
          uploadedByUserId: userId,
        },
      });
    }
    if (cause instanceof ShelfError)
      return data(
        { error: cause.message, intent, purchaseId: affectedPurchaseId },
        { status: cause.status }
      );
    throw cause;
  }
}

function money(value: string | number, _currency = PURCHASING_CURRENCY) {
  const amount = Number(value);
  const normalizedAmount = Number.isFinite(amount) ? amount : 0;
  const hasMinorUnits = Math.abs(normalizedAmount % 1) > 0.000001;
  const formattedAmount = new Intl.NumberFormat("sv-SE", {
    minimumFractionDigits: hasMinorUnits ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(normalizedAmount);
  return `${formattedAmount} ${PURCHASING_CURRENCY}`;
}

function dateLabel(value: Date | string) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(value));
}

function localDateInputValue() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function priorityLabel(priority: string) {
  if (priority === "HIGH") return "High";
  if (priority === "MEDIUM") return "Medium";
  return "Low";
}

function noticeText(notice: string | null) {
  const messages: Record<string, string> = {
    "budget-saved": "Annual budget updated.",
    "plan-added": "Planned purchase added.",
    "plan-updated": "Planned purchase updated.",
    reserved: "Budget reserved for this purchase.",
    released: "Reservation released.",
    cancelled: "Purchase plan cancelled.",
    "purchase-recorded": "Purchase recorded.",
  };
  return notice ? messages[notice] ?? null : null;
}

type Line = {
  name: string;
  quantity: string;
  lineTotal: string;
  linkedAssetId?: string | null;
};

function PurchaseLinesEditor({
  initial,
  assets,
}: {
  initial: Line[];
  assets: Array<{
    id: string;
    title: string;
    type: string;
    quantity: number | null;
  }>;
}) {
  const [lines, setLines] = useState(
    initial.length ? initial : [{ name: "", quantity: "1", lineTotal: "" }]
  );
  const serialized = useMemo(
    () =>
      JSON.stringify(
        lines.map((line) => ({
          ...line,
          quantity: Number(line.quantity),
          lineTotal: line.lineTotal || null,
        }))
      ),
    [lines]
  );
  function update(index: number, key: keyof Line, value: string) {
    setLines((current) =>
      current.map((line, lineIndex) =>
        lineIndex === index ? { ...line, [key]: value } : line
      )
    );
  }
  return (
    <div className="space-y-2">
      <input type="hidden" name="items" value={serialized} />
      <div className="text-xs font-bold uppercase tracking-wide text-gray-500">
        Purchased lines
      </div>
      {lines.map((line, index) => (
        <div
          key={index}
          className="grid gap-2 rounded-lg border border-gray-200 p-3 sm:grid-cols-[minmax(0,1fr)_6rem_8rem_auto]"
        >
          <label className="text-xs font-semibold text-gray-600">
            Item name
            <input
              required
              maxLength={240}
              value={line.name}
              onChange={(event) =>
                update(index, "name", event.currentTarget.value)
              }
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900"
            />
          </label>
          <label className="text-xs font-semibold text-gray-600">
            Quantity
            <input
              required
              type="number"
              min="1"
              value={line.quantity}
              onChange={(event) =>
                update(index, "quantity", event.currentTarget.value)
              }
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900"
            />
          </label>
          <label className="text-xs font-semibold text-gray-600">
            Line total
            <input
              type="number"
              min="0"
              step="0.01"
              value={line.lineTotal}
              onChange={(event) =>
                update(index, "lineTotal", event.currentTarget.value)
              }
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900"
            />
          </label>
          <button
            type="button"
            aria-label="Remove purchase line"
            onClick={() =>
              setLines((current) =>
                current.length > 1
                  ? current.filter((_, lineIndex) => lineIndex !== index)
                  : [{ name: "", quantity: "1", lineTotal: "" }]
              )
            }
            className="self-end rounded-md border border-gray-200 p-2 text-gray-500 hover:bg-gray-50"
          >
            <X className="size-4" />
          </button>
          <label className="text-xs font-semibold text-gray-600 sm:col-span-4">
            Link to an existing inventory item (optional)
            <select
              value={line.linkedAssetId ?? ""}
              onChange={(event) =>
                update(index, "linkedAssetId", event.currentTarget.value)
              }
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900"
            >
              <option value="">Not linked</option>
              {assets.map((asset) => (
                <option key={asset.id} value={asset.id}>
                  {asset.title}
                  {asset.type === "QUANTITY_TRACKED"
                    ? ` · quantity ${asset.quantity ?? 0}`
                    : " · individual"}
                </option>
              ))}
            </select>
          </label>
        </div>
      ))}
      <button
        type="button"
        onClick={() =>
          setLines((current) => [
            ...current,
            { name: "", quantity: "1", lineTotal: "" },
          ])
        }
        className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm font-semibold text-red-800 hover:bg-red-50"
      >
        <Plus className="size-4" /> Add another line
      </button>
    </div>
  );
}

export default function PurchasingPage() {
  const page = useLoaderData<typeof loader>() as LoaderData;
  const actionData = useActionData<typeof action>() as
    | {
        error?: string;
        intent?: string;
        purchaseId?: string | null;
        bulkPurchaseResult?: {
          recorded: Array<{ id: string; title: string }>;
          failed: Array<{ id: string; title: string; reason: string }>;
        };
        bulkStatusResult?: {
          updatedCount: number;
          status: "PLANNED" | "RESERVED";
        };
      }
    | undefined;
  const navigate = useNavigate();
  const location = useLocation();
  const showNotification = useSetAtom(showNotificationAtom);
  const markPurchasedFetcher = useFetcher<typeof action>();
  const markPurchaseFeedback = markPurchasedFetcher.data as
    | {
        error?: string;
        intent?: string;
        bulkPurchaseResult?: {
          recorded: Array<{ id: string; title: string }>;
          failed: Array<{ id: string; title: string; reason: string }>;
        };
      }
    | undefined;
  const markPurchaseError = markPurchaseFeedback?.error;
  const [addPurchaseOpen, setAddPurchaseOpen] = useState(false);
  const [editingRequestId, setEditingRequestId] = useState<string | null>(null);
  const [budgetEditorOpen, setBudgetEditorOpen] = useState(false);
  const [removePurchaseId, setRemovePurchaseId] = useState<string | null>(null);
  const [purchasedOpen, setPurchasedOpen] = useState(
    () =>
      page.notice === "purchases-marked" ||
      page.notice === "request-purchased" ||
      location.hash === "#purchased"
  );
  const [cancelPurchaseRequestId, setCancelPurchaseRequestId] = useState<
    string | null
  >(null);
  const [selectedPurchaseIds, setSelectedPurchaseIds] = useState<Set<string>>(
    () => new Set()
  );
  const year = page.budget.academicYear;
  const latestBudgetYearStart = Math.max(
    ...page.years.map((availableYear) => Number(availableYear.slice(0, 4)))
  );
  const nextBudgetYear = `${latestBudgetYearStart + 1}-${
    latestBudgetYearStart + 2
  }`;
  const currency = page.budget.currency;
  const eligiblePurchases = page.requests;
  const selectedPurchases = useMemo(
    () =>
      eligiblePurchases.filter((purchase) =>
        selectedPurchaseIds.has(purchase.id)
      ),
    [eligiblePurchases, selectedPurchaseIds]
  );
  const hasUnpricedSelection = selectedPurchases.some(
    (purchase) => purchase.estimatedCost === null
  );
  const allVisiblePurchasesSelected =
    eligiblePurchases.length > 0 &&
    eligiblePurchases.every((purchase) => selectedPurchaseIds.has(purchase.id));
  const budgetIsSet = Number(page.budget.amount) > 0;
  const recordedPurchaseId = new URLSearchParams(location.search).get(
    "purchaseId"
  );
  const recordedPurchase = page.purchases.find(
    (purchase) => purchase.id === recordedPurchaseId
  );
  const notice = noticeText(page.notice);
  const requestForPurchase = page.requestForPurchase;
  const editingRequest = page.requests.find(
    (request) => request.id === editingRequestId
  );
  const requestToCancel = page.requests.find(
    (request) => request.id === cancelPurchaseRequestId
  );
  const receiptDraft = page.receiptDraft;

  useEffect(() => {
    const visibleIds = new Set(
      eligiblePurchases.map((purchase) => purchase.id)
    );
    setSelectedPurchaseIds((current) => {
      const next = new Set([...current].filter((id) => visibleIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [eligiblePurchases]);

  useEffect(() => {
    if (actionData?.bulkStatusResult) setSelectedPurchaseIds(new Set());
  }, [actionData]);

  useEffect(() => {
    const result = markPurchaseFeedback?.bulkPurchaseResult;
    if (!result) return;
    const { recorded, failed } = result;
    showNotification({
      title:
        failed.length > 0
          ? "Some purchases could not be marked"
          : "Purchases marked as purchased",
      message:
        failed.length > 0
          ? `${recorded.length} marked; ${failed.length} could not be updated.`
          : undefined,
      icon: {
        name: failed.length > 0 ? "x" : "success",
        variant: failed.length > 0 ? "error" : "success",
      },
      senderId: null,
    });
  }, [markPurchaseFeedback, showNotification]);

  useEffect(() => {
    if (page.notice === "plan-added" || page.notice === "reserved") {
      setAddPurchaseOpen(false);
    }
    if (page.notice === "plan-updated") setEditingRequestId(null);
    if (page.notice === "request-purchased") {
      setPurchasedOpen(true);
      showNotification({
        title: "Purchase marked as purchased.",
        icon: { name: "success", variant: "success" },
        senderId: null,
      });
    }
    if (page.notice === "purchases-marked") {
      setPurchasedOpen(true);
      showNotification({
        title: "Selected purchases marked as purchased.",
        icon: { name: "success", variant: "success" },
        senderId: null,
      });
    }
    if (page.notice === "budget-reset") {
      setBudgetEditorOpen(false);
      showNotification({
        title: "Budget reset",
        message:
          "All totals are zero. Planned items and purchase history are preserved.",
        icon: { name: "success", variant: "success" },
        senderId: null,
      });
    }
    if (page.notice === "purchase-hidden") {
      setRemovePurchaseId(null);
      showNotification({
        title: "Purchase removed from Purchased",
        message: "It remains counted as spent and was not returned to Planned.",
        icon: { name: "success", variant: "success" },
        senderId: null,
      });
    }
    if (
      page.notice === "request-purchased" ||
      page.notice === "purchases-marked" ||
      page.notice === "purchase-hidden" ||
      page.notice === "budget-reset"
    ) {
      const params = new URLSearchParams(location.search);
      params.delete("notice");
      const search = params.toString();
      void navigate(`${location.pathname}${search ? `?${search}` : ""}`, {
        replace: true,
      });
    }
    if (page.notice === "cancelled") setCancelPurchaseRequestId(null);
  }, [
    location.key,
    location.pathname,
    location.search,
    navigate,
    page.notice,
    showNotification,
  ]);

  function togglePurchaseSelection(id: string) {
    setSelectedPurchaseIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAllVisiblePurchases() {
    setSelectedPurchaseIds(
      allVisiblePurchasesSelected
        ? new Set()
        : new Set(eligiblePurchases.map((purchase) => purchase.id))
    );
  }

  return (
    <div className="space-y-6 pb-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-gray-950">
            Purchasing
          </h1>
          <p className="mt-1 text-sm text-gray-600">
            Plan equipment purchases and track the annual budget.
          </p>
        </div>
        <div className="space-y-1">
          <span className="block text-sm font-semibold text-gray-700">
            Budget year
          </span>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Select
              value={year}
              onValueChange={(value) =>
                navigate(`/purchasing?year=${encodeURIComponent(value)}`)
              }
            >
              <SelectTrigger
                hideArrow
                className="inline-flex h-10 w-44 items-center justify-between gap-2 px-3 py-0 text-sm font-semibold leading-none text-gray-800"
              >
                <SelectValue />
                <ChevronDown aria-hidden="true" className="size-4 shrink-0" />
              </SelectTrigger>
              <SelectContent position="popper" align="end">
                {page.years.map((option) => (
                  <SelectItem
                    key={option}
                    value={option}
                    className="px-2 [&>div>span]:ml-3 [&>div>span]:mr-0"
                  >
                    {option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <button
              type="button"
              onClick={() =>
                navigate(
                  `/purchasing?year=${encodeURIComponent(nextBudgetYear)}`
                )
              }
              className="inline-flex h-10 items-center justify-center gap-1.5 rounded-lg border border-gray-300 px-3 text-sm font-semibold text-gray-700 hover:bg-gray-50"
            >
              <Plus aria-hidden="true" className="size-4" /> Add future year
            </button>
          </div>
        </div>
      </header>

      {notice && !recordedPurchase ? (
        <div
          role="status"
          className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm font-medium text-green-900"
        >
          {notice}
        </div>
      ) : null}
      {markPurchaseError ? (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-900"
        >
          {markPurchaseError}
        </div>
      ) : null}
      {actionData?.bulkStatusResult ? (
        <div
          role="status"
          className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm font-medium text-green-950"
        >
          {actionData.bulkStatusResult.status === "RESERVED"
            ? `Budget reserved for ${actionData.bulkStatusResult.updatedCount} purchases.`
            : `Reservations released for ${actionData.bulkStatusResult.updatedCount} purchases.`}
        </div>
      ) : null}
      {recordedPurchase ? (
        <section
          role="status"
          className="rounded-xl border border-green-200 bg-green-50 p-4"
        >
          <h2 className="font-bold text-green-950">Purchase recorded</h2>
          <ul className="mt-2 space-y-1 text-sm text-green-900">
            {recordedPurchase.items.map((item) => (
              <li key={item.id}>
                {item.quantity} {item.name}
              </li>
            ))}
          </ul>
          <div className="mt-3 flex flex-wrap gap-2">
            {recordedPurchase.items.some((item) => !item.linkedAsset)
              ? recordedPurchase.items
                  .filter((item) => !item.linkedAsset)
                  .map((item) => (
                    <Link
                      key={item.id}
                      to={`/assets/new?prefillTitle=${encodeURIComponent(
                        item.name
                      )}&prefillQuantity=${
                        item.quantity
                      }&purchaseItemId=${encodeURIComponent(
                        item.id
                      )}&returnToPurchasing=${encodeURIComponent(year)}`}
                      className="rounded-lg bg-red-700 px-3 py-2 text-sm font-semibold text-white hover:bg-red-800"
                    >
                      Register {item.name} in Inventory
                    </Link>
                  ))
              : null}
            <Link
              to={`/purchasing?year=${encodeURIComponent(year)}`}
              className="rounded-lg border border-green-300 px-3 py-2 text-sm font-semibold text-green-900 hover:bg-green-100"
            >
              Done
            </Link>
          </div>
        </section>
      ) : null}
      {actionData?.error &&
      actionData.intent !== "markRequestPurchased" &&
      actionData.intent !== "cancelRequest" &&
      actionData.intent !== "removePurchase" &&
      actionData.intent !== "resetBudget" ? (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-900"
        >
          {actionData.error}
        </div>
      ) : null}

      <section
        aria-labelledby="purchasing-budget-heading"
        className="space-y-3"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2
            id="purchasing-budget-heading"
            className="text-lg font-bold text-gray-950"
          >
            Budget {year}
          </h2>
          <button
            type="button"
            onClick={() => setBudgetEditorOpen(true)}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
          >
            {budgetIsSet ? "Edit budget" : "Set annual budget"}
          </button>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <SummaryCard
            label="Annual budget"
            value={money(page.budget.amount, currency)}
          />
          <SummaryCard
            label="Spent"
            value={money(page.budget.spent, currency)}
          />
          <SummaryCard
            label="Reserved"
            value={money(page.budget.reserved, currency)}
          />
          <SummaryCard
            label="Available"
            value={money(page.budget.available, currency)}
            prominent
            negative={Number(page.budget.available) < 0}
          />
        </div>
      </section>

      <PurchasingModal
        open={budgetEditorOpen}
        title={budgetIsSet ? "Edit annual budget" : "Set annual budget"}
        onClose={() => setBudgetEditorOpen(false)}
      >
        <p className="text-sm text-gray-600">Budget year {year}</p>
        {(actionData?.intent === "saveBudget" ||
          actionData?.intent === "resetBudget") &&
        actionData.error ? (
          <p
            role="alert"
            className="rounded-md bg-red-50 p-3 text-sm text-red-900"
          >
            {actionData.error}
          </p>
        ) : null}
        <Form
          method="post"
          action={`/purchasing?year=${encodeURIComponent(year)}`}
          className="space-y-4"
          onSubmit={(event) => {
            const form = new FormData(event.currentTarget);
            const proposed = Number(form.get("amount"));
            const resultingAvailable =
              Number(page.budget.available) +
              proposed -
              Number(page.budget.amount);
            if (
              resultingAvailable < 0 &&
              !window.confirm(
                `This change will leave ${money(
                  Math.abs(resultingAvailable),
                  currency
                )} in confirmed spending or reservations above the annual budget. Continue?`
              )
            ) {
              event.preventDefault();
            } else {
              const input = event.currentTarget.elements.namedItem(
                "confirmedOverBudget"
              );
              if (input instanceof HTMLInputElement)
                input.value = resultingAvailable < 0 ? "1" : "0";
            }
          }}
        >
          <input type="hidden" name="intent" value="saveBudget" />
          <input type="hidden" name="academicYear" value={year} />
          <input type="hidden" name="confirmedOverBudget" value="0" />
          <label className="block text-sm font-semibold text-gray-700">
            Annual budget
            <div className="mt-1 flex items-center gap-2">
              <input
                type="number"
                name="amount"
                min="0"
                step="0.01"
                required
                defaultValue={page.budget.amount}
                className="w-full rounded-md border border-gray-300 px-3 py-2"
              />
              <span className="text-sm font-bold text-gray-600">SEK</span>
            </div>
          </label>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setBudgetEditorOpen(false)}
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button className="rounded-lg bg-red-700 px-4 py-2 text-sm font-semibold text-white hover:bg-red-800">
              Save
            </button>
          </div>
        </Form>
        <Form
          method="post"
          action={`/purchasing?year=${encodeURIComponent(year)}`}
          onSubmit={(event) => {
            if (
              !window.confirm(
                `Reset the ${year} budget? Annual budget, spent, reserved, and available will become 0 SEK. Planned requests and Purchased history will remain. Existing reservations will be released back to Planned.`
              )
            ) {
              event.preventDefault();
            }
          }}
        >
          <input type="hidden" name="intent" value="resetBudget" />
          <input type="hidden" name="academicYear" value={year} />
          <div className="flex justify-start border-t border-gray-100 pt-3">
            <button
              type="submit"
              className="rounded-lg border border-red-300 px-3 py-2 text-sm font-semibold text-red-800 hover:bg-red-50"
            >
              Reset budget
            </button>
          </div>
        </Form>
      </PurchasingModal>

      {receiptDraft ? (
        <ReceiptReview
          draft={receiptDraft}
          request={requestForPurchase}
          assets={page.assets}
          year={year}
          currency={currency}
          available={Number(page.budget.available)}
          error={
            actionData?.intent === "recordPurchase"
              ? actionData.error
              : undefined
          }
        />
      ) : null}
      {requestForPurchase && !receiptDraft ? (
        <PurchaseRecordForm
          request={requestForPurchase}
          assets={page.assets}
          year={year}
          currency={currency}
          available={Number(page.budget.available)}
          error={
            actionData?.intent === "recordPurchase"
              ? actionData.error
              : undefined
          }
        />
      ) : null}

      <section className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-bold text-gray-950">
              Planned purchases
            </h2>
            <p className="text-sm text-gray-600">
              Plan upcoming purchases and reserve budget when needed.
            </p>
            {eligiblePurchases.length ? (
              <button
                type="button"
                onClick={toggleAllVisiblePurchases}
                className="mt-2 text-sm font-semibold text-red-800 underline-offset-2 hover:underline"
              >
                {allVisiblePurchasesSelected ? "Clear selection" : "Select all"}
              </button>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => setAddPurchaseOpen(true)}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-red-700 px-4 text-sm font-semibold text-white hover:bg-red-800"
            >
              <Plus className="size-4 shrink-0" /> Add planned purchase
            </button>
          </div>
        </div>
        {selectedPurchases.length ? (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-red-100 bg-red-50/60 px-3 py-2">
            <span className="mr-1 text-sm font-semibold text-gray-800">
              {selectedPurchases.length} selected
            </span>
            <button
              type="button"
              disabled={
                hasUnpricedSelection || markPurchasedFetcher.state !== "idle"
              }
              title={
                hasUnpricedSelection
                  ? "Add an estimated price to each selected purchase first."
                  : undefined
              }
              onClick={() =>
                markPurchasedFetcher.submit(
                  {
                    intent: "bulkRecordPurchases",
                    academicYear: year,
                    purchaseDate: localDateInputValue(),
                    confirmedOverBudget: "0",
                    purchaseLines: JSON.stringify(
                      selectedPurchases.map((purchase) => ({
                        requestId: purchase.id,
                      }))
                    ),
                  },
                  {
                    method: "post",
                    action: `/purchasing?year=${encodeURIComponent(year)}`,
                  }
                )
              }
              className="rounded-md bg-red-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Mark purchased
            </button>
            <button
              type="button"
              onClick={() => setSelectedPurchaseIds(new Set())}
              className="rounded-md px-3 py-1.5 text-sm font-semibold text-gray-600 hover:bg-white"
            >
              Clear
            </button>
          </div>
        ) : null}
        <PurchasingModal
          open={addPurchaseOpen}
          title="Add purchase"
          onClose={() => setAddPurchaseOpen(false)}
        >
          <PurchaseRequestForm
            mode="create"
            year={year}
            currency={currency}
            available={Number(page.budget.available)}
            error={
              actionData?.intent === "createRequest"
                ? actionData.error
                : undefined
            }
            onCancel={() => setAddPurchaseOpen(false)}
          />
        </PurchasingModal>

        <PurchasingModal
          open={Boolean(editingRequest)}
          title="Edit purchase"
          onClose={() => setEditingRequestId(null)}
        >
          {editingRequest ? (
            <PurchaseRequestForm
              mode="edit"
              request={editingRequest}
              year={year}
              currency={currency}
              available={Number(page.budget.available)}
              error={
                actionData?.intent === "updateRequest"
                  ? actionData.error
                  : undefined
              }
              onCancel={() => setEditingRequestId(null)}
            />
          ) : null}
        </PurchasingModal>

        <PurchasingModal
          open={Boolean(requestToCancel)}
          title="Cancel purchase"
          onClose={() => setCancelPurchaseRequestId(null)}
        >
          {requestToCancel ? (
            <>
              {actionData?.intent === "cancelRequest" && actionData.error ? (
                <p
                  role="alert"
                  className="rounded-md bg-red-50 p-3 text-sm text-red-900"
                >
                  {actionData.error}
                </p>
              ) : null}
              <p className="text-sm text-gray-700">
                Cancel{" "}
                <span className="font-semibold">{requestToCancel.title}</span>?
                {requestToCancel.status === "RESERVED"
                  ? ` This will release ${money(
                      requestToCancel.estimatedCost ?? 0,
                      currency
                    )} back to the available budget.`
                  : " This removes it from active planned purchases."}
              </p>
              <Form
                method="post"
                action={`/purchasing?year=${encodeURIComponent(year)}`}
                className="flex justify-end gap-2"
              >
                <input type="hidden" name="intent" value="cancelRequest" />
                <input type="hidden" name="academicYear" value={year} />
                <input
                  type="hidden"
                  name="requestId"
                  value={requestToCancel.id}
                />
                <button
                  type="button"
                  onClick={() => setCancelPurchaseRequestId(null)}
                  className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button className="rounded-lg bg-red-700 px-4 py-2 text-sm font-semibold text-white hover:bg-red-800">
                  Confirm cancellation
                </button>
              </Form>
            </>
          ) : null}
        </PurchasingModal>

        {(["HIGH", "MEDIUM", "LATER"] as const).map((priority) => {
          const requests = page.requests.filter(
            (request) => request.priority === priority
          );
          if (!requests.length) return null;
          return (
            <div key={priority} className="space-y-2">
              <h3 className="text-sm font-bold uppercase tracking-wide text-gray-500">
                {priority === "LATER"
                  ? "Low"
                  : priority === "HIGH"
                  ? "High"
                  : "Medium"}
              </h3>
              {requests.map((request) => (
                <SelectableRow
                  key={request.id}
                  selected={selectedPurchaseIds.has(request.id)}
                  onToggle={() => togglePurchaseSelection(request.id)}
                  className="mb-2"
                >
                  <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1">
                    <input
                      type="checkbox"
                      aria-label={`Select ${request.title}`}
                      checked={selectedPurchaseIds.has(request.id)}
                      onChange={() => togglePurchaseSelection(request.id)}
                      className="row-span-3 ml-1 size-4 self-center accent-red-700"
                    />
                    <div className="col-start-2 row-start-1 flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 lg:flex-nowrap">
                      <div className="flex min-w-0 items-baseline gap-2">
                        <span className="shrink-0 whitespace-nowrap text-base font-medium leading-6 text-gray-600">
                          {request.quantity}x
                        </span>
                        {request.link ? (
                          <a
                            href={request.link}
                            target="_blank"
                            rel="noreferrer"
                            title={request.title}
                            className="inline-flex min-w-0 items-center gap-1 text-base font-bold leading-6 text-gray-950 underline decoration-gray-300 underline-offset-2 hover:text-red-800"
                          >
                            <span className="min-w-0 truncate">
                              {request.title}
                            </span>
                            <ExternalLink
                              aria-hidden="true"
                              className="size-3.5 shrink-0"
                            />
                          </a>
                        ) : (
                          <span className="min-w-0 truncate text-base font-bold leading-6 text-gray-950">
                            {request.title}
                          </span>
                        )}
                      </div>
                      {request.estimatedCost != null ? (
                        <span
                          title="Estimated total"
                          aria-label={`${money(
                            request.estimatedCost,
                            currency
                          )} estimated`}
                          className="shrink-0 whitespace-nowrap text-base font-medium leading-6 text-gray-700"
                        >
                          {money(request.estimatedCost, currency)}{" "}
                          <span className="font-normal text-gray-500">
                            estimated
                          </span>
                        </span>
                      ) : null}
                    </div>
                    <p className="col-start-2 row-start-2 flex min-w-0 items-center gap-1.5 text-sm text-gray-600">
                      <UserRound
                        aria-hidden="true"
                        className="size-4 shrink-0 text-gray-400"
                      />
                      <span className="whitespace-normal break-words">
                        {displayPerson(request.requestedBy)}
                      </span>
                    </p>
                    {request.note ? (
                      <p className="col-start-2 row-start-3 min-w-0 whitespace-pre-wrap break-words text-sm text-gray-800">
                        {request.note}
                      </p>
                    ) : null}
                    <div
                      className="col-start-3 row-start-1 flex shrink-0 items-center gap-2"
                      data-selection-exempt
                    >
                      {request.status === "RESERVED" ? (
                        <span className="inline-flex rounded-full bg-gray-100 px-2.5 py-1 text-xs font-semibold text-gray-600">
                          Reserved
                        </span>
                      ) : null}
                      <span
                        className={`inline-flex rounded-full px-2.5 py-1 text-xs font-bold ${
                          request.priority === "HIGH"
                            ? "bg-red-50 text-red-800"
                            : request.priority === "MEDIUM"
                            ? "bg-amber-50 text-amber-800"
                            : "bg-gray-100 text-gray-600"
                        }`}
                      >
                        {priorityLabel(request.priority)}
                      </span>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            aria-label={`Actions for ${request.title}`}
                            className="flex size-9 items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-600 shadow-sm hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-700"
                          >
                            <MoreHorizontal
                              aria-hidden="true"
                              className="size-5"
                            />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          align="end"
                          onClick={(event) => event.stopPropagation()}
                          className="min-w-48 space-y-1"
                        >
                          <DropdownMenuItem
                            onSelect={() => setEditingRequestId(request.id)}
                          >
                            Edit purchase
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={
                              request.estimatedCost === null ||
                              markPurchasedFetcher.state !== "idle"
                            }
                            onSelect={() =>
                              markPurchasedFetcher.submit(
                                {
                                  intent: "markRequestPurchased",
                                  requestId: request.id,
                                  academicYear: year,
                                  purchaseDate: localDateInputValue(),
                                  confirmedOverBudget: "0",
                                },
                                {
                                  method: "post",
                                  action: `/purchasing?year=${encodeURIComponent(
                                    year
                                  )}`,
                                }
                              )
                            }
                          >
                            Purchased
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() =>
                              setCancelPurchaseRequestId(request.id)
                            }
                            className="text-red-800 focus:bg-red-50"
                          >
                            Cancel purchase
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                </SelectableRow>
              ))}
            </div>
          );
        })}
        {!page.requests.length ? (
          <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50 px-4 py-5">
            <p className="text-sm text-gray-600">No purchases yet.</p>
          </div>
        ) : null}
      </section>

      <details
        id="purchased"
        open={purchasedOpen}
        onToggle={(event) => setPurchasedOpen(event.currentTarget.open)}
        className="rounded-xl border border-gray-200 bg-white p-3"
      >
        <summary className="cursor-pointer font-semibold text-gray-800">
          Purchased
        </summary>
        <div className="mt-2 space-y-2">
          <p className="text-sm text-gray-600">
            Confirmed purchases for this budget year.
          </p>
          {page.purchases.map((purchase) => {
            const purchaseLabel =
              purchase.items.map((item) => item.name).join(" + ") ||
              purchase.purchaseRequest?.title ||
              "This purchase";
            const removalError =
              actionData?.intent === "removePurchase" &&
              actionData.purchaseId === purchase.id
                ? actionData.error
                : null;
            return (
              <AlertDialog
                key={purchase.id}
                open={removePurchaseId === purchase.id}
                onOpenChange={(open) =>
                  setRemovePurchaseId(open ? purchase.id : null)
                }
              >
                <article className="rounded-lg border border-gray-200 bg-white px-3 py-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                        <h3 className="text-base font-semibold leading-6 text-gray-950">
                          {purchase.items
                            .map((item) => `${item.quantity}x ${item.name}`)
                            .join(" · ") ||
                            purchase.purchaseRequest?.title ||
                            "Purchase"}
                        </h3>
                        <span className="text-sm font-semibold leading-6 text-gray-800">
                          {money(purchase.actualTotal, currency)}
                        </span>
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-600">
                        <span>
                          Purchased {dateLabel(purchase.purchaseDate)}
                        </span>
                        {purchase.createdBy ? (
                          <span className="inline-flex items-center gap-1">
                            <UserRound
                              aria-hidden="true"
                              className="size-3.5 text-gray-400"
                            />
                            {displayPerson(purchase.createdBy)}
                          </span>
                        ) : null}
                        {purchase.vendor ? (
                          <span>{purchase.vendor}</span>
                        ) : null}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {purchase.receiptUrl ? (
                        <a
                          href={purchase.receiptUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-xs font-semibold text-gray-600 hover:bg-gray-50"
                        >
                          <FileText className="size-4" /> View receipt
                        </a>
                      ) : null}
                      {purchase.items
                        .filter((item) => !item.linkedAsset)
                        .map((item) => (
                          <Link
                            key={item.id}
                            to={`/assets/new?prefillTitle=${encodeURIComponent(
                              item.name
                            )}&prefillQuantity=${
                              item.quantity
                            }&purchaseItemId=${encodeURIComponent(
                              item.id
                            )}&returnToPurchasing=${encodeURIComponent(year)}`}
                            aria-label={`Register ${item.name} in Inventory`}
                            className="rounded-md bg-red-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-800"
                          >
                            Register in Inventory
                          </Link>
                        ))}
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            aria-label={`Actions for ${purchaseLabel}`}
                            className="flex size-9 items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-600 shadow-sm hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-700"
                          >
                            <MoreHorizontal
                              aria-hidden="true"
                              className="size-5"
                            />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="min-w-48">
                          <DropdownMenuItem
                            onSelect={() => setRemovePurchaseId(purchase.id)}
                            className="text-red-800 focus:bg-red-50 focus:text-red-900"
                          >
                            Remove purchase
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                  {purchase.note ? (
                    <p className="mt-1 text-xs text-gray-600">
                      {purchase.note}
                    </p>
                  ) : null}
                  {purchase.corrections.length ? (
                    <details className="mt-1 text-xs text-gray-600">
                      <summary className="cursor-pointer font-semibold">
                        Correction history ({purchase.corrections.length})
                      </summary>
                      <ul className="mt-1 space-y-1">
                        {purchase.corrections.map((correction) => (
                          <li key={correction.id}>
                            {money(
                              correction.previousTotal.toString(),
                              currency
                            )}{" "}
                            → {money(correction.newTotal.toString(), currency)}{" "}
                            · {dateLabel(correction.createdAt)} ·{" "}
                            {displayPerson(correction.changedBy)}
                            {correction.reason ? ` · ${correction.reason}` : ""}
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Remove purchase?</AlertDialogTitle>
                      <AlertDialogDescription>
                        <span className="block">
                          {purchaseLabel} was recorded as a{" "}
                          {money(purchase.actualTotal, currency)} purchase.
                        </span>
                        <span className="mt-2 block">
                          This will hide it from Purchased. The amount remains
                          counted as spent, and the purchase will not return to
                          Planned.
                        </span>
                      </AlertDialogDescription>
                      {purchase.items.some((item) => item.linkedAsset) ? (
                        <p className="text-sm text-gray-600">
                          Items already registered in Inventory will remain
                          there.
                        </p>
                      ) : null}
                      {purchase.corrections.length ? (
                        <p className="text-sm text-gray-600">
                          Its purchase and correction history will remain
                          recorded.
                        </p>
                      ) : null}
                      {removalError ? (
                        <p
                          role="alert"
                          className="rounded-md bg-red-50 p-3 text-sm text-red-900"
                        >
                          {removalError}
                        </p>
                      ) : null}
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel asChild>
                        <button
                          type="button"
                          className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
                        >
                          Cancel
                        </button>
                      </AlertDialogCancel>
                      <Form
                        method="post"
                        action={`/purchasing?year=${encodeURIComponent(year)}`}
                      >
                        <input
                          type="hidden"
                          name="intent"
                          value="removePurchase"
                        />
                        <input
                          type="hidden"
                          name="purchaseId"
                          value={purchase.id}
                        />
                        <input type="hidden" name="academicYear" value={year} />
                        <button
                          type="submit"
                          className="rounded-lg border border-red-700 bg-red-700 px-4 py-2 text-sm font-semibold text-white hover:border-red-800 hover:bg-red-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-700 focus-visible:ring-offset-2"
                        >
                          Remove purchase
                        </button>
                      </Form>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </article>
              </AlertDialog>
            );
          })}
          {!page.purchases.length ? (
            <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50 px-4 py-6 text-center text-sm text-gray-600">
              No purchases recorded yet.
            </div>
          ) : null}
        </div>
      </details>

      <details className="rounded-xl border border-gray-200 bg-white p-4">
        <summary className="cursor-pointer font-semibold text-gray-800">
          Budget history
        </summary>
        {page.adjustments.length ? (
          <ol className="mt-3 divide-y divide-gray-100">
            {page.adjustments.map((entry) => (
              <li
                key={entry.id}
                className="flex flex-wrap justify-between gap-2 py-2 text-sm"
              >
                <span>
                  {entry.reason === "Budget reset"
                    ? "Budget reset · totals set to 0 SEK"
                    : `Annual budget changed · ${money(
                        entry.previousAmount,
                        currency
                      )} → ${money(entry.newAmount, currency)}${
                        entry.reason ? ` · ${entry.reason}` : ""
                      }`}
                </span>
                <span className="text-gray-500">
                  {dateLabel(entry.createdAt)} ·{" "}
                  {displayPerson(entry.changedBy)}
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="mt-2 text-sm text-gray-600">No budget changes yet.</p>
        )}
      </details>
    </div>
  );
}

function displayPerson(
  person: {
    displayName?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    email?: string | null;
  } | null
) {
  return (
    person?.displayName?.trim() ||
    [person?.firstName, person?.lastName].filter(Boolean).join(" ").trim() ||
    person?.email ||
    "Former user"
  );
}

function SummaryCard({
  label,
  value,
  prominent = false,
  negative = false,
}: {
  label: string;
  value: string;
  prominent?: boolean;
  negative?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border p-4 ${
        prominent ? "border-red-200 bg-red-50" : "border-gray-200 bg-white"
      }`}
    >
      <p className="text-sm font-semibold text-gray-600">{label}</p>
      <p
        className={`mt-1 text-2xl font-bold tabular-nums ${
          negative
            ? "text-red-800"
            : prominent
            ? "text-red-800"
            : "text-gray-950"
        }`}
      >
        {value}
      </p>
    </div>
  );
}

function PurchasingModal({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [onClose, open]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto p-4">
      <button
        type="button"
        aria-label={`Close ${title}`}
        onClick={onClose}
        className="absolute inset-0 bg-gray-950/40"
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative z-10 my-auto w-full max-w-xl rounded-2xl border border-gray-200 bg-white p-5 shadow-xl"
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-lg font-bold text-gray-950">{title}</h2>
          <button
            type="button"
            aria-label={`Close ${title}`}
            onClick={onClose}
            className="rounded-lg p-2 text-gray-500 hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-red-700"
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        </div>
        <div className="space-y-4">{children}</div>
      </section>
    </div>
  );
}

function PurchaseRequestForm({
  mode,
  request,
  year,
  currency,
  available,
  error,
  onCancel,
}: {
  mode: "create" | "edit";
  request?: LoaderData["requests"][number];
  year: string;
  currency: string;
  available: number;
  error?: string;
  onCancel: () => void;
}) {
  const isEditing = mode === "edit";

  return (
    <>
      {error ? (
        <p
          role="alert"
          className="rounded-md bg-red-50 p-3 text-sm text-red-900"
        >
          {error}
        </p>
      ) : null}
      <Form
        method="post"
        action={`/purchasing?year=${encodeURIComponent(year)}`}
        className="space-y-4"
        onSubmit={(event) => {
          const form = new FormData(event.currentTarget);
          const reserveBudget = form.getAll("reserveBudget").includes("1");
          const estimated = Number(form.get("estimatedCost"));
          const wasReserved = request?.status === "RESERVED";
          if (
            reserveBudget &&
            (!Number.isFinite(estimated) || estimated <= 0)
          ) {
            const input =
              event.currentTarget.elements.namedItem("estimatedCost");
            if (input instanceof HTMLInputElement) {
              input.setCustomValidity(
                "Enter an estimated total before reserving budget."
              );
              input.reportValidity();
              input.addEventListener(
                "input",
                () => input.setCustomValidity(""),
                { once: true }
              );
            }
            event.preventDefault();
            return;
          }

          const resultingAvailable = reserveBudget
            ? available +
              (wasReserved ? Number(request?.estimatedCost ?? 0) : 0) -
              estimated
            : available +
              (wasReserved ? Number(request?.estimatedCost ?? 0) : 0);
          if (
            resultingAvailable < 0 &&
            !window.confirm(
              `This ${
                reserveBudget ? "reservation" : "change"
              } will exceed available budget by ${money(
                Math.abs(resultingAvailable),
                currency
              )}. Continue?`
            )
          ) {
            event.preventDefault();
            return;
          }
          const confirmedField = event.currentTarget.elements.namedItem(
            "confirmedOverBudget"
          );
          if (confirmedField instanceof HTMLInputElement) {
            confirmedField.value = resultingAvailable < 0 ? "1" : "0";
          }
        }}
      >
        <input
          type="hidden"
          name="intent"
          value={isEditing ? "updateRequest" : "createRequest"}
        />
        <input type="hidden" name="academicYear" value={year} />
        <input type="hidden" name="confirmedOverBudget" value="0" />
        <input type="hidden" name="reserveBudget" value="0" />
        {isEditing ? (
          <input type="hidden" name="requestId" value={request?.id ?? ""} />
        ) : null}
        <label className="block text-sm font-semibold text-gray-700">
          Item
          <input
            name="title"
            required
            maxLength={240}
            autoFocus={!isEditing}
            defaultValue={request?.title ?? ""}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2"
          />
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm font-semibold text-gray-700">
            Quantity
            <input
              name="quantity"
              type="number"
              min="1"
              required
              defaultValue={request?.quantity ?? 1}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2"
            />
          </label>
          <label className="block text-sm font-semibold text-gray-700">
            Estimated total
            <div className="mt-1 flex items-center gap-2">
              <input
                name="estimatedCost"
                type="number"
                min="0"
                step="0.01"
                defaultValue={request?.estimatedCost ?? ""}
                className="w-full rounded-md border border-gray-300 px-3 py-2"
              />
              <span className="text-sm font-bold text-gray-600">SEK</span>
            </div>
          </label>
        </div>
        <label className="block text-sm font-semibold text-gray-700">
          Priority
          <select
            name="priority"
            defaultValue={
              request
                ? request.priority === "LATER"
                  ? "LOW"
                  : request.priority
                : "MEDIUM"
            }
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2"
          >
            <option value="HIGH">High</option>
            <option value="MEDIUM">Medium</option>
            <option value="LOW">Low</option>
          </select>
        </label>
        <label className="block text-sm font-semibold text-gray-700">
          Supplier link{" "}
          <span className="font-normal text-gray-500">(optional)</span>
          <input
            name="link"
            type="url"
            defaultValue={request?.link ?? ""}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2"
          />
        </label>
        <label className="block text-sm font-semibold text-gray-700">
          Note <span className="font-normal text-gray-500">(optional)</span>
          <textarea
            name="note"
            rows={2}
            maxLength={2000}
            defaultValue={request?.note ?? ""}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2"
          />
        </label>
        <label className="flex items-start gap-2 rounded-lg bg-gray-50 p-3 text-sm text-gray-700">
          <input
            type="checkbox"
            name="reserveBudget"
            value="1"
            defaultChecked={request?.status === "RESERVED"}
            className="mt-0.5 size-4 accent-red-700"
          />
          <span>
            {isEditing ? "Reserved" : "Reserve budget now"}
            {!isEditing ? (
              <span className="block text-xs text-gray-500">
                The estimated total will be deducted from Available.
              </span>
            ) : null}
          </span>
        </label>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button className="rounded-lg bg-red-700 px-4 py-2 text-sm font-semibold text-white hover:bg-red-800">
            {isEditing ? "Save changes" : "Add purchase"}
          </button>
        </div>
      </Form>
    </>
  );
}

function PurchaseRecordForm({
  request,
  assets,
  year,
  currency,
  available,
  error,
}: {
  request: {
    id: string;
    title: string;
    quantity: number;
    estimatedCost: string | null;
    status: string;
  };
  assets: LoaderData["assets"];
  year: string;
  currency: string;
  available: number;
  error?: string;
}) {
  const initial = [
    {
      name: request.title,
      quantity: String(request.quantity),
      lineTotal: request.estimatedCost ?? "",
    },
  ];
  return (
    <section
      className="scroll-mt-4 rounded-xl border border-red-200 bg-red-50/40 p-4"
      id="purchase-form"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-gray-950">Purchase details</h2>
          <p className="text-sm text-gray-600">
            Confirm the actual cost and item details before recording.
          </p>
        </div>
        <Link
          to={`/purchasing?year=${encodeURIComponent(year)}`}
          className="rounded-md p-2 text-gray-500 hover:bg-gray-100"
          aria-label="Close purchase form"
        >
          <X className="size-4" />
        </Link>
      </div>
      {error ? (
        <p
          role="alert"
          className="mt-3 rounded-md bg-red-100 px-3 py-2 text-sm text-red-900"
        >
          {error}
        </p>
      ) : null}
      <Form
        method="post"
        action={`/purchasing?year=${encodeURIComponent(year)}`}
        className="mt-4 space-y-4"
        onSubmit={(event) => {
          const amount = Number(
            new FormData(event.currentTarget).get("actualTotal")
          );
          const releasedReservation =
            request.status === "RESERVED"
              ? Number(request.estimatedCost ?? 0)
              : 0;
          const resultingAvailable = available + releasedReservation - amount;
          if (
            resultingAvailable < 0 &&
            !window.confirm(
              `This purchase will exceed available budget by ${money(
                Math.abs(resultingAvailable),
                currency
              )}. Continue?`
            )
          )
            event.preventDefault();
          else {
            const field = event.currentTarget.elements.namedItem(
              "confirmedOverBudget"
            );
            if (field instanceof HTMLInputElement)
              field.value = resultingAvailable < 0 ? "1" : "0";
          }
        }}
      >
        <input type="hidden" name="intent" value="recordPurchase" />
        <input type="hidden" name="academicYear" value={year} />
        <input type="hidden" name="requestId" value={request.id} />
        <input type="hidden" name="confirmedOverBudget" value="0" />
        <PurchaseRecordFields initial={initial} assets={assets} />
      </Form>
    </section>
  );
}

function PurchaseRecordFields({
  initial,
  assets,
  draft,
}: {
  initial: Line[];
  assets: LoaderData["assets"];
  draft?: NonNullable<LoaderData["receiptDraft"]>;
}) {
  return (
    <>
      {draft ? (
        <input type="hidden" name="receiptDraftId" value={draft.id} />
      ) : null}
      {draft ? (
        <p className="text-sm text-gray-700">
          Receipt saved privately:{" "}
          <a
            className="font-semibold text-red-800 underline"
            href={draft.signedUrl}
            target="_blank"
            rel="noreferrer"
          >
            {draft.originalName}
          </a>
          .{" "}
          {draft.extractedData?.extractionNote ??
            "Enter the details manually; no values have been assumed."}
        </p>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="text-sm font-semibold text-gray-700">
          Vendor
          <input
            name="vendor"
            defaultValue={draft?.extractedData?.vendor ?? ""}
            maxLength={240}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2"
          />
        </label>
        <label className="text-sm font-semibold text-gray-700">
          Purchase date
          <input
            name="purchaseDate"
            type="date"
            required
            defaultValue={
              draft?.extractedData?.purchaseDate ||
              new Date().toISOString().slice(0, 10)
            }
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2"
          />
        </label>
        <label className="text-sm font-semibold text-gray-700">
          Total (SEK)
          <input
            name="actualTotal"
            type="number"
            min="0"
            step="0.01"
            required
            defaultValue={draft?.extractedData?.actualTotal ?? ""}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2"
          />
        </label>
      </div>
      <label className="block text-sm font-semibold text-gray-700">
        Optional note
        <textarea
          name="note"
          rows={2}
          className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2"
        />
      </label>
      <PurchaseLinesEditor
        initial={
          draft?.extractedData?.items?.length
            ? draft.extractedData.items.map((item) => ({
                name: item.name,
                quantity: String(item.quantity),
                lineTotal: item.lineTotal,
              }))
            : initial
        }
        assets={assets}
      />
      <div className="flex flex-wrap gap-2">
        <button className="rounded-md bg-red-700 px-4 py-2 font-semibold text-white hover:bg-red-800">
          Confirm purchase
        </button>
      </div>
    </>
  );
}

function ReceiptReview({
  draft,
  request,
  assets,
  year,
  currency,
  available,
  error,
}: {
  draft: NonNullable<LoaderData["receiptDraft"]>;
  request: LoaderData["requestForPurchase"];
  assets: LoaderData["assets"];
  year: string;
  currency: string;
  available: number;
  error?: string;
}) {
  return (
    <PurchaseRecordFormWithDraft
      draft={draft}
      request={request}
      assets={assets}
      year={year}
      currency={currency}
      available={available}
      error={error}
    />
  );
}

function PurchaseRecordFormWithDraft({
  draft,
  request,
  assets,
  year,
  currency,
  available,
  error,
}: {
  draft: NonNullable<LoaderData["receiptDraft"]>;
  request: LoaderData["requestForPurchase"];
  assets: LoaderData["assets"];
  year: string;
  currency: string;
  available: number;
  error?: string;
}) {
  const initial = request
    ? [
        {
          name: request.title,
          quantity: String(request.quantity),
          lineTotal: request.estimatedCost ?? "",
        },
      ]
    : [{ name: "", quantity: "1", lineTotal: "" }];
  return (
    <section className="rounded-xl border border-red-200 bg-red-50/40 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-gray-950">Receipt review</h2>
          <p className="text-sm text-gray-600">
            Review and correct every suggested value before confirming the
            purchase.
          </p>
        </div>
        <Link
          to={`/purchasing?year=${encodeURIComponent(year)}`}
          aria-label="Close receipt review"
          className="rounded-md p-2 text-gray-500 hover:bg-gray-100"
        >
          <X className="size-4" />
        </Link>
      </div>
      {error ? (
        <p
          role="alert"
          className="mt-3 rounded-md bg-red-100 px-3 py-2 text-sm text-red-900"
        >
          {error}
        </p>
      ) : null}
      <Form
        method="post"
        action={`/purchasing?year=${encodeURIComponent(year)}`}
        className="mt-4 space-y-4"
        onSubmit={(event) => {
          const form = new FormData(event.currentTarget);
          const amount = Number(form.get("actualTotal"));
          const releasedReservation =
            request?.status === "RESERVED"
              ? Number(request.estimatedCost ?? 0)
              : 0;
          const resultingAvailable = available + releasedReservation - amount;
          if (
            resultingAvailable < 0 &&
            !window.confirm(
              `This purchase will exceed available budget by ${money(
                Math.abs(resultingAvailable),
                currency
              )}. Continue?`
            )
          )
            event.preventDefault();
          else {
            const field = event.currentTarget.elements.namedItem(
              "confirmedOverBudget"
            );
            if (field instanceof HTMLInputElement)
              field.value = resultingAvailable < 0 ? "1" : "0";
          }
        }}
      >
        <input type="hidden" name="intent" value="recordPurchase" />
        <input type="hidden" name="academicYear" value={year} />
        <input type="hidden" name="requestId" value={request?.id ?? ""} />
        <input type="hidden" name="confirmedOverBudget" value="0" />
        <PurchaseRecordFields initial={initial} assets={assets} draft={draft} />
      </Form>
    </section>
  );
}
