import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AssetType, BookingStatus } from "@prisma/client";
import {
  data,
  Form,
  Link,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  type MetaFunction,
  useActionData,
  useFetcher,
  useLoaderData,
} from "react-router";
import { z } from "zod";
import { ReservationQuantityControl } from "~/components/ioio-staff/reservation-quantity-control";
import { groupStudentAssets } from "~/components/ioio-student/inventory-presentation";
import { IoioDateRangePicker } from "~/components/ioio-student/ioio-date-range-picker";
import { SectionHeading } from "~/components/ioio-student/student-ui";
import { db } from "~/database/db.server";
import {
  cancelBooking,
  createBooking,
  reserveBooking,
  updateBasicBooking,
  updateBookingAssets,
} from "~/modules/booking/service.server";
import { IOIO_STAFF_RESERVATION_DESCRIPTION } from "~/modules/ioio-student/availability.server";
import {
  dateOnlyToUtcEnd,
  dateOnlyToUtcStart,
} from "~/modules/ioio-student/date-range";
import { getStudentAssets } from "~/modules/ioio-student/service.server";
import {
  getIoioStaffReservationConflictSummary,
  requestIoioEarlierReturn,
  type IoioStaffLoanConflict,
} from "~/modules/ioio-student/staff-reservation-conflicts.server";
import { getClientHint } from "~/utils/client-hints";
import { makeShelfError } from "~/utils/error";
import { payload } from "~/utils/http.server";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";
import { resolveUserDisplayName } from "~/utils/user";

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  {
    title: data?.reservation ? "Edit IOIO reservation" : "New IOIO reservation",
  },
];

const reservationSchema = z.object({
  name: z.string().trim().min(1).max(200),
  assetId: z.string().min(1),
  candidateAssetIds: z.string().optional(),
  quantity: z.coerce.number().int().min(1).max(1000),
  startDate: z.string().date(),
  returnDate: z.string().date(),
});

const availabilitySchema = reservationSchema.pick({
  assetId: true,
  candidateAssetIds: true,
  quantity: true,
  startDate: true,
  returnDate: true,
});

const earlierReturnSchema = z.object({
  bookingId: z.string().min(1),
  bookingAssetId: z.string().min(1),
  reservationName: z.string().trim().min(1).max(200),
  reservationStartDate: z.string().date(),
  newReturnDate: z.string().date(),
});

type ReservationProduct = {
  id: string;
  title: string;
  type: AssetType;
  quantity: number;
  availableQuantity: number;
  candidateAssetIds: string[];
  isKit: boolean;
  searchText: string;
};

type StaffReservationSummary = Awaited<
  ReturnType<typeof getIoioStaffReservationConflictSummary>
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStaffLoanConflict(value: unknown): value is IoioStaffLoanConflict {
  return (
    isRecord(value) &&
    typeof value.bookingId === "string" &&
    typeof value.bookingAssetId === "string" &&
    typeof value.assetId === "string" &&
    typeof value.itemName === "string" &&
    typeof value.borrowerName === "string" &&
    typeof value.currentReturnDate === "string" &&
    (value.status === "ONGOING" || value.status === "OVERDUE") &&
    typeof value.quantity === "number"
  );
}

function isStaffReservationSummary(
  value: unknown
): value is StaffReservationSummary {
  if (!isRecord(value)) return false;

  const numericFields = [
    "total",
    "available",
    "requested",
    "shortfall",
    "loanConflictQuantity",
    "staffReservedCount",
    "availableAfterSoftConflicts",
  ] as const;
  const stringArrayFields = [
    "staffReservationBookingIds",
    "availableUnitIdsAfterSoftConflicts",
    "loanBookingIds",
    "softConflictBookingIds",
  ] as const;

  return (
    numericFields.every((field) => typeof value[field] === "number") &&
    Array.isArray(value.conflicts) &&
    value.conflicts.every(isStaffLoanConflict) &&
    stringArrayFields.every(
      (field) =>
        Array.isArray(value[field]) &&
        value[field].every((item) => typeof item === "string")
    )
  );
}

