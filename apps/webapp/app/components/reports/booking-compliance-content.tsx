import type { ReportKpi } from "~/modules/reports/types";

type Props = {
  complianceData?: {
    completed: number;
    onTime: number;
    late: number;
    unavailable: number;
    rate: number | null;
  };
  kpis: ReportKpi[];
  timeframeLabel?: string;
};

/** Small return-only summary. Active overdue loans are shown separately. */
export function BookingComplianceContent({
  complianceData,
  kpis,
  timeframeLabel,
}: Props) {
  const completed = complianceData?.completed ?? 0;
  const overdue =
    (kpis.find((kpi) => kpi.id === "currently_overdue")?.rawValue as number) ??
    0;

  if (completed === 0 && overdue === 0) {
    return (
      <p className="rounded border border-gray-200 bg-white p-4 text-sm text-gray-600">
        No completed loans in {timeframeLabel?.toLowerCase() ?? "this period"}.
      </p>
    );
  }

  return (
    <section aria-label="Booking compliance" className="space-y-4">
      <p className="text-sm text-gray-500">
        Returned loans due in{" "}
        {timeframeLabel?.toLowerCase() ?? "the selected period"}
      </p>
      <p className="text-xs text-gray-500">
        Returns up to 15 minutes after the planned due time count as on time.
      </p>
      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Completed loans" value={completed} />
        <Metric label="Returned on time" value={complianceData?.onTime ?? 0} />
        <Metric label="Returned late" value={complianceData?.late ?? 0} />
        <Metric
          label="On-time return rate"
          value={
            complianceData?.rate !== null && complianceData?.rate !== undefined
              ? `${complianceData.rate}%`
              : "—"
          }
        />
      </dl>
      {complianceData?.unavailable ? (
        <p className="text-sm text-gray-500">
          Return time unavailable for {complianceData.unavailable} completed{" "}
          {complianceData.unavailable === 1 ? "loan" : "loans"}.
        </p>
      ) : null}
      <div className="rounded border border-gray-200 bg-white p-4">
        <h2 className="text-sm font-medium text-gray-700">Currently overdue</h2>
        <p className="mt-1 text-2xl font-semibold tabular-nums text-gray-900">
          {overdue}
        </p>
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded border border-gray-200 bg-white p-4">
      <dt className="text-sm text-gray-600">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold tabular-nums text-gray-900">
        {value}
      </dd>
    </div>
  );
}
