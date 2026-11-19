import type { ReactNode } from "react";
import {
  AssetDetailInformation,
  type AssetDetailField,
  type AssetDetailLocation,
} from "~/components/assets/asset-detail-information";
import { PageBackLink } from "~/components/shared/page-back-link";
import { tw } from "~/utils/tw";

const contentCardClasses =
  "w-full min-w-0 rounded-2xl border border-gray-200 bg-white p-3 shadow-sm sm:p-4";

export type IoioAssetDetailLayoutProps = {
  className?: string;
  backTo: string;
  backLabel: string;
  title: string;
  description?: string | null;
  image: ReactNode;
  actions?: ReactNode;
  categoryName?: string | null;
  locations: AssetDetailLocation[];
  availableToBook?: boolean;
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
  className,
  backTo,
  backLabel,
  title,
  description,
  image,
  actions,
  categoryName,
  locations,
  availableToBook = true,
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
    <div
      className={tw(
        "mx-auto w-full min-w-0 max-w-7xl px-4 pb-6 sm:px-6 lg:px-8",
        className
      )}
    >
      <PageBackLink
        to={backTo}
        className="mb-1 max-md:flex max-md:min-h-11 max-md:items-center md:mb-3 lg:!ml-0"
      >
        {backLabel}
      </PageBackLink>

      <header className="mb-3 flex min-w-0 flex-col gap-2.5 border-b border-gray-200 pb-3 md:mb-4 md:flex-row md:flex-wrap md:items-center md:justify-between md:gap-4 md:pb-4">
        <div className="min-w-0 md:flex-1">
          <h1 className="break-words text-2xl font-black leading-tight tracking-tight text-gray-950 [overflow-wrap:anywhere] md:text-4xl">
            {title}
          </h1>
        </div>
        {actions ? (
          <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2 md:justify-end max-md:[&>a]:min-h-11 max-md:[&>button]:min-h-11">
            {actions}
          </div>
        ) : null}
      </header>

      <div className="grid items-stretch gap-4 lg:grid-cols-[minmax(0,1.45fr)_minmax(340px,0.9fr)]">
        <section
          aria-label={`${title} image`}
          className={`${contentCardClasses} flex items-center justify-center [&>div]:p-0`}
        >
          {image}
        </section>

        <AssetDetailInformation
          categoryName={categoryName}
          locations={locations}
          availableToBook={availableToBook}
          availability={
            availableToBook ? availableLabel : "Not available to borrow"
          }
          availabilityTone={
            availableToBook && available > 0 ? "available" : "unavailable"
          }
          availabilityDetail={
            availableToBook ? availabilityDetail : "Lab use only"
          }
          tracking={tracking}
          status={status}
          maxBorrowDays={maxBorrowDays}
          additionalFields={additionalFields}
        />
        {description?.trim() ? (
          <section
            aria-labelledby="asset-description-heading"
            className={`${contentCardClasses} lg:col-span-2`}
          >
            <h2
              id="asset-description-heading"
              className="text-sm font-bold uppercase tracking-wide text-gray-500"
            >
              Description
            </h2>
            <p className="mt-3 w-full min-w-0 max-w-[110ch] whitespace-pre-wrap break-words text-sm leading-6 text-gray-700 [overflow-wrap:anywhere]">
              {description.trim()}
            </p>
          </section>
        ) : null}
      </div>

      {children}
    </div>
  );
}
