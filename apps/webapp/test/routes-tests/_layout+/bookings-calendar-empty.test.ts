import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLoaderArgs } from "@mocks/remix";

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  getBookingsFilterData: vi.fn(),
  getBookings: vi.fn(),
  resolveCustodianScope: vi.fn(),
  custodianScopeClause: vi.fn(),
  decorateBookingsForList: vi.fn(),
  getTeamMemberForCustodianFilter: vi.fn(),
  getTeamMemberForForm: vi.fn(),
  getTeamMembersForNotify: vi.fn(),
  getBookingsForCalendar: vi.fn(),
  getMemberCalendarFeedUrl: vi.fn(),
  getTagsForBookingTagsFilter: vi.fn(),
  findBookingTags: vi.fn(),
  findLoanDateYears: vi.fn(),
  findIoioOperations: vi.fn(),
  findBookingAssets: vi.fn(),
  findKits: vi.fn(),
  findAssets: vi.fn(),
  findBorrowerMemberships: vi.fn(),
}));

// why: the route loaders are exercised without a seeded organization or a
// database connection; each query returns the same empty result as a new org.
vi.mock("~/database/db.server", () => ({
  db: {
    tag: { findMany: mocks.findBookingTags },
    booking: { findMany: mocks.findLoanDateYears },
    ioioWriteOperation: { findMany: mocks.findIoioOperations },
    bookingAsset: { findMany: mocks.findBookingAssets },
    kit: { findMany: mocks.findKits },
    asset: { findMany: mocks.findAssets },
    userOrganization: { findMany: mocks.findBorrowerMemberships },
  },
}));
vi.mock("~/utils/roles.server", () => ({
  requirePermission: mocks.requirePermission,
}));
vi.mock("~/modules/booking/service.server", () => ({
  custodianScopeClause: mocks.custodianScopeClause,
  getBookingsFilterData: mocks.getBookingsFilterData,
  getBookings: mocks.getBookings,
  resolveCustodianScope: mocks.resolveCustodianScope,
  getBookingsForCalendar: mocks.getBookingsForCalendar,
}));
// why: no booking image URLs are asserted in this loader test; avoid storage configuration.
vi.mock("~/modules/asset/service.server", () => ({
  resolveAssetImagesForPresentation: vi.fn((assets) => Promise.resolve(assets)),
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
  mocks.custodianScopeClause.mockReturnValue({ custodianUserId: "user-1" });
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
  mocks.findLoanDateYears.mockResolvedValue([]);
  mocks.findIoioOperations.mockResolvedValue([]);
  mocks.findBookingAssets.mockResolvedValue([]);
  mocks.findKits.mockResolvedValue([]);
  mocks.findAssets.mockResolvedValue([]);
  mocks.findBorrowerMemberships.mockResolvedValue([]);
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
      expect.objectContaining({
        organizationId: organization.id,
        excludeBookingDescriptions: expect.any(Array),
      })
    );
    expect(mocks.getBookings.mock.calls.at(-1)?.[0]).not.toHaveProperty(
      "custodianScope"
    );
  });

  it("keeps My Loans scoped when filters and pagination are active", async () => {
    mocks.getBookingsFilterData.mockResolvedValueOnce({
      page: 3,
      perPage: 20,
      search: "camera",
      status: "OVERDUE",
      teamMemberIds: [],
      orderBy: "from",
      orderDirection: "desc",
      selfServiceData: null,
      searchParams: new URLSearchParams(
        "mine=1&s=camera&status=OVERDUE&page=3"
      ),
      cookie: {},
      filtersCookie: null,
      filters: null,
      redirectNeeded: false,
      tags: [],
    });

    await bookingsLoader(
      createLoaderArgs({
        context: { getSession: () => ({ userId: "user-1" }) },
        request: new Request(
          "http://localhost/bookings?mine=1&s=camera&status=OVERDUE&page=3"
        ),
      })
    );

    expect(mocks.getBookings).toHaveBeenCalledWith(
      expect.objectContaining({
        page: 3,
        search: "camera",
        statuses: ["OVERDUE"],
        custodianScope: {
          userId: "user-1",
          teamMemberIds: ["team-member-1"],
        },
      })
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
