import { AssetType } from "@prisma/client";
import { act, render, screen } from "@testing-library/react";
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
  updateBasicBooking: vi.fn(),
  cancelBooking: vi.fn(),
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
  cancelBooking: mocks.cancelBooking,
  createBooking: mocks.createBooking,
  reserveBooking: mocks.reserveBooking,
  updateBasicBooking: mocks.updateBasicBooking,
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
    available: 5,
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

function studentUnit(id: string, sequentialId: string) {
  return {
    id,
    title: `Makey Kit #${sequentialId}`,
    description: null,
    mainImage: null,
    mainImageExpiration: null,
    thumbnailImage: null,
    assetModel: {
      id: "makey-model",
      name: "Makey Kit",
      image: null,
      thumbnailImage: null,
    },
    status: "AVAILABLE",
    type: AssetType.INDIVIDUAL,
    quantity: null,
    updatedAt: new Date("2026-10-20T12:00:00.000Z"),
    assetModelId: "makey-model",
    availableQuantity: 1,
    availableToBook: true,
    maxBorrowDays: 45,
    extensionBorrowDays: null,
    requiresBorrowApproval: false,
    requiresStaffPreparation: true,
    sequentialId,
    category: null,
    locations: [],
    kits: [],
    qrIds: [],
    kitImage: null,
  };
}

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
    expect(
      screen.queryByRole("link", { name: "Review pending IOIO requests" })
    ).not.toBeInTheDocument();
  });

  it("allows quantity four across a soft reservation and ignores only that reservation", async () => {
    mocks.getConflictSummary.mockResolvedValue({
      total: 5,
      available: 4,
      requested: 4,
      shortfall: 0,
      loanConflictQuantity: 0,
      staffReservedCount: 1,
      staffReservationBookingIds: ["course-reservation"],
      availableAfterSoftConflicts: 4,
      availableUnitIdsAfterSoftConflicts: [
        "makey-001",
        "makey-002",
        "makey-003",
        "makey-004",
      ],
      loanBookingIds: [],
      softConflictBookingIds: ["course-reservation"],
      conflicts: [],
    });
    const form = new FormData();
    form.set("name", "Course equipment reservation");
    form.set("assetId", "makey-model");
    form.set(
      "candidateAssetIds",
      "makey-001,makey-002,makey-003,makey-004,makey-005"
    );
    form.set("quantity", "4");
    form.set("startDate", "2027-10-11");
    form.set("returnDate", "2028-01-30");

    const result = await action(
      createLoaderArgs({
        context: { getSession: () => ({ userId: "staff-1" }) },
        request: new Request("http://localhost/calendar/new-reservation", {
          method: "POST",
          body: form,
        }),
      })
    );

    expect(result).toBeInstanceOf(Response);
    if (!(result instanceof Response)) {
      throw new Error("Expected successful creation to redirect");
    }
    expect(result.status).toBe(302);
    expect(result.headers.get("Location")).toBe("/calendar?start=2027-10-11");
    expect(mocks.createBooking).toHaveBeenCalledWith(
      expect.objectContaining({
        booking: expect.objectContaining({
          organizationId: "org-1",
          description: "IOIO staff reservation",
          from: new Date("2027-10-11T00:00:00.000Z"),
          to: new Date("2028-01-30T23:59:59.999Z"),
        }),
        assetIds: ["makey-001", "makey-002", "makey-003", "makey-004"],
      })
    );
    expect(mocks.createBooking).toHaveBeenCalledTimes(1);
    expect(mocks.reserveBooking).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "calendar-booking",
        organizationId: "org-1",
        description: "IOIO staff reservation",
        ignoreBookingIds: ["course-reservation"],
      })
    );
    expect(mocks.updateBasicBooking).not.toHaveBeenCalled();
  });

  it("loads and displays every assigned unit from the parent reservation", async () => {
    const unitIds = ["makey-001", "makey-002", "makey-003", "makey-004"];
    mocks.getStudentAssets.mockResolvedValue(
      unitIds.map((id, index) => studentUnit(id, `00${index + 1}`))
    );
    mocks.findReservation.mockResolvedValue({
      id: "parent-reservation",
      name: "TEI",
      description: "IOIO staff reservation",
      status: "RESERVED",
      from: new Date("2026-10-22T00:00:00.000Z"),
      to: new Date("2026-10-29T23:59:59.999Z"),
      custodianUserId: "staff-1",
      custodianTeamMemberId: "staff-member",
      creator: {
        id: "staff-1",
        firstName: "Teacher",
        lastName: null,
        displayName: null,
      },
      bookingAssets: unitIds.map((assetId) => ({ assetId, quantity: 1 })),
    });

    const result = await loader(
      createLoaderArgs({
        context: { getSession: () => ({ userId: "staff-1" }) },
        request: new Request(
          "http://localhost/calendar/new-reservation?bookingId=parent-reservation"
        ),
      })
    );

    expect(mocks.findReservation).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "parent-reservation",
          organizationId: "org-1",
          description: "IOIO staff reservation",
        },
      })
    );
    expect(result.data.reservation).toMatchObject({
      id: "parent-reservation",
      name: "TEI",
      quantity: 4,
      items: [
        {
          label: "Makey Kit",
          quantity: 4,
          unitLabels: ["#001", "#002", "#003", "#004"],
        },
      ],
    });

    const Stub = createRoutesStub([
      {
        path: "/calendar/new-reservation",
        Component: NewIoioReservation,
        loader: () => result.data,
        HydrateFallback: () => <div>Loading reservation...</div>,
      },
    ]);
    await act(async () => {
      render(
        <Stub
          initialEntries={[
            "/calendar/new-reservation?bookingId=parent-reservation",
          ]}
        />
      );
    });

    const equipmentList = await screen.findByRole("group", {
      name: "Equipment in this reservation",
    });
    expect(screen.getByText("Reserved")).toBeInTheDocument();
    expect(equipmentList).toHaveTextContent("Makey Kit ×4");
    expect(equipmentList).toHaveTextContent("units #001, #002, #003, #004");
    expect(screen.queryByPlaceholderText("Search equipment...")).toBeNull();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  });

  it("cancels the whole parent reservation by its canonical booking ID", async () => {
    mocks.findReservation.mockResolvedValue({ id: "parent-reservation" });
    const form = new FormData();
    form.set("intent", "cancel-reservation");
    form.set("bookingId", "parent-reservation");

    const result = await action(
      createLoaderArgs({
        context: { getSession: () => ({ userId: "staff-1" }) },
        request: new Request("http://localhost/calendar/new-reservation", {
          method: "POST",
          body: form,
        }),
      })
    );

    if (result instanceof Response) {
      throw new Error("Cancelling the reservation should return action data");
    }
    expect(result.data).toMatchObject({
      ok: true,
      intent: "cancel-reservation",
    });
    expect(mocks.cancelBooking).toHaveBeenCalledTimes(1);
    expect(mocks.cancelBooking).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "parent-reservation",
        organizationId: "org-1",
        userId: "staff-1",
      })
    );
  });

  it("edits the parent reservation without replacing its memberships", async () => {
    mocks.findReservation.mockResolvedValue({
      id: "parent-reservation",
      custodianUserId: "staff-1",
      custodianTeamMemberId: "staff-member",
    });
    const form = new FormData();
    form.set("intent", "edit");
    form.set("bookingId", "parent-reservation");
    form.set("name", "Updated TEI workshop");
    form.set("assetId", "makey-model");
    form.set("quantity", "4");
    form.set("startDate", "2027-10-11");
    form.set("returnDate", "2027-10-12");

    const result = await action(
      createLoaderArgs({
        context: { getSession: () => ({ userId: "staff-1" }) },
        request: new Request("http://localhost/calendar/new-reservation", {
          method: "POST",
          body: form,
        }),
      })
    );

    if (result instanceof Response) {
      throw new Error("Editing the reservation should return action data");
    }
    expect(result.data).toMatchObject({
      ok: true,
      intent: "edit",
      bookingId: "parent-reservation",
    });
    expect(mocks.updateBasicBooking).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "parent-reservation",
        organizationId: "org-1",
        name: "Updated TEI workshop",
        from: new Date("2027-10-11T00:00:00.000Z"),
        to: new Date("2027-10-12T23:59:59.999Z"),
      })
    );
    expect(mocks.createBooking).not.toHaveBeenCalled();
    expect(mocks.reserveBooking).not.toHaveBeenCalled();
  });

  it("assigns only the eligible physical units when one candidate is hard-conflicted", async () => {
    mocks.getConflictSummary.mockResolvedValue({
      total: 5,
      available: 4,
      requested: 4,
      shortfall: 0,
      loanConflictQuantity: 1,
      staffReservedCount: 0,
      staffReservationBookingIds: [],
      availableAfterSoftConflicts: 4,
      availableUnitIdsAfterSoftConflicts: [
        "makey-001",
        "makey-002",
        "makey-003",
        "makey-005",
      ],
      loanBookingIds: ["active-student-loan"],
      softConflictBookingIds: [],
      conflicts: [],
    });
    const form = new FormData();
    form.set("name", "Course equipment reservation");
    form.set("assetId", "makey-model");
    form.set(
      "candidateAssetIds",
      "makey-001,makey-002,makey-003,makey-004,makey-005"
    );
    form.set("quantity", "4");
    form.set("startDate", "2027-10-11");
    form.set("returnDate", "2028-01-30");

    await action(
      createLoaderArgs({
        context: { getSession: () => ({ userId: "staff-1" }) },
        request: new Request("http://localhost/calendar/new-reservation", {
          method: "POST",
          body: form,
        }),
      })
    );

    expect(mocks.createBooking).toHaveBeenCalledWith(
      expect.objectContaining({
        assetIds: ["makey-001", "makey-002", "makey-003", "makey-005"],
      })
    );
    expect(mocks.reserveBooking).toHaveBeenCalledWith(
      expect.objectContaining({ ignoreBookingIds: [] })
    );
  });

  it("rejects quantity four when only three units remain after hard conflicts", async () => {
    mocks.getConflictSummary.mockResolvedValue({
      total: 5,
      available: 3,
      requested: 4,
      shortfall: 1,
      loanConflictQuantity: 2,
      staffReservedCount: 0,
      staffReservationBookingIds: [],
      availableAfterSoftConflicts: 3,
      availableUnitIdsAfterSoftConflicts: [],
      loanBookingIds: ["active-student-loan"],
      softConflictBookingIds: [],
      conflicts: [],
    });
    const form = new FormData();
    form.set("name", "Course equipment reservation");
    form.set("assetId", "makey-model");
    form.set(
      "candidateAssetIds",
      "makey-001,makey-002,makey-003,makey-004,makey-005"
    );
    form.set("quantity", "4");
    form.set("startDate", "2027-10-11");
    form.set("returnDate", "2028-01-30");

    const result = await action(
      createLoaderArgs({
        context: { getSession: () => ({ userId: "staff-1" }) },
        request: new Request("http://localhost/calendar/new-reservation", {
          method: "POST",
          body: form,
        }),
      })
    );

    if (result instanceof Response) {
      throw new Error("Invalid availability must not redirect");
    }
    expect(result.init?.status).toBe(409);
    expect(result.data).toMatchObject({ ok: false, intent: "create" });
    expect(mocks.createBooking).not.toHaveBeenCalled();
    expect(mocks.reserveBooking).not.toHaveBeenCalled();
  });

  it("keeps the reservation form on screen when saving fails", async () => {
    mocks.reserveBooking.mockRejectedValue(
      new Error("Reservation save failed")
    );
    const form = new FormData();
    form.set("name", "Course equipment reservation");
    form.set("assetId", "makey-model");
    form.set("candidateAssetIds", "makey-001,makey-002,makey-003");
    form.set("quantity", "1");
    form.set("startDate", "2027-10-11");
    form.set("returnDate", "2028-01-30");

    const result = await action(
      createLoaderArgs({
        context: { getSession: () => ({ userId: "staff-1" }) },
        request: new Request("http://localhost/calendar/new-reservation", {
          method: "POST",
          body: form,
        }),
      })
    );

    if (result instanceof Response) {
      throw new Error("Failed reservation save must not redirect");
    }
    expect(result.init?.status).toBe(500);
    expect(result.data).toMatchObject({
      ok: false,
      error: "Sorry, something went wrong.",
    });
    expect(mocks.createBooking).toHaveBeenCalled();
    expect(mocks.reserveBooking).toHaveBeenCalled();
  });

  it("shows the same date availability in the selected product and summary", async () => {
    const availability = {
      total: 5,
      available: 4,
      requested: 1,
      shortfall: 0,
      loanConflictQuantity: 0,
      staffReservedCount: 1,
      staffReservationBookingIds: ["course-reservation"],
      availableAfterSoftConflicts: 4,
      availableUnitIdsAfterSoftConflicts: [
        "makey-001",
        "makey-002",
        "makey-003",
        "makey-004",
      ],
      loanBookingIds: [],
      softConflictBookingIds: ["course-reservation"],
      conflicts: [],
    };
    const products = [
      {
        id: "makey-model",
        title: "Makey Kit",
        type: AssetType.INDIVIDUAL,
        quantity: 5,
        availableQuantity: 4,
        candidateAssetIds: [
          "makey-001",
          "makey-002",
          "makey-003",
          "makey-004",
          "makey-005",
        ],
        isKit: true,
        searchText: "makey kit",
      },
    ];
    const Stub = createRoutesStub([
      {
        path: "/calendar/new-reservation",
        Component: NewIoioReservation,
        loader: () => ({ products, reservation: null }),
        action: () => ({ ok: true, intent: "availability", availability }),
      },
    ]);
    render(<Stub initialEntries={["/calendar/new-reservation"]} />);

    expect(
      await screen.findByRole("option", {
        name: "Kit · Makey Kit (4 available)",
      })
    ).toBeInTheDocument();
    expect(
      await screen.findByText("Available for these dates: 4")
    ).toBeInTheDocument();
    expect(await screen.findByText(/4 available of 5/)).toBeInTheDocument();
  });
});
