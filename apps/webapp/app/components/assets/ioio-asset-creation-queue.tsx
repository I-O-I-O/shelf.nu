import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import type { ForwardedRef } from "react";
import type { CustomField } from "@prisma/client";
import { AssetType } from "@prisma/client";
import { useAtom } from "jotai";
import {
  useBeforeUnload,
  useBlocker,
  useFetcher,
  useNavigate,
} from "react-router";
import { dynamicTitleAtom } from "~/atoms/dynamic-title-atom";
import { Button } from "~/components/shared/button";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/shared/modal";
import type { DataOrErrorResponse } from "~/utils/http.server";

import {
  IoioAssetCreateForm,
  type IoioAssetFormLoaderData,
} from "./ioio-asset-create-form";

type QueueActionData = {
  assetQueueValidated?: boolean;
  assetQueueCreated?: boolean;
  createdCount?: number;
  warning?: string;
} & DataOrErrorResponse;

type InitialAssetValues = {
  title?: string;
  quantity?: number;
  qrId?: string | null;
  categoryId?: string | null;
  locationId?: string | null;
  sequentialId?: string;
  referer?: string | null;
  customFields?: IoioAssetFormLoaderData["customFields"];
};

type QueueCustomFieldsResponse = {
  customFields: Array<
    Pick<
      CustomField,
      "id" | "name" | "helpText" | "required" | "type" | "options" | "active"
    >
  >;
};

type DraftSummary = {
  title: string;
  units: string;
  type: string;
  valid: boolean;
  needsAttention: boolean;
};

type QueueDraftHandle = {
  submitIntent: (
    intent: "validate" | "create",
    formDataSnapshot?: FormData
  ) => Promise<QueueActionData | undefined>;
  snapshotFormData: () => FormData | undefined;
  readSummary: () => DraftSummary;
};

function cloneFormData(source: FormData) {
  const clone = new FormData();
  for (const [key, value] of source.entries()) {
    clone.append(key, value);
  }
  return clone;
}

const EMPTY_SUMMARY: DraftSummary = {
  title: "",
  units: "Quantity not set",
  type: AssetType.QUANTITY_TRACKED,
  valid: false,
  needsAttention: false,
};

function readDraftSummary(form: HTMLFormElement): DraftSummary {
  const data = new FormData(form);
  const title = String(data.get("title") ?? "").trim();
  const type = String(data.get("type") ?? AssetType.QUANTITY_TRACKED);
  const rawQuantity = Number(data.get("quantity"));
  const quantity =
    Number.isSafeInteger(rawQuantity) && rawQuantity > 0 ? rawQuantity : null;
  const unitLabel = String(data.get("unitOfMeasure") ?? "").trim();
  const units =
    type === AssetType.INDIVIDUAL
      ? `${quantity ?? 1} individually tracked ${
          quantity === 1 ? "unit" : "units"
        }`
      : quantity
      ? `${quantity} ${unitLabel || (quantity === 1 ? "unit" : "units")}`
      : "Quantity not set";

  return {
    title,
    units,
    type,
    valid: form.checkValidity(),
    needsAttention: false,
  };
}