type ExistingIoioReservation = {
  id: string;
  name: string;
  description: string | null;
  status: BookingStatus;
  from: Date | null;
  to: Date | null;
  custodianUserId: string | null;
  custodianTeamMemberId: string | null;
  creator: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    displayName: string | null;
  };
  bookingAssets: Array<{
    assetId: string;
    quantity: number;
  }>;
};

async function getExistingIoioReservation({
  bookingId,
  organizationId,
}: {
  bookingId: string;
  organizationId: string;
}): Promise<ExistingIoioReservation | null> {
  return db.booking.findFirst({
    where: {
      id: bookingId,
      organizationId,
      description: IOIO_STAFF_RESERVATION_DESCRIPTION,
    },
    select: {
      id: true,
      name: true,
      description: true,
      status: true,
      from: true,
      to: true,
      custodianUserId: true,
      custodianTeamMemberId: true,
      creator: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          displayName: true,
        },
      },
      bookingAssets: {
        select: {
          assetId: true,
          quantity: true,
        },
      },
    },
  });
}

async function requireStaffBookingAccess({
  context,
  request,
}: Pick<LoaderFunctionArgs, "context" | "request">) {
  const { userId } = context.getSession();
  const permission = await requirePermission({
    userId,
    request,
    entity: PermissionEntity.booking,
    action: PermissionAction.create,
  });
  if (permission.role !== "ADMIN" && permission.role !== "OWNER") {
    throw new Response("Staff access required", { status: 403 });
  }
  return { ...permission, userId };
}

export async function loader({ context, request }: LoaderFunctionArgs) {
  const auth = await requireStaffBookingAccess({ context, request });
  const bookingId = new URL(request.url).searchParams.get("bookingId");
  const reservation = bookingId
    ? await getExistingIoioReservation({
        bookingId,
        organizationId: auth.organizationId,
      })
    : null;
  if (bookingId && !reservation) {
    throw new Response("Reservation not found", { status: 404 });
  }
  const sourceAssets = await getStudentAssets({
    organizationId: auth.organizationId,
  });
  const sourceAssetsById = new Map(
    sourceAssets.map((asset) => [asset.id, asset])
  );
  const assets = groupStudentAssets(sourceAssets);
  const products: ReservationProduct[] = assets.map((asset) => {
    const units = asset.sourceAssetIds.flatMap((id) => {
      const source = sourceAssetsById.get(id);
      return source ? [source] : [];
    });
    return {
      id: asset.id,
      title: asset.title,
      type: asset.type,
      quantity: asset.quantity ?? 0,
      availableQuantity: asset.availableQuantity ?? 0,
      candidateAssetIds: asset.sourceAssetIds,
      isKit: asset.kits.length > 0,
      searchText: [
        asset.title,
        ...asset.kits.map((kit) => kit.name),
        ...units.flatMap((unit) => [
          unit.title,
          unit.sequentialId,
          ...unit.qrIds,
        ]),
        ...asset.sourceAssetIds,
      ]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase(),
    };
  });
  const reservationAssetIds = new Set(
    reservation?.bookingAssets.map((asset) => asset.assetId) ?? []
  );
  const selectedProduct = reservation
    ? products.find((product) =>
        product.candidateAssetIds.some((id) => reservationAssetIds.has(id))
      )
    : undefined;

  return data(
    payload({
      products,
      reservation: reservation
        ? {
            id: reservation.id,
            name: reservation.name,
            status: reservation.status,
            from: reservation.from,
            to: reservation.to,
            selectedProductId: selectedProduct?.id ?? "",
            quantity: reservation.bookingAssets.reduce(
              (total, asset) => total + asset.quantity,
              0
            ),
            creatorName:
              resolveUserDisplayName(reservation.creator) || "Staff member",
          }
        : null,
    })
  );
}

