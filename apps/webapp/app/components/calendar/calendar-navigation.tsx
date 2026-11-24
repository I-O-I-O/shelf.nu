import type { RefObject } from "react";
import type FullCalendar from "@fullcalendar/react";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { Button } from "../shared/button";
import { ButtonGroup } from "../shared/button-group";

export function CalendarNavigation({
  calendarRef,
  updateTitle,
}: {
  calendarRef: RefObject<FullCalendar | null>;
  updateTitle: () => void;
}) {
  function handleCalendarNavigation(navigateTo: "prev" | "today" | "next") {
    const calendarApi = calendarRef.current?.getApi();
    if (navigateTo === "prev") {
      calendarApi?.prev();
    } else if (navigateTo == "next") {
      calendarApi?.next();
    } else if (navigateTo == "today") {
      calendarApi?.gotoDate(new Date());
    }

    updateTitle();
  }

  return (
    <div className="shrink-0">
      <ButtonGroup className="rounded-lg border border-gray-200 bg-white shadow-sm">
        <Button
          type="button"
          variant="secondary"
          size="xs"
          className="!h-9 !min-w-9 !rounded-none !border-0 !px-2 !py-0 text-gray-500 first:rounded-l-lg"
          onClick={() => handleCalendarNavigation("prev")}
          aria-label="Previous month"
        >
          <ChevronLeftIcon className="size-4" />
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="xs"
          className="!h-9 !rounded-none !border-0 !border-x !px-3 !py-0 text-sm font-semibold text-gray-700"
          onClick={() => handleCalendarNavigation("today")}
          tooltip={"Go to today"}
        >
          Today
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="xs"
          className="!h-9 !min-w-9 !rounded-none !border-0 !px-2 !py-0 text-gray-500 last:rounded-r-lg"
          onClick={() => handleCalendarNavigation("next")}
          aria-label="Next month"
        >
          <ChevronRightIcon className="size-4" />
        </Button>
      </ButtonGroup>
    </div>
  );
}
