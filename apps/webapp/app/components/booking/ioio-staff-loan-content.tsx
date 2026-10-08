import { useEffect, useState } from "react";
import type { Prisma } from "@prisma/client";
import { ArrowUpRight, Mail, MoreHorizontal } from "lucide-react";
import { Link, useFetcher } from "react-router";
import { Dialog, DialogPortal } from "~/components/layout/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/shared/dropdown";
import { useDateFormatter } from "~/hooks/use-date-formatter";
import { withReturnTo } from "~/modules/booking/return-review-navigation";
import { BADGE_COLORS } from "~/utils/badge-colors";
import {
  canAssignModelUnits,
  countUnassignedModelUnits,
} from "~/utils/booking-model-requests";
import { resolveUserDisplayName } from "~/utils/user";
import { AvailabilityBadge } from "./availability-label";
import { BookingAssetsSidebar } from "./booking-assets-sidebar";
import {
  getLoanAssetDisplayName,
  getLoanLifecycle,
  getLoanListDateValue,
  type LoanLifecycle,
  type LoanLifecycleAsset,
} from "./loan-presentation";
import { UnassignedModelUnitsPill } from "./unassigned-model-units-pill";
import { AssetImage } from "../assets/asset-image";
import { Badge } from "../shared/badge";
import { Button } from "../shared/button";
import { DateS } from "../shared/date";
import { UserBadge } from "../shared/user-badge";
import { Td } from "../table";
import { TeamMemberBadge } from "../user/team-member-badge";

export type ListBookingsContentProps = {
  item: Prisma.BookingGetPayload<{
    include: {
      creator: {
        select: {
          id: true;
          firstName: true;
          lastName: true;
          displayName: true;
          profilePicture: true;
        };
      };
      custodianUser: true;
      custodianTeamMember: { include: { user: true } };
      tags: { select: { id: true; name: true; color: true } };
      modelRequests: {
        include: {
          assetModel: {
            select: { id: true; name: true };
          };
        };
      };
    };
  }> & {
    _count: { bookingAssets: number };
    bookingAssets?: LoanLifecycleAsset[];
    consumptionLogs?: Array<{
      category: string;
      quantity: number;
      createdAt: Date;
    }>;
    hasStockConflict?: boolean;
    hasUnavailableAssets?: boolean;
    hasPendingIoioReturn?: boolean;
    pendingIoioReturnOperationId?: string;
    readyForPickup?: Array<{ unit: string; location: string | null }>;
    borrowerRole?: "Staff" | "Student" | null;
  };
  ioioStaff?: boolean;
  compactStaffLoans?: boolean;
};

/** Shared desktop grid for the Staff Loans header and body rows. */
export const STAFF_LOAN_COLUMNS = {
  item: "w-[30%]",
  borrower: "w-[24%]",
  status: "w-[14%]",
  period: "w-[22%]",
  actions: "w-[10%]",
} as const;

/** Keep the horizontal rhythm identical in every Staff Loans cell. */
export const STAFF_LOAN_CELL_CLASS = "p-3 md:px-3";

function StockConflictPill() {
  return (
    <span
      role="img"
      aria-label="Stock conflict: one or more quantity-tracked assets are over-reserved for these dates. Open the loan to resolve."
      className="cursor-help"
      title="One or more quantity-tracked assets are over-reserved for these dates. Open the loan to resolve."
    >
      <Badge
        color={BADGE_COLORS.amber.bg}
        textColor={BADGE_COLORS.amber.text}
        withDot={false}
      >
        Stock conflict
      </Badge>
    </span>
  );
}

function LoanStatusBadge({ label }: { label: LoanStatusLabel }) {
  const colors =
    label === "Returned"
      ? BADGE_COLORS.green
      : label === "Overdue"
      ? BADGE_COLORS.red
      : label === "Partially returned"
      ? BADGE_COLORS.amber
      : label === "Needs check" || label === "Waiting for staff check"
      ? BADGE_COLORS.amber
      : BADGE_COLORS.blue;

  return (
    <Badge color={colors.bg} textColor={colors.text} withDot={false}>
      {label}
    </Badge>
  );
}

type LoanStatusLabel =
  | "Active"
  | "Partially returned"
  | "Returned"
  | "Overdue"
  | "Needs check"
  | "Waiting for staff check"
  | "Ready for pickup";

function getLoanDisplayName(name: string) {
  return (
    name
      .replace(/^(?:IOIO\s+)?(?:borrow|booking|loan)\s*(?:-|:|\u2014)\s*/iu, "")
      .trim() || name
  );
}