export async function action({ context, request }: ActionFunctionArgs) {
  try {
    const auth = await requireStaffBookingAccess({ context, request });
    const form = Object.fromEntries(await request.formData());
    const intent = typeof form.intent === "string" ? form.intent : "create";

    if (intent === "cancel-reservation") {
      const bookingId = z.string().min(1).parse(form.bookingId);
      const reservation = await getExistingIoioReservation({
        bookingId,
        organizationId: auth.organizationId,
      });
      if (!reservation) throw new Error("Reservation not found.");

      await cancelBooking({
        id: reservation.id,
        organizationId: auth.organizationId,
        hints: getClientHint(request),
        userId: auth.userId,
      });
      return data({ ok: true as const, intent: "cancel-reservation" as const });
    }

    if (intent === "edit") {
      const parsed = reservationSchema
        .extend({ bookingId: z.string().min(1) })
        .parse(form);
      const reservation = await getExistingIoioReservation({
        bookingId: parsed.bookingId,
        organizationId: auth.organizationId,
      });
      if (!reservation) throw new Error("Reservation not found.");

      // Keep edits on Shelf's native booking service. The IOIO reservation
      // marker is preserved so Calendar visibility remains unchanged.
      await updateBasicBooking({
        id: reservation.id,
        organizationId: auth.organizationId,
        name: parsed.name,
        description: IOIO_STAFF_RESERVATION_DESCRIPTION,
        from: dateOnlyToUtcStart(parsed.startDate),
        to: dateOnlyToUtcEnd(parsed.returnDate),
        custodianUserId: reservation.custodianUserId ?? undefined,
        custodianTeamMemberId: reservation.custodianTeamMemberId ?? undefined,
        tags: [],
        userId: auth.userId,
        hints: getClientHint(request),
      });

      return data({
        ok: true as const,
        intent: "edit" as const,
        bookingId: reservation.id,
      });
    }

    if (intent === "request-earlier-return") {
      const parsed = earlierReturnSchema.parse(form);
      const reservationStart = dateOnlyToUtcStart(parsed.reservationStartDate);
      const newReturnDate = dateOnlyToUtcEnd(parsed.newReturnDate);
      const result = await requestIoioEarlierReturn({
        organizationId: auth.organizationId,
        bookingId: parsed.bookingId,
        bookingAssetId: parsed.bookingAssetId,
        reservationName: parsed.reservationName,
        reservationStart,
        newReturnDate,
      });
      return data({
        ok: true as const,
        intent: "request-earlier-return" as const,
        ...result,
      });
    }

    if (intent === "availability") {
      const parsed = availabilitySchema.parse(form);
      const from = dateOnlyToUtcStart(parsed.startDate);
      const to = dateOnlyToUtcEnd(parsed.returnDate);
      if (from <= new Date()) {
        throw new Error("Choose a future reservation start date.");
      }
      if (to <= from) {
        throw new Error("The end date must be after the start date.");
      }
      const candidateAssetIds = parsed.candidateAssetIds
        ?.split(",")
        .filter(Boolean);
      const summary = await getIoioStaffReservationConflictSummary({
        organizationId: auth.organizationId,
        productId: parsed.assetId,
        candidateAssetIds,
        quantity: parsed.quantity,
        from,
        to,
      });
      return data({
        ok: true as const,
        intent: "availability" as const,
        availability: summary,
      });
    }

    const parsed = reservationSchema
      .extend({
        createAnyway: z.union([z.literal("true"), z.literal("on")]).optional(),
      })
      .parse(form);
    const from = dateOnlyToUtcStart(parsed.startDate);
    const to = dateOnlyToUtcEnd(parsed.returnDate);
    if (from <= new Date()) {
      throw new Error("Choose a future reservation start date.");
    }
    if (to <= from) {
      throw new Error("The end date must be after the start date.");
    }
    const candidateAssetIds = parsed.candidateAssetIds
      ?.split(",")
      .filter(Boolean);
    const summary = await getIoioStaffReservationConflictSummary({
      organizationId: auth.organizationId,
      productId: parsed.assetId,
      candidateAssetIds,
      quantity: parsed.quantity,
      from,
      to,
    });

    const createAnyway =
      parsed.createAnyway === "true" || parsed.createAnyway === "on";
    if (parsed.quantity > summary.available) {
      if (
        !createAnyway ||
        parsed.quantity > summary.availableAfterSoftConflicts
      ) {
        return data(
          {
            ok: false as const,
            intent: "create" as const,
            error:
              `Only ${summary.available} of ${summary.total} units are available for the full reservation period. ` +
              `Requested: ${parsed.quantity}. Short by: ${summary.shortfall}.`,
            availability: summary,
            canCreateAnyway: summary.staffReservationBookingIds.length > 0,
          },
          { status: 409 }
        );
      }
    }
    const teamMember = await db.teamMember.findFirst({
      where: {
        organizationId: auth.organizationId,
        userId: auth.userId,
        deletedAt: null,
      },
      select: { id: true },
    });
    if (!teamMember)
      throw new Error("Your staff account has no team-member mapping.");

    const assetIds =
      summary.availableUnitIdsAfterSoftConflicts.length > 0
        ? summary.availableUnitIdsAfterSoftConflicts.slice(0, parsed.quantity)
        : [parsed.assetId];
    const booking = await createBooking({
      booking: {
        name: parsed.name,
        description: IOIO_STAFF_RESERVATION_DESCRIPTION,
        creatorId: auth.userId,
        custodianUserId: auth.userId,
        custodianTeamMemberId: teamMember.id,
        organizationId: auth.organizationId,
        from,
        to,
        tags: [],
      },
      assetIds,
      hints: getClientHint(request),
    });
    if (summary.availableUnitIdsAfterSoftConflicts.length === 0) {
      await updateBookingAssets({
        id: booking.id,
        organizationId: auth.organizationId,
        assetIds: [parsed.assetId],
        quantities: { [parsed.assetId]: parsed.quantity },
        userId: auth.userId,
      });
    }
    await reserveBooking({
      id: booking.id,
      organizationId: auth.organizationId,
      name: parsed.name,
      from,
      to,
      custodianUserId: auth.userId,
      custodianTeamMemberId: teamMember.id,
      description: IOIO_STAFF_RESERVATION_DESCRIPTION,
      hints: getClientHint(request),
      isSelfServiceOrBase: false,
      tags: [],
      userId: auth.userId,
      ignoreBookingIds: createAnyway ? summary.softConflictBookingIds : [],
    });
    return data({
      ok: true as const,
      intent: "create" as const,
      bookingId: booking.id,
    });
  } catch (cause) {
    // Keep authorization failures as HTTP 403 responses instead of converting
    // them to generic 500 action data.
    if (cause instanceof Response) throw cause;
    const reason = makeShelfError(cause);
    return data(
      { ok: false as const, error: reason.message },
      { status: reason.status }
    );
  }
}

