import type { ReactNode } from "react";
import {
  AssetDetailInformation,
  type AssetDetailField,
} from "~/components/assets/asset-detail-information";
import { ASSET_IMAGE_FRAME_CLASSES } from "~/components/assets/asset-image/sizing";
import {
  PhysicalUnitAvailabilityList,
  type PhysicalUnitAvailabilityRow,
} from "~/components/ioio-staff/physical-unit-availability-list";
import { PageBackLink } from "~/components/shared/page-back-link";

export type StaffItemDetailProps = {
  title: string;
  image: ReactNode;
  availableQuantity: number;
  unitLabel?: string;
  categoryName?: string | null;
  locationPath: string[];
  description?: string | null;
  maxBorrowDays?: number | null;
  tracking?: string | null;
  status?: string | null;
  additionalFields?: AssetDetailField[];
  borrowAction?: ReactNode;
  actions?: ReactNode;
  assistantAction?: ReactNode;
  contents?: ReactNode;
  qrLifecycle?: ReactNode;
  physicalUnits?: PhysicalUnitAvailabilityRow[];
  canEditPhysicalUnits?: boolean;
  physicalUnitsActionUrl?: string;
};

export function StaffItemDetail({
  title,
  image,
  availableQuantity,
  unitLabel = "items",
  categoryName,
  locationPath,
  description,
  maxBorrowDays,
  tracking,
  status,
  additionalFields,
  borrowAction,
  actions,
  assistantAction,
  contents,
  qrLifecycle,
  physicalUnits,
  canEditPhysicalUnits = false,
  physicalUnitsActionUrl,
}: StaffItemDetailProps) {
  const available = availableQuantity > 0;

  return (
    <div className="mx-auto max-w-3xl px-4 py-5 sm:px-6 lg:px-8">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <PageBackLink to="/assets" className="mb-5">
            Back to inventory
          </PageBackLink>

          <p className="text-xs font-black uppercase tracking-[0.18em] text-red-800">
            Inventory
          </p>
          <h1 className="mt-2 break-words text-3xl font-black tracking-tight text-gray-950 sm:text-4xl">
            {title}
          </h1>
          {assistantAction ? (
            <div className="mt-4">{assistantAction}</div>
          ) : null}
        </div>
        {actions ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {actions}
          </div>
        ) : null}
      </header>

      <div className="mt-6 space-y-4">
        <section className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
          <div
            className={`flex items-center justify-center bg-gray-50 [&_img]:max-h-full [&_img]:max-w-full [&_img]:object-contain [&_img]:p-4 sm:[&_img]:p-8 ${ASSET_IMAGE_FRAME_CLASSES.detail}`}
          >
            {image}
          </div>
          <div className="p-5">
            <div className="flex justify-end">{borrowAction}</div>
          </div>
        </section>

        {qrLifecycle}

        <AssetDetailInformation
          categoryName={categoryName}
          locations={locationPath.length ? [{ path: locationPath }] : []}
          availability={
            available
              ? `${availableQuantity} available${
                  unitLabel ? ` ${unitLabel}` : ""
                }`
              : "Unavailable"
          }
          tracking={tracking}
          status={status}
          maxBorrowDays={maxBorrowDays}
          description={description}
          additionalFields={additionalFields}
          compact
        />

        {contents ? (
          <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
            <h2 className="text-sm font-bold uppercase tracking-wide text-gray-500">
              Contents
            </h2>
            <div className="mt-3 text-sm text-gray-800">{contents}</div>
          </section>
        ) : null}
        {physicalUnits?.length && physicalUnitsActionUrl ? (
          <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
            <PhysicalUnitAvailabilityList
              units={physicalUnits}
              actionUrl={physicalUnitsActionUrl}
              canEdit={canEditPhysicalUnits}
            />
          </section>
        ) : null}
      </div>
    </div>
  );
}
