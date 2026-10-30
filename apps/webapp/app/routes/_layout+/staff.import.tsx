import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { data, Link, useLoaderData } from "react-router";
import { z } from "zod";
import { StaffImportPanel } from "~/components/ioio-staff/staff-import-panel";
import Header from "~/components/layout/header";
import { requireIoioStaffAccess } from "~/modules/ioio-staff/access.server";
import {
  applyStaffInventoryImport,
  cancelStaffInventoryImport,
  getStaffInventoryImportDrafts,
  getStaffInventoryImportProposal,
  prepareStaffInventoryImport,
  revertStaffInventoryImportRow,
  saveStaffInventoryImportDraft,
} from "~/modules/ioio-staff/inventory-import.server";
import {
  IMPORT_IMAGE_SOURCE_MAX_BYTES,
  processStaffImportImageUpload,
} from "~/modules/ioio-staff/product-enrichment.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { makeShelfError, ShelfError } from "~/utils/error";
import { error, payload } from "~/utils/http.server";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

const ImportIntentSchema = z.enum([
  "analyze-file",
  "apply-import",
  "apply-row",
  "apply-selected",
  "cancel-import",
  "save-draft",
  "process-import-image",
  "revert-row",
  "revert-selected",
]);

export async function loader({ context, request }: LoaderFunctionArgs) {
  const { userId } = await requireIoioStaffAccess({
    context,
    request,
  });
  let canCreateCategory = false;
  try {
    await requirePermission({
      userId,
      request,
      entity: PermissionEntity.category,
      action: PermissionAction.create,
    });
    canCreateCategory = true;
  } catch {
    canCreateCategory = false;
  }
  const operationId = new URL(request.url).searchParams.get("importOperation");
  const allSavedDrafts = await getStaffInventoryImportDrafts({
    context,
    request,
  });
  let importProposal = null;
  let importNotice = null;
  if (operationId) {
    try {
      importProposal = await getStaffInventoryImportProposal({
        context,
        request,
        operationId,
      });
    } catch (cause) {
      const reason = makeShelfError(cause);
      if (reason.message.includes("no longer available")) {
        importNotice =
          "This import proposal expired or is no longer available. Start a new import to continue.";
      } else {
        throw data(error(reason), { status: reason.status });
      }
    }
  }
  return payload({
    header: { title: "Import inventory" },
    importProposal,
    importNotice,
    canCreateCategory,
    savedDrafts: allSavedDrafts.filter(
      (draft) => draft.operationId !== operationId
    ),
  });
}

