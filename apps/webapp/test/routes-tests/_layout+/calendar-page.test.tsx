import type { ReactNode } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createRoutesStub, useLocation } from "react-router";
import { describe, expect, it, vi } from "vitest";

// why: FullCalendar's browser-only rendering is represented by a small
// component that exposes the event list and its datesSet callback to the test.
vi.mock("@fullcalendar/react", () => {
  type CalendarEvent = { title: string };
  type DateRange = {
    start: Date;
    end: Date;
    view: { type: string };
  };
  return {
    default: function MockFullCalendar({
      events,
      datesSet,
    }: {
      events: CalendarEvent[];
      datesSet: (range: DateRange) => void;
    }) {
      return (
        <div className="fc">
          <button
            type="button"
            onClick={() =>
              datesSet({
                start: new Date("2026-10-08T00:00:00.000Z"),
                end: new Date("2026-10-15T00:00:00.000Z"),
                view: { type: "dayGridMonth" },
              })
            }
          >
            Advance calendar date
          </button>
          {events.map((event) => (
            <div key={event.title}>{event.title}</div>
          ))}
        </div>
      );
    },
  };
});

// why: these shared UI pieces require unrelated root loader data or browser
// widgets; the behavior under test is Calendar's IOIO action, events, and URL.
vi.mock("~/components/layout/header", () => ({
  default: ({
    children,
    subHeading,
  }: {
    children: ReactNode;
    subHeading: string;
  }) => (
    <header>
      <div>{subHeading}</div>
      {children}
    </header>
  ),
}));
vi.mock("~/components/booking/booking-filters", () => ({
  default: () => <div>Booking filters</div>,
}));
vi.mock("~/components/booking/create-booking-dialog", () => ({
  default: () => <button type="button">New booking</button>,
}));
vi.mock("~/components/calendar/calendar-navigation", () => ({
  CalendarNavigation: () => <div>Calendar navigation</div>,
}));
vi.mock("~/components/calendar/calendar-subscribe-dialog", () => ({
  default: () => null,
}));
vi.mock("~/components/calendar/event-card", () => ({ default: () => null }));
vi.mock("~/components/calendar/title-container", () => ({
  default: () => <div>October 2026</div>,
}));
vi.mock("~/components/calendar/view-button-group", () => ({
  ViewButtonGroup: () => null,
}));
vi.mock("~/components/dashboard/fallback-loading", () => ({
  default: () => <div>Loading</div>,
}));
vi.mock("~/components/errors", () => ({ ErrorContent: () => null }));
// why: lottie-web initializes a canvas during module evaluation, unsupported
// by happy-dom and unrelated to the Calendar page behavior under test.
vi.mock("lottie-react", () => ({ default: () => null }));
vi.mock("~/components/shared/spinner", () => ({ Spinner: () => null }));
vi.mock("~/hooks/use-date-formatter", () => ({
  useDateFormatter: () => ({
    prefs: {
      dateFormat: "MM_DD_YYYY",
      timeFormat: "H12",
      weekStartsOn: 0,
      timeZone: "UTC",
    },
  }),
}));
vi.mock("~/hooks/use-viewport-height", () => ({
  useViewportHeight: () => ({ isMd: true }),
}));
vi.mock("~/hooks/use-disabled", () => ({ useDisabled: () => false }));
vi.mock("remix-utils/client-only", () => ({
  ClientOnly: ({ children }: { children: () => ReactNode }) => children(),
}));

import Calendar from "~/routes/_layout+/calendar";

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="calendar-location">{location.search}</output>;
}

function CalendarRoute() {
  return (
    <>
      <Calendar />
      <LocationProbe />
    </>
  );
}

describe("IOIO Calendar page", () => {
  it("renders reservation events and updates the date range in the URL", async () => {
    const Stub = createRoutesStub([
      {
        path: "/calendar",
        Component: CalendarRoute,
        loader: () => ({
          header: { title: "Calendar" },
          events: [{ id: "reservation-1", title: "Microscope - Lab setup" }],
          calendarFeedUrl: null,
          organizationId: "org-1",
          canManageIoioReservations: true,
          isSelfServiceOrBase: false,
        }),
        HydrateFallback: () => <div>Loading calendar test</div>,
      },
    ]);

    render(<Stub initialEntries={["/calendar?focus=week"]} />);

    expect(
      await screen.findByText("Plan upcoming equipment reservations.")
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "New reservation" })
    ).toHaveAttribute("href", "/calendar/new-reservation");
    expect(screen.getByText("Microscope - Lab setup")).toBeInTheDocument();

    act(() => {
      fireEvent.click(
        screen.getByRole("button", { name: "Advance calendar date" })
      );
    });
    // The first datesSet callback represents FullCalendar's initial render;
    // the next callback represents the user's date navigation.
    act(() => {
      fireEvent.click(
        screen.getByRole("button", { name: "Advance calendar date" })
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId("calendar-location")).toHaveTextContent(
        "focus=week&start=2026-10-08T00%3A00%3A00.000Z&end=2026-10-15T00%3A00%3A00.000Z"
      );
    });
  });
});
