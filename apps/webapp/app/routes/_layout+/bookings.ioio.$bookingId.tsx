import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { data, useLoaderData } from "react-router";
import { getLoanAssetDisplayName } from "~/components/booking/loan-presentation";
import { PageBackLink } from "~/components/shared/page-back-link";
import { db } from "~/database/db.server";
import { getIoioKitDisplayName } from "~/modules/kit/ioio-kit-presentation";
import { makeShelfError } from "~/utils/error";
import { error } from "~/utils/http.server";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

export async function loader({ context, request, params }: LoaderFunctionArgs) {
  const { userId } = context.getSession();
  try {
    const { organizationId } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.booking,
      action: PermissionAction.read,
    });
    const booking = await db.booking.findFirst({
      where: { id: params.bookingId, organizationId },
      select: {
        id: true,
        name: true,
        status: true,
        from: true,
        to: true,
        custodianUser: {
          select: {
            email: true,
            firstName: true,
            lastName: true,
            displayName: true,
          },
        },
        custodianTeamMember: {
          select: {
            name: true,
            user: {
              select: {
                email: true,
                firstName: true,
                lastName: true,
                displayName: true,
              },
            },
          },
        },
        bookingAssets: {
          select: {
            id: true,
            quantity: true,
            sourceKitId: true,
            asset: { select: { title: true, type: true, sequentialId: true } },
          },
        },
      },
    });
    if (!booking) {
      throw new Error("Loan not found");
    }
    const kitIds = booking.bookingAssets
      .map(({ sourceKitId }) => sourceKitId)
      .filter((id): id is string => Boolean(id));
    const kits = kitIds.length
      ? await db.kit.findMany({
          where: { organizationId, id: { in: kitIds } },
          select: { id: true, name: true },
        })
      : [];
    const kitNames = new Map(
      kits.map((kit) => [kit.id, getIoioKitDisplayName(kit)])
    );
    return data({
      booking: {
        ...booking,
        bookingAssets: booking.bookingAssets.map((item) => ({
          ...item,
          displayName: getLoanAssetDisplayName({
            title: item.asset.title,
            type: item.asset.type,
            sequentialId: item.asset.sequentialId,
            logicalProductName: item.sourceKitId
              ? kitNames.get(item.sourceKitId)
              : null,
          }),
        })),
      },
    });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    throw data(error(reason), { status: reason.status });
  }
}

export const meta: MetaFunction<typeof loader> = ({ data: routeData }) => [
  { title: routeData ? `Loan: ${routeData.booking.name}` : "Loan" },
];

function formatDate(value: Date | null) {
  return value
    ? new Intl.DateTimeFormat("en-US", {
        dateStyle: "medium",
      }).format(new Date(value))
    : "Not recorded";
}

export default function IoioStaffLoanDetail() {
  const { booking } = useLoaderData<typeof loader>();
  const itemNames = Array.from(
    new Set(booking.bookingAssets.map((item) => item.displayName))
  );
  const displayTitle = itemNames.length ? itemNames.join(" + ") : "Loan";
  const borrower = booking.custodianUser ?? booking.custodianTeamMember?.user;
  const borrowerName = borrower
    ? [borrower.displayName, borrower.firstName, borrower.lastName].find(
        (value) => value?.trim()
      ) ?? "Borrower"
    : booking.custodianTeamMember?.name ?? "Not assigned";

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <PageBackLink to="/bookings">Back to Loans</PageBackLink>
      <div>
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-gray-500">
          Loan
        </p>
        <h1 className="mt-1 text-2xl font-black text-gray-950">
          {displayTitle}
        </h1>
      </div>
      <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
        <dl className="grid gap-4 sm:grid-cols-2">
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-gray-500">
              Borrower
            </dt>
            <dd className="mt-1 font-semibold text-gray-950">{borrowerName}</dd>
            {borrower?.email ? (
              <dd className="text-sm text-gray-600">{borrower.email}</dd>
            ) : null}
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-gray-500">
              Status
            </dt>
            <dd className="mt-1 font-semibold text-gray-950">
              {booking.status.replaceAll("_", " ")}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-gray-500">
              Borrowed
            </dt>
            <dd className="mt-1 text-gray-950">{formatDate(booking.from)}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-gray-500">
              Due
            </dt>
            <dd className="mt-1 text-gray-950">{formatDate(booking.to)}</dd>
          </div>
        </dl>
      </section>
      <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
        <h2 className="font-bold text-gray-950">Items</h2>
        <ul className="mt-3 space-y-2 text-sm text-gray-800">
          {booking.bookingAssets.map((item) => (
            <li
              key={item.id}
              className="flex justify-between gap-4 border-b border-gray-100 pb-2 last:border-0"
            >
              <span>{item.displayName}</span>
              <span className="font-semibold">x{item.quantity}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
