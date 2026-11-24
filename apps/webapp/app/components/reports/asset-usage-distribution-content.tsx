import { Link } from "react-router";

import type { DistributionBreakdown, ReportKpi } from "~/modules/reports/types";

type Props = {
  usageKpis: ReportKpi[];
  distributionKpis: ReportKpi[];
  distributionBreakdown?: DistributionBreakdown;
  timeframeLabel?: string;
};

/** Separates checkout activity from the current inventory snapshot. */
export function AssetUsageDistributionContent({
  usageKpis,
  distributionKpis,
  distributionBreakdown,
  timeframeLabel,
}: Props) {
  const metric = (items: ReportKpi[], id: string) =>
    (items.find((item) => item.id === id)?.rawValue as number | undefined) ?? 0;
  const totalAssets = metric(distributionKpis, "total_assets");
  const borrowed = metric(usageKpis, "assets_borrowed");
  const loans = metric(usageKpis, "loans");

  return (
    <div className="space-y-6">
      <section aria-labelledby="usage-heading" className="space-y-3">
        <div>
          <h2
            id="usage-heading"
            className="text-base font-semibold text-gray-900"
          >
            Inventory usage
          </h2>
          <p className="text-sm text-gray-500">
            Actual checkouts during{" "}
            {timeframeLabel?.toLowerCase() ?? "the selected period"}. Each
            parent inventory asset counts once per loan; archived loan history
            is retained.
          </p>
        </div>
        <dl className="grid gap-3 sm:grid-cols-3">
          <Metric label="Total active assets" value={totalAssets} />
          <Metric label="Assets borrowed" value={borrowed} />
          <Metric label="Loans" value={loans} />
        </dl>
        {loans === 0 ? (
          <p className="text-sm text-gray-500">No loans in this period.</p>
        ) : null}
      </section>

      <section aria-labelledby="distribution-heading" className="space-y-3">
        <div>
          <h2
            id="distribution-heading"
            className="text-base font-semibold text-gray-900"
          >
            Current inventory distribution
          </h2>
          <p className="text-sm text-gray-500">
            Counts include active assets only. An asset in multiple locations
            appears in each location count.
          </p>
        </div>
        {!distributionBreakdown || totalAssets === 0 ? (
          <p className="rounded border border-gray-200 bg-white p-4 text-sm text-gray-600">
            No active inventory to distribute.
          </p>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            <BreakdownList
              title="Assets by category"
              rows={distributionBreakdown.byCategory}
              href={(id) => `/assets?category=${encodeURIComponent(id)}`}
            />
            <BreakdownList
              title="Assets by location"
              rows={distributionBreakdown.byLocation}
              href={(id) => `/assets?location=${encodeURIComponent(id)}`}
            />
          </div>
        )}
      </section>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded border border-gray-200 bg-white p-4">
      <dt className="text-sm text-gray-600">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold tabular-nums text-gray-900">
        {value}
      </dd>
    </div>
  );
}

function BreakdownList({
  title,
  rows,
  href,
}: {
  title: string;
  rows: DistributionBreakdown["byCategory"];
  href: (id: string) => string;
}) {
  return (
    <section className="rounded border border-gray-200 bg-white">
      <h3 className="border-b border-gray-100 px-4 py-3 text-sm font-medium text-gray-800">
        {title}
      </h3>
      {rows.length === 0 ? (
        <p className="p-4 text-sm text-gray-500">No data available.</p>
      ) : (
        <ul className="divide-y divide-gray-100">
          {rows.map((row) => (
            <li
              key={row.id}
              className="flex items-center justify-between gap-4 px-4 py-3"
            >
              <Link
                to={href(row.id)}
                className="truncate text-sm text-primary-700 hover:underline"
              >
                {row.groupName}
              </Link>
              <span className="shrink-0 text-sm tabular-nums text-gray-700">
                {row.assetCount} {row.assetCount === 1 ? "asset" : "assets"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