function getCanonicalLoanAssets(item: ListBookingsContentProps["item"]) {
  return (item.bookingAssets ?? [])
    .map((bookingAsset) => bookingAsset.asset)
    .filter((asset): asset is NonNullable<typeof asset> => Boolean(asset));
}

function getCanonicalLoanName(item: ListBookingsContentProps["item"]) {
  const names = Array.from(
    new Set(getCanonicalLoanAssets(item).map(getLoanAssetDisplayName))
  );

  if (names.length === 1) return names[0];
  if (names.length > 1) return `${names[0]} + ${names.length - 1} more`;
  return getLoanDisplayName(item.name);
}

function getLoanQuantity(item: ListBookingsContentProps["item"]) {
  const bookingAssets = item.bookingAssets ?? [];
  if (bookingAssets.length === 0) return item._count.bookingAssets;

  return bookingAssets.reduce(
    (total, bookingAsset) => total + (bookingAsset.quantity ?? 1),
    0
  );
}

function LoanThumbnail({
  bookingAssets,
  name,
}: {
  bookingAssets?: LoanLifecycleAsset[];
  name: string;
}) {
  const asset = bookingAssets
    ?.map((bookingAsset) => bookingAsset.asset)
    .find(Boolean);

  return asset ? (
    <div className="size-10 shrink-0 overflow-hidden rounded-lg border border-gray-200 bg-gray-100">
      <AssetImage
        asset={{
          id: asset.id,
          mainImage: asset.mainImage,
          thumbnailImage: asset.thumbnailImage,
          assetModel: asset.assetModel ?? null,
        }}
        alt={name}
        className="size-full object-cover"
      />
    </div>
  ) : null;
}

function LoanDate({
  date,
  planned = false,
}: {
  date: Date | string;
  planned?: boolean;
}) {
  const { prefs } = useDateFormatter();
  const dateValue = getLoanListDateValue(date, planned);
  if (!dateValue) return null;

  const timeZone = planned ? "UTC" : prefs.timeZone;
  const year = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
  }).format(new Date(dateValue));
  const currentYear = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
  }).format(new Date());

  return (
    <DateS
      date={dateValue}
      options={{
        month: "short",
        day: "numeric",
        ...(year !== currentYear ? { year: "numeric" } : {}),
      }}
    />
  );
}

function DateCell({
  date,
  planned = false,
  emptyLabel = "Not recorded",
}: {
  date: Date | string | null;
  planned?: boolean;
  emptyLabel?: string;
}) {
  return date ? (
    <LoanDate date={date} planned={planned} />
  ) : (
    <span className="text-sm text-gray-400">{emptyLabel}</span>
  );
}

function getDaysOverdue(date: Date | string | null) {
  const dateValue = getLoanListDateValue(date, true);
  if (!dateValue) return 0;

  const dateString =
    typeof dateValue === "string" ? dateValue : dateValue.toISOString();
  const [year, month, day] = dateString.slice(0, 10).split("-").map(Number);
  const dueDate = Date.UTC(year, month - 1, day);
  const today = new Date();
  const todayDate = Date.UTC(
    today.getFullYear(),
    today.getMonth(),
    today.getDate()
  );

  return Math.max(0, Math.floor((todayDate - dueDate) / 86_400_000));
}

function LoanPeriodCell({
  lifecycle,
  statusLabel,
}: {
  lifecycle: LoanLifecycle;
  statusLabel: LoanStatusLabel;
}) {
  const isReturned =
    statusLabel === "Returned" ||
    statusLabel === "Partially returned" ||
    statusLabel === "Waiting for staff check";
  const overdueDays =
    statusLabel === "Overdue" ? getDaysOverdue(lifecycle.dueAt) : 0;

  return (
    <div className="flex min-w-0 flex-col gap-0.5 text-xs leading-4 text-gray-700">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-1">
        <span className="font-semibold text-gray-500">Borrowed</span>
        <DateCell date={lifecycle.borrowedAt} />
      </div>
      {isReturned && lifecycle.returnedAt ? (
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-1">
          <span className="font-semibold text-gray-500">Returned</span>
          <DateCell date={lifecycle.returnedAt} />
        </div>
      ) : lifecycle.dueAt ? (
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-1">
          <span className="font-semibold text-gray-500">Due</span>
          <DateCell date={lifecycle.dueAt} planned />
        </div>
      ) : null}
      {statusLabel === "Waiting for staff check" ? (
        <span className="text-amber-700">Waiting for staff check</span>
      ) : null}
      {overdueDays > 0 ? (
        <span className="text-red-700">
          {overdueDays} day{overdueDays === 1 ? "" : "s"} overdue
        </span>
      ) : null}
    </div>
  );
}

