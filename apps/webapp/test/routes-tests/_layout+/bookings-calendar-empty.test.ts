import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLoaderArgs } from "@mocks/remix";

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  getBookingsFilterData: vi.fn(),
  getBookings: vi.fn(),
  resolveCustodianScope: vi.fn(),
  decorateBookingsForList: vi.fn(),
  getTeamMemberForCustodianFilter: vi.fn(),
  getTeamMemberForForm: vi.fn(),
  getTeamMembersForNotify: vi.fn(),
  getBookingsForCalendar: vi.fn(),
  getMemberCalendarFeedUrl: vi.fn(),
  getTagsForBookingTagsFilter: vi.fn(),
  findBookingTags: vi.fn(),
}));

// why: the route loaders are exercised without a seeded organization or a
// database connection; each query returns the same empty result as a new org.
vi.mock("~/database/db.server", () => ({
  db: { tag: { findMany: mocks.findBookingTags } },
}));
vi.mock("~/utils/roles.server", () => ({
  requirePermission: mocks.requirePermission,
}));
vi.mock("~/modules/booking/service.server", () => ({
  getBookingsFilterData: mocks.getBookingsFilterData,
  getBookings: mocks.getBookings,
  resolveCustodianScope: mocks.resolveCustodianScope,
  getBookingsForCalendar: mocks.getBookingsForCalendar,
}));
vi.mock("~/modules/booking/list-flags.server", () => ({
  decorateBookingsForList: mocks.decorateBookingsForList,
}));
vi.mock("~/modules/team-member/service.server", () => ({
  getTeamMemberForCustodianFilter: mocks.getTeamMemberForCustodianFilter,
  getTeamMemberForForm: mocks.getTeamMemberForForm,
  getTeamMembersForNotify: mocks.getTeamMembersForNotify,
}));
vi.mock("~/modules/calendar-subscription/service.server", () => ({
  getMemberCalendarFeedUrl: mocks.getMemberCalendarFeedUrl,
}));
vi.mock("~/modules/tag/service.server", () => ({
  getTagsForBookingTagsFilter: mocks.getTagsForBookingTagsFilter,
}));
vi.mock("~/utils/cookies.server", () => ({
  setCookie: vi.fn((value: string) => value),
  userPrefs: { serialize: vi.fn().mockResolvedValue("prefs-cookie") },
}));
vi.mock("~/modules/organization/context.server", () => ({
  setSelectedOrganizationIdCookie: vi.fn().mockResolvedValue("org-cookie"),
}));
vi.mock("lottie-react", () => ({ default: () => null }));

import { loader as bookingsLoader } from "~/routes/_layout+/bookings._index";
import { loader as calendarLoader } from "~/routes/_layout+/calendar";

const organization = { id: "org-1", type: "TEAM" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requirePermission.mockResolvedValue({
    organizationId: organization.id,
    currentOrganization: organization,
    role: "OWNER",
    isSelfServiceOrBase: false,
    canSeeAllBookings: true,
    canSeeAllCustody: true,
  });
  mocks.getBookingsFilterData.mockResolvedValue({
    page: 1,
    perPage: 20,
    search: "",
    status: null,
    teamMemberIds: [],
    orderBy: "from",
    orderDirection: "desc",
    selfServiceData: null,
    searchParams: new URLSearchParams(),
    cookie: {},
    filtersCookie: null,
    filters: null,
    redirectNeeded: false,
    tags: [],
  });
  mocks.getBookings.mockResolvedValue({ bookings: [], bookingCount: 0 });
  mocks.resolveCustodianScope.mockResolvedValue({
    userId: "user-1",
    teamMemberIds: ["team-member-1"],
  });
  mocks.decorateBookingsForList.mockResolvedValue([]);
  mocks.getTeamMemberForCustodianFilter.mockResolvedValue({
    teamMembers: [],
    totalTeamMembers: 0,
  });
  mocks.getTeamMemberForForm.mockResolvedValue({
    teamMembers: [],
    totalTeamMembers: 0,
  });
  mocks.getTeamMembersForNotify.mockResolvedValue({
    teamMembersForNotify: [],
  });
  mocks.findBookingTags.mockResolvedValue([]);
  mocks.getBookingsForCalendar.mockResolvedValue([]);
  mocks.getTagsForBookingTagsFilter.mockResolvedValue({
    tags: [],
    totalTags: 0,
  });
  mocks.getMemberCalendarFeedUrl.mockResolvedValue(null);
});

