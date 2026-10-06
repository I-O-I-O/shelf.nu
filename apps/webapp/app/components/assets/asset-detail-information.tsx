import type { ReactNode } from "react";
import { Link } from "react-router";
import { SettingHelpLabel } from "~/components/shared/setting-help-label";
import { getCompactLocationSummary } from "~/modules/location/compact-location";

export type AssetDetailLocation = {
  path: string[];
  href?: string;
};

export type AssetDetailField = {
  label: string;
  value: ReactNode;
  help?: ReactNode;
};

type AssetDetailInformationProps = {
  categoryName?: string | null;
  locations: AssetDetailLocation[];
  availability: string;
  tracking?: string | null;
  status?: string | null;
  maxBorrowDays?: number | null;
  description?: string | null;
  additionalFields?: AssetDetailField[];
  compact?: boolean;
};

function LocationValue({
  location,
  compact = false,
}: {
  location: AssetDetailLocation;
  compact?: boolean;
}) {
  const summary = getCompactLocationSummary(location.path);
  const content = compact ? (
    <span className="inline-flex max-w-full flex-wrap items-baseline gap-x-2 gap-y-0.5">
      {summary.room ? <span>{summary.room}</span> : null}
      {summary.room && summary.storageLabel ? (
        <span aria-hidden="true" className="text-gray-400">
          ·
        </span>
      ) : null}
      {summary.storageLabel ? <span>{summary.storageLabel}</span> : null}
    </span>
  ) : (
    <>
      {summary.room ? <span className="block">{summary.room}</span> : null}
      {summary.storageLabel ? (
        <span className="mt-0.5 block text-sm text-gray-700">
          {summary.storageLabel}
        </span>
      ) : null}
    </>
  );

  return location.href ? (
    <Link
      to={location.href}
      className="font-medium text-red-700 hover:underline"
    >
      {content}
    </Link>
  ) : (
    content
  );
}

export function AssetDetailInformation({
  categoryName,
  locations,
  availability,
  tracking,
  status,
  maxBorrowDays,
  description,
  additionalFields = [],
  compact = false,
}: AssetDetailInformationProps) {
  const fields: AssetDetailField[] = [
    {
      label: "Category",
      value: categoryName || "Uncategorized",
    },
    {
      label: "Location",
      value: locations.length ? (
        <div className={compact ? "space-y-1" : "space-y-3"}>
          {locations.map((location, index) => (
            <LocationValue
              key={`${location.path.join("/")}-${index}`}
              location={location}
              compact={compact}
            />
          ))}
        </div>
      ) : (
        "Location not recorded"
      ),
    },
    { label: "Availability", value: availability },
    ...(status ? [{ label: "Status", value: status }] : []),
    ...(tracking ? [{ label: "Tracking", value: tracking }] : []),
    ...(maxBorrowDays != null
      ? [
          {
            label: "Maximum borrowing period",
            value: `${maxBorrowDays} days`,
            help: "How long this item can be borrowed before an extension is required.",
          },
        ]
      : []),
    ...additionalFields,
  ];

  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5">
      <h2 className="text-sm font-bold uppercase tracking-wide text-gray-500">
        Details
      </h2>
      <dl
        className={
          compact
            ? "mt-3 grid gap-x-6 gap-y-3 sm:grid-cols-2"
            : "mt-4 grid gap-4 sm:grid-cols-2"
        }
      >
        {fields.map((field) => (
          <div key={field.label} className="min-w-0">
            <dt className="text-xs font-bold uppercase tracking-wide text-gray-500">
              {field.help ? (
                <SettingHelpLabel label={field.label} help={field.help} />
              ) : (
                field.label
              )}
            </dt>
            <dd
              className={
                compact
                  ? "mt-0.5 break-words text-sm leading-5 text-gray-800"
                  : "mt-1 break-words text-sm text-gray-800"
              }
            >
              {field.value}
            </dd>
          </div>
        ))}
        {description?.trim() ? (
          <div className="sm:col-span-2">
            <dt className="text-xs font-bold uppercase tracking-wide text-gray-500">
              Description
            </dt>
            <dd className="mt-1 whitespace-pre-wrap text-sm leading-6 text-gray-800">
              {description.trim()}
            </dd>
          </div>
        ) : null}
      </dl>
    </section>
  );
}
