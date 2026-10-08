import type {
  AssetUtilizationRow,
  DistributionBreakdown,
  ReportKpi,
} from "~/modules/reports/types";

import { AssetDistributionContent } from "./asset-distribution-content";
import { AssetUtilizationContent } from "./asset-utilization-content";

type Props = {
  usageRows: AssetUtilizationRow[];
  usageKpis: ReportKpi[];
  usageTotalRows: number;
  distributionKpis: ReportKpi[];
  distributionBreakdown?: DistributionBreakdown;
  onRowClick?: (row: AssetUtilizationRow) => void;
};

/** Combines equipment usage and inventory distribution for IOIO Analytics. */
export function AssetUsageDistributionContent({
  usageRows,
  usageKpis,
  usageTotalRows,
  distributionKpis,
  distributionBreakdown,
  onRowClick,
}: Props) {
  return (
    <div className="flex flex-col gap-6">
      <AssetUtilizationContent
        rows={usageRows}
        kpis={usageKpis}
        totalRows={usageTotalRows}
        onRowClick={onRowClick}
      />
      <AssetDistributionContent
        kpis={distributionKpis}
        distributionBreakdown={distributionBreakdown}
      />
    </div>
  );
}