function QueueDraftForm(
  {
    draftId,
    visible,
    saving,
    initialValues,
    onFormChange,
    onAddAnother,
    onSaveAll,
    initialCustomFields,
  }: {
    draftId: string;
    visible: boolean;
    saving: boolean;
    initialValues?: InitialAssetValues;
    onFormChange: (form: HTMLFormElement, needsAttention?: boolean) => void;
    onAddAnother: () => void;
    onSaveAll: () => void;
    initialCustomFields?: IoioAssetFormLoaderData["customFields"];
  },
  ref: ForwardedRef<QueueDraftHandle>
) {
  const formRef = useRef<HTMLFormElement | null>(null);
  const onFormChangeRef = useRef(onFormChange);
  onFormChangeRef.current = onFormChange;
  const pendingResolve = useRef<
    ((data: QueueActionData | undefined) => void) | null
  >(null);
  const fetcher = useFetcher<QueueActionData>();
  const customFieldsFetcher = useFetcher<QueueCustomFieldsResponse>();
  const [draftCustomFields, setDraftCustomFields] = useState<
    IoioAssetFormLoaderData["customFields"]
  >(initialCustomFields ?? []);
  const loadedCategory = useRef<string | null | undefined>(
    initialValues?.categoryId ?? undefined
  );

  const loadCategoryFields = useCallback(
    (categoryId: string | undefined) => {
      const category = categoryId || null;
      if (loadedCategory.current === category) return;
      loadedCategory.current = category;
      setDraftCustomFields([]);
      const query = new URLSearchParams({ assetQueueFields: "1" });
      if (category) query.set("category", category);
      void customFieldsFetcher.load(`/assets/new?${query.toString()}`);
    },
    [customFieldsFetcher]
  );

  useEffect(() => {
    if (initialCustomFields) return;
    loadCategoryFields(initialValues?.categoryId ?? undefined);
  }, [initialCustomFields, initialValues?.categoryId, loadCategoryFields]);

  useEffect(() => {
    if (customFieldsFetcher.data?.customFields) {
      setDraftCustomFields(customFieldsFetcher.data.customFields);
    }
  }, [customFieldsFetcher.data]);

  useEffect(() => {
    if (fetcher.state !== "idle" || !pendingResolve.current) return;
    const resolve = pendingResolve.current;
    pendingResolve.current = null;
    resolve(fetcher.data);
  }, [fetcher.data, fetcher.state]);

  const submitIntent = useCallback(
    (intent: "validate" | "create", formDataSnapshot?: FormData) =>
      new Promise<QueueActionData | undefined>((resolve) => {
        const form = formRef.current;
        if (!form) {
          resolve(undefined);
          return;
        }

        const formData = formDataSnapshot
          ? cloneFormData(formDataSnapshot)
          : new FormData(form);
        formData.set("assetQueueIntent", intent);
        pendingResolve.current = resolve;
        void fetcher.submit(formData, {
          method: "post",
          encType: "multipart/form-data",
        });
      }),
    [fetcher]
  );

  const readSummary = useCallback(
    () => (formRef.current ? readDraftSummary(formRef.current) : EMPTY_SUMMARY),
    []
  );
  const snapshotFormData = useCallback(
    () => (formRef.current ? new FormData(formRef.current) : undefined),
    []
  );

  useImperativeHandle(
    ref,
    () => ({ submitIntent, snapshotFormData, readSummary }),
    [readSummary, snapshotFormData, submitIntent]
  );

  const actionError =
    fetcher.data && "error" in fetcher.data ? fetcher.data.error : undefined;

  useEffect(() => {
    if (formRef.current) {
      onFormChangeRef.current(formRef.current, Boolean(actionError));
    }
  }, [actionError]);

  return (
    <div hidden={!visible}>
      <IoioAssetCreateForm
        {...initialValues}
        showAssetModel={false}
        assetQueueMode
        assetQueueSaving={saving}
        assetQueueCustomFields={draftCustomFields}
        assetQueueDraftId={draftId}
        assetQueueActionError={actionError}
        onAssetQueueFormRef={(form) => {
          formRef.current = form;
        }}
        onAssetQueueFormChange={(form) =>
          onFormChangeRef.current(form, Boolean(actionError))
        }
        onAssetQueueAddAnother={onAddAnother}
        onAssetQueueSaveAll={onSaveAll}
        onAssetQueueCategoryChange={loadCategoryFields}
      />
    </div>
  );
}

const ForwardedQueueDraftForm = forwardRef(QueueDraftForm);

function getUnitsLabel(summary: DraftSummary) {
  return summary.units;
}

/**
 * Staff-only in-memory draft queue around the existing asset creation form.
 * Every form stays mounted while hidden, keeping native field and File input
 * state intact as Staff switches between drafts.
 */
