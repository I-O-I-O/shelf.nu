import { useState } from "react";
import { PrinterIcon, RefreshCwIcon } from "lucide-react";
import { RelinkQrCodeDialog } from "~/components/qr/relink-qr-code-dialog";
import { Button } from "~/components/shared/button";

type IoioQrLifecycleProps = {
  itemId: string;
  itemName: string;
  itemType: "asset" | "kit";
  qrId?: string | null;
  qrCreatedAt?: Date | string | null;
  canReplaceQr: boolean;
  isQuantityTracked?: boolean;
};

function formatCreatedAt(value: Date | string | null | undefined) {
  if (!value) return null;

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
  }).format(new Date(value));
}

export function IoioQrLifecycle({
  itemId,
  itemName,
  itemType,
  qrId,
  qrCreatedAt,
  canReplaceQr,
  isQuantityTracked = false,
}: IoioQrLifecycleProps) {
  const [isReplaceDialogOpen, setIsReplaceDialogOpen] = useState(false);
  const labelParam = itemType === "kit" ? "kitId" : "assetId";
  const labelHref = `/labels?${labelParam}=${encodeURIComponent(itemId)}`;
  const createdAt = formatCreatedAt(qrCreatedAt);
  const hasQr = Boolean(qrId);

  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-bold uppercase tracking-wide text-gray-500">
            Labels &amp; QR
          </h2>
        </div>
        <span
          className={`rounded-full px-2.5 py-1 text-xs font-bold ${
            hasQr ? "bg-green-50 text-green-800" : "bg-gray-100 text-gray-700"
          }`}
        >
          {hasQr ? "Active" : "No QR"}
        </span>
      </div>

      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs font-bold uppercase tracking-wide text-gray-500">
            Label type
          </dt>
          <dd className="mt-1 text-gray-800">
            {itemType === "kit" ? "Kit" : "Individual item"}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-bold uppercase tracking-wide text-gray-500">
            QR status
          </dt>
          <dd className="mt-1 text-gray-800">
            {hasQr ? "Ready" : "No QR assigned"}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-bold uppercase tracking-wide text-gray-500">
            Created
          </dt>
          <dd className="mt-1 text-gray-800">{createdAt ?? "Not available"}</dd>
        </div>
        <div>
          <dt className="text-xs font-bold uppercase tracking-wide text-gray-500">
            Replacement status
          </dt>
          <dd className="mt-1 text-gray-800">
            {hasQr ? "No replacement pending" : "Not available"}
          </dd>
        </div>
      </dl>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          to={labelHref}
          size="sm"
          variant="secondary"
          className="h-9 rounded-lg border-red-200 px-3 text-red-700 hover:border-red-300 hover:bg-red-50 hover:text-red-800"
        >
          <PrinterIcon className="mr-2 size-4" />
          Reprint label
        </Button>
        {canReplaceQr && hasQr ? (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="h-9 rounded-lg border-gray-300 px-3 text-gray-700 hover:border-red-300 hover:bg-red-50 hover:text-red-800"
            onClick={() => setIsReplaceDialogOpen(true)}
          >
            <RefreshCwIcon className="mr-2 size-4" />
            Replace QR
          </Button>
        ) : null}
      </div>

      {isQuantityTracked ? (
        <p className="mt-3 text-xs leading-5 text-gray-500">
          One QR identifies this inventory record. It does not create one QR per
          quantity unit.
        </p>
      ) : null}

      {canReplaceQr && hasQr ? (
        <RelinkQrCodeDialog
          open={isReplaceDialogOpen}
          onClose={() => setIsReplaceDialogOpen(false)}
          itemName={itemName}
          currentQrId={qrId ?? undefined}
          itemLabel={itemType}
        />
      ) : null}
    </section>
  );
}