function BorrowerCell({
  custodianTeamMember,
  custodianUser,
  borrowerRole,
  showRole = true,
}: {
  custodianTeamMember: ListBookingsContentProps["item"]["custodianTeamMember"];
  custodianUser: ListBookingsContentProps["item"]["custodianUser"];
  borrowerRole: ListBookingsContentProps["item"]["borrowerRole"];
  showRole?: boolean;
}) {
  if (!custodianTeamMember && !custodianUser) {
    return <span className="text-sm text-gray-400">Not assigned</span>;
  }

  return (
    <div className="min-w-0">
      <TeamMemberBadge
        teamMember={{
          name:
            custodianTeamMember?.name ?? resolveUserDisplayName(custodianUser),
          user: custodianUser ?? null,
        }}
      />
      {showRole && borrowerRole ? (
        <span className="mt-1 block text-xs font-semibold text-gray-500">
          {borrowerRole}
        </span>
      ) : null}
    </div>
  );
}

export default function ListBookingsContent({
  item,
  ioioStaff = false,
  compactStaffLoans = false,
}: ListBookingsContentProps) {
  const lifecycle = getLoanLifecycle(item);
  const statusLabel = item.hasPendingIoioReturn
    ? "Needs check"
    : lifecycle.statusLabel;
  const compactStatusLabel = item.hasPendingIoioReturn
    ? "Waiting for staff check"
    : item.readyForPickup?.length
    ? "Ready for pickup"
    : lifecycle.statusLabel;
  const displayName = ioioStaff ? getCanonicalLoanName(item) : item.name;
  const loanPath = ioioStaff
    ? `/bookings/ioio/${item.id}`
    : `/bookings/${item.id}`;

  if (compactStaffLoans) {
    return (
      <>
        <Td
          className={`${STAFF_LOAN_COLUMNS.item} ${STAFF_LOAN_CELL_CLASS} max-w-none whitespace-normal`}
        >
          <div className="flex min-w-0 items-start gap-3">
            <LoanThumbnail
              bookingAssets={item.bookingAssets}
              name={displayName}
            />
            <div className="min-w-0 flex-1">
              <Button
                to={loanPath}
                variant="link"
                className="block max-w-full p-0 font-medium text-gray-900 hover:text-red-800 md:line-clamp-2 md:break-words"
              >
                {displayName}
              </Button>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <BookingAssetsSidebar
                  booking={{
                    ...item,
                    name: displayName,
                    displayQuantity: getLoanQuantity(item),
                  }}
                />
                <UnassignedModelUnitsPill
                  count={countUnassignedModelUnits(item.modelRequests)}
                  canAssign={canAssignModelUnits(item.status)}
                />
                {item.hasStockConflict ? <StockConflictPill /> : null}
                {item.hasUnavailableAssets ? (
                  <AvailabilityBadge
                    badgeText="Includes unavailable assets"
                    tooltipTitle="Loan includes unavailable assets"
                    tooltipContent="One or more assets in this loan are unavailable for reservation."
                  />
                ) : null}
              </div>
            </div>
          </div>
        </Td>

        <Td
          className={`${STAFF_LOAN_COLUMNS.borrower} ${STAFF_LOAN_CELL_CLASS} max-w-none whitespace-normal`}
        >
          <div className="min-w-0 overflow-hidden [&>span]:max-w-full [&>span]:truncate">
            <BorrowerCell
              custodianTeamMember={item.custodianTeamMember}
              custodianUser={item.custodianUser}
              borrowerRole={item.borrowerRole}
              showRole={false}
            />
          </div>
        </Td>

        <Td
          className={`${STAFF_LOAN_COLUMNS.status} ${STAFF_LOAN_CELL_CLASS} max-w-none whitespace-normal`}
        >
          <LoanStatusBadge label={compactStatusLabel} />
          {item.readyForPickup?.length ? (
            <div className="mt-1 space-y-0.5 text-xs text-gray-600">
              {item.readyForPickup.map((ready, index) => (
                <p key={`${ready.unit}-${index}`}>
                  {ready.location ? `${ready.location} · ` : ""}Assigned{" "}
                  {ready.unit}
                </p>
              ))}
            </div>
          ) : null}
        </Td>

        <Td
          className={`${STAFF_LOAN_COLUMNS.period} ${STAFF_LOAN_CELL_CLASS} max-w-none whitespace-normal`}
        >
          <LoanPeriodCell
            lifecycle={lifecycle}
            statusLabel={compactStatusLabel}
          />
        </Td>

        <Td
          className={`${STAFF_LOAN_COLUMNS.actions} ${STAFF_LOAN_CELL_CLASS} max-w-none whitespace-nowrap text-center`}
        >
          <LoanActionButton item={item} ioioStaff={ioioStaff} />
        </Td>
      </>
    );
  }

  return (
    <>
      <Td className="w-1/5 max-w-none whitespace-normal p-3 md:px-3">
        <div className="min-w-0">
          <div className="min-w-0">
            <Button
              to={loanPath}
              variant="link"
              className="block max-w-full p-0 font-medium text-gray-900 hover:text-red-800 md:line-clamp-2 md:break-words"
            >
              {displayName}
            </Button>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <BookingAssetsSidebar booking={item} />
              <UnassignedModelUnitsPill
                count={countUnassignedModelUnits(item.modelRequests)}
                canAssign={canAssignModelUnits(item.status)}
              />
              {item.hasStockConflict ? <StockConflictPill /> : null}
              {item.hasUnavailableAssets ? (
                <AvailabilityBadge
                  badgeText="Includes unavailable assets"
                  tooltipTitle="Loan includes unavailable assets"
                  tooltipContent="One or more assets in this loan are unavailable for reservation."
                />
              ) : null}
            </div>
          </div>
          <div className="mt-1 hidden items-center gap-1 text-xs text-gray-500 md:flex lg:hidden">
            <span>Borrowed:</span>
            <DateCell date={lifecycle.borrowedAt} />
          </div>
        </div>
      </Td>

      <Td className="w-[14%] max-w-none whitespace-normal p-3 md:px-3">
        <div className="min-w-0 overflow-hidden [&>span]:max-w-full [&>span]:truncate">
          <BorrowerCell
            custodianTeamMember={item.custodianTeamMember}
            custodianUser={item.custodianUser}
            borrowerRole={item.borrowerRole}
          />
        </div>
        <p className="mt-1 hidden truncate text-xs text-gray-500 md:block lg:hidden">
          Created by {resolveUserDisplayName(item.creator)}
        </p>
      </Td>

      <Td className="w-[14%] max-w-none p-3 md:px-2">
        <LoanStatusBadge label={statusLabel} />
      </Td>

      <Td className="hidden w-[9%] max-w-none whitespace-nowrap p-3 text-xs md:px-2 lg:table-cell">
        <DateCell date={lifecycle.borrowedAt} />
      </Td>

      <Td className="w-[11%] max-w-none whitespace-nowrap p-3 text-xs md:px-2">
        <DateCell date={lifecycle.dueAt} planned />
      </Td>

      <Td className="w-[9%] max-w-none whitespace-nowrap p-3 text-xs md:px-2">
        <DateCell date={lifecycle.returnedAt} emptyLabel="Not returned" />
      </Td>

      <Td className="hidden w-[14%] max-w-none overflow-hidden p-3 md:px-2 lg:table-cell">
        <UserBadge user={item.creator} className="max-w-full truncate" />
      </Td>

      <Td className="w-[9%] max-w-none whitespace-nowrap p-3 text-right md:px-2">
        <LoanActionButton item={item} ioioStaff={ioioStaff} />
      </Td>
    </>
  );
}

