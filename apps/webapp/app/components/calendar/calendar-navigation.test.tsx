import type { RefObject } from "react";
import type FullCalendar from "@fullcalendar/react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CalendarNavigation } from "./calendar-navigation";

describe("CalendarNavigation", () => {
  it("uses the active FullCalendar view for previous/next and returns to today", () => {
    const prev = vi.fn();
    const next = vi.fn();
    const gotoDate = vi.fn();
    const updateTitle = vi.fn();
    const calendarRef = {
      current: { getApi: () => ({ prev, next, gotoDate }) },
    } as unknown as RefObject<FullCalendar | null>;

    render(
      <CalendarNavigation calendarRef={calendarRef} updateTitle={updateTitle} />
    );

    fireEvent.click(screen.getByRole("button", { name: "Previous month" }));
    fireEvent.click(screen.getByRole("button", { name: "Next month" }));
    fireEvent.click(screen.getByRole("button", { name: "Today" }));

    expect(prev).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledOnce();
    expect(gotoDate).toHaveBeenCalledWith(expect.any(Date));
    expect(updateTitle).toHaveBeenCalledTimes(3);
  });
});
