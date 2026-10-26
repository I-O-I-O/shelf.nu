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
  getStaffInventoryImportProposal,
  prepareStaffInventoryImport,
} from "~/modules/ioio-staff/inventory-import.server";
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
  "cancel-import",
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
  });
}

export async function action({ context, request }: ActionFunctionArgs) {
  let userId: string | undefined;
  try {
    ({ userId } = await requireIoioStaffAccess({ context, request }));
    const formData = await request.formData();
    const intent = ImportIntentSchema.parse(formData.get("intent"));

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
      pdfDecisions:
        typeof rawPdfDecisions === "string" ? rawPdfDecisions : null,
      reviewDecisions:
        typeof rawReviewDecisions === "string" ? rawReviewDecisions : null,
    });
    if ("status" in result) {
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
    return payload({ kind: "import-result" as const, result });
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
  const { importProposal, importNotice, canCreateCategory } =
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
        />
      </div>
    </div>
  );
}
