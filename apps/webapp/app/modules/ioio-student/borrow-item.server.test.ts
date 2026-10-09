import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
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
const requireStudentReadMock = vi.hoisted(() => vi.fn());
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
  requireStudentRead: requireStudentReadMock,
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
  Logger: { info: vi.fn(), warn: vi.fn() },
}));

import {
  borrowItem,
  acknowledgeBorrowItemStaffReservation,
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
    requireStudentReadMock.mockResolvedValue(auth);
    dbMock.asset.findFirst.mockResolvedValue(asset);
    dbMock.asset.findMany.mockResolvedValue([]);
    dbMock.ioioArchivedItem.findMany.mockResolvedValue([]);
    dbMock.bookingAsset.findMany.mockResolvedValue([]);
    dbMock.teamMember.findFirst.mockResolvedValue({ id: "team-a" });
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

  it("stores a preparation request against the logical product without assigning a physical unit", async () => {
    dbMock.asset.findFirst.mockResolvedValue({
      ...asset,
      requiresStaffPreparation: true,
      maxBorrowDays: 45,
    });
    dbMock.ioioWriteOperation.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "op-a" });

    await requestPreparationForItem(
      { assetId: asset.id, quantity: 1 },
      { context, request }
    );

    expect(dbMock.ioioWriteOperation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: auth.organizationId,
          source: "IOIO_PREPARATION_REQUEST",
          status: "PENDING_PREPARATION",
          assetId: asset.id,
          selectedAssetIds: [asset.id],
          quantity: 1,
        }),
      })
    );
    expect(createBookingMock).not.toHaveBeenCalled();
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

  it("persists an acknowledged course overlap on the preparation request", async () => {
    dbMock.asset.findFirst.mockResolvedValue({
      ...asset,
      requiresStaffPreparation: true,
      maxBorrowDays: 45,
    });
    dbMock.ioioWriteOperation.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "op-a" });
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

    await requestPreparationForItem(
      {
        assetId: asset.id,
        quantity: 1,
        acknowledgeStaffReservationOverlap: true,
      },
      { context, request }
    );

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

  it("does not reuse an assigned request after its pickup task is finished", async () => {
    dbMock.asset.findFirst.mockResolvedValue({
      ...asset,
      requiresStaffPreparation: true,
      maxBorrowDays: 45,
    });
    dbMock.ioioWriteOperation.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "op-a" });
    dbMock.ioioWriteOperation.findMany.mockResolvedValue([
      {
        id: "old-assigned-request",
        bookingId: "old-booking",
        quantity: 1,
        selectedAssetIds: [asset.id],
      },
    ]);
    dbMock.booking.findFirst.mockResolvedValue(null);

    const result = await requestPreparationForItem(
      { assetId: asset.id, quantity: 1 },
      { context, request }
    );

    expect(result).toMatchObject({ requestId: "op-a", status: "requested" });
    expect(dbMock.ioioWriteOperation.create).toHaveBeenCalledOnce();
  });

  it("reuses an assigned request while its reserved pickup task is active", async () => {
    dbMock.asset.findFirst.mockResolvedValue({
      ...asset,
      requiresStaffPreparation: true,
      maxBorrowDays: 45,
    });
    dbMock.ioioWriteOperation.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "active-preparation-task" });
    dbMock.ioioWriteOperation.findMany.mockResolvedValue([
      {
        id: "assigned-request",
        bookingId: "reserved-booking",
        quantity: 1,
        selectedAssetIds: [asset.id],
      },
    ]);
    dbMock.booking.findFirst.mockResolvedValue({ id: "reserved-booking" });

    const result = await requestPreparationForItem(
      { assetId: asset.id, quantity: 1 },
      { context, request }
    );

    expect(result).toMatchObject({
      requestId: "assigned-request",
      duplicate: true,
    });
    expect(dbMock.ioioWriteOperation.create).not.toHaveBeenCalled();
  });

  it("reuses an equivalent active preparation request instead of creating a duplicate", async () => {
    dbMock.asset.findFirst.mockResolvedValue({
      ...asset,
      requiresStaffPreparation: true,
      maxBorrowDays: 45,
    });
    dbMock.ioioWriteOperation.findFirst.mockResolvedValue({
      id: "existing-preparation-request",
      quantity: 1,
      selectedAssetIds: [asset.id],
    });

    const result = await requestPreparationForItem(
      { assetId: asset.id, quantity: 1 },
      { context, request }
    );

    expect(result).toMatchObject({
      status: "requested",
      requestId: "existing-preparation-request",
      duplicate: true,
    });
    expect(dbMock.ioioWriteOperation.create).not.toHaveBeenCalled();
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
    requireStudentReadMock.mockResolvedValue({ ...auth, role: "ADMIN" });
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
  });

  it("creates the missing Shelf team-member mapping for Staff borrowing", async () => {
    requireStudentReadMock.mockResolvedValue({ ...auth, role: "ADMIN" });
    dbMock.teamMember.findFirst.mockResolvedValue(null);
    dbMock.user.findFirst.mockResolvedValue({
      displayName: "IOIO Staff",
      firstName: null,
      lastName: null,
    });
    dbMock.teamMember.create.mockResolvedValue({ id: "staff-team-member" });

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
          name: "IOIO Staff",
          organization: { connect: { id: auth.organizationId } },
          user: { connect: { id: auth.userId } },
        }),
      })
    );
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
      message:
        "Makey Kit #003 is temporarily unavailable and cannot be borrowed. Ask a TA if you think this kit should be available.",
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

  it.each(["001", "#001"])(
    "resolves a physical unit number entered as %s against the selected product",
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
          kit_id: null,
          quantity: 1,
          from,
          to,
        },
        { context, request }
      )
    ).rejects.toMatchObject({ status: 409 });
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
