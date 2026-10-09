import { render, screen } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLoaderArgs } from "@mocks/remix";

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  getStudentAssets: vi.fn(),
  findReservation: vi.fn(),
  findTeamMember: vi.fn(),
  getConflictSummary: vi.fn(),
  createBooking: vi.fn(),
  reserveBooking: vi.fn(),
}));

// why: this route's loader reads the organization and catalog; empty records
// are returned to model a new organization without an initialized database.
vi.mock("~/database/db.server", () => ({
  db: {
    booking: { findFirst: mocks.findReservation },
    teamMember: { findFirst: mocks.findTeamMember },
  },
}));
vi.mock("~/utils/roles.server", () => ({
  requirePermission: mocks.requirePermission,
}));
vi.mock("~/modules/ioio-student/service.server", () => ({
  getStudentAssets: mocks.getStudentAssets,
}));
// why: the route test verifies the real Calendar action's booking payload and
// service sequence without writing to a development or production database.
vi.mock("~/modules/booking/service.server", () => ({
  cancelBooking: vi.fn(),
  createBooking: mocks.createBooking,
  reserveBooking: mocks.reserveBooking,
  updateBasicBooking: vi.fn(),
  updateBookingAssets: vi.fn(),
}));
vi.mock("~/modules/ioio-student/staff-reservation-conflicts.server", () => ({
  getIoioStaffReservationConflictSummary: mocks.getConflictSummary,
  requestIoioEarlierReturn: vi.fn(),
}));
// why: the reservation UI behavior under test is its no-inventory state, not
// the shared date picker, which requires root request-info loader context.
vi.mock("~/components/ioio-student/ioio-date-range-picker", () => ({
  IoioDateRangePicker: () => <div>Date range</div>,
}));
// why: the route's shared error components import a Lottie animation that
// expects canvas support unavailable in happy-dom at module initialization.
vi.mock("lottie-react", () => ({ default: () => null }));

import NewIoioReservation, {
  action,
  loader,
} from "~/routes/_layout+/calendar.new-reservation";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requirePermission.mockResolvedValue({
    organizationId: "org-1",
    role: "OWNER",
    userId: "staff-1",
  });
  mocks.getStudentAssets.mockResolvedValue([]);
  mocks.findReservation.mockResolvedValue(null);
  mocks.findTeamMember.mockResolvedValue({ id: "team-member-staff" });
  mocks.getConflictSummary.mockResolvedValue({
    total: 5,
    available: 0,
    requested: 1,
    shortfall: 1,
    loanConflictQuantity: 0,
    staffReservedCount: 5,
    staffReservationBookingIds: ["course-reservation"],
    availableAfterSoftConflicts: 5,
    availableUnitIdsAfterSoftConflicts: [
      "makey-001",
      "makey-002",
      "makey-003",
      "makey-004",
      "makey-005",
    ],
    loanBookingIds: [],
    softConflictBookingIds: ["course-reservation"],
    conflicts: [],
  });
  mocks.createBooking.mockResolvedValue({ id: "calendar-booking" });
  mocks.reserveBooking.mockResolvedValue({ id: "calendar-booking" });
});

describe("staff calendar reservation", () => {
  it("requires staff permissions for reservation routes and actions", async () => {
    mocks.requirePermission.mockResolvedValue({
      organizationId: "org-1",
      role: "SELF_SERVICE",
      userId: "student-1",
    });

    await expect(
      loader(
        createLoaderArgs({
          context: { getSession: () => ({ userId: "student-1" }) },
          request: new Request("http://localhost/calendar/new-reservation"),
        })
      )
    ).rejects.toMatchObject({ status: 403 });

    await expect(
      action(
        createLoaderArgs({
          context: { getSession: () => ({ userId: "student-1" }) },
          request: new Request("http://localhost/calendar/new-reservation", {
            method: "POST",
            body: new FormData(),
          }),
        })
      )
    ).rejects.toMatchObject({ status: 403 });

    expect(mocks.requirePermission).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: "create" })
    );
  });

  it("loads and renders safely when the organization has no inventory", async () => {
    const result = await loader(
      createLoaderArgs({
        context: { getSession: () => ({ userId: "staff-1" }) },
        request: new Request("http://localhost/calendar/new-reservation"),
      })
    );

    expect(result.data).toMatchObject({ products: [], reservation: null });

    const Stub = createRoutesStub([
      {
        path: "/calendar/new-reservation",
        Component: NewIoioReservation,
        loader: () => ({ products: [], reservation: null }),
        HydrateFallback: () => <div>Loading reservation...</div>,
      },
    ]);
    render(<Stub initialEntries={["/calendar/new-reservation"]} />);

    expect(
      await screen.findByText(/No equipment is available to reserve yet/)
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: "Create reservation" })
    ).toBeDisabled();
  });

  it("persists the IOIO soft-reservation marker through the Calendar create flow", async () => {
    const form = new FormData();
    form.set("name", "Course equipment reservation");
    form.set("assetId", "makey-model");
    form.set(
      "candidateAssetIds",
      "makey-001,makey-002,makey-003,makey-004,makey-005"
    );
    form.set("quantity", "1");
    form.set("startDate", "2026-10-11");
    form.set("returnDate", "2027-01-30");
    form.set("createAnyway", "true");

    const result = await action(
      createLoaderArgs({
        context: { getSession: () => ({ userId: "staff-1" }) },
        request: new Request("http://localhost/calendar/new-reservation", {
          method: "POST",
          body: form,
        }),
      })
    );

    expect(result.data).toMatchObject({
      ok: true,
      intent: "create",
      bookingId: "calendar-booking",
    });
    expect(mocks.createBooking).toHaveBeenCalledWith(
      expect.objectContaining({
        booking: expect.objectContaining({
          organizationId: "org-1",
          description: "IOIO staff reservation",
          from: new Date("2026-10-11T00:00:00.000Z"),
          to: new Date("2027-01-30T23:59:59.999Z"),
        }),
        assetIds: ["makey-001"],
      })
    );
    expect(mocks.reserveBooking).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-1",
        description: "IOIO staff reservation",
        ignoreBookingIds: ["course-reservation"],
      })
    );
  });

  it("does not allow Create anyway for a hard Student loan conflict", async () => {
    mocks.getConflictSummary.mockResolvedValue({
      total: 5,
      available: 0,
      requested: 1,
      shortfall: 1,
      loanConflictQuantity: 1,
      staffReservedCount: 0,
      staffReservationBookingIds: [],
      availableAfterSoftConflicts: 0,
      availableUnitIdsAfterSoftConflicts: [],
      loanBookingIds: ["active-student-loan"],
      softConflictBookingIds: [],
      conflicts: [],
    });
    const form = new FormData();
    form.set("name", "Course equipment reservation");
    form.set("assetId", "makey-model");
    form.set("candidateAssetIds", "makey-001");
    form.set("quantity", "1");
    form.set("startDate", "2026-10-11");
    form.set("returnDate", "2027-01-30");
    form.set("createAnyway", "true");

    const result = await action(
      createLoaderArgs({
        context: { getSession: () => ({ userId: "staff-1" }) },
        request: new Request("http://localhost/calendar/new-reservation", {
          method: "POST",
          body: form,
        }),
      })
    );

    expect(result.init?.status).toBe(409);
    expect(result.data).toMatchObject({ ok: false, canCreateAnyway: false });
    expect(mocks.createBooking).not.toHaveBeenCalled();
    expect(mocks.reserveBooking).not.toHaveBeenCalled();
  });
});
