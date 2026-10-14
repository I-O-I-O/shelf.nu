import type { ReactNode } from "react";
import {
  AssetDetailInformation,
  type AssetDetailField,
  type AssetDetailLocation,
} from "~/components/assets/asset-detail-information";
import { PageBackLink } from "~/components/shared/page-back-link";

export type IoioAssetDetailLayoutProps = {
  backTo: string;
  backLabel: string;
  title: string;
  description?: string | null;
  image: ReactNode;
  actions?: ReactNode;
  categoryName?: string | null;
  locations: AssetDetailLocation[];
  availableQuantity: number;
  totalQuantity: number;
  availabilityDetail?: string;
  unitLabel?: string;
  tracking?: string | null;
  status?: string | null;
  maxBorrowDays?: number | null;
  additionalFields?: AssetDetailField[];
  children?: ReactNode;
};

export function IoioAssetDetailLayout({
  backTo,
  backLabel,
  title,
  description,
  image,
  actions,
  categoryName,
  locations,
  availableQuantity,
  totalQuantity,
  availabilityDetail,
  unitLabel = "items",
  tracking,
  status,
  maxBorrowDays,
  additionalFields,
  children,
}: IoioAssetDetailLayoutProps) {
  const available = Math.max(0, availableQuantity);
  const total = Math.max(0, totalQuantity);
  const singularUnitLabel =
    ({ items: "item", units: "unit", kits: "kit" } as Record<string, string>)[
      unitLabel
    ] ?? unitLabel;
  const availableLabel = `${available} / ${total} ${
    total === 1 ? singularUnitLabel : unitLabel
  } available`;

  return (
    <div className="mx-auto max-w-7xl px-4 pb-6 pt-0 sm:px-6 lg:px-8">
      <PageBackLink to={backTo} className="mb-3 lg:!ml-0">
        {backLabel}
      </PageBackLink>

      <header className="mb-4 flex flex-col gap-4 border-b border-gray-200 pb-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="break-words text-3xl font-black tracking-tight text-gray-950 sm:text-4xl">
            {title}
          </h1>
          {description?.trim() ? (
            <p className="mt-2 max-w-3xl whitespace-pre-wrap text-sm leading-6 text-gray-600">
              {description.trim()}
            </p>
          ) : null}
        </div>
        {actions ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
            {actions}
          </div>
        ) : null}
      </header>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.45fr)_minmax(340px,0.9fr)]">
        <section
          aria-label={`${title} image`}
          className="flex w-full min-w-0 items-center justify-center rounded-2xl border border-gray-200 bg-gray-50 shadow-sm"
        >
          {image}
        </section>
        <AssetDetailInformation
          categoryName={categoryName}
          locations={locations}
          availability={availableLabel}
          availabilityTone={available > 0 ? "available" : "unavailable"}
          availabilityDetail={availabilityDetail}
          tracking={tracking}
          status={status}
          maxBorrowDays={maxBorrowDays}
          additionalFields={additionalFields}
        />
      </div>

      {children}
    </div>
  );
}