function LoanActionButton({
  item,
  ioioStaff = false,
}: {
  item: ListBookingsContentProps["item"];
  ioioStaff?: boolean;
}) {
  if (ioioStaff) {
    return <IoioStaffLoanActions item={item} />;
  }

  if (item.hasPendingIoioReturn) {
    return (
      <Button
        to={
          item.pendingIoioReturnOperationId
            ? withReturnTo(
                `/bookings/return-check/${item.pendingIoioReturnOperationId}`,
                "/bookings"
              )
            : "/calendar/ioio-requests"
        }
        variant="secondary"
        aria-label={`Check return for ${item.name}`}
        className="whitespace-nowrap rounded-lg px-2 py-1.5 text-xs font-semibold text-red-800 hover:border-red-300"
      >
        Check return
      </Button>
    );
  }
  return (
    <Button
      to={`/bookings/${item.id}`}
      aria-label={`Open loan ${item.name}`}
      variant="secondary"
      tooltip="Open loan"
      className="size-8 rounded-lg p-1.5 text-gray-600 hover:text-red-800 focus:ring-red-300"
    >
      <ArrowUpRight className="size-4" aria-hidden="true" />
    </Button>
  );
}

type SendEmailResult = { ok: true } | { ok: false; error: string } | undefined;

function IoioStaffLoanActions({
  item,
}: {
  item: ListBookingsContentProps["item"];
}) {
  const [open, setOpen] = useState(false);
  const fetcher = useFetcher<SendEmailResult>();
  const borrower = item.custodianUser;
  const borrowerName = borrower
    ? resolveUserDisplayName(borrower)
    : item.custodianTeamMember?.name ?? "Borrower";
  const borrowerEmail =
    borrower?.email ?? item.custodianTeamMember?.user?.email ?? null;
  const [subject, setSubject] = useState(`Loan message: ${item.name}`);
  const [message, setMessage] = useState(
    `Hi,\n\nI am contacting you about your loan of ${item.name}.\n\nThanks,\nIOIO Lab`
  );

  useEffect(() => {
    if (fetcher.data?.ok) setOpen(false);
  }, [fetcher.data]);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`Actions for ${item.name}`}
            onClick={(event) => {
              event.stopPropagation();
            }}
            className="inline-flex size-8 items-center justify-center rounded-lg border border-gray-200 text-gray-600 hover:border-red-200 hover:text-red-800 focus:outline-none focus:ring-2 focus:ring-red-300"
          >
            <MoreHorizontal className="size-4" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          {item.hasPendingIoioReturn ? (
            <DropdownMenuItem asChild>
              <Link
                to={
                  item.pendingIoioReturnOperationId
                    ? withReturnTo(
                        `/bookings/return-check/${item.pendingIoioReturnOperationId}`,
                        "/bookings"
                      )
                    : "/calendar/ioio-requests"
                }
                className="flex w-full items-center gap-2"
              >
                Check return
              </Link>
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            disabled={!borrowerEmail}
            onSelect={() => setOpen(true)}
            className="flex items-center gap-2"
          >
            <Mail className="size-4 shrink-0" aria-hidden="true" />
            Send email
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <DialogPortal>
        <Dialog
          open={open}
          onClose={() => setOpen(false)}
          title="Send email"
          className="w-[min(32rem,calc(100vw-2rem))]"
        >
          <fetcher.Form
            method="post"
            action={`/api/bookings/${item.id}/send-email`}
            className="space-y-4 px-6 py-4"
          >
            <div className="rounded-lg bg-gray-50 p-3 text-sm">
              <p className="font-semibold text-gray-900">To</p>
              <p className="text-gray-700">{borrowerName}</p>
              <p className="text-gray-600">
                {borrowerEmail ?? "No email recorded"}
              </p>
            </div>
            <label className="block text-sm font-semibold text-gray-900">
              Subject
              <input
                name="subject"
                value={subject}
                onChange={(event) => setSubject(event.target.value)}
                required
                maxLength={200}
                className="mt-1.5 w-full rounded-lg border border-gray-300 px-3 py-2 font-normal outline-none focus:border-red-600 focus:ring-2 focus:ring-red-100"
              />
            </label>
            <label className="block text-sm font-semibold text-gray-900">
              Message
              <textarea
                name="message"
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                required
                maxLength={5000}
                rows={7}
                className="mt-1.5 w-full rounded-lg border border-gray-300 px-3 py-2 font-normal outline-none focus:border-red-600 focus:ring-2 focus:ring-red-100"
              />
            </label>
            {fetcher.data && !fetcher.data.ok ? (
              <div
                role="alert"
                className="rounded-lg bg-red-50 p-3 text-sm font-semibold text-red-800"
              >
                <p>{fetcher.data.error}</p>
                {fetcher.data.error.includes("Settings > Email") ? (
                  <Link
                    to="/settings/emails"
                    className="mt-2 inline-block underline underline-offset-2"
                  >
                    Open Email settings
                  </Link>
                ) : null}
              </div>
            ) : null}
            {fetcher.data?.ok ? (
              <p className="rounded-lg bg-green-50 p-3 text-sm font-semibold text-green-800">
                Email queued for delivery.
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-semibold text-gray-700 hover:border-gray-400"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={fetcher.state !== "idle" || !borrowerEmail}
                className="rounded-lg bg-red-700 px-3 py-2 text-sm font-semibold text-white hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {fetcher.state === "submitting" ? "Sending..." : "Send email"}
              </button>
            </div>
          </fetcher.Form>
        </Dialog>
      </DialogPortal>
    </>
  );
}

function MobileLoanDate({
  label,
  date,
  planned = false,
  emptyLabel,
}: {
  label: string;
  date: Date | string | null;
  planned?: boolean;
  emptyLabel?: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-semibold text-gray-500">{label}</dt>
      <dd className="mt-1 text-sm text-gray-900">
        <DateCell date={date} planned={planned} emptyLabel={emptyLabel} />
      </dd>
    </div>
  );
}

export function MobileListBookingsContent({
  item,
  ioioStaff = false,
  compactStaffLoans = false,
}: ListBookingsContentProps) {
  const lifecycle = getLoanLifecycle(item);
  const statusLabel = item.hasPendingIoioReturn
    ? "Needs check"
    : lifecycle.statusLabel;
  const compactStatusLabel = item.hasPendingIoioReturn
    ? "Waiting for staff check"
    : item.readyForPickup?.length
    ? "Ready for pickup"
    : lifecycle.statusLabel;
  const displayName = ioioStaff ? getCanonicalLoanName(item) : item.name;
  const loanPath = ioioStaff
    ? `/bookings/ioio/${item.id}`
    : `/bookings/${item.id}`;

  return (
    <article className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          {compactStaffLoans ? (
            <LoanThumbnail
              bookingAssets={item.bookingAssets}
              name={displayName}
            />
          ) : null}
          <div className="min-w-0 flex-1">
            <Button
              to={loanPath}
              variant="link"
              className="block max-w-full p-0 text-left font-semibold text-gray-950 hover:text-red-800"
            >
              {displayName}
            </Button>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <BookingAssetsSidebar
                booking={
                  compactStaffLoans
                    ? {
                        ...item,
                        name: displayName,
                        displayQuantity: getLoanQuantity(item),
                      }
                    : item
                }
              />
            </div>
            {item.hasStockConflict ? <StockConflictPill /> : null}
            {item.hasUnavailableAssets ? (
              <AvailabilityBadge
                badgeText="Includes unavailable assets"
                tooltipTitle="Loan includes unavailable assets"
                tooltipContent="One or more assets in this loan are unavailable for reservation."
              />
            ) : null}
          </div>
        </div>
        <LoanActionButton item={item} ioioStaff={ioioStaff} />
      </div>

      <div className="mt-4 flex items-center justify-between gap-3">
        <div className="min-w-0 overflow-hidden [&>span]:max-w-full [&>span]:truncate">
          <p className="text-xs font-semibold text-gray-500">Borrower</p>
          <BorrowerCell
            custodianTeamMember={item.custodianTeamMember}
            custodianUser={item.custodianUser}
            borrowerRole={item.borrowerRole}
            showRole={!compactStaffLoans}
          />
        </div>
        <LoanStatusBadge
          label={compactStaffLoans ? compactStatusLabel : statusLabel}
        />
      </div>
      {item.readyForPickup?.length ? (
        <div className="mt-2 space-y-0.5 text-xs text-gray-600">
          {item.readyForPickup.map((ready, index) => (
            <p key={`${ready.unit}-${index}`}>
              {ready.location ? `${ready.location} · ` : ""}Assigned{" "}
              {ready.unit}
            </p>
          ))}
        </div>
      ) : null}

      {compactStaffLoans ? (
        <div className="mt-4 border-t border-gray-100 pt-3">
          <LoanPeriodCell
            lifecycle={lifecycle}
            statusLabel={compactStatusLabel}
          />
        </div>
      ) : (
        <dl className="mt-4 grid grid-cols-3 gap-3 border-t border-gray-100 pt-3">
          <MobileLoanDate label="Borrowed" date={lifecycle.borrowedAt} />
          <MobileLoanDate label="Due" date={lifecycle.dueAt} planned />
          <MobileLoanDate
            label="Returned"
            date={lifecycle.returnedAt}
            emptyLabel="Not returned"
          />
        </dl>
      )}

      {compactStaffLoans ? null : (
        <div className="mt-3 flex items-center gap-2 border-t border-gray-100 pt-3 text-xs text-gray-500">
          <span className="font-semibold">Created by</span>
          <UserBadge user={item.creator} className="max-w-full truncate" />
        </div>
      )}
    </article>
  );
}