export function IoioAssetCreationQueue({
  initialValues,
}: {
  initialValues: InitialAssetValues;
}) {
  const navigate = useNavigate();
  const [, setDynamicTitle] = useAtom(dynamicTitleAtom);
  const [draftIds, setDraftIds] = useState(["asset-draft-1"]);
  const [activeDraftId, setActiveDraftId] = useState("asset-draft-1");
  const [summaries, setSummaries] = useState<Record<string, DraftSummary>>({
    "asset-draft-1": {
      ...EMPTY_SUMMARY,
      title: initialValues.title ?? "",
      units:
        initialValues.quantity && initialValues.quantity > 0
          ? `${initialValues.quantity} units`
          : EMPTY_SUMMARY.units,
    },
  });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string>();
  const [warning, setWarning] = useState<string>();
  const nextDraftNumber = useRef(2);
  const handles = useRef(new Map<string, QueueDraftHandle>());
  const allowExit = useRef(false);
  const savingRef = useRef(false);

  const hasMultipleDrafts = draftIds.length > 1;
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      !allowExit.current &&
      (saving || hasMultipleDrafts) &&
      (currentLocation.pathname !== nextLocation.pathname ||
        currentLocation.search !== nextLocation.search)
  );
  useBeforeUnload(
    (event) => {
      if (saving || hasMultipleDrafts) event.preventDefault();
    },
    { capture: true }
  );

  const updateSummary = useCallback(
    (draftId: string, form: HTMLFormElement, needsAttention = false) => {
      const summary = readDraftSummary(form);
      setSummaries((current) => ({
        ...current,
        [draftId]: { ...summary, needsAttention },
      }));
      if (draftId === activeDraftId) setDynamicTitle(summary.title);
    },
    [activeDraftId, setDynamicTitle]
  );

  const addAnother = useCallback(
    (sourceDraftId?: string) => {
      const summary = sourceDraftId
        ? handles.current.get(sourceDraftId)?.readSummary()
        : undefined;
      if (summary) {
        setSummaries((current) => ({ ...current, [sourceDraftId]: summary }));
      }
      const nextId = `asset-draft-${nextDraftNumber.current++}`;
      setDraftIds((current) => [...current, nextId]);
      setSummaries((current) => ({ ...current, [nextId]: EMPTY_SUMMARY }));
      setActiveDraftId(nextId);
      setDynamicTitle("");
      setMessage(undefined);
      setWarning(undefined);
    },
    [setDynamicTitle]
  );

  const removeDraft = (draftId: string) => {
    const remaining = draftIds.filter((id) => id !== draftId);
    const nextIds =
      remaining.length > 0
        ? remaining
        : [`asset-draft-${nextDraftNumber.current++}`];
    setDraftIds(nextIds);
    setSummaries((current) => {
      const next = { ...current };
      delete next[draftId];
      if (nextIds.length > 0 && !next[nextIds[0]]) {
        next[nextIds[0]] = EMPTY_SUMMARY;
      }
      return next;
    });
    if (activeDraftId === draftId) {
      const nextId = nextIds[0];
      setActiveDraftId(nextId);
      setDynamicTitle(summaries[nextId]?.title ?? "");
    }
    setMessage(undefined);
  };

  const selectDraft = (draftId: string) => {
    setActiveDraftId(draftId);
    setDynamicTitle(summaries[draftId]?.title ?? "");
    setMessage(undefined);
  };

  const saveAll = async () => {
    if (savingRef.current || draftIds.length === 0) return;
    // Keep successful controls in the exact payload used for both validation
    // and creation. Setting `saving` disables the form inputs; disabled HTML
    // controls disappear from a later `new FormData(form)` call.
    const formDataSnapshots = new Map(
      draftIds.map((draftId) => [
        draftId,
        handles.current.get(draftId)?.snapshotFormData(),
      ])
    );
    savingRef.current = true;
    setSaving(true);
    setMessage(undefined);
    setWarning(undefined);

    const idsToSave = [...draftIds];
    for (const draftId of idsToSave) {
      const result = await handles.current
        .get(draftId)
        ?.submitIntent("validate", formDataSnapshots.get(draftId));
      if (!result?.assetQueueValidated) {
        setActiveDraftId(draftId);
        setDynamicTitle(summaries[draftId]?.title ?? "");
        setMessage(result?.error?.message ?? "Check this asset before saving.");
        savingRef.current = false;
        setSaving(false);
        return;
      }
    }

    const notices: string[] = [];
    for (const draftId of idsToSave) {
      const result = await handles.current
        .get(draftId)
        ?.submitIntent("create", formDataSnapshots.get(draftId));
      if (!result?.assetQueueCreated) {
        setActiveDraftId(draftId);
        setDynamicTitle(summaries[draftId]?.title ?? "");
        setMessage(
          result?.error?.message ?? "This asset could not be created."
        );
        savingRef.current = false;
        setSaving(false);
        return;
      }

      setDraftIds((current) => current.filter((id) => id !== draftId));
      setSummaries((current) => {
        const next = { ...current };
        delete next[draftId];
        return next;
      });
      if (result.warning) notices.push(result.warning);
    }

    if (notices.length > 0) {
      setWarning(notices.join(" "));
      savingRef.current = false;
      setSaving(false);
      return;
    }
    allowExit.current = true;
    savingRef.current = false;
    setSaving(false);
    void navigate("/assets");
  };

  return (
    <>
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0">
          {draftIds.map((draftId) => (
            <ForwardedQueueDraftForm
              key={draftId}
              ref={(handle) => {
                if (handle) handles.current.set(draftId, handle);
                else handles.current.delete(draftId);
              }}
              draftId={draftId}
              visible={draftId === activeDraftId}
              saving={saving}
              initialValues={
                draftId === "asset-draft-1"
                  ? initialValues
                  : { referer: initialValues.referer }
              }
              initialCustomFields={
                draftId === "asset-draft-1"
                  ? initialValues.customFields
                  : undefined
              }
              onFormChange={(form, needsAttention) =>
                updateSummary(draftId, form, needsAttention)
              }
              onAddAnother={() => addAnother(draftId)}
              onSaveAll={() => void saveAll()}
            />
          ))}
        </div>

        <aside className="w-full rounded border border-gray-200 bg-white p-4 xl:sticky xl:top-4 xl:mt-4 xl:pt-3">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-gray-900">
              Assets to add
            </h2>
            <span className="text-sm tabular-nums text-gray-500">
              {draftIds.length}
            </span>
          </div>

          <ul className="space-y-2">
            {draftIds.map((draftId) => {
              const summary = summaries[draftId] ?? EMPTY_SUMMARY;
              const isActive = draftId === activeDraftId;
              const status = isActive
                ? "Editing"
                : summary.needsAttention || !summary.valid
                ? "Needs attention"
                : "Ready";
              const displayName = summary.title || "Untitled asset";

              return (
                <li
                  key={draftId}
                  className={`rounded border border-gray-200 ${
                    isActive
                      ? "border-l-2 border-l-red-500 bg-red-50/40"
                      : "bg-white"
                  }`}
                >
                  <div className="flex items-start justify-between gap-2 p-2.5">
                    <button
                      type="button"
                      className="min-w-0 flex-1 text-left"
                      onClick={() => selectDraft(draftId)}
                      aria-current={isActive ? "true" : undefined}
                    >
                      <span className="block truncate text-sm font-medium text-gray-900">
                        {displayName}
                      </span>
                      <span className="mt-0.5 block text-xs text-gray-500">
                        {getUnitsLabel(summary)}
                      </span>
                      <span className="mt-1 block text-xs text-gray-600">
                        {status}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="shrink-0 text-xs text-gray-500 underline decoration-gray-300 underline-offset-2 hover:text-gray-900"
                      onClick={() => removeDraft(draftId)}
                      disabled={saving}
                      aria-label={`Remove ${displayName}`}
                    >
                      Remove
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>

          {draftIds.length === 0 ? (
            <Button
              type="button"
              variant="secondary"
              className="mt-3 w-full"
              onClick={() => addAnother()}
            >
              Add another asset
            </Button>
          ) : null}

          {message ? (
            <p className="mt-3 text-sm text-red-700" role="alert">
              {message}
            </p>
          ) : null}
          {warning ? (
            <p className="mt-3 text-sm text-amber-700" role="status">
              {warning}
            </p>
          ) : null}

          <Button
            type="button"
            className="mt-4 w-full"
            disabled={saving || draftIds.length === 0}
            onClick={() => void saveAll()}
          >
            {saving ? "Saving…" : `Save all (${draftIds.length})`}
          </Button>
        </aside>
      </div>

      <AlertDialog
        open={blocker.state === "blocked"}
        onOpenChange={(open) => {
          if (!open && blocker.state === "blocked") blocker.reset();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unsaved assets</AlertDialogTitle>
            <AlertDialogDescription>
              You have unsaved assets.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="secondary"
                onClick={() => blocker.state === "blocked" && blocker.reset()}
              >
                Continue editing
              </Button>
              <Button
                type="button"
                onClick={() => {
                  if (blocker.state !== "blocked") return;
                  allowExit.current = true;
                  blocker.proceed();
                }}
                disabled={saving}
              >
                Discard
              </Button>
            </div>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
