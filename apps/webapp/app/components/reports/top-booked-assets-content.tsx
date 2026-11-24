import type { ColumnDef } from "@tanstack/react-table";
import { Link } from "react-router";

import { ReportEmptyState } from "~/components/reports/report-empty-state";
import { AssetCell, ReportTable } from "~/components/reports/report-table";
import type { TopBookedAssetRow } from "~/modules/reports/types";

type Props = {
  rows: TopBookedAssetRow[];
  totalRows: number;
  timeframeLabel?: string;
};

const columns: ColumnDef<TopBookedAssetRow>[] = [
  {
    accessorKey: "assetName",
    header: "Asset",
    cell: ({ row }) => (
      <AssetCell
        name={row.original.assetName}
        thumbnailImage={row.original.thumbnailImage}
        mainImage={row.original.mainImage}
        assetId={row.original.assetId}
        assetModel={row.original.assetModel}
      />
    ),
  },
  {
    accessorKey: "bookingCount",
    header: "Loans",
    cell: ({ row }) => (
      <Link
        to={`/assets/${row.original.assetId}/bookings`}
        onClick={(event) => event.stopPropagation()}
        className="font-medium text-primary-700 hover:underline"
        aria-label={`${row.original.bookingCount} loans for ${row.original.assetName}`}
      >
        {row.original.bookingCount} loans
      </Link>
    ),
  },
];

export function TopBookedAssetsContent({
  rows,
  totalRows,
  timeframeLabel,
}: Props) {
  return (
    <section className="overflow-hidden rounded border border-gray-200 bg-white">
      <div className="border-b border-gray-100 px-4 py-3">
        <h2 className="text-sm font-semibold text-gray-900">
          Loans by asset · {timeframeLabel ?? "Selected period"}
        </h2>
        <p className="mt-1 text-xs text-gray-500">
          Each asset counts once per loan when a checkout was recorded during
          the period.
        </p>
      </div>
      <ReportTable
        data={rows}
        columns={columns}
        emptyContent={
          <ReportEmptyState
            reason="no_data"
            title="No borrowed assets in this period"
            description="Only actual checkouts are counted."
          />
        }
      />
      {totalRows > rows.length ? (
        <p className="px-4 py-2 text-xs text-gray-500">
          Showing {rows.length} of {totalRows} assets.
        </p>
      ) : null}
    </section>
  );
}
