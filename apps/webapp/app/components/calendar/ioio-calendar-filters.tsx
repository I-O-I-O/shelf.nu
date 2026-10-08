import { BookingStatus } from "@prisma/client";
import { StatusFilter } from "~/components/booking/status-filter";
import { Filters } from "~/components/list/filters";

/** The b816 IOIO Calendar filter row: booking search and status only. */
export function IoioCalendarFilters({ className }: { className?: string }) {
  return (
    <Filters
      className={className}
      slots={{
        "left-of-search": <StatusFilter statusItems={BookingStatus} />,
      }}
    />
  );
}
