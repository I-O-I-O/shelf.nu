import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  $transaction: vi.fn(),
  $queryRaw: vi.fn(),
  asset: { findFirst: vi.fn(), findMany: vi.fn() },
  qr: { findFirst: vi.fn() },
  bookingAsset: { findMany: vi.fn() },
  teamMember: { findFirst: vi.fn(), create: vi.fn() },
  user: { findFirst: vi.fn() },
  booking: { findFirst: vi.fn() },
  ioioArchivedItem: { findMany: vi.fn() },
  ioioWriteOperation: {
    create: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
}));
const requireIoioBorrowerAccessMock = vi.hoisted(() => vi.fn());
const getIoioAvailabilityMock = vi.hoisted(() => vi.fn());
const enforceBorrowRateLimitMock = vi.hoisted(() => vi.fn());
const createBookingMock = vi.hoisted(() => vi.fn());
const reserveBookingMock = vi.hoisted(() => vi.fn());
const updateBookingAssetsMock = vi.hoisted(() => vi.fn());
const checkoutBookingMock = vi.hoisted(() => vi.fn());

// why: this unit suite isolates proposal validation and durable-operation
// decisions; native booking integration is exercised by the gated DB suite.
vi.mock("~/database/db.server", () => ({ db: dbMock }));
// why: authorization is supplied as a controlled fixture so these tests can
// exercise the service's own organization/role checks.
vi.mock("./route.server", () => ({
  requireIoioBorrowerAccess: requireIoioBorrowerAccessMock,
}));
// why: live availability is a database concern covered by integration tests;
// unit cases need deterministic available/over-capacity values.
vi.mock("./availability.server", () => ({
  getIoioAvailability: getIoioAvailabilityMock,
  IOIO_STAFF_RESERVATION_ACKNOWLEDGEMENT:
    "Student acknowledged IOIO staff reservation overlap.",
}));
// why: persistent quota accounting is tested separately; these cases focus on
// borrow validation and idempotency.
vi.mock("./rate-limit.server", () => ({
  IOIO_BORROW_OPERATION: "BORROW_ITEM",
  enforceIoioBorrowRateLimit: enforceBorrowRateLimitMock,
}));
// why: native Shelf booking services are integration boundaries here; mocking
// them lets the tests assert that confirmation, not proposal creation, starts
// native writes.
vi.mock("~/modules/booking/service.server", () => ({
  createBooking: createBookingMock,
  reserveBooking: reserveBookingMock,
  updateBookingAssets: updateBookingAssetsMock,
  checkoutBooking: checkoutBookingMock,
}));
vi.mock("~/modules/ioio-staff/preparation.server", () => ({
  IOIO_PREPARATION_OPERATION: "IOIO_PREPARATION",
  PREPARATION_PENDING: "PENDING_PREPARATION",
  PREPARATION_READY: "READY_FOR_PICKUP",
  createPreparationTask: vi.fn(),
}));
vi.mock("./annual-access.server", () => ({
  assertAnnualAccessApproved: vi.fn(),
}));
vi.mock("~/utils/client-hints", () => ({
  getClientHint: vi.fn(() => ({ locale: "en-US", timeZone: "UTC" })),
}));
vi.mock("~/utils/error", () => ({
  ShelfError: class ShelfError extends Error {
    status: number;

    constructor(options: { message?: string; status?: number }) {
      super(options.message);
      this.status = options.status ?? 409;
    }
  },
  isLikeShelfError: vi.fn(() => false),
}));
vi.mock("~/utils/user", () => ({
  resolveUserDisplayName: vi.fn(
    (user: { displayName?: string | null } | null) => user?.displayName ?? ""
  ),
}));
vi.mock("~/utils/logger", () => ({
  Logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  borrowItem,
  acknowledgeBorrowItemStaffReservation,
  acknowledgePreparationStaffReservation,
  prepareBorrowItem,
  requestPreparationForItem,
  resolvePhysicalUnitNumber,
} from "./borrow-item.server";

const context = {};
const request = new Request("http://localhost/ioio/ask");
const auth = {
  userId: "user-a",
  organizationId: "org-a",
  role: "SELF_SERVICE",
};
const asset = {
  id: "asset-a",
  title: "Arduino Nano",
  type: "QUANTITY_TRACKED" as const,
  assetModelId: null,
  quantity: 8,
  status: "AVAILABLE" as const,
  availableToBook: true,
  assetLocations: [{ location: { name: "B477 / Shelf A1" } }],
  assetKits: [],
};
const from = new Date(Date.now() + 60_000).toISOString();
const to = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

describe("IOIO borrow_item", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.ioioWriteOperation.findFirst.mockReset();
    dbMock.ioioWriteOperation.findUnique.mockReset();
    requireIoioBorrowerAccessMock.mockResolvedValue(auth);
    dbMock.$transaction.mockImplementation((callback) => callback(dbMock));
    dbMock.$queryRaw.mockResolvedValue([
      { id: "membership-a", roles: ["SELF_SERVICE"] },
    ]);
    dbMock.asset.findFirst.mockResolvedValue(asset);
    dbMock.asset.findMany.mockResolvedValue([]);
    dbMock.ioioArchivedItem.findMany.mockResolvedValue([]);
    dbMock.bookingAsset.findMany.mockResolvedValue([]);
    dbMock.teamMember.findFirst.mockResolvedValue({ id: "team-a" });
    getIoioAvailabilityMock.mockReset();
    getIoioAvailabilityMock.mockResolvedValue({
      totalActive: 8,
      availableCount: 8,
      availableUnitIds: [],
      availableUnitIdsWithoutStaffReservations: [],
      conflicts: [],
      staffReservedCount: 0,
      staffReservationBookingIds: [],
      availableWithoutStaffReservations: 8,
    });
    dbMock.ioioWriteOperation.create.mockResolvedValue({ id: "op-a" });
    dbMock.ioioWriteOperation.findMany.mockResolvedValue([]);
    dbMock.ioioWriteOperation.update.mockResolvedValue({});
    dbMock.ioioWriteOperation.updateMany.mockResolvedValue({ count: 1 });
    enforceBorrowRateLimitMock.mockResolvedValue(undefined);
  });

  it("creates a persisted proposal without creating a booking", async () => {
    const proposal = await prepareBorrowItem(
      {
        asset_id: asset.id,
        kit_id: null,
        quantity: 2,
        from,
        to,
      },
      { context, request }
    );

    expect(proposal).toMatchObject({
      operationId: "op-a",
      quantity: 2,
      availableQuantity: 8,
      asset: { id: asset.id, title: asset.title },
    });
    expect(dbMock.ioioWriteOperation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          operationType: "BORROW_ITEM",
          status: "PREPARED",
          assetId: asset.id,
          quantity: 2,
        }),
      })
    );
    expect(createBookingMock).not.toHaveBeenCalled();
  });

  it("borrows an immediately available quantity-tracked asset through Shelf without preparation", async () => {
    dbMock.asset.findFirst.mockResolvedValue({
      ...asset,
      requiresStaffPreparation: false,
      requiresBorrowApproval: false,
    });
    dbMock.ioioWriteOperation.findUnique.mockResolvedValue({
      id: "op-motor",
      userId: auth.userId,
      organizationId: auth.organizationId,
      operationType: "BORROW_ITEM",
      status: "PREPARED",
      source: "IOIO_ASSISTANT",
      assetId: asset.id,
      kitId: null,
      quantity: 2,
      selectedAssetIds: null,
      from: new Date(from),
      to: new Date(to),
      bookingId: null,
      createdAt: new Date(),
      failureCode: null,
    });
    dbMock.booking.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: "booking-motor",
      status: "DRAFT",
      bookingAssets: [
        { id: "booking-asset-motor", assetId: asset.id, quantity: 2 },
      ],
    });
    createBookingMock.mockResolvedValue({ id: "booking-motor" });

    await expect(
      borrowItem(
        {
          confirmationToken: "motor-proposal",
          quantity: 2,
        },
        { context, request }
      )
    ).resolves.toMatchObject({
      status: "submitted",
      bookingId: "booking-motor",
      requiresStaffPreparation: false,
    });

    expect(createBookingMock).toHaveBeenCalledWith(
      expect.objectContaining({ assetIds: [asset.id] })
    );
    expect(updateBookingAssetsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "booking-motor",
        quantities: { [asset.id]: 2 },
      })
    );
    expect(checkoutBookingMock).toHaveBeenCalled();
  });

  it("refreshes only an expired Motor proposal before borrowing", async () => {
    const expiredOperation = {
      id: "op-expired-motor",
      userId: auth.userId,
      organizationId: auth.organizationId,
      operationType: "BORROW_ITEM",
      status: "PREPARED",
      source: "IOIO_ASSISTANT",
      assetId: asset.id,
      kitId: null,
      quantity: 1,
      selectedAssetIds: null,
      from: new Date(from),
      to: new Date(to),
      bookingId: null,
      createdAt: new Date(Date.now() - 11 * 60 * 1000),
      failureCode: null,
      description: `Borrow proposal for Shelf asset ${asset.id}`,
    };
    let replacementOperation: typeof expiredOperation | null = null;
    dbMock.ioioWriteOperation.findUnique.mockImplementation(({ where }) =>
      Promise.resolve(
        where.idempotencyKey === "expired-motor-token"
          ? expiredOperation
          : replacementOperation
      )
    );
    dbMock.ioioWriteOperation.create.mockImplementation(({ data }) => {
      replacementOperation = {
        ...expiredOperation,
        id: "op-refreshed-motor",
        status: "PREPARED",
        source: data.source,
        assetId: data.assetId,
        quantity: data.quantity,
        selectedAssetIds: null,
        from: data.from,
        to: data.to,
        createdAt: new Date(),
        description: data.description,
      };
      return Promise.resolve({ id: "op-refreshed-motor" });
    });
    dbMock.booking.findFirst.mockResolvedValueOnce(null).mockResolvedValue({
      id: "booking-refreshed-motor",
      status: "DRAFT",
      bookingAssets: [
        {
          id: "booking-asset-refreshed-motor",
          assetId: asset.id,
          quantity: 1,
        },
      ],
    });
    createBookingMock.mockResolvedValue({ id: "booking-refreshed-motor" });
    updateBookingAssetsMock.mockResolvedValue(undefined);
    checkoutBookingMock.mockResolvedValue(undefined);

    await expect(
      borrowItem(
        {
          confirmationToken: "expired-motor-token",
          quantity: 1,
          selectedPhysicalUnitIds: [],
        },
        { context, request }
      )
    ).resolves.toMatchObject({
      status: "submitted",
      bookingId: "booking-refreshed-motor",
    });

    expect(dbMock.ioioWriteOperation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          operationType: "BORROW_ITEM",
          status: "PREPARED",
          assetId: asset.id,
          quantity: 1,
          idempotencyKey: expect.not.stringMatching("expired-motor-token"),
        }),
      })
    );
    expect(dbMock.ioioWriteOperation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "op-expired-motor",
          idempotencyKey: "expired-motor-token",
          status: "PREPARED",
        }),
        data: expect.objectContaining({ status: "CANCELLED" }),
      })
    );
    expect(checkoutBookingMock).toHaveBeenCalled();
  });

  it("refreshes an expired scanned Kit proposal from its saved physical units", async () => {
    const kit = {
      ...asset,
      id: "makey-kit",
      title: "Makey Kit",
      type: "INDIVIDUAL" as const,
      quantity: null,
      assetModelId: "makey-model",
      requiresBorrowApproval: false,
      requiresStaffPreparation: false,
    };
    const unit = {
      id: "makey-unit-003",
      title: "Makey Kit #003",
      status: "AVAILABLE" as const,
      availableToBook: true,
      assetModelId: "makey-model",
      assetKits: [],
      qrCodes: [{ id: "makey-qr-003" }],
    };
    const expiredOperation = {
      id: "op-expired-makey",
      userId: auth.userId,
      organizationId: auth.organizationId,
      operationType: "BORROW_ITEM",
      status: "PREPARED",
      source: "IOIO_HAVE_ITEM",
      assetId: kit.id,
      kitId: null,
      quantity: 1,
      selectedAssetIds: [unit.id],
      from: new Date(from),
      to: new Date(to),
      bookingId: null,
      createdAt: new Date(Date.now() - 11 * 60 * 1000),
      failureCode: null,
      description: `Borrow proposal for Shelf asset ${kit.id}`,
    };
    let replacementOperation: typeof expiredOperation | null = null;
    dbMock.ioioWriteOperation.findUnique.mockImplementation(({ where }) =>
      Promise.resolve(
        where.idempotencyKey === "expired-makey-token"
          ? expiredOperation
          : replacementOperation
      )
    );
    dbMock.ioioWriteOperation.create.mockImplementation(({ data }) => {
      replacementOperation = {
        ...expiredOperation,
        id: "op-refreshed-makey",
        status: "PREPARED",
        source: data.source,
        assetId: data.assetId,
        quantity: data.quantity,
        selectedAssetIds: data.selectedAssetIds,
        from: data.from,
        to: data.to,
        createdAt: new Date(),
        description: data.description,
      };
      return Promise.resolve({ id: "op-refreshed-makey" });
    });
    dbMock.asset.findFirst
      .mockResolvedValueOnce(kit)
      .mockResolvedValueOnce(kit)
      .mockResolvedValueOnce({
        ...unit,
        assetLocations: [{ location: { name: "Container A1-1" } }],
      })
      .mockResolvedValue(kit);
    dbMock.asset.findMany.mockResolvedValue([unit]);
    dbMock.qr.findFirst.mockResolvedValue({ assetId: unit.id });
    getIoioAvailabilityMock.mockResolvedValue({
      totalActive: 1,
      availableCount: 1,
      availableUnitIds: [unit.id],
      availableUnitIdsWithoutStaffReservations: [unit.id],
      conflicts: [],
      staffReservedCount: 0,
      staffReservationBookingIds: [],
      availableWithoutStaffReservations: 1,
    });
    dbMock.booking.findFirst.mockResolvedValueOnce(null).mockResolvedValue({
      id: "booking-refreshed-makey",
      status: "DRAFT",
      bookingAssets: [
        {
          id: "booking-asset-refreshed-makey",
          assetId: unit.id,
          quantity: 1,
        },
      ],
    });
    createBookingMock.mockResolvedValue({ id: "booking-refreshed-makey" });
    checkoutBookingMock.mockResolvedValue(undefined);

    await expect(
      borrowItem(
        {
          confirmationToken: "expired-makey-token",
          quantity: 1,
          selectedPhysicalUnitIds: [unit.id],
        },
        { context, request }
      )
    ).resolves.toMatchObject({
      status: "submitted",
      bookingId: "booking-refreshed-makey",
    });

    expect(dbMock.qr.findFirst).toHaveBeenCalledWith({
      where: {
        id: "makey-qr-003",
        organizationId: auth.organizationId,
        assetId: unit.id,
      },
      select: { assetId: true },
    });
    expect(dbMock.ioioWriteOperation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          source: "IOIO_HAVE_ITEM",
          assetId: kit.id,
          selectedAssetIds: [unit.id],
        }),
      })
    );
    expect(createBookingMock).toHaveBeenCalledWith(
      expect.objectContaining({ assetIds: [unit.id] })
    );
  });

  it("reserves a quantity-pool preparation request in Shelf with its requested quantity", async () => {
    dbMock.asset.findFirst.mockResolvedValue({
      ...asset,
      requiresStaffPreparation: true,
      maxBorrowDays: 45,
    });
    dbMock.ioioWriteOperation.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "op-a" });
    createBookingMock.mockResolvedValue({ id: "booking-preparation" });
    dbMock.booking.findFirst.mockResolvedValue({
      id: "booking-preparation",
      status: "RESERVED",
    });
    dbMock.ioioWriteOperation.updateMany.mockResolvedValue({ count: 1 });

    await requestPreparationForItem(
      { assetId: asset.id, quantity: 2 },
      { context, request }
    );

    expect(createBookingMock).toHaveBeenCalledTimes(1);
    expect(reserveBookingMock).toHaveBeenCalledTimes(1);

    expect(dbMock.ioioWriteOperation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: auth.organizationId,
          source: "IOIO_PREPARATION_REQUEST",
          status: "ASSIGNING",
          assetId: asset.id,
          selectedAssetIds: [asset.id],
          quantity: 2,
        }),
      })
    );
    expect(createBookingMock).toHaveBeenCalledWith(
      expect.objectContaining({
        booking: expect.objectContaining({
          description: "IOIO_PREPARATION_REQUEST:op-a",
          custodianUserId: auth.userId,
          custodianTeamMemberId: "team-a",
        }),
        assetIds: [asset.id],
      })
    );
    expect(updateBookingAssetsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "booking-preparation",
        assetIds: [asset.id],
        quantities: { [asset.id]: 2 },
      })
    );
    expect(reserveBookingMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "booking-preparation",
        description: "IOIO_PREPARATION_REQUEST:op-a",
        allowImmediateStart: true,
      })
    );
    expect(dbMock.ioioWriteOperation.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({ id: "op-a" }),
        data: { bookingId: "booking-preparation" },
      })
    );
    expect(dbMock.ioioWriteOperation.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          id: "op-a",
          status: "ASSIGNING",
          bookingId: "booking-preparation",
        }),
        data: { status: "PENDING_PREPARATION" },
      })
    );
  });

  it("reserves the selected physical kit units when preparation is requested", async () => {
    const product = {
      ...asset,
      id: "makey-product",
      title: "Makey Kit",
      type: "INDIVIDUAL" as const,
      quantity: null,
      assetModelId: "makey-model",
      requiresStaffPreparation: true,
    };
    dbMock.asset.findFirst.mockResolvedValue(product);
    dbMock.asset.findMany.mockResolvedValue([
      {
        id: "unit-001",
        title: "Makey Kit #001",
        status: "AVAILABLE",
        availableToBook: true,
        assetModelId: "makey-model",
        assetKits: [],
        qrCodes: [],
      },
      {
        id: "unit-002",
        title: "Makey Kit #002",
        status: "AVAILABLE",
        availableToBook: true,
        assetModelId: "makey-model",
        assetKits: [],
        qrCodes: [],
      },
    ]);
    dbMock.ioioWriteOperation.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "op-makey" });
    dbMock.ioioWriteOperation.create.mockResolvedValue({ id: "op-makey" });
    dbMock.ioioWriteOperation.updateMany.mockResolvedValue({ count: 1 });
    createBookingMock.mockResolvedValue({ id: "booking-makey" });
    dbMock.booking.findFirst.mockResolvedValue({
      id: "booking-makey",
      status: "RESERVED",
    });
    getIoioAvailabilityMock.mockResolvedValue({
      totalActive: 5,
      availableCount: 2,
      availableUnitIds: ["unit-001", "unit-002"],
      availableUnitIdsWithoutStaffReservations: ["unit-001", "unit-002"],
      conflicts: [],
      staffReservedCount: 0,
      staffReservationBookingIds: [],
      availableWithoutStaffReservations: 2,
    });

    await requestPreparationForItem(
      {
        assetId: product.id,
        candidateAssetIds: ["unit-001", "unit-002"],
        quantity: 2,
      },
      { context, request }
    );

    expect(createBookingMock).toHaveBeenCalledWith(
      expect.objectContaining({
        assetIds: ["unit-001", "unit-002"],
      })
    );
    expect(updateBookingAssetsMock).not.toHaveBeenCalled();
    expect(reserveBookingMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: "booking-makey" })
    );
  });

  it("requires a Student acknowledgement before creating a request across a course reservation", async () => {
    dbMock.asset.findFirst.mockResolvedValue({
      ...asset,
      requiresStaffPreparation: true,
      maxBorrowDays: 45,
    });
    getIoioAvailabilityMock.mockResolvedValue({
      totalActive: 8,
      availableCount: 0,
      availableUnitIds: [],
      availableUnitIdsWithoutStaffReservations: [],
      conflicts: [],
      staffReservedCount: 8,
      staffReservationBookingIds: ["course-booking"],
      staffReservationFrom: new Date("2026-10-11T00:00:00.000Z"),
      staffReservationTo: new Date("2027-01-30T00:00:00.000Z"),
      availableWithoutStaffReservations: 8,
    });

    await expect(
      requestPreparationForItem(
        { assetId: asset.id, quantity: 1 },
        { context, request }
      )
    ).rejects.toThrow("Confirm that you have permission");
    expect(dbMock.ioioWriteOperation.create).not.toHaveBeenCalled();
  });

  it("acknowledges only the selected preparation conflict without submitting, then submits on final confirmation", async () => {
    dbMock.asset.findFirst.mockResolvedValue({
      ...asset,
      requiresStaffPreparation: true,
      maxBorrowDays: 45,
    });
    dbMock.ioioWriteOperation.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "op-a" });
    createBookingMock.mockResolvedValue({ id: "booking-preparation" });
    dbMock.booking.findFirst.mockResolvedValue({
      id: "booking-preparation",
      status: "RESERVED",
    });
    dbMock.ioioWriteOperation.updateMany.mockResolvedValue({ count: 1 });
    getIoioAvailabilityMock.mockResolvedValue({
      totalActive: 8,
      availableCount: 0,
      availableUnitIds: [],
      availableUnitIdsWithoutStaffReservations: [],
      conflicts: [],
      staffReservedCount: 8,
      staffReservationBookingIds: ["course-booking"],
      staffReservationFrom: new Date("2026-10-11T00:00:00.000Z"),
      staffReservationTo: new Date("2027-01-30T00:00:00.000Z"),
      availableWithoutStaffReservations: 8,
    });

    const acknowledgement = await acknowledgePreparationStaffReservation(
      { assetId: asset.id, quantity: 1 },
      { context, request }
    );
    expect(acknowledgement.confirmationToken).toBeTruthy();
    expect(dbMock.ioioWriteOperation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          source: "IOIO_PREPARATION_RESERVATION_ACKNOWLEDGEMENT",
          status: "PREPARED",
          assetId: asset.id,
          quantity: 1,
        }),
      })
    );
    expect(createBookingMock).not.toHaveBeenCalled();
    expect(reserveBookingMock).not.toHaveBeenCalled();
    expect(checkoutBookingMock).not.toHaveBeenCalled();
    dbMock.ioioWriteOperation.findUnique.mockResolvedValue({
      operationType: "IOIO_PREPARATION",
      source: "IOIO_PREPARATION_RESERVATION_ACKNOWLEDGEMENT",
      status: "PREPARED",
      userId: auth.userId,
      organizationId: auth.organizationId,
      assetId: asset.id,
      quantity: 1,
      selectedAssetIds: [asset.id],
      reviewComment: JSON.stringify(["course-booking"]),
      createdAt: new Date(),
    });

    await requestPreparationForItem(
      {
        assetId: asset.id,
        quantity: 1,
        reservationAcknowledgementToken: acknowledgement.confirmationToken,
      },
      { context, request }
    );

    expect(createBookingMock).toHaveBeenCalledTimes(1);
    expect(reserveBookingMock).toHaveBeenCalledTimes(1);

    expect(dbMock.ioioWriteOperation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          description: expect.stringContaining(
            "Student acknowledged IOIO staff reservation overlap."
          ),
        }),
      })
    );
  });

  it("rejects a preparation acknowledgement issued for another item", async () => {
    dbMock.asset.findFirst.mockResolvedValue({
      ...asset,
      requiresStaffPreparation: true,
    });
    dbMock.ioioWriteOperation.findFirst.mockResolvedValue(null);
    getIoioAvailabilityMock.mockResolvedValue({
      totalActive: 5,
      availableCount: 0,
      availableUnitIds: [],
      availableUnitIdsWithoutStaffReservations: [],
      staffReservedCount: 5,
      staffReservationBookingIds: ["course-booking"],
      availableWithoutStaffReservations: 5,
    });
    dbMock.ioioWriteOperation.findUnique.mockResolvedValue({
      operationType: "IOIO_PREPARATION",
      source: "IOIO_PREPARATION_RESERVATION_ACKNOWLEDGEMENT",
      status: "PREPARED",
      userId: auth.userId,
      organizationId: auth.organizationId,
      assetId: "different-item",
      quantity: 1,
      selectedAssetIds: ["different-item"],
      reviewComment: JSON.stringify(["course-booking"]),
      createdAt: new Date(),
    });

    await expect(
      requestPreparationForItem(
        {
          assetId: asset.id,
          quantity: 1,
          reservationAcknowledgementToken:
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        },
        { context, request }
      )
    ).rejects.toThrow("Confirm that you have permission");
    expect(createBookingMock).not.toHaveBeenCalled();
  });

  it("rejects a forged final override without the stored acknowledgement", async () => {
    dbMock.ioioWriteOperation.findUnique.mockResolvedValue({
      id: "op-a",
      userId: auth.userId,
      organizationId: auth.organizationId,
      operationType: "BORROW_ITEM",
      status: "PREPARED",
      assetId: asset.id,
      kitId: null,
      quantity: 1,
      selectedAssetIds: null,
      from: new Date(from),
      to: new Date(to),
      bookingId: null,
      createdAt: new Date(),
      description: "Borrow proposal for Shelf asset asset-a",
    });

    await expect(
      borrowItem(
        {
          confirmationToken: "forged-token",
          quantity: 1,
          allowStaffReservationOverlap: true,
        },
        { context, request }
      )
    ).rejects.toThrow("Confirm that you have permission");
  });

  it("persists the acknowledgement only for the authenticated proposal owner", async () => {
    dbMock.ioioWriteOperation.findUnique.mockResolvedValue({
      id: "op-a",
      userId: auth.userId,
      organizationId: auth.organizationId,
      operationType: "BORROW_ITEM",
      status: "PREPARED",
      assetId: asset.id,
      selectedAssetIds: null,
      quantity: 1,
      from: new Date(from),
      to: new Date(to),
      description: "Borrow proposal for Shelf asset asset-a",
    });
    getIoioAvailabilityMock.mockResolvedValue({
      totalActive: 8,
      availableCount: 0,
      availableUnitIds: [],
      availableUnitIdsWithoutStaffReservations: [],
      conflicts: [],
      staffReservedCount: 8,
      staffReservationBookingIds: ["course-booking"],
      staffReservationFrom: new Date("2026-10-11T00:00:00.000Z"),
      staffReservationTo: new Date("2027-01-30T00:00:00.000Z"),
      availableWithoutStaffReservations: 8,
    });

    await expect(
      acknowledgeBorrowItemStaffReservation("proposal-token", {
        context,
        request,
      })
    ).resolves.toEqual({ ok: true, acknowledged: true });
    expect(dbMock.ioioWriteOperation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "op-a",
          userId: auth.userId,
          organizationId: auth.organizationId,
        }),
        data: expect.objectContaining({
          description: expect.stringContaining(
            "Student acknowledged IOIO staff reservation overlap."
          ),
        }),
      })
    );
  });

  it("validates the exact I have the kit unit against soft and hard availability", async () => {
    dbMock.ioioWriteOperation.findUnique.mockResolvedValue({
      id: "op-exact-unit",
      userId: auth.userId,
      organizationId: auth.organizationId,
      operationType: "BORROW_ITEM",
      status: "PREPARED",
      assetId: "makey-logical-item",
      selectedAssetIds: ["makey-unit-003"],
      quantity: 1,
      from: new Date(from),
      to: new Date(to),
      description: "Borrow proposal for Makey Kit",
    });
    dbMock.asset.findFirst.mockResolvedValue({
      ...asset,
      id: "makey-logical-item",
      type: "INDIVIDUAL",
      assetModelId: "makey-model",
    });
    getIoioAvailabilityMock.mockResolvedValue({
      totalActive: 5,
      availableCount: 0,
      availableUnitIds: [],
      availableUnitIdsWithoutStaffReservations: ["makey-unit-003"],
      conflicts: [],
      staffReservedCount: 5,
      staffReservationBookingIds: ["course-booking"],
      staffReservationFrom: new Date("2026-10-11T00:00:00.000Z"),
      staffReservationTo: new Date("2027-01-30T00:00:00.000Z"),
      availableWithoutStaffReservations: 1,
    });

    await acknowledgeBorrowItemStaffReservation("exact-unit-proposal", {
      context,
      request,
    });

    expect(getIoioAvailabilityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        productId: "makey-logical-item",
        candidateAssetIds: ["makey-unit-003"],
      })
    );
  });

  it("does not acknowledge an exact unit with a hard physical conflict", async () => {
    dbMock.ioioWriteOperation.findUnique.mockResolvedValue({
      id: "op-exact-unit",
      userId: auth.userId,
      organizationId: auth.organizationId,
      operationType: "BORROW_ITEM",
      status: "PREPARED",
      assetId: "makey-logical-item",
      selectedAssetIds: ["makey-unit-003"],
      quantity: 1,
      from: new Date(from),
      to: new Date(to),
      description: "Borrow proposal for Makey Kit",
    });
    dbMock.asset.findFirst.mockResolvedValue({
      ...asset,
      id: "makey-logical-item",
      type: "INDIVIDUAL",
      assetModelId: "makey-model",
    });
    getIoioAvailabilityMock.mockResolvedValue({
      totalActive: 5,
      availableCount: 0,
      availableUnitIds: [],
      availableUnitIdsWithoutStaffReservations: [],
      conflicts: [],
      staffReservedCount: 1,
      staffReservationBookingIds: ["course-booking"],
      staffReservationFrom: new Date("2026-10-11T00:00:00.000Z"),
      staffReservationTo: new Date("2027-01-30T00:00:00.000Z"),
      availableWithoutStaffReservations: 0,
    });

    await expect(
      acknowledgeBorrowItemStaffReservation("exact-unit-proposal", {
        context,
        request,
      })
    ).rejects.toThrow("Some equipment is unavailable for these dates");
    expect(dbMock.ioioWriteOperation.updateMany).not.toHaveBeenCalled();
  });

  it("does not accept a preparation quantity above the remaining pool stock", async () => {
    dbMock.asset.findFirst.mockResolvedValue({
      ...asset,
      requiresStaffPreparation: true,
      maxBorrowDays: 45,
    });
    getIoioAvailabilityMock.mockResolvedValue({
      totalActive: 5,
      availableCount: 3,
      availableUnitIds: [],
      availableUnitIdsWithoutStaffReservations: [],
      conflicts: [],
      staffReservedCount: 0,
      staffReservationBookingIds: [],
      availableWithoutStaffReservations: 3,
    });

    await expect(
      requestPreparationForItem(
        { assetId: asset.id, quantity: 4 },
        { context, request }
      )
    ).rejects.toThrow("Only 3 units are available for preparation.");

    expect(dbMock.ioioWriteOperation.create).not.toHaveBeenCalled();
    expect(createBookingMock).not.toHaveBeenCalled();
  });

  it("creates a separate preparation obligation for each new same-kit submission", async () => {
    const product = {
      ...asset,
      id: "makey-product",
      title: "Makey Kit",
      type: "INDIVIDUAL" as const,
      quantity: null,
      assetModelId: "makey-model",
      requiresStaffPreparation: true,
      maxBorrowDays: 45,
    };
    const unitIds = [
      "unit-001",
      "unit-002",
      "unit-003",
      "unit-004",
      "unit-005",
    ];
    dbMock.asset.findFirst.mockResolvedValue({
      ...product,
    });
    dbMock.asset.findMany.mockResolvedValue(
      unitIds.map((id) => ({
        id,
        title: `Makey Kit #${id.slice(-3)}`,
        status: "AVAILABLE",
        availableToBook: true,
        assetModelId: "makey-model",
        assetKits: [],
        qrCodes: [],
      }))
    );
    dbMock.ioioWriteOperation.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "request-one" })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "request-two" });
    dbMock.ioioWriteOperation.create
      .mockResolvedValueOnce({ id: "request-one" })
      .mockResolvedValueOnce({ id: "request-two" });
    createBookingMock
      .mockResolvedValueOnce({ id: "booking-one" })
      .mockResolvedValueOnce({ id: "booking-two" });
    dbMock.booking.findFirst
      .mockResolvedValueOnce({ id: "booking-one", status: "RESERVED" })
      .mockResolvedValueOnce({ id: "booking-two", status: "RESERVED" });
    dbMock.ioioWriteOperation.updateMany.mockResolvedValue({ count: 1 });
    getIoioAvailabilityMock
      .mockResolvedValueOnce({
        totalActive: 5,
        availableCount: 5,
        availableUnitIds: unitIds,
        availableUnitIdsWithoutStaffReservations: unitIds,
        conflicts: [],
        staffReservedCount: 0,
        staffReservationBookingIds: [],
        availableWithoutStaffReservations: 5,
      })
      .mockResolvedValueOnce({
        totalActive: 5,
        availableCount: 4,
        availableUnitIds: unitIds.slice(1),
        availableUnitIdsWithoutStaffReservations: unitIds.slice(1),
        conflicts: [],
        staffReservedCount: 0,
        staffReservationBookingIds: [],
        availableWithoutStaffReservations: 4,
      });

    const first = await requestPreparationForItem(
      {
        assetId: product.id,
        candidateAssetIds: unitIds,
        quantity: 1,
        submissionToken: "11111111-1111-4111-8111-111111111111",
      },
      { context, request }
    );
    const second = await requestPreparationForItem(
      {
        assetId: product.id,
        candidateAssetIds: unitIds,
        quantity: 1,
        submissionToken: "22222222-2222-4222-8222-222222222222",
      },
      { context, request }
    );

    expect(first).toMatchObject({
      requestId: "request-one",
      status: "requested",
    });
    expect(second).toMatchObject({
      requestId: "request-two",
      status: "requested",
    });
    expect(dbMock.ioioWriteOperation.create).toHaveBeenCalledTimes(2);
    expect(dbMock.ioioWriteOperation.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({
          assetId: product.id,
          quantity: 1,
          idempotencyKey:
            "IOIO_PREPARATION_REQUEST:org-a:user-a:11111111-1111-4111-8111-111111111111",
        }),
      })
    );
    expect(dbMock.ioioWriteOperation.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          assetId: product.id,
          quantity: 1,
          idempotencyKey:
            "IOIO_PREPARATION_REQUEST:org-a:user-a:22222222-2222-4222-8222-222222222222",
        }),
      })
    );
    expect(createBookingMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ assetIds: ["unit-001"] })
    );
    expect(createBookingMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ assetIds: ["unit-002"] })
    );
    expect(reserveBookingMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ id: "booking-one" })
    );
    expect(reserveBookingMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: "booking-two" })
    );
    expect(getIoioAvailabilityMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ productId: product.id })
    );
  });

  it("returns the same canonical request when the same submission token is retried", async () => {
    dbMock.asset.findFirst.mockResolvedValue({
      ...asset,
      requiresStaffPreparation: true,
      maxBorrowDays: 45,
    });
    dbMock.ioioWriteOperation.findFirst.mockResolvedValue({
      id: "existing-preparation-request",
      assetId: asset.id,
      bookingId: "existing-booking",
      status: "PENDING_PREPARATION",
      quantity: 1,
      selectedAssetIds: [asset.id],
    });
    dbMock.booking.findFirst.mockResolvedValue({
      id: "existing-booking",
      status: "RESERVED",
    });

    const result = await requestPreparationForItem(
      {
        assetId: asset.id,
        quantity: 1,
        submissionToken: "33333333-3333-4333-8333-333333333333",
      },
      { context, request }
    );

    expect(result).toMatchObject({
      status: "requested",
      requestId: "existing-preparation-request",
      duplicate: true,
    });
    expect(dbMock.ioioWriteOperation.create).not.toHaveBeenCalled();
    expect(createBookingMock).not.toHaveBeenCalled();
  });

  it("keeps submission idempotency independent between students", async () => {
    dbMock.asset.findFirst.mockResolvedValue({
      ...asset,
      requiresStaffPreparation: true,
      maxBorrowDays: 45,
    });
    requireIoioBorrowerAccessMock
      .mockResolvedValueOnce({ ...auth, userId: "student-a" })
      .mockResolvedValueOnce({ ...auth, userId: "student-b" });
    dbMock.ioioWriteOperation.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "request-a" })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "request-b" });
    dbMock.ioioWriteOperation.create
      .mockResolvedValueOnce({ id: "request-a" })
      .mockResolvedValueOnce({ id: "request-b" });
    createBookingMock
      .mockResolvedValueOnce({ id: "booking-a" })
      .mockResolvedValueOnce({ id: "booking-b" });
    dbMock.booking.findFirst
      .mockResolvedValueOnce({ id: "booking-a", status: "RESERVED" })
      .mockResolvedValueOnce({ id: "booking-b", status: "RESERVED" });
    dbMock.ioioWriteOperation.updateMany.mockResolvedValue({ count: 1 });

    await requestPreparationForItem(
      {
        assetId: asset.id,
        quantity: 1,
        submissionToken: "44444444-4444-4444-8444-444444444444",
      },
      { context, request }
    );
    await requestPreparationForItem(
      {
        assetId: asset.id,
        quantity: 1,
        submissionToken: "44444444-4444-4444-8444-444444444444",
      },
      { context, request }
    );

    expect(dbMock.ioioWriteOperation.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({
          idempotencyKey:
            "IOIO_PREPARATION_REQUEST:org-a:student-a:44444444-4444-4444-8444-444444444444",
        }),
      })
    );
    expect(dbMock.ioioWriteOperation.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          idempotencyKey:
            "IOIO_PREPARATION_REQUEST:org-a:student-b:44444444-4444-4444-8444-444444444444",
        }),
      })
    );
  });

  it("treats blank physical-unit fields as absent for pooled assets", async () => {
    const proposal = await prepareBorrowItem(
      {
        asset_id: asset.id,
        kit_id: null,
        quantity: 1,
        scanned_asset_id: "",
        scanned_qr_id: "",
      },
      { context, request }
    );

    expect(proposal).toMatchObject({
      operationId: "op-a",
      selectedPhysicalUnitIds: [],
    });
  });

  it("accepts the same reviewed physical units when final order changes", async () => {
    const individualAsset = {
      ...asset,
      id: "product-a",
      title: "Makey Makey Kit",
      type: "INDIVIDUAL" as const,
      quantity: null,
      assetModelId: "model-a",
    };
    const units = [
      {
        id: "unit-1",
        title: "Makey Makey Kit #001",
        status: "AVAILABLE" as const,
        availableToBook: true,
        assetModelId: "model-a",
        assetKits: [],
        qrCodes: [{ id: "qr-1" }],
      },
      {
        id: "unit-2",
        title: "Makey Makey Kit #002",
        status: "AVAILABLE" as const,
        availableToBook: true,
        assetModelId: "model-a",
        assetKits: [],
        qrCodes: [{ id: "qr-2" }],
      },
    ];
    dbMock.ioioWriteOperation.findUnique.mockResolvedValue({
      id: "op-a",
      userId: auth.userId,
      organizationId: auth.organizationId,
      operationType: "BORROW_ITEM",
      status: "PREPARED",
      assetId: individualAsset.id,
      kitId: null,
      quantity: 2,
      selectedAssetIds: ["unit-2", "unit-1"],
      from: new Date(from),
      to: new Date(to),
      bookingId: null,
      createdAt: new Date(),
    });
    dbMock.asset.findFirst.mockResolvedValue(individualAsset);
    dbMock.asset.findMany.mockResolvedValue(units);
    dbMock.booking.findFirst.mockResolvedValueOnce(null).mockResolvedValue({
      id: "booking-a",
      status: "DRAFT",
      bookingAssets: [
        { id: "booking-asset-1", assetId: "unit-1", quantity: 1 },
        { id: "booking-asset-2", assetId: "unit-2", quantity: 1 },
      ],
    });
    createBookingMock.mockResolvedValue({ id: "booking-a" });
    checkoutBookingMock.mockResolvedValue(undefined);
    getIoioAvailabilityMock.mockResolvedValue({
      totalActive: 2,
      availableCount: 2,
      availableUnitIds: units.map((unit) => unit.id),
      availableUnitIdsWithoutStaffReservations: units.map((unit) => unit.id),
      conflicts: [],
      staffReservedCount: 0,
      staffReservationBookingIds: [],
      availableWithoutStaffReservations: 2,
    });

    await expect(
      borrowItem(
        {
          confirmationToken: "00000000-0000-4000-8000-000000000014",
          quantity: 2,
          selectedPhysicalUnitIds: ["unit-1", "unit-2"],
        },
        { context, request }
      )
    ).resolves.toMatchObject({ status: "submitted", bookingId: "booking-a" });
    expect(createBookingMock).toHaveBeenCalledWith(
      expect.objectContaining({ assetIds: ["unit-2", "unit-1"] })
    );
  });

  it("rejects a confirmation whose quantity was changed", async () => {
    dbMock.ioioWriteOperation.findUnique.mockResolvedValue({
      id: "op-a",
      userId: auth.userId,
      organizationId: auth.organizationId,
      operationType: "BORROW_ITEM",
      status: "PREPARED",
      assetId: asset.id,
      kitId: null,
      quantity: 2,
      from: new Date(from),
      to: new Date(to),
      bookingId: null,
      createdAt: new Date(),
    });

    await expect(
      borrowItem(
        {
          confirmationToken: "00000000-0000-4000-8000-000000000014",
          quantity: 3,
          from,
          to,
        },
        { context, request }
      )
    ).rejects.toMatchObject({ status: 409 });
    expect(enforceBorrowRateLimitMock).not.toHaveBeenCalled();
    expect(createBookingMock).not.toHaveBeenCalled();
  });

  it("rechecks availability before borrowing and rejects a stale quantity", async () => {
    getIoioAvailabilityMock.mockReset();
    dbMock.booking.findFirst.mockReset().mockResolvedValue(null);
    dbMock.ioioWriteOperation.findUnique.mockResolvedValue({
      id: "op-a",
      userId: auth.userId,
      organizationId: auth.organizationId,
      operationType: "BORROW_ITEM",
      status: "PREPARED",
      source: "IOIO_ASSISTANT",
      assetId: asset.id,
      kitId: null,
      quantity: 3,
      selectedAssetIds: null,
      from: new Date(from),
      to: new Date(to),
      bookingId: null,
      createdAt: new Date(),
      failureCode: null,
      description: null,
    });
    getIoioAvailabilityMock.mockResolvedValue({
      totalActive: 8,
      availableCount: 2,
      availableUnitIds: [],
      availableUnitIdsWithoutStaffReservations: [],
      conflicts: [],
      staffReservedCount: 0,
      staffReservationBookingIds: [],
      availableWithoutStaffReservations: 2,
    });

    let caught: unknown;
    try {
      await borrowItem(
        { confirmationToken: "proposal-token", quantity: 3 },
        { context, request }
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      message: "The requested quantity is no longer available.",
      status: 409,
    });
    expect(createBookingMock).not.toHaveBeenCalled();
  });

  it("returns the existing booking for a duplicate confirmation", async () => {
    dbMock.ioioWriteOperation.findUnique.mockResolvedValue({
      id: "op-a",
      userId: auth.userId,
      organizationId: auth.organizationId,
      operationType: "BORROW_ITEM",
      status: "SUCCEEDED",
      assetId: asset.id,
      kitId: null,
      quantity: 1,
      from: new Date(from),
      to: new Date(to),
      bookingId: "booking-a",
      createdAt: new Date(),
    });

    await expect(
      borrowItem(
        {
          confirmationToken: "00000000-0000-4000-8000-000000000014",
          quantity: 1,
          from,
          to,
        },
        { context, request }
      )
    ).resolves.toEqual({
      ok: true,
      status: "duplicate",
      bookingId: "booking-a",
    });
    expect(enforceBorrowRateLimitMock).not.toHaveBeenCalled();
    expect(createBookingMock).not.toHaveBeenCalled();
  });

  it("rejects a reused token when the reviewed payload is changed", async () => {
    dbMock.ioioWriteOperation.findUnique.mockResolvedValue({
      id: "op-a",
      userId: auth.userId,
      organizationId: auth.organizationId,
      operationType: "BORROW_ITEM",
      status: "SUCCEEDED",
      assetId: asset.id,
      kitId: null,
      quantity: 1,
      from: new Date(from),
      to: new Date(to),
      bookingId: "booking-a",
      createdAt: new Date(),
    });

    await expect(
      borrowItem(
        {
          confirmationToken: "00000000-0000-4000-8000-000000000014",
          quantity: 2,
          from,
          to,
        },
        { context, request }
      )
    ).rejects.toMatchObject({ status: 409 });
    expect(enforceBorrowRateLimitMock).not.toHaveBeenCalled();
    expect(createBookingMock).not.toHaveBeenCalled();
  });

  it("rejects over-borrow before persisting a proposal", async () => {
    getIoioAvailabilityMock.mockResolvedValue({
      totalActive: 8,
      availableCount: 1,
      availableUnitIds: [],
      availableUnitIdsWithoutStaffReservations: [],
      conflicts: [],
      staffReservedCount: 0,
      staffReservationBookingIds: [],
      availableWithoutStaffReservations: 1,
    });

    await expect(
      prepareBorrowItem(
        {
          asset_id: asset.id,
          kit_id: null,
          quantity: 2,
          from,
          to,
        },
        { context, request }
      )
    ).rejects.toMatchObject({ status: 409 });
    expect(dbMock.ioioWriteOperation.create).not.toHaveBeenCalled();
  });

  it("rejects a fabricated or cross-organization asset reference", async () => {
    dbMock.asset.findFirst.mockResolvedValue(null);

    await expect(
      prepareBorrowItem(
        {
          asset_id: "asset-from-another-org",
          kit_id: null,
          quantity: 1,
          from,
          to,
        },
        { context, request }
      )
    ).rejects.toMatchObject({ status: 403 });
    expect(dbMock.asset.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "asset-from-another-org",
          organizationId: auth.organizationId,
        },
      })
    );
    expect(dbMock.ioioWriteOperation.create).not.toHaveBeenCalled();
  });

  it("lets Staff borrow approval-required assets directly", async () => {
    requireIoioBorrowerAccessMock.mockResolvedValue({ ...auth, role: "ADMIN" });
    dbMock.$queryRaw.mockResolvedValue([
      { id: "membership-a", roles: ["ADMIN"] },
    ]);
    dbMock.asset.findFirst.mockResolvedValue({
      ...asset,
      requiresBorrowApproval: true,
    });
    dbMock.ioioWriteOperation.findUnique.mockResolvedValue({
      id: "op-a",
      userId: "user-a",
      organizationId: "org-a",
      operationType: "BORROW_ITEM",
      status: "PREPARED",
      assetId: asset.id,
      kitId: null,
      quantity: 1,
      from: new Date(from),
      to: new Date(to),
      bookingId: null,
      createdAt: new Date(),
    });
    dbMock.booking.findFirst.mockResolvedValueOnce(null).mockResolvedValue({
      id: "booking-a",
      status: "DRAFT",
      bookingAssets: [
        { id: "booking-asset-a", assetId: asset.id, quantity: 1 },
      ],
    });
    createBookingMock.mockResolvedValue({ id: "booking-a" });
    updateBookingAssetsMock.mockResolvedValue(undefined);
    checkoutBookingMock.mockResolvedValue(undefined);

    await expect(
      borrowItem(
        {
          confirmationToken: "00000000-0000-4000-8000-000000000014",
          quantity: 1,
          from,
          to,
        },
        { context, request }
      )
    ).resolves.toMatchObject({ status: "submitted", bookingId: "booking-a" });
    expect(dbMock.ioioWriteOperation.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: "PENDING_APPROVAL", completedAt: null },
      })
    );
    expect(createBookingMock).toHaveBeenCalled();
    expect(createBookingMock).toHaveBeenCalledWith(
      expect.objectContaining({
        booking: expect.objectContaining({
          creatorId: auth.userId,
          custodianUserId: auth.userId,
          custodianTeamMemberId: "team-a",
          organizationId: auth.organizationId,
        }),
        assetIds: [asset.id],
      })
    );
  });

  it.each([
    {
      role: "SELF_SERVICE",
      name: "IOIO Student",
      teamMemberId: "student-team-member",
    },
    { role: "ADMIN", name: "IOIO Staff", teamMemberId: "staff-team-member" },
  ])(
    "creates an authorized $role borrower's missing Shelf team-member mapping",
    async ({ role, name, teamMemberId }) => {
      const borrowerAuth = { ...auth, role };
      requireIoioBorrowerAccessMock.mockResolvedValue(borrowerAuth);
      dbMock.$queryRaw.mockResolvedValue([
        { id: "membership-a", roles: [role] },
      ]);
      dbMock.teamMember.findFirst.mockResolvedValue(null);
      dbMock.user.findFirst.mockResolvedValue({
        displayName: name,
        firstName: null,
        lastName: null,
      });
      dbMock.teamMember.create.mockResolvedValue({ id: teamMemberId });

      await prepareBorrowItem(
        {
          asset_id: asset.id,
          kit_id: null,
          quantity: 1,
          from,
          to,
        },
        { context, request }
      );

      expect(dbMock.teamMember.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            name,
            organizationId: auth.organizationId,
            userId: auth.userId,
          }),
        })
      );
      expect(dbMock.$queryRaw).toHaveBeenCalled();
    }
  );

  it("does not create a borrow mapping for a user whose active membership lacks the role", async () => {
    dbMock.teamMember.findFirst.mockResolvedValue(null);
    dbMock.$queryRaw.mockResolvedValue([
      { id: "membership-a", roles: ["ADMIN"] },
    ]);

    await expect(
      prepareBorrowItem(
        { asset_id: asset.id, kit_id: null, quantity: 1, from, to },
        { context, request }
      )
    ).rejects.toThrow("active workspace membership could not be linked");
    expect(dbMock.teamMember.create).not.toHaveBeenCalled();
  });

  it("does not create a borrow mapping when there is no active workspace membership", async () => {
    dbMock.teamMember.findFirst.mockResolvedValue(null);
    dbMock.$queryRaw.mockResolvedValue([]);

    await expect(
      prepareBorrowItem(
        { asset_id: asset.id, kit_id: null, quantity: 1, from, to },
        { context, request }
      )
    ).rejects.toThrow("active workspace membership could not be linked");
    expect(dbMock.teamMember.create).not.toHaveBeenCalled();
  });

  it("requires an exact QR unit for every individually tracked product", async () => {
    const product = {
      ...asset,
      id: "product-a",
      title: "Makey Kit",
      type: "INDIVIDUAL" as const,
      quantity: null,
      assetModelId: "model-a",
    };
    const unit = {
      ...product,
      id: "unit-1",
      title: "Makey Kit #001",
      assetModelId: "model-a",
    };

    dbMock.asset.findFirst
      .mockResolvedValueOnce(product)
      .mockResolvedValueOnce(unit);
    dbMock.asset.findMany.mockResolvedValue([unit]);
    dbMock.qr.findFirst.mockResolvedValue({ assetId: unit.id });
    getIoioAvailabilityMock.mockResolvedValue({
      totalActive: 2,
      availableCount: 1,
      availableUnitIds: [unit.id],
      availableUnitIdsWithoutStaffReservations: [unit.id],
      conflicts: [],
      staffReservedCount: 0,
      staffReservationBookingIds: [],
      availableWithoutStaffReservations: 1,
    });

    await expect(
      prepareBorrowItem(
        {
          asset_id: product.id,
          candidate_asset_ids: ["unit-1", "unit-2"],
          scanned_asset_id: unit.id,
          scanned_qr_id: "qr-1",
          kit_id: null,
          quantity: 1,
          from,
          to,
        },
        { context, request }
      )
    ).resolves.toMatchObject({ asset: { id: unit.id, title: unit.title } });
  });

  it("rejects a selected physical unit when its submitted QR belongs elsewhere", async () => {
    const product = {
      ...asset,
      id: "product-a",
      title: "Makey Kit",
      type: "INDIVIDUAL" as const,
      quantity: null,
      assetModelId: "model-a",
    };
    const unit = {
      ...product,
      id: "unit-1",
      title: "Makey Kit #001",
      assetModelId: "model-a",
    };
    dbMock.asset.findFirst
      .mockResolvedValueOnce(product)
      .mockResolvedValueOnce(unit);
    dbMock.asset.findMany.mockResolvedValue([unit]);
    dbMock.qr.findFirst.mockResolvedValue(null);

    await expect(
      prepareBorrowItem(
        {
          asset_id: product.id,
          candidate_asset_ids: [unit.id],
          scanned_asset_id: unit.id,
          scanned_qr_id: "qr-from-another-unit",
          borrow_mode: "I_HAVE_ITEM",
          kit_id: null,
          quantity: 1,
        },
        { context, request }
      )
    ).rejects.toMatchObject({ status: 409 });
    expect(dbMock.ioioWriteOperation.create).not.toHaveBeenCalled();
  });

  it("does not let a scan from another checkout item select this unit", async () => {
    const product = {
      ...asset,
      id: "product-a",
      title: "Makey Kit",
      type: "INDIVIDUAL" as const,
      quantity: null,
      assetModelId: "model-a",
    };
    const expectedUnit = {
      ...product,
      id: "unit-1",
      title: "Makey Kit #001",
      assetModelId: "model-a",
    };
    dbMock.asset.findFirst.mockResolvedValueOnce(product);
    dbMock.asset.findMany.mockResolvedValue([expectedUnit]);

    await expect(
      prepareBorrowItem(
        {
          asset_id: product.id,
          candidate_asset_ids: [expectedUnit.id],
          scanned_asset_id: "unit-from-another-item",
          scanned_qr_id: "another-item-qr",
          borrow_mode: "I_HAVE_ITEM",
          kit_id: null,
          quantity: 1,
        },
        { context, request }
      )
    ).rejects.toMatchObject({ status: 409 });
    expect(dbMock.qr.findFirst).not.toHaveBeenCalled();
    expect(dbMock.ioioWriteOperation.create).not.toHaveBeenCalled();
  });

  it("confirms possession only for a scanned unit in the expected kit", async () => {
    const product = {
      ...asset,
      id: "product-a",
      title: "Makey Kit",
      type: "INDIVIDUAL" as const,
      quantity: null,
      assetModelId: null,
      assetKits: [{ kitId: "makey-kit", kit: { maxBorrowDays: 45 } }],
    };
    const unit = {
      ...product,
      id: "unit-1",
      title: "Makey Kit #001",
      assetKits: [{ kitId: "makey-kit" }],
    };
    dbMock.asset.findFirst
      .mockResolvedValueOnce(product)
      .mockResolvedValueOnce(unit);
    dbMock.asset.findMany.mockResolvedValue([unit]);
    dbMock.qr.findFirst.mockResolvedValue({ assetId: unit.id });
    getIoioAvailabilityMock.mockResolvedValue({
      totalActive: 1,
      availableCount: 1,
      availableUnitIds: [unit.id],
      availableUnitIdsWithoutStaffReservations: [unit.id],
      conflicts: [],
      staffReservedCount: 0,
      staffReservationBookingIds: [],
      staffReservationFrom: null,
      staffReservationTo: null,
      availableWithoutStaffReservations: 1,
    });

    await expect(
      prepareBorrowItem(
        {
          asset_id: product.id,
          candidate_asset_ids: [unit.id],
          scanned_asset_id: unit.id,
          scanned_qr_id: "makey-unit-qr",
          borrow_mode: "I_HAVE_ITEM",
          kit_id: null,
          quantity: 1,
        },
        { context, request }
      )
    ).resolves.toMatchObject({
      selectedPhysicalUnitIds: [unit.id],
      asset: { id: unit.id, title: unit.title },
      requiresStaffPreparation: false,
    });
  });

  it("rejects a scanned unit that belongs to a different kit", async () => {
    const product = {
      ...asset,
      id: "product-a",
      title: "Makey Kit",
      type: "INDIVIDUAL" as const,
      quantity: null,
      assetModelId: null,
      assetKits: [{ kitId: "makey-kit", kit: { maxBorrowDays: 45 } }],
    };
    const unit = {
      ...product,
      id: "unit-1",
      title: "Arduino Kit #001",
      assetKits: [{ kitId: "arduino-kit" }],
    };
    // The candidate query rejects this mismatched kit before loading the
    // scanned asset itself, so only the requested product is read here.
    dbMock.asset.findFirst.mockResolvedValueOnce(product);
    dbMock.qr.findFirst.mockResolvedValue({ assetId: unit.id });

    await expect(
      prepareBorrowItem(
        {
          asset_id: product.id,
          candidate_asset_ids: [unit.id],
          scanned_asset_id: unit.id,
          scanned_qr_id: "arduino-unit-qr",
          borrow_mode: "I_HAVE_ITEM",
          kit_id: null,
          quantity: 1,
        },
        { context, request }
      )
    ).rejects.toMatchObject({ status: 409 });
    expect(dbMock.ioioWriteOperation.create).not.toHaveBeenCalled();
  });

  it("rejects an individually tracked unit when Staff marked it unavailable", async () => {
    const product = {
      ...asset,
      id: "product-a",
      title: "Makey Kit",
      type: "INDIVIDUAL" as const,
      quantity: null,
      assetModelId: "model-a",
    };
    dbMock.asset.findFirst.mockResolvedValueOnce(product);
    dbMock.asset.findMany.mockResolvedValueOnce([
      {
        ...product,
        id: "unit-3",
        title: "Makey Kit #003",
        availableToBook: false,
        qrCodes: [{ id: "qr-3" }],
      },
    ]);

    await expect(
      resolvePhysicalUnitNumber(
        {
          assetId: product.id,
          candidateAssetIds: ["unit-3"],
          unitNumber: "003",
        },
        { context, request }
      )
    ).rejects.toMatchObject({
      message: "This item is currently out of service and cannot be borrowed.",
      status: 409,
    });
  });

  it("keeps exact-unit validation but skips Staff preparation when the Student has the item", async () => {
    const product = {
      ...asset,
      id: "product-a",
      title: "Makey Makey Kit",
      type: "INDIVIDUAL" as const,
      quantity: null,
      assetModelId: "model-a",
      requiresStaffPreparation: true,
      assetLocations: [{ location: { id: "location-a", name: "B477" } }],
    };
    const unit = {
      id: "unit-3",
      title: "Makey Makey Kit #003",
      status: "AVAILABLE" as const,
      availableToBook: true,
      assetModelId: "model-a",
      assetKits: [],
      qrCodes: [{ id: "qr-3" }],
      assetLocations: [{ location: { id: "location-a", name: "B477" } }],
    };
    dbMock.asset.findFirst
      .mockResolvedValueOnce(product)
      .mockResolvedValueOnce(unit);
    dbMock.asset.findMany.mockResolvedValue([unit]);
    dbMock.qr.findFirst.mockResolvedValue({ assetId: unit.id });
    getIoioAvailabilityMock.mockResolvedValue({
      totalActive: 1,
      availableCount: 1,
      availableUnitIds: [unit.id],
      availableUnitIdsWithoutStaffReservations: [unit.id],
      conflicts: [],
      staffReservedCount: 0,
      staffReservationBookingIds: [],
      staffReservationFrom: null,
      staffReservationTo: null,
      availableWithoutStaffReservations: 1,
    });

    await expect(
      prepareBorrowItem(
        {
          asset_id: product.id,
          candidate_asset_ids: [unit.id],
          scanned_asset_id: unit.id,
          scanned_qr_id: "qr-3",
          borrow_mode: "I_HAVE_ITEM",
          kit_id: null,
          quantity: 1,
        },
        { context, request }
      )
    ).resolves.toMatchObject({
      selectedPhysicalUnitIds: [unit.id],
      requiresStaffPreparation: false,
    });
    expect(dbMock.ioioWriteOperation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ source: "IOIO_HAVE_ITEM" }),
      })
    );
  });

  it("does not let I have the kit borrow a physical unit reported out of service", async () => {
    const product = {
      ...asset,
      id: "product-a",
      title: "Makey Makey Kit",
      type: "INDIVIDUAL" as const,
      quantity: null,
      assetModelId: "model-a",
    };
    const unit = {
      id: "unit-3",
      title: "Makey Makey Kit #003",
      status: "AVAILABLE" as const,
      availableToBook: false,
      assetModelId: "model-a",
      assetKits: [],
      qrCodes: [{ id: "qr-3" }],
    };
    dbMock.asset.findFirst
      .mockResolvedValueOnce(product)
      .mockResolvedValueOnce(unit);
    dbMock.asset.findMany.mockResolvedValue([unit]);
    dbMock.qr.findFirst.mockResolvedValue({ assetId: unit.id });
    getIoioAvailabilityMock.mockResolvedValue({
      totalActive: 1,
      availableCount: 0,
      availableUnitIds: [],
      availableUnitIdsWithoutStaffReservations: [],
      conflicts: [],
      staffReservedCount: 0,
      staffReservationBookingIds: [],
      staffReservationFrom: null,
      staffReservationTo: null,
      availableWithoutStaffReservations: 0,
    });

    await expect(
      prepareBorrowItem(
        {
          asset_id: product.id,
          candidate_asset_ids: [unit.id],
          scanned_asset_id: unit.id,
          scanned_qr_id: "qr-3",
          borrow_mode: "I_HAVE_ITEM",
          kit_id: null,
          quantity: 1,
        },
        { context, request }
      )
    ).rejects.toMatchObject({ status: 409 });
    expect(dbMock.ioioWriteOperation.create).not.toHaveBeenCalled();
  });

  it.each(["001", "#001"])(
    "resolves a scanned physical unit label in the %s format",
    async (unitNumber) => {
      const product = {
        ...asset,
        id: "product-a",
        title: "Makey Makey Kit",
        type: "INDIVIDUAL" as const,
        quantity: null,
        assetModelId: "model-a",
      };
      const unit = {
        id: "unit-1",
        title: "Makey Makey Kit #001",
        status: "AVAILABLE" as const,
        availableToBook: true,
        assetModelId: "model-a",
        assetKits: [],
        qrCodes: [{ id: "qr-1" }],
      };
      dbMock.asset.findFirst.mockResolvedValue(product);
      dbMock.asset.findMany.mockResolvedValue([unit]);
      getIoioAvailabilityMock.mockResolvedValue({
        totalActive: 1,
        availableCount: 1,
        availableUnitIds: [unit.id],
        availableUnitIdsWithoutStaffReservations: [unit.id],
        conflicts: [],
        staffReservedCount: 0,
        staffReservationBookingIds: [],
        availableWithoutStaffReservations: 1,
      });

      await expect(
        resolvePhysicalUnitNumber(
          {
            assetId: product.id,
            candidateAssetIds: [unit.id],
            unitNumber,
          },
          { context, request }
        )
      ).resolves.toMatchObject({
        physicalAssetId: unit.id,
        logicalProductId: product.id,
        displayUnitNumber: "#001",
        title: "Makey Makey Kit #001",
        qrId: "qr-1",
      });
      expect(enforceBorrowRateLimitMock).not.toHaveBeenCalled();
    }
  );

  it("does not create a proposal for an individual product without a scan", async () => {
    dbMock.asset.findFirst.mockResolvedValue({
      ...asset,
      type: "INDIVIDUAL",
      quantity: null,
      assetModelId: "model-a",
    });

    await expect(
      prepareBorrowItem(
        {
          asset_id: asset.id,
          candidate_asset_ids: ["unit-1"],
          borrow_mode: "I_HAVE_ITEM",
          kit_id: null,
          quantity: 1,
          from,
          to,
        },
        { context, request }
      )
    ).rejects.toMatchObject({
      status: 409,
      message: "Scan the physical unit QR before confirming this borrowing.",
    });
    expect(dbMock.ioioWriteOperation.create).not.toHaveBeenCalled();
  });

  it("derives the due date from the configured maximum instead of client dates", async () => {
    const returnAfterLimit = new Date(
      Date.now() + 46 * 24 * 60 * 60 * 1000
    ).toISOString();

    const proposal = await prepareBorrowItem(
      {
        asset_id: asset.id,
        kit_id: null,
        quantity: 1,
        from,
        to: returnAfterLimit,
      },
      { context, request }
    );
    expect(new Date(proposal.to).getTime()).toBeLessThanOrEqual(
      Date.now() + 45 * 24 * 60 * 60 * 1000 + 24 * 60 * 60 * 1000
    );
  });
});