describe("empty booking and calendar route loaders", () => {
  it("loads the staff loan list when the user has no TeamMember or bookings", async () => {
    const result = await bookingsLoader(
      createLoaderArgs({
        context: { getSession: () => ({ userId: "user-1" }) },
        request: new Request("http://localhost/bookings"),
      })
    );

    if (!("data" in result)) {
      throw new Error("Expected booking loader data");
    }

    expect(result.data).toMatchObject({
      items: [],
      totalItems: 0,
      totalPages: 0,
    });
    expect(mocks.requirePermission).toHaveBeenCalledWith(
      expect.objectContaining({ entity: "booking", action: "read" })
    );
    expect(mocks.getBookings).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: organization.id })
    );
  });

  it("scopes My Loans to the current user and renders a zero-result state", async () => {
    const result = await bookingsLoader(
      createLoaderArgs({
        context: { getSession: () => ({ userId: "user-1" }) },
        request: new Request("http://localhost/bookings?mine=1"),
      })
    );

    if (!("data" in result)) {
      throw new Error("Expected booking loader data");
    }

    expect(mocks.resolveCustodianScope).toHaveBeenCalledWith({
      userId: "user-1",
      organizationId: organization.id,
    });
    expect(mocks.getBookings).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: organization.id,
        custodianScope: {
          userId: "user-1",
          teamMemberIds: ["team-member-1"],
        },
      })
    );
    expect(result.data).toMatchObject({
      header: { title: "My Loans - 0" },
      mineOnly: true,
      items: [],
      totalItems: 0,
    });
  });

  it("keeps the ordinary staff Loans view organization-wide", async () => {
    await bookingsLoader(
      createLoaderArgs({
        context: { getSession: () => ({ userId: "user-1" }) },
        request: new Request("http://localhost/bookings"),
      })
    );

    expect(mocks.resolveCustodianScope).not.toHaveBeenCalled();
    expect(mocks.getBookings).toHaveBeenCalledWith(
      expect.not.objectContaining({ custodianScope: expect.anything() })
    );
  });

  it("loads Calendar with no reservations and gives SELF_SERVICE no staff controls", async () => {
    mocks.requirePermission.mockResolvedValueOnce({
      organizationId: organization.id,
      currentOrganization: organization,
      role: "SELF_SERVICE",
      isSelfServiceOrBase: true,
      canSeeAllBookings: false,
      canSeeAllCustody: false,
    });
    const result = await calendarLoader(
      createLoaderArgs({
        context: { getSession: () => ({ userId: "user-1" }) },
        request: new Request("http://localhost/calendar"),
      })
    );

    expect(result).toMatchObject({
      events: [],
      canManageIoioReservations: false,
    });
    expect(mocks.requirePermission).toHaveBeenCalledWith(
      expect.objectContaining({ entity: "booking", action: "read" })
    );
    expect(mocks.getBookingsForCalendar).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: organization.id,
        canSeeAllBookings: false,
      })
    );
  });

  it("keeps the personal-workspace booking restriction", async () => {
    mocks.requirePermission.mockResolvedValueOnce({
      organizationId: "personal-org",
      currentOrganization: { id: "personal-org", type: "PERSONAL" },
      role: "OWNER",
      canSeeAllBookings: true,
      canSeeAllCustody: true,
    });

    await expect(
      calendarLoader(
        createLoaderArgs({
          context: { getSession: () => ({ userId: "user-1" }) },
          request: new Request("http://localhost/calendar"),
        })
      )
    ).rejects.toMatchObject({ init: { status: 403 } });
    expect(mocks.getBookingsForCalendar).not.toHaveBeenCalled();
  });

  it("keeps only IOIO reservation events and links them to reservation review", async () => {
    mocks.getBookingsForCalendar.mockResolvedValueOnce([
      {
        id: "reservation-1",
        title: "Legacy title",
        start: "2026-10-07T09:00:00.000Z",
        end: "2026-10-07T10:00:00.000Z",
        extendedProps: {
          id: "reservation-1",
          description: "IOIO staff reservation",
          name: "Lab setup",
          assetNames: ["Microscope"],
          creator: { id: "creator-1", name: "Taylor" },
        },
      },
      {
        id: "generic-booking-1",
        title: "Generic booking",
        start: "2026-10-08T09:00:00.000Z",
        end: "2026-10-08T10:00:00.000Z",
        extendedProps: { description: "Shelf booking" },
      },
    ]);

    const result = await calendarLoader(
      createLoaderArgs({
        context: { getSession: () => ({ userId: "user-1" }) },
        request: new Request("http://localhost/calendar"),
      })
    );

    expect(result).toMatchObject({
      events: [
        {
          id: "reservation-1",
          title: "Microscope - Lab setup - Taylor",
          extendedProps: {
            isIoioReservation: true,
            url: "/calendar/new-reservation?bookingId=reservation-1",
          },
        },
      ],
    });
  });
});