export async function action({ context, request }: ActionFunctionArgs) {
  let userId: string | undefined;
  try {
    ({ userId } = await requireIoioStaffAccess({ context, request }));
    const formData = await request.formData();
    const intent = ImportIntentSchema.parse(formData.get("intent"));

    if (intent === "process-import-image") {
      const file = formData.get("file");
      const rowNumber = Number(formData.get("rowNumber"));
      if (
        !(file instanceof File) ||
        file.size > IMPORT_IMAGE_SOURCE_MAX_BYTES ||
        !Number.isSafeInteger(rowNumber) ||
        rowNumber < 1
      ) {
        throw new ShelfError({
          cause: null,
          message: "Choose a valid product image.",
          label: "Assets",
          status: 400,
          shouldBeCaptured: false,
        });
      }
      let proposal: Awaited<ReturnType<typeof processStaffImportImageUpload>>;
      try {
        proposal = await processStaffImportImageUpload(
          Buffer.from(await file.arrayBuffer()),
          file.type
        );
      } catch {
        throw new ShelfError({
          cause: null,
          message: "Choose a readable JPEG, PNG, or WebP image up to 8 MB.",
          label: "Assets",
          status: 400,
          shouldBeCaptured: false,
        });
      }
      return payload({
        kind: "import-image-processed" as const,
        rowNumber,
        proposal,
      });
    }

    if (intent === "analyze-file") {
      const file = formData.get("file");
      if (!(file instanceof File)) {
        throw new ShelfError({
          cause: null,
          message: "Choose a CSV, XLSX, or PDF file to review.",
          label: "Assets",
          status: 400,
          shouldBeCaptured: false,
        });
      }
      const prepared = await prepareStaffInventoryImport({
        context,
        request,
        file,
        spreadsheetSheet:
          String(formData.get("spreadsheetSheet") ?? "").trim() || undefined,
        spreadsheetHeaderRow: formData.get("spreadsheetHeaderRow")
          ? Number(formData.get("spreadsheetHeaderRow"))
          : undefined,
      });
      return prepared.status !== "PREPARED"
        ? payload({ kind: "import-result" as const, result: prepared.result })
        : payload({
            kind: "import-proposal" as const,
            proposal: prepared.proposal,
          });
    }

    const operationId = z
      .string()
      .min(1)
      .max(100)
      .parse(formData.get("operationId"));
    if (intent === "revert-row") {
      const rowNumber = z.coerce
        .number()
        .int()
        .positive()
        .parse(formData.get("rowNumber"));
      const result = await revertStaffInventoryImportRow({
        context,
        request,
        operationId,
        rowNumber,
      });
      return payload({ kind: "import-row-reverted" as const, result });
    }
    if (intent === "revert-selected") {
      const rowNumbers = z
        .string()
        .transform((value, ctx) => {
          try {
            return JSON.parse(value);
          } catch {
            ctx.addIssue({ code: "custom", message: "Invalid row selection." });
            return z.NEVER;
          }
        })
        .pipe(
          z
            .array(z.number().int().positive())
            .min(1)
            .max(1000)
            .refine((values) => new Set(values).size === values.length)
        )
        .parse(formData.get("rowNumbers"));
      const revertedRowNumbers: number[] = [];
      const failedRows: Array<{ rowNumber: number; message: string }> = [];
      for (const rowNumber of rowNumbers) {
        try {
          await revertStaffInventoryImportRow({
            context,
            request,
            operationId,
            rowNumber,
          });
          revertedRowNumbers.push(rowNumber);
        } catch (cause) {
          failedRows.push({
            rowNumber,
            message: makeShelfError(cause).message,
          });
        }
      }
      const proposal = await getStaffInventoryImportProposal({
        context,
        request,
        operationId,
      });
      return payload({
        kind: "import-rows-reverted" as const,
        proposal,
        result: { operationId, revertedRowNumbers, failedRows },
      });
    }
    if (intent === "save-draft") {
      const reviewDecisions = formData.get("reviewDecisions");
      if (typeof reviewDecisions !== "string") {
        throw new ShelfError({
          cause: null,
          message: "The review draft could not be saved. Reload and try again.",
          label: "Assets",
          status: 400,
          shouldBeCaptured: false,
        });
      }
      const result = await saveStaffInventoryImportDraft({
        context,
        request,
        operationId,
        reviewDecisions,
      });
      return payload({ kind: "import-draft-saved" as const, ...result });
    }
    if (intent === "cancel-import") {
      const result = await cancelStaffInventoryImport({
        context,
        request,
        operationId,
      });
      return payload({ kind: "import-cancelled" as const, result });
    }

    const rawPdfDecisions = formData.get("pdfDecisions");
    const rawReviewDecisions = formData.get("reviewDecisions");
    const rawProposalHash = formData.get("proposalHash");
    const applyOnlyRowNumber =
      intent === "apply-row"
        ? z.coerce.number().int().positive().parse(formData.get("rowNumber"))
        : undefined;
    if (typeof rawProposalHash !== "string") {
      throw new ShelfError({
        cause: null,
        message: "Reload the import proposal and confirm it again.",
        label: "Assets",
        status: 400,
        shouldBeCaptured: false,
      });
    }
    const result = await applyStaffInventoryImport({
      context,
      request,
      operationId,
      proposalHash: rawProposalHash,
      allowSameFileReimport: formData.get("allowSameFileReimport") === "true",
      applyOnlyRowNumber,
      applyOnlyRowNumbers:
        intent === "apply-selected"
          ? z
              .array(z.number().int().positive())
              .min(1)
              .max(1000)
              .parse(JSON.parse(String(formData.get("rowNumbers"))))
          : undefined,
      pdfDecisions:
        typeof rawPdfDecisions === "string" ? rawPdfDecisions : null,
      reviewDecisions:
        typeof rawReviewDecisions === "string" ? rawReviewDecisions : null,
    });
    if ("status" in result) {
      if (result.status === "NEEDS_REVIEW")
        return payload({
          error: null,
          kind: "import-review-blocked" as const,
          ...result,
        });
      if (result.status === "DUPLICATE") {
        return payload({
          kind: "import-duplicate" as const,
          duplicate: result,
        });
      }
      return payload({
        kind: "import-in-progress" as const,
        operationId: result.operationId,
      });
    }
    if (result.remainingRows && result.remainingRows > 0) {
      const proposal = await getStaffInventoryImportProposal({
        context,
        request,
        operationId,
      });
      return payload({
        kind: "import-partial" as const,
        proposal,
        result,
      });
    }
    const proposal = await getStaffInventoryImportProposal({
      context,
      request,
      operationId,
    });
    return payload({ kind: "import-complete" as const, proposal, result });
  } catch (cause) {
    const reason = userId
      ? makeShelfError(cause, { userId })
      : makeShelfError(cause);
    return data(error(reason), { status: reason.status });
  }
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  { title: data ? appendToMetaTitle(data.header.title) : "Import inventory" },
];

export const handle = {
  breadcrumb: () => <Link to="/staff/import">Import</Link>,
};

export default function StaffImportPage() {
  const { importProposal, importNotice, canCreateCategory, savedDrafts } =
    useLoaderData<typeof loader>();
  return (
    <div>
      <Header hideQuickFind />
      <div className="mx-auto max-w-5xl py-6">
        <StaffImportPanel
          actionPath="/staff/import"
          initialProposal={importProposal}
          initialNotice={importNotice}
          canCreateCategory={canCreateCategory}
          savedDrafts={savedDrafts}
        />
      </div>
    </div>
  );
}
