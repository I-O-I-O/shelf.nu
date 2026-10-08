import type { ReactNode } from "react";
import { BookingStatus } from "@prisma/client";
import { BookingDateFilter } from "./booking-date-filter";
import { StatusFilter } from "./status-filter";
import { Filters } from "../list/filters";

/** The b816 IOIO loan toolbar: status/date controls, search, then actions. */
export function IoioLoanFilters({
  actions,
  dateYears = [],
}: {
  actions?: ReactNode;
  dateYears?: number[];
}) {
  return (
    <Filters
      slots={{
        "left-of-search": (
          <div className="flex w-full shrink-0 flex-col gap-2 md:w-auto md:flex-row md:items-center">
            <StatusFilter statusItems={BookingStatus} />
            <BookingDateFilter dateYears={dateYears} />
          </div>
        ),
      }}
    >
      {actions ? (
        <div className="flex w-full shrink-0 flex-wrap justify-end gap-2 md:w-auto">
          {actions}
        </div>
      ) : null}
    </Filters>
  );
}
