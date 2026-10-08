import {
  BarChart3,
  Boxes,
  CalendarCheck2,
  ChevronRight,
  FileText,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";
import { Link } from "react-router";
import type { ReportDefinition } from "~/modules/reports/types";
import { tw } from "~/utils/tw";

export const IOIO_ANALYTICS_REPORT_IDS = [
  "booking-compliance",
  "top-booked-assets",
  "top-booked-kits",
  "asset-usage-distribution",
] as const;

const REPORT_COPY: Record<string, string> = {
  "booking-compliance":
    "See how often loans are returned and checked out on time.",
  "top-booked-assets": "See which assets are borrowed most often.",
  "top-booked-kits": "See which kits are borrowed most often.",
  "asset-usage-distribution":
    "See how equipment is used and where inventory is distributed.",
};

const ANALYTICS_ICONS: Record<string, LucideIcon> = {
  "booking-compliance": CalendarCheck2,
  "top-booked-assets": TrendingUp,
  "top-booked-kits": Boxes,
  "asset-usage-distribution": BarChart3,
};

export function getIoioAnalyticsReports(reports: ReportDefinition[]) {
  const reportsById = new Map(reports.map((report) => [report.id, report]));
  return IOIO_ANALYTICS_REPORT_IDS.flatMap((id) => {
    const report = reportsById.get(id);
    return report ? [report] : [];
  });
}

export function IoioAnalyticsLanding({
  reports,
}: {
  reports: ReportDefinition[];
}) {
  if (!reports.length) return null;

  return (
    <section>
      <div className="mb-3">
        <h3 className="text-sm font-semibold text-gray-950">Analytics</h3>
        <p className="mt-1 text-sm text-gray-500">
          Understand borrowing patterns and inventory usage.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-2">
        {reports.map((report) => (
          <AnalyticsReportCard key={report.id} report={report} />
        ))}
      </div>
    </section>
  );
}

function AnalyticsReportCard({ report }: { report: ReportDefinition }) {
  const IconComponent = ANALYTICS_ICONS[report.id] ?? FileText;
  const card = (
    <div
      className={tw(
        "group relative flex h-full rounded-xl border p-4 transition-colors",
        "border-gray-200 bg-white hover:border-primary-300",
        report.enabled ? "cursor-pointer" : "cursor-not-allowed opacity-75"
      )}
    >
      <div className="flex items-start gap-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-gray-200 bg-gray-50 text-red-700">
          <IconComponent aria-hidden="true" className="size-5 shrink-0" />
        </div>
        <div className="min-w-0 pr-6">
          <h4
            className={tw(
              "text-sm font-semibold",
              report.enabled ? "text-gray-950" : "text-gray-500"
            )}
          >
            {report.title}
          </h4>
          <p className="mt-1 text-sm leading-5 text-gray-600">
            {REPORT_COPY[report.id] ?? report.description}
          </p>
        </div>
        {report.enabled ? (
          <ChevronRight className="absolute right-4 top-1/2 size-4 -translate-y-1/2 text-gray-400 transition-transform group-hover:translate-x-0.5 group-hover:text-primary-600" />
        ) : null}
      </div>
    </div>
  );

  return report.enabled ? (
    <Link to={`/reports/${report.id}`} prefetch="intent">
      {card}
    </Link>
  ) : (
    card
  );
}
