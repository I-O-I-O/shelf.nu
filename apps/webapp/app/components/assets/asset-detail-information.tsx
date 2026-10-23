import type { ReactNode } from "react";
import { Link } from "react-router";
import { SettingHelpLabel } from "~/components/shared/setting-help-label";
import { formatStudentAssetLocation } from "~/modules/location/compact-location";

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
  availabilityTone: "available" | "unavailable";
  availabilityDetail?: string;
  tracking?: string | null;
  status?: string | null;
  maxBorrowDays?: number | null;
  additionalFields?: AssetDetailField[];
};

function LocationValue({ location }: { location: AssetDetailLocation }) {
  const content = formatStudentAssetLocation(location.path);

  return location.href ? (
    <Link
      to={location.href}
      className="font-medium text-red-700 hover:underline"
    >
      <span className="block">{content}</span>
    </Link>
  ) : (
    <span className="block">{content}</span>
  );
}

export function AssetDetailInformation({
  categoryName,
  locations,
  availability,
  availabilityTone,
  availabilityDetail,
  tracking,
  status,
  maxBorrowDays,
  additionalFields = [],
}: AssetDetailInformationProps) {
  const usefulLocations = locations.filter((location) =>
    formatStudentAssetLocation(location.path)
  );
  const fields: AssetDetailField[] = [
    {
      label: "Location",
      value: usefulLocations.length ? (
        <div className="space-y-2">
          {usefulLocations.map((location, index) => (
            <LocationValue
              key={`${location.path.join("/")}-${index}`}
              location={location}
            />
          ))}
        </div>
      ) : (
        "Location not recorded"
      ),
    },
    {
      label: "Category",
      value: categoryName || "Uncategorized",
    },
    ...(maxBorrowDays != null
      ? [{ label: "Maximum borrowing period", value: `${maxBorrowDays} days` }]
      : []),
    ...(tracking
      ? [
          {
            label: "Tracking",
            value: tracking,
            ...(tracking === "Individual QR tracking"
              ? {
                  help: "Each physical unit has its own QR code so IOIO can track which exact unit is borrowed and returned.",
                }
              : {}),
          },
        ]
      : []),
  ];
  const staffFields = [
    ...(status ? [{ label: "Status", value: status }] : []),
    ...additionalFields,
  ];

  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5">
      <h2 className="text-sm font-bold uppercase tracking-wide text-gray-500">
        Details
      </h2>
      <div
        className={`mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-xl border p-3.5 ${
          availabilityTone === "available"
            ? "border-green-200 bg-green-50 text-green-800"
            : "border-red-200 bg-red-50 text-red-800"
        }`}
      >
        <p className="text-xl font-black tracking-tight sm:text-2xl">
          {availability}
        </p>
        {availabilityDetail ? (
          <p className="text-sm text-gray-600">{availabilityDetail}</p>
        ) : null}
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-4 sm:gap-x-6">
        {fields.map((field) => (
          <div key={field.label} className="min-w-0">
            <dt className="text-xs font-bold uppercase tracking-wide text-gray-500">
              {field.help ? (
                <SettingHelpLabel label={field.label} help={field.help} />
              ) : (
                field.label
              )}
            </dt>
            <dd className="mt-1 break-words text-sm leading-5 text-gray-800">
              {field.value}
            </dd>
          </div>
        ))}
      </dl>
      {staffFields.length ? (
        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-gray-100 pt-3 sm:gap-x-6">
          {staffFields.map((field) => (
            <div key={field.label} className="min-w-0">
              <dt className="text-xs font-bold uppercase tracking-wide text-gray-500">
                {field.help ? (
                  <SettingHelpLabel label={field.label} help={field.help} />
                ) : (
                  field.label
                )}
              </dt>
              <dd className="mt-0.5 break-words text-sm leading-5 text-gray-800">
                {field.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </section>
  );
}
