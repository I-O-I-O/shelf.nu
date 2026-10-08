import type { ComponentProps, ReactNode } from "react";
import { BookingStatus } from "@prisma/client";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// why: the list row is tested outside the application router; anchors preserve destinations for assertions.
vi.mock("react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
  useFetcher: () => ({
    data: undefined,
    state: "idle",
    Form: ({ children, action }: { children: ReactNode; action: string }) => (
      <form action={action}>{children}</form>
    ),
  }),
}));
// why: use only the destination and visible label; the shared Button's styling is unrelated to row content.
vi.mock("../shared/button", () => ({
  Button: ({ children, to }: { children: ReactNode; to?: string }) => (
    <a href={to}>{children}</a>
  ),
}));
// why: Radix menus add portal and interaction behavior unrelated to loan-row presentation.
vi.mock("~/components/shared/dropdown", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuItem: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));
// why: asset thumbnails are not the behavior under test.
vi.mock("../assets/asset-image", () => ({
  AssetImage: () => <span aria-hidden="true" />,
}));
// why: the drawer has its own data-fetching UI; the row only needs to show its trigger.
vi.mock("./booking-assets-sidebar", () => ({
  BookingAssetsSidebar: () => <span>1 item</span>,
}));
// why: team member display formatting depends on current organization context.
vi.mock("../user/team-member-badge", () => ({
  TeamMemberBadge: ({ teamMember }: { teamMember: { name: string } }) => (
    <span>{teamMember.name}</span>
  ),
}));
// why: date formatting context is provided by the authenticated application shell.
vi.mock("~/hooks/use-date-formatter", () => ({
  useDateFormatter: () => ({ prefs: { timeZone: "UTC" } }),
}));
// why: date display is not under test; render the supplied value.
vi.mock("../shared/date", () => ({
  DateS: ({ date }: { date: Date | string }) => <span>{String(date)}</span>,
}));

import IoioStaffLoanContent from "./ioio-staff-loan-content";

type LoanItem = ComponentProps<typeof IoioStaffLoanContent>["item"];

function buildLoan(overrides: Partial<LoanItem> = {}): LoanItem {
  return {
    id: "loan-1",
    name: "IOIO loan - equipment request",
    status: BookingStatus.OVERDUE,
    from: new Date("2026-10-01T09:00:00Z"),
    to: new Date("2026-10-03T17:00:00Z"),
    originalTo: null,
    archivedWithoutCheckin: false,
    description: null,
    custodianUserId: "student-1",
    custodianUser: {
      id: "student-1",
      email: "student@example.org",
      firstName: "Ari",
      lastName: "Student",
      displayName: null,
      profilePicture: null,
    },
    custodianTeamMember: null,
    creator: {
      id: "staff-1",
      firstName: "TA",
      lastName: "Member",
      displayName: null,
      profilePicture: null,
    },
    tags: [],
    modelRequests: [],
    _count: { bookingAssets: 1 },
    bookingAssets: [
      {
        id: "booking-asset-1",
        checkedOutAt: new Date("2026-10-01T09:00:00Z"),
        checkedInAt: null,
        checkedOutQuantity: 1,
        quantity: 1,
        asset: {
          id: "asset-1",
          title: "Makey Kit #001",
          type: "INDIVIDUAL",
          mainImage: null,
          thumbnailImage: null,
          assetModel: null,
        },
      },
    ],
    consumptionLogs: [],
    hasStockConflict: false,
    hasUnavailableAssets: false,
    hasPendingIoioReturn: false,
    readyForPickup: [],
    pendingIoioReturnOperationId: undefined,
    borrowerRole: "Student",
    ...overrides,
  } as LoanItem;
}

describe("IOIO staff loan row", () => {
  it("shows an IOIO item name, friendly overdue status, borrower, and loan workflow link", () => {
    render(
      <table>
        <tbody>
          <tr>
            <IoioStaffLoanContent
              item={buildLoan()}
              ioioStaff
              compactStaffLoans
            />
          </tr>
        </tbody>
      </table>
    );

    expect(screen.getByText("Makey Kit #001")).toBeInTheDocument();
    expect(screen.getByText("Overdue")).toBeInTheDocument();
    expect(screen.getByText("Ari Student")).toBeInTheDocument();
    expect(screen.getByText("Borrowed")).toBeInTheDocument();
    expect(screen.getByText("Due")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Makey Kit #001" })
    ).toHaveAttribute("href", "/bookings/ioio/loan-1");
    expect(
      screen.getByRole("button", {
        name: "Actions for IOIO loan - equipment request",
      })
    ).toBeInTheDocument();
  });
});