function localDateWire(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(
    2,
    "0"
  )}-${String(date.getDate()).padStart(2, "0")}`;
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function formatConflictDate(value: string) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(value));
}

function dateInputValue(value: Date | null) {
  return value ? value.toISOString().slice(0, 10) : "";
}

export default function NewIoioReservation() {
  const { products, reservation } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const availabilityFetcher = useFetcher<typeof action>();
  const availabilityFetcherRef = useRef(availabilityFetcher);
  availabilityFetcherRef.current = availabilityFetcher;
  const submitAvailability = useCallback((formData: FormData) => {
    void availabilityFetcherRef.current.submit(formData, { method: "post" });
  }, []);
  const tomorrow = addDays(new Date(), 1);
  const nextWeek = addDays(tomorrow, 7);
  const isEdit = reservation !== null;
  const [selectedId, setSelectedId] = useState(
    reservation?.selectedProductId || products[0]?.id || ""
  );
  const [reservationName, setReservationName] = useState(
    reservation?.name ?? ""
  );
  const [startDate, setStartDate] = useState(
    reservation ? dateInputValue(reservation.from) : localDateWire(tomorrow)
  );
  const [returnDate, setReturnDate] = useState(
    reservation ? dateInputValue(reservation.to) : localDateWire(nextWeek)
  );
  const [quantityInput, setQuantityInput] = useState(
    String(reservation?.quantity ?? 1)
  );
  const quantity = Number(quantityInput);
  const quantityIsValid =
    Number.isInteger(quantity) && quantity >= 1 && quantity <= 1000;
  const [productSearch, setProductSearch] = useState("");
  const [productKind, setProductKind] = useState<"all" | "kits" | "equipment">(
    "all"
  );
  const [selectedConflict, setSelectedConflict] =
    useState<IoioStaffLoanConflict | null>(null);
  const [newReturnDate, setNewReturnDate] = useState("");
  const selected = products.find((product) => product.id === selectedId);
  const candidateAssetIds = selected?.candidateAssetIds.join(",") ?? "";
  const matchingProducts = useMemo(() => {
    const query = productSearch.trim().toLocaleLowerCase();
    return products.filter((product) => {
      if (productKind === "kits" && !product.isKit) return false;
      if (productKind === "equipment" && product.isKit) return false;
      return !query || product.searchText.includes(query);
    });
  }, [productKind, productSearch, products]);
  const liveAvailability =
    quantityIsValid &&
    availabilityFetcher.data?.ok &&
    availabilityFetcher.data.intent === "availability"
      ? availabilityFetcher.data.availability
      : null;
  const earlierReturnSucceeded =
    result?.ok === true &&
    "intent" in result &&
    result.intent === "request-earlier-return";
  const earlierReturnBookingAssetId =
    result && "bookingAssetId" in result ? result.bookingAssetId : null;
  const createConflictAvailability: StaffReservationSummary | null =
    result &&
    !result.ok &&
    "intent" in result &&
    result.intent === "create" &&
    "canCreateAnyway" in result &&
    result.canCreateAnyway &&
    "availability" in result &&
    isStaffReservationSummary(result.availability)
      ? result.availability
      : null;

  useEffect(() => {
    setSelectedId(reservation?.selectedProductId || products[0]?.id || "");
    setReservationName(reservation?.name ?? "");
    setStartDate(
      reservation ? dateInputValue(reservation.from) : localDateWire(tomorrow)
    );
    setReturnDate(
      reservation ? dateInputValue(reservation.to) : localDateWire(nextWeek)
    );
    setQuantityInput(String(reservation?.quantity ?? 1));
    // The reservation identity is the intentional sync boundary. Revalidation
    // of the same route must not overwrite values the staff member is editing.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only reset when the loaded reservation changes
  }, [reservation?.id]);

  useEffect(() => {
    if (matchingProducts.some((product) => product.id === selectedId)) return;
    setSelectedId(matchingProducts[0]?.id ?? "");
  }, [matchingProducts, selectedId]);

  useEffect(() => {
    if (!selectedId || !startDate || !returnDate || !quantityIsValid) return;
    setSelectedConflict(null);
    const timeout = window.setTimeout(() => {
      const formData = new FormData();
      formData.set("intent", "availability");
      formData.set("assetId", selectedId);
      formData.set("candidateAssetIds", candidateAssetIds);
      formData.set("quantity", String(quantity));
      formData.set("startDate", startDate);
      formData.set("returnDate", returnDate);
      submitAvailability(formData);
    }, 180);
    return () => window.clearTimeout(timeout);
  }, [
    candidateAssetIds,
    quantity,
    quantityIsValid,
    returnDate,
    selectedId,
    startDate,
    submitAvailability,
  ]);

  useEffect(() => {
    if (earlierReturnSucceeded && earlierReturnBookingAssetId && selectedId) {
      const formData = new FormData();
      formData.set("intent", "availability");
      formData.set("assetId", selectedId);
      formData.set("candidateAssetIds", candidateAssetIds);
      formData.set("quantity", String(quantity));
      formData.set("startDate", startDate);
      formData.set("returnDate", returnDate);
      submitAvailability(formData);
      setSelectedConflict(null);
    }
  }, [
    candidateAssetIds,
    quantity,
    earlierReturnBookingAssetId,
    earlierReturnSucceeded,
    returnDate,
    selectedId,
    startDate,
    submitAvailability,
  ]);

  function openEarlierReturn(conflict: IoioStaffLoanConflict) {
    setSelectedConflict(conflict);
    setNewReturnDate(localDateWire(addDays(new Date(startDate), -1)));
  }

  return (
    <div className="mx-auto max-w-3xl">
      <SectionHeading
        title={isEdit ? "Edit reservation" : "New reservation"}
        text={
          isEdit
            ? "Update this class, workshop, or other lab reservation."
            : "Reserve equipment for a class, workshop, or other lab activity."
        }
      />
      <p className="mb-4 text-sm text-gray-600">
        <Link
          to="/calendar/ioio-requests"
          className="font-semibold text-red-700 hover:underline"
        >
          Review pending IOIO requests
        </Link>
      </p>
      {reservation ? (
        <p className="mb-4 text-sm text-gray-600">
          Reserved by:{" "}
          <span className="font-semibold text-gray-800">
            {reservation.creatorName}
          </span>
        </p>
      ) : null}
      {result?.ok && "intent" in result && result.intent === "create" ? (
        <div className="mb-4 rounded-xl border border-green-200 bg-green-50 p-4 text-sm text-green-900">
          Reservation created and added to the Shelf calendar.
        </div>
      ) : null}
      {result?.ok && "intent" in result && result.intent === "edit" ? (
        <div className="mb-4 rounded-xl border border-green-200 bg-green-50 p-4 text-sm text-green-900">
          Reservation changes saved.
        </div>
      ) : null}
      {result?.ok &&
      "intent" in result &&
      result.intent === "cancel-reservation" ? (
        <div className="mb-4 rounded-xl border border-green-200 bg-green-50 p-4 text-sm text-green-900">
          Reservation cancelled.
        </div>
      ) : null}
      {earlierReturnSucceeded ? (
        <div className="mb-4 rounded-xl border border-green-200 bg-green-50 p-4 text-sm text-green-900">
          Return request sent for{" "}
          {result && "itemName" in result ? result.itemName : "the item"}. The
          loan due date was updated.
        </div>
      ) : null}
      {result && !result.ok ? (
        <p
          role="alert"
          className="mb-4 rounded-xl bg-red-50 p-3 text-sm font-semibold text-red-800"
        >
          {result.error}
        </p>
      ) : null}
      <Form
        method="post"
        className="space-y-5 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm"
      >
        {isEdit ? <input type="hidden" name="intent" value="edit" /> : null}
        {reservation ? (
          <input type="hidden" name="bookingId" value={reservation.id} />
        ) : null}
        <label className="block text-sm font-semibold text-gray-800">
          Reservation name
          <input
            name="name"
            required
            placeholder="Embedded systems workshop"
            value={reservationName}
            onChange={(event) => setReservationName(event.target.value)}
            className="mt-1 min-h-11 w-full rounded-xl border border-gray-300 px-3 font-normal"
          />
        </label>
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-sm font-semibold text-gray-800">
              Equipment
            </span>
            <div className="inline-flex rounded-lg border border-gray-200 bg-gray-50 p-1">
              {(
                [
                  ["all", "All"],
                  ["kits", "Kits"],
                  ["equipment", "Equipment"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={productKind === value}
                  onClick={() => setProductKind(value)}
                  className={`min-h-8 rounded-md px-3 text-sm font-semibold ${
                    productKind === value
                      ? "bg-white text-red-800 shadow-sm"
                      : "text-gray-600 hover:text-gray-900"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <label className="block text-sm font-semibold text-gray-800">
            <span className="sr-only">Search equipment</span>
            <input
              type="search"
              value={productSearch}
              onChange={(event) => setProductSearch(event.target.value)}
              placeholder="Search equipment..."
              autoComplete="off"
              className="min-h-10 w-full rounded-xl border border-gray-300 px-3 font-normal"
            />
          </label>
          <label className="block text-sm font-semibold text-gray-800">
            <select
              name="assetId"
              value={selectedId}
              onChange={(event) => setSelectedId(event.target.value)}
              required
              className="mt-1 min-h-11 w-full rounded-xl border border-gray-300 px-3 font-normal"
            >
              <option value="" disabled>
                {matchingProducts.length
                  ? "Select equipment"
                  : "No matching equipment"}
              </option>
              {matchingProducts.map((product) => (
                <option key={product.id} value={product.id}>
                  {product.isKit ? "Kit · " : "Equipment · "}
                  {product.title} ({product.availableQuantity} available)
                </option>
              ))}
            </select>
            <input
              type="hidden"
              name="candidateAssetIds"
              value={selected?.candidateAssetIds.join(",") ?? ""}
            />
          </label>
          {products.length === 0 ? (
            <p className="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-3 text-sm text-gray-600">
              No equipment is available to reserve yet. Add inventory first,
              then return here to plan a lab reservation.
            </p>
          ) : matchingProducts.length === 0 ? (
            <p className="text-sm text-gray-600">
              No equipment matches this search. Try another name or category.
            </p>
          ) : null}
        </div>
        <div className="max-w-xs">
          <label
            htmlFor="reservation-quantity"
            className="block text-sm font-semibold text-gray-800"
          >
            Quantity
          </label>
          <ReservationQuantityControl
            value={quantityInput}
            onChange={setQuantityInput}
          />
        </div>
        <IoioDateRangePicker
          startDate={startDate}
          returnDate={returnDate}
          minStartDate={tomorrow}
          startName="startDate"
          returnName="returnDate"
          onStartDateChange={(value) => {
            setStartDate(value);
            if (returnDate < value) setReturnDate(value);
          }}
          onReturnDateChange={setReturnDate}
          helperText="Availability is checked again before the reservation is saved."
        />
        <div
          aria-live="polite"
          className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm text-gray-700"
        >
          <p className="font-semibold text-gray-900">
            Reservation availability
          </p>
          {availabilityFetcher.state !== "idle" && !liveAvailability ? (
            <p className="mt-1">Checking the selected dates...</p>
          ) : liveAvailability ? (
            <p className="mt-1 flex flex-wrap items-center gap-x-2">
              <span>
                {liveAvailability.available} available of{" "}
                {liveAvailability.total}
              </span>
              <span aria-hidden="true">·</span>
              <span>Requested {liveAvailability.requested}</span>
              {liveAvailability.loanConflictQuantity > 0 ? (
                <>
                  <span aria-hidden="true">·</span>
                  <span>
                    {liveAvailability.loanConflictQuantity} loan conflict
                    {liveAvailability.loanConflictQuantity === 1 ? "" : "s"}
                  </span>
                </>
              ) : null}
              {liveAvailability.shortfall > 0 ? (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="font-semibold text-red-800">
                    Short by {liveAvailability.shortfall}
                  </span>
                </>
              ) : null}
            </p>
          ) : (
            <p className="mt-2">
              Choose equipment and dates to check availability.
            </p>
          )}
        </div>
        {liveAvailability && liveAvailability.conflicts.length > 0 ? (
          <details className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
            <summary className="cursor-pointer font-semibold">
              Conflicting current loans ({liveAvailability.conflicts.length})
            </summary>
            <div className="mt-3 space-y-3">
              {liveAvailability.conflicts.map((conflict) => (
                <div
                  key={conflict.bookingAssetId}
                  className="rounded-lg border border-amber-200 bg-white p-3"
                >
                  <p className="font-semibold">{conflict.itemName}</p>
                  <p>Borrower: {conflict.borrowerName}</p>
                  <p>
                    Current return date:{" "}
                    {formatConflictDate(conflict.currentReturnDate)}
                  </p>
                  <button
                    type="button"
                    onClick={() => openEarlierReturn(conflict)}
                    className="mt-2 rounded-lg border border-red-300 px-3 py-2 text-xs font-semibold text-red-800 hover:bg-red-50"
                  >
                    Request earlier return
                  </button>
                </div>
              ))}
            </div>
          </details>
        ) : null}
        {createConflictAvailability ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
            <p className="font-semibold">
              This reservation has a planning shortfall.
            </p>
            <p className="mt-1">
              You can reduce the quantity or create the reservation with the
              current shortfall.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() =>
                  setQuantityInput(String(createConflictAvailability.available))
                }
                className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-gray-800"
              >
                Adjust quantity
              </button>
              <button
                type="submit"
                name="createAnyway"
                value="true"
                disabled={!quantityIsValid || !selectedId}
                className="rounded-lg bg-red-700 px-3 py-2 text-sm font-semibold text-white hover:bg-red-800"
              >
                Create reservation anyway
              </button>
            </div>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center justify-end gap-3 border-t border-gray-100 pt-4">
          <Link
            to="/calendar"
            className="inline-flex min-h-11 items-center justify-center rounded-xl border border-gray-300 px-4 text-sm font-semibold text-gray-700 hover:border-gray-400"
          >
            Cancel
          </Link>
          <button
            type="submit"
            disabled={!quantityIsValid || !selectedId}
            className="inline-flex min-h-11 items-center justify-center rounded-xl bg-red-700 px-5 text-sm font-bold text-white hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isEdit ? "Save changes" : "Create reservation"}
          </button>
        </div>
      </Form>
      {reservation ? (
        <Form method="post" className="mt-4">
          <input type="hidden" name="intent" value="cancel-reservation" />
          <input type="hidden" name="bookingId" value={reservation.id} />
          <button
            type="submit"
            className="rounded-xl border border-red-300 px-4 py-2 text-sm font-semibold text-red-800 hover:bg-red-50"
          >
            Cancel reservation
          </button>
        </Form>
      ) : null}
      {selectedConflict ? (
        <Form
          method="post"
          className="mt-4 rounded-2xl border border-red-200 bg-white p-5 shadow-sm"
        >
          <input type="hidden" name="intent" value="request-earlier-return" />
          <input
            type="hidden"
            name="bookingId"
            value={selectedConflict.bookingId}
          />
          <input
            type="hidden"
            name="bookingAssetId"
            value={selectedConflict.bookingAssetId}
          />
          <input type="hidden" name="reservationStartDate" value={startDate} />
          <p className="font-semibold text-gray-900">Request earlier return</p>
          <p className="mt-2 text-sm text-gray-700">
            {selectedConflict.itemName}
          </p>
          <p className="text-sm text-gray-600">
            Currently due:{" "}
            {formatConflictDate(selectedConflict.currentReturnDate)}
          </p>
          <label className="mt-3 block text-sm font-semibold text-gray-800">
            Reservation name
            <input
              name="reservationName"
              required
              placeholder="Interaction Design course"
              className="mt-1 min-h-11 w-full rounded-xl border border-gray-300 px-3 font-normal"
            />
          </label>
          <label className="mt-3 block text-sm font-semibold text-gray-800">
            New requested return date
            <input
              type="date"
              name="newReturnDate"
              required
              value={newReturnDate}
              min={localDateWire(new Date())}
              max={localDateWire(addDays(new Date(startDate), -1))}
              onChange={(event) => setNewReturnDate(event.target.value)}
              className="mt-1 min-h-11 rounded-xl border border-gray-300 px-3 font-normal"
            />
          </label>
          <p className="mt-3 rounded-lg bg-gray-50 p-3 text-sm text-gray-700">
            “This item is needed for a scheduled course beginning {startDate}.
            Please return it by {newReturnDate}."
          </p>
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={() => setSelectedConflict(null)}
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-semibold text-gray-700"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="rounded-lg bg-red-700 px-3 py-2 text-sm font-semibold text-white hover:bg-red-800"
            >
              Send request
            </button>
          </div>
        </Form>
      ) : null}
    </div>
  );
}
