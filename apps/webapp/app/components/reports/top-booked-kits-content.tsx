import type { ColumnDef } from "@tanstack/react-table";
import { Link } from "react-router";

import { ReportEmptyState } from "~/components/reports/report-empty-state";
import { KitCell, ReportTable } from "~/components/reports/report-table";
import type { TopBookedKitRow } from "~/modules/reports/types";

type Props = {
  rows: TopBookedKitRow[];
  totalRows: number;
  timeframeLabel?: string;
};

const columns: ColumnDef<TopBookedKitRow>[] = [
  {
    accessorKey: "kitName",
    header: "Kit",
    cell: ({ row }) => (
      <KitCell
        name={row.original.kitName}
        image={row.original.image}
        imageExpiration={row.original.imageExpiration}
        kitId={row.original.kitId}
      />
    ),
  },
  {
    accessorKey: "bookingCount",
    header: "Loans",
    cell: ({ row }) => (
      <Link
        to={`/kits/${row.original.kitId}/bookings`}
        onClick={(event) => event.stopPropagation()}
        className="font-medium text-primary-700 hover:underline"
        aria-label={`${row.original.bookingCount} loans for ${row.original.kitName}`}
      >
        {row.original.bookingCount} loans
      </Link>
    ),
  },
];

export function TopBookedKitsContent({
  rows,
  totalRows,
  timeframeLabel,
}: Props) {
  return (
    <section className="overflow-hidden rounded border border-gray-200 bg-white">
      <div className="border-b border-gray-100 px-4 py-3">
        <h2 className="text-sm font-semibold text-gray-900">
          Loans by kit · {timeframeLabel ?? "Selected period"}
        </h2>
        <p className="mt-1 text-xs text-gray-500">
          A genuine kit counts once per loan when a kit item checkout was
          recorded during the period.
        </p>
      </div>
      <ReportTable
        data={rows}
        columns={columns}
        emptyContent={
          <ReportEmptyState
            reason="no_data"
            title="No borrowed kits in this period"
            description="Only checked-out kit slices are counted."
          />
        }
      />
      {totalRows > rows.length ? (
        <p className="px-4 py-2 text-xs text-gray-500">
          Showing {rows.length} of {totalRows} kits.
        </p>
      ) : null}
    </section>
  );
}
