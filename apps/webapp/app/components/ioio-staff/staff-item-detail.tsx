import type { ReactNode } from "react";
import type { AssetDetailField } from "~/components/assets/asset-detail-information";
import { IoioAssetDetailLayout } from "~/components/ioio-staff/ioio-asset-detail-layout";
import {
  PhysicalUnitAvailabilityList,
  type PhysicalUnitAvailabilityRow,
} from "~/components/ioio-staff/physical-unit-availability-list";

export type StaffItemDetailProps = {
  title: string;
  image: ReactNode;
  availableQuantity: number;
  totalQuantity?: number;
  availabilityDetail?: string;
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
  totalQuantity,
  availabilityDetail,
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
  const total = totalQuantity ?? physicalUnits?.length ?? availableQuantity;
  const statusCounts = new Map<string, number>();
  for (const unit of physicalUnits ?? []) {
    statusCounts.set(unit.status, (statusCounts.get(unit.status) ?? 0) + 1);
  }
  const detail =
    availabilityDetail ??
    (physicalUnits
      ? [
          `${availableQuantity} available`,
          ...Array.from(statusCounts)
            .filter(([status]) => status !== "Available")
            .map(([status, count]) => `${count} ${status.toLocaleLowerCase()}`),
        ].join(" · ")
      : undefined);

  return (
    <IoioAssetDetailLayout
      backTo="/assets"
      backLabel="Back to inventory"
      title={title}
      description={description}
      image={image}
      actions={
        <>
          {borrowAction}
          {actions}
          {assistantAction}
        </>
      }
      availableQuantity={availableQuantity}
      totalQuantity={total}
      availabilityDetail={detail}
      unitLabel={unitLabel}
      categoryName={categoryName}
      locations={locationPath.length ? [{ path: locationPath }] : []}
      tracking={tracking}
      status={status}
      maxBorrowDays={maxBorrowDays}
      additionalFields={additionalFields}
    >
      <div className="mt-5 space-y-4">
        {qrLifecycle}
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
    </IoioAssetDetailLayout>
  );
}
