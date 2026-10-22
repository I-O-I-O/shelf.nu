// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "~/database/db.server";
import { getAssetAvailabilityBatch } from "~/modules/asset/availability.server";
import { resolveAssetImagesForPresentation } from "~/modules/asset/service.server";
import { getIoioArchivedItemIds } from "~/modules/ioio-staff/archive.server";
import { refreshExpiredKitImages } from "~/modules/kit/service.server";
import { getLocationDescendantIds } from "~/modules/location/descendants.server";
import { getIoioAvailability } from "./availability.server";
import {
  getMyStudentLoans,
  getStudentAsset,
  getStudentAssets,
  getStudentKits,
  getStudentLocations,
} from "./service.server";

vi.mock("~/database/db.server", () => ({
  db: {
    asset: { findFirst: vi.fn(), findMany: vi.fn() },
    booking: { findMany: vi.fn() },
    kit: { findMany: vi.fn() },
    location: { findMany: vi.fn() },
    teamMember: { findMany: vi.fn() },
  },
}));
vi.mock("~/modules/asset/availability.server", () => ({
  getAssetAvailabilityBatch: vi.fn(),
}));
vi.mock("~/modules/location/descendants.server", () => ({
  getLocationDescendantIds: vi.fn(),
}));
vi.mock("./availability.server", () => ({
  getIoioAvailability: vi.fn(() =>
    Promise.resolve({ availableUnitIdsWithoutStaffReservations: ["unit-001"] })
  ),
  IOIO_STAFF_RESERVATION_DESCRIPTION: "IOIO staff reservation",
}));
vi.mock("~/modules/asset/service.server", () => ({
  resolveAssetImagesForPresentation: vi.fn((rows) => Promise.resolve(rows)),
}));
vi.mock("~/modules/ioio-staff/archive.server", () => ({
  getIoioArchivedItemIds: vi.fn(),
  IOIO_ARCHIVE_ITEM_TYPE: { ASSET: "ASSET", KIT: "KIT" },
}));
vi.mock("~/modules/kit/service.server", () => ({
  refreshExpiredKitImages: vi.fn((rows) => Promise.resolve(rows)),
}));

describe("student catalog source selectors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getLocationDescendantIds).mockReset();
    vi.mocked(getIoioArchivedItemIds).mockImplementation(({ itemType }) =>
      Promise.resolve(
        itemType === "ASSET" ? ["archived-asset"] : ["archived-kit"]
      )
    );
  });

  it("hides standalone and model-linked products from student discovery only", async () => {
    const makeAsset = (
      id: string,
      options: {
        ioioHidden?: boolean;
        modelHidden?: boolean;
        assetModelId?: string | null;
      } = {}
    ) => ({
      id,
      organizationId: "org-1",
      title: id,
      description: null,
      mainImage: null,
      mainImageExpiration: null,
      thumbnailImage: null,
      updatedAt: new Date("2026-10-01T00:00:00.000Z"),
      assetModelId: options.assetModelId ?? null,
      ioioHidden: options.ioioHidden ?? false,
      assetModel: options.assetModelId
        ? {
            id: options.assetModelId,
            name: "Grouped product",
            organizationId: "org-1",
            ioioHidden: options.modelHidden ?? false,
            image: null,
            thumbnailImage: null,
          }
        : null,
      status: "AVAILABLE",
      type: "QUANTITY_TRACKED",
      quantity: 5,
      availableToBook: true,
      maxBorrowDays: 45,
      extensionBorrowDays: null,
      requiresBorrowApproval: false,
      requiresStaffPreparation: false,
      sequentialId: null,
      category: null,
      assetLocations: [],
      assetKits: [],
      qrCodes: [],
    });
    vi.mocked(db.asset.findMany).mockResolvedValue([
      makeAsset("visible"),
      makeAsset("hidden-asset", { ioioHidden: true }),
      makeAsset("hidden-model-unit", {
        assetModelId: "hidden-model",
        modelHidden: true,
      }),
    ] as never);
    vi.mocked(getAssetAvailabilityBatch).mockResolvedValue(
      new Map([
        ["visible", { physicalAvailable: 5, bookable: 5 } as never],
        ["hidden-asset", { physicalAvailable: 5, bookable: 5 } as never],
        ["hidden-model-unit", { physicalAvailable: 5, bookable: 5 } as never],
      ])
    );

    const studentAssets = await getStudentAssets({ organizationId: "org-1" });
    const staffAssets = await getStudentAssets({
      organizationId: "org-1",
      includeHidden: true,
    });

    expect(studentAssets.map(({ id }) => id)).toEqual(["visible"]);
    expect(staffAssets.map(({ id }) => id)).toEqual([
      "visible",
      "hidden-asset",
      "hidden-model-unit",
    ]);
    expect(
      staffAssets.slice(1).map(({ availableQuantity }) => availableQuantity)
    ).toEqual([5, 5]);
  });

  it("does not resolve a hidden asset through direct student detail access", async () => {
    vi.mocked(db.asset.findFirst).mockResolvedValue({
      id: "hidden-asset",
      organizationId: "org-1",
      ioioHidden: true,
      assetModel: null,
    } as never);

    const asset = await getStudentAsset({
      organizationId: "org-1",
      assetId: "hidden-asset",
    });

    expect(asset).toBeNull();
  });

  it("uses the same org-scoped Shelf asset records and physical availability as Staff", async () => {
    vi.mocked(db.asset.findMany).mockResolvedValue([
      {
        id: "asset-1",
        organizationId: "org-1",
        title: "Arduino Nano",
        description: "Current description",
        mainImage: "https://images.example/nano.jpg",
        mainImageExpiration: null,
        thumbnailImage: null,
        updatedAt: new Date("2026-09-01T00:00:00.000Z"),
        assetModelId: null,
        assetModel: null,
        status: "AVAILABLE",
        type: "QUANTITY_TRACKED",
        quantity: 8,
        availableToBook: true,
        sequentialId: "SAM-0001",
        category: {
          id: "category-1",
          name: "Boards & Embedded Systems",
          color: "#123456",
          organizationId: "org-1",
        },
        assetLocations: [
          {
            quantity: 8,
            location: {
              id: "shelf-1",
              name: "Shelf A1",
              parentId: "room-1",
              organizationId: "org-1",
            },
          },
        ],
        assetKits: [],
        qrCodes: [{ id: "qr-1", organizationId: "org-1" }],
      },
    ] as never);
    vi.mocked(getAssetAvailabilityBatch).mockResolvedValue(
      new Map([["asset-1", { physicalAvailable: 5, bookable: 3 } as never]])
    );

    const assets = await getStudentAssets({ organizationId: "org-1" });

    expect(db.asset.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: "org-1", id: { notIn: ["archived-asset"] } },
        select: expect.objectContaining({
          organizationId: true,
          mainImage: true,
          mainImageExpiration: true,
          mainImageStoragePath: true,
          thumbnailImageStoragePath: true,
          assetModel: expect.objectContaining({
            select: expect.objectContaining({
              id: true,
              name: true,
              imageStoragePath: true,
              thumbnailImageStoragePath: true,
            }),
          }),
        }),
      })
    );
    expect(getAssetAvailabilityBatch).toHaveBeenCalledWith(["asset-1"], {
      organizationId: "org-1",
      window: expect.objectContaining({
        from: expect.any(Date),
        to: expect.any(Date),
      }),
    });
    expect(resolveAssetImagesForPresentation).toHaveBeenCalledTimes(1);
    expect(assets[0]).toMatchObject({
      id: "asset-1",
      title: "Arduino Nano",
      mainImage: "https://images.example/nano.jpg",
      quantity: 8,
      availableQuantity: 3,
      category: { id: "category-1", name: "Boards & Embedded Systems" },
      locations: [{ id: "shelf-1", name: "Shelf A1", quantity: 8 }],
      qrIds: ["qr-1"],
    });
    expect(assets[0]).not.toHaveProperty("organizationId");
    expect(assets[0].category).not.toHaveProperty("organizationId");
  });

  it.each([
    ["ioio-room", ["ioio-room", "section-a", "shelf-a1", "container-a1-1"]],
    ["storage-room", ["storage-room", "storage-section", "storage-shelf"]],
    [
      "soldering-room",
      ["soldering-room", "soldering-section", "soldering-cabinet"],
    ],
  ])(
    "filters %s through its canonical Shelf descendant tree",
    async (roomId, descendantIds) => {
      vi.mocked(getLocationDescendantIds).mockResolvedValue(descendantIds);
      vi.mocked(db.asset.findMany).mockResolvedValue([] as never);
      vi.mocked(getAssetAvailabilityBatch).mockResolvedValue(new Map());

      await getStudentAssets({
        organizationId: "org-1",
        categoryId: "category-tools",
        locationId: roomId,
      });

      expect(getLocationDescendantIds).toHaveBeenCalledWith({
        organizationId: "org-1",
        locationId: roomId,
      });
      expect(db.asset.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            organizationId: "org-1",
            categoryId: "category-tools",
            assetLocations: {
              some: { locationId: { in: descendantIds } },
            },
          }),
        })
      );
    }
  );

  it("does not restrict location when All areas is selected", async () => {
    vi.mocked(db.asset.findMany).mockResolvedValue([] as never);
    vi.mocked(getAssetAvailabilityBatch).mockResolvedValue(new Map());

    await getStudentAssets({ organizationId: "org-1" });

    expect(getLocationDescendantIds).not.toHaveBeenCalled();
    expect(db.asset.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.not.objectContaining({
          assetLocations: expect.anything(),
        }),
      })
    );
  });

  it("keeps the AssetModel grouping key without leaking a foreign model's display fields", async () => {
    vi.mocked(db.asset.findMany).mockResolvedValue([
      {
        id: "unit-001",
        organizationId: "org-1",
        title: "Makey Kit #001",
        description: null,
        mainImage: null,
        mainImageExpiration: null,
        thumbnailImage: null,
        updatedAt: new Date("2026-09-01T00:00:00.000Z"),
        assetModelId: "logical-model-1",
        assetModel: {
          id: "logical-model-1",
          name: "Foreign Model Name",
          organizationId: "another-org",
          image: "https://foreign.example/private-cover.jpg",
          thumbnailImage: null,
        },
        status: "AVAILABLE",
        type: "INDIVIDUAL",
        quantity: null,
        availableToBook: true,
        sequentialId: null,
        category: null,
        assetLocations: [],
        assetKits: [],
        qrCodes: [],
      },
    ] as never);
    vi.mocked(getAssetAvailabilityBatch).mockResolvedValue(
      new Map([["unit-001", { physicalAvailable: 1 } as never]])
    );

    const assets = await getStudentAssets({ organizationId: "org-1" });

    expect(assets[0]).toMatchObject({
      assetModelId: "logical-model-1",
      assetModel: null,
    });
    expect(JSON.stringify(assets)).not.toContain("Foreign Model Name");
    expect(JSON.stringify(assets)).not.toContain("foreign.example");
  });

  it("returns canonical AssetModel and native Kit images resolved by the shared Shelf resolver", async () => {
    const rows = [
      {
        id: "kit-unit-1",
        organizationId: "org-1",
        title: "Makey Kit #001",
        description: null,
        mainImage: null,
        mainImageExpiration: null,
        thumbnailImage: null,
        mainImageStoragePath: null,
        thumbnailImageStoragePath: null,
        updatedAt: new Date("2026-09-01T00:00:00.000Z"),
        assetModelId: "makey-model",
        assetModel: {
          id: "makey-model",
          name: "Makey Kit",
          organizationId: "org-1",
          image: null,
          thumbnailImage: null,
          imageStoragePath: "org-1/makey/model.jpg",
          thumbnailImageStoragePath: "org-1/makey/thumb.jpg",
        },
        status: "AVAILABLE",
        type: "INDIVIDUAL",
        quantity: null,
        availableToBook: true,
        sequentialId: null,
        category: null,
        assetLocations: [],
        assetKits: [
          {
            quantity: 1,
            kit: {
              id: "makey-kit",
              name: "Makey Kit",
              image: null,
              imageExpiration: null,
              imageStoragePath: "org-1/makey/kit-cover.jpg",
              maxBorrowDays: 45,
              extensionBorrowDays: null,
              locationId: null,
              organizationId: "org-1",
            },
          },
        ],
        qrCodes: [],
      },
    ];
    vi.mocked(db.asset.findMany).mockResolvedValue(rows as never);
    vi.mocked(getAssetAvailabilityBatch).mockResolvedValue(
      new Map([["kit-unit-1", { physicalAvailable: 1 } as never]])
    );
    vi.mocked(resolveAssetImagesForPresentation).mockImplementationOnce(
      (input) =>
        Promise.resolve(
          input.map((row) => {
            const asset = row as (typeof rows)[number];
            return {
              ...asset,
              assetModel: asset.assetModel
                ? {
                    ...asset.assetModel,
                    image: "https://storage.example/makey/model.jpg",
                    thumbnailImage: "https://storage.example/makey/thumb.jpg",
                  }
                : null,
              assetKits: asset.assetKits.map((relation) => ({
                ...relation,
                kit: {
                  ...relation.kit,
                  image: "https://storage.example/makey/kit-cover.jpg",
                },
              })),
            };
          }) as never
        )
    );

    const assets = await getStudentAssets({
      organizationId: "org-1",
      query: "Makey Kit",
    });

    expect(db.asset.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            {
              assetModel: {
                is: {
                  organizationId: "org-1",
                  name: { contains: "Makey Kit", mode: "insensitive" },
                },
              },
            },
          ]),
        }),
      })
    );
    expect(assets[0]).toMatchObject({
      assetModelId: "makey-model",
      assetModel: {
        image: "https://storage.example/makey/model.jpg",
        thumbnailImage: "https://storage.example/makey/thumb.jpg",
      },
      kitImage: "https://storage.example/makey/kit-cover.jpg",
      kits: [{ image: "https://storage.example/makey/kit-cover.jpg" }],
    });
  });

  it("uses the shared IOIO availability for the same physical kit units shown by Staff", async () => {
    const rows = ["001", "002", "003", "004", "005"].map((unit) => ({
      id: `unit-${unit}`,
      organizationId: "org-1",
      title: `Makey Kit #${unit}`,
      description: null,
      mainImage: null,
      mainImageExpiration: null,
      thumbnailImage: null,
      mainImageStoragePath: null,
      thumbnailImageStoragePath: null,
      updatedAt: new Date("2026-09-01T00:00:00.000Z"),
      assetModelId: "makey-model",
      assetModel: {
        id: "makey-model",
        name: "Makey Kit",
        organizationId: "org-1",
        image: null,
        thumbnailImage: null,
        imageStoragePath: null,
        thumbnailImageStoragePath: null,
      },
      status: "AVAILABLE",
      type: "INDIVIDUAL",
      quantity: null,
      availableToBook: true,
      maxBorrowDays: 45,
      sequentialId: null,
      category: null,
      assetLocations: [],
      assetKits: [],
      qrCodes: [],
    }));
    vi.mocked(db.asset.findMany).mockResolvedValue(rows as never);
    vi.mocked(getIoioAvailability).mockResolvedValue({
      availableUnitIdsWithoutStaffReservations: [
        "unit-001",
        "unit-002",
        "unit-003",
      ],
    } as never);

    const assets = await getStudentAssets({ organizationId: "org-1" });

    expect(getIoioAvailability).toHaveBeenCalledTimes(1);
    expect(getIoioAvailability).toHaveBeenCalledWith({
      organizationId: "org-1",
      productId: "unit-001",
      candidateAssetIds: rows.map(({ id }) => id),
      from: expect.any(Date),
      to: expect.any(Date),
    });
    expect(assets.map(({ availableQuantity }) => availableQuantity)).toEqual([
      1, 1, 1, 0, 0,
    ]);

    vi.mocked(getIoioAvailability).mockResolvedValue({
      availableUnitIdsWithoutStaffReservations: rows.map(({ id }) => id),
    } as never);
    const allAvailableAssets = await getStudentAssets({
      organizationId: "org-1",
    });
    expect(
      allAvailableAssets.map(({ availableQuantity }) => availableQuantity)
    ).toEqual([1, 1, 1, 1, 1]);
  });

  it("builds Student locations from current hierarchical rows, images, and active asset placements", async () => {
    vi.mocked(db.location.findMany).mockResolvedValue([
      {
        id: "room-1",
        name: "IOIO Lab - B477",
        parentId: null,
        imageUrl:
          "https://supabase-project.supabase.co/storage/v1/object/public/files/room.jpg",
        thumbnailUrl: "https://images.example/room-thumb.jpg",
      },
      {
        id: "shelf-1",
        name: "Shelf A1",
        parentId: "room-1",
        imageUrl: null,
        thumbnailUrl: null,
      },
    ] as never);
    vi.mocked(db.asset.findMany).mockResolvedValue([
      { assetLocations: [{ locationId: "shelf-1" }] },
    ] as never);

    const locations = await getStudentLocations({ organizationId: "org-1" });

    expect(db.asset.findMany).toHaveBeenCalledWith({
      where: { organizationId: "org-1", id: { notIn: ["archived-asset"] } },
      select: {
        ioioHidden: true,
        assetModel: {
          select: { organizationId: true, ioioHidden: true },
        },
        assetLocations: { select: { locationId: true } },
      },
    });
    expect(locations).toMatchObject([
      {
        id: "room-1",
        name: "IOIO Lab - B477",
        imageUrl:
          "https://supabase-project.supabase.co/storage/v1/object/public/files/room.jpg",
        children: [{ id: "shelf-1", assetCount: 1 }],
      },
    ]);
  });

  it("returns native active Shelf Kits with current image, canonical name, safe contents, and shared availability", async () => {
    vi.mocked(db.kit.findMany).mockResolvedValue([
      {
        id: "kit-1",
        organizationId: "org-1",
        name: "Arduino Kit - #014 Board",
        status: "AVAILABLE",
        image: "https://images.example/kit.jpg",
        imageExpiration: null,
        location: {
          id: "room-1",
          name: "IOIO Lab - B477",
          organizationId: "org-1",
        },
        qrCodes: [{ id: "kit-qr", organizationId: "org-1" }],
        assetKits: [
          {
            quantity: 1,
            asset: {
              id: "member-1",
              organizationId: "org-1",
              title: "Arduino Nano",
              type: "INDIVIDUAL",
              quantity: null,
              availableToBook: true,
            },
          },
          {
            quantity: 1,
            asset: {
              id: "archived-asset",
              organizationId: "org-1",
              title: "Archived board",
              type: "INDIVIDUAL",
              quantity: null,
              availableToBook: true,
            },
          },
          {
            quantity: 1,
            asset: {
              id: "hidden-asset",
              organizationId: "org-1",
              title: "Hidden board",
              type: "INDIVIDUAL",
              quantity: null,
              availableToBook: true,
              ioioHidden: true,
              assetModelId: null,
              assetModel: null,
            },
          },
          {
            quantity: 1,
            asset: {
              id: "foreign-asset",
              organizationId: "org-2",
              title: "Foreign asset",
              type: "INDIVIDUAL",
              quantity: null,
              availableToBook: true,
            },
          },
        ],
      },
    ] as never);

    const kits = await getStudentKits({ organizationId: "org-1" });

    expect(db.kit.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: "org-1", id: { notIn: ["archived-kit"] } },
        select: expect.objectContaining({ image: true, imageExpiration: true }),
      })
    );
    expect(refreshExpiredKitImages).toHaveBeenCalledTimes(1);
    expect(kits[0]).toMatchObject({
      id: "kit-1",
      name: "Arduino Kit",
      image: "https://images.example/kit.jpg",
      location: { id: "room-1", name: "IOIO Lab - B477" },
      availableToBook: true,
      assetKits: [
        {
          quantity: 1,
          asset: { id: "member-1", title: "Arduino Nano" },
        },
      ],
    });
    expect(kits[0]).not.toHaveProperty("organizationId");
    expect(kits[0].assetKits[0]?.asset).not.toHaveProperty("organizationId");
    expect(kits[0].assetKits.map(({ asset }) => asset.id)).toEqual([
      "member-1",
    ]);
  });
});

describe("student Loans quantity representation", () => {
  it("scopes personal loans to the supplied Staff borrower identity", async () => {
    vi.mocked(db.teamMember.findMany).mockResolvedValue([] as never);
    vi.mocked(db.booking.findMany).mockResolvedValue([] as never);

    await getMyStudentLoans({
      organizationId: "org-1",
      userId: "staff-1",
      includePast: true,
    });

    expect(db.booking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: "org-1",
          AND: expect.arrayContaining([
            expect.objectContaining({ OR: [{ custodianUserId: "staff-1" }] }),
          ]),
        }),
      })
    );
  });

  it("keeps an existing loan visible when its product is hidden", async () => {
    const hiddenLoan = {
      id: "hidden-product-loan",
      name: "IOIO borrow — Makey Kit",
      status: "ONGOING",
      from: new Date("2026-10-20T09:00:00.000Z"),
      to: new Date("2026-11-20T17:00:00.000Z"),
      bookingAssets: [
        {
          id: "hidden-product-booking-asset",
          quantity: 1,
          checkedOutAt: new Date("2026-10-20T09:00:00.000Z"),
          checkedInAt: null,
          sourceKitId: null,
          asset: {
            id: "hidden-product",
            title: "Makey Kit",
            type: "QUANTITY_TRACKED",
            sequentialId: null,
            maxBorrowDays: 45,
            extensionBorrowDays: null,
            returnHandling: "RETURN_TO_SHELF",
            mainImage: null,
            thumbnailImage: null,
            mainImageStoragePath: null,
            thumbnailImageStoragePath: null,
            assetModel: null,
            assetLocations: [],
          },
        },
      ],
      consumptionLogs: [],
    };
    vi.mocked(db.teamMember.findMany).mockResolvedValue([] as never);
    vi.mocked(db.booking.findMany).mockResolvedValue([hiddenLoan] as never);

    const loans = await getMyStudentLoans({
      organizationId: "org-1",
      userId: "student-1",
    });

    expect(loans).toHaveLength(1);
    expect(loans[0]).toMatchObject({
      id: "hidden-product-loan",
      bookingAssets: [{ asset: { id: "hidden-product", title: "Makey Kit" } }],
    });
  });

  it("keeps repeated same-item preparation reservations as separate loan requests", async () => {
    const from = new Date("2026-10-20T09:00:00.000Z");
    const to = new Date("2026-11-20T17:00:00.000Z");
    const unit = (id: string) => ({
      id,
      title: "Makey Kit",
      type: "INDIVIDUAL",
      sequentialId: id,
      maxBorrowDays: 45,
      extensionBorrowDays: null,
      returnHandling: "RETURN_TO_SHELF",
      mainImage: null,
      thumbnailImage: null,
      mainImageStoragePath: null,
      thumbnailImageStoragePath: null,
      assetModel: null,
      assetLocations: [],
    });
    const requestBooking = (id: string, unitId: string) => ({
      id,
      name: "IOIO borrow — Makey Kit",
      status: "RESERVED",
      from,
      to,
      bookingAssets: [
        {
          id: `${id}-asset`,
          quantity: 1,
          checkedOutAt: null,
          checkedInAt: null,
          sourceKitId: null,
          asset: unit(unitId),
        },
      ],
      consumptionLogs: [],
    });
    vi.mocked(db.teamMember.findMany).mockResolvedValue([] as never);
    vi.mocked(db.kit.findMany).mockResolvedValue([] as never);
    vi.mocked(db.booking.findMany).mockResolvedValue([
      requestBooking("request-booking-1", "makey-unit-001"),
      requestBooking("request-booking-2", "makey-unit-002"),
    ] as never);

    const loans = await getMyStudentLoans({
      organizationId: "org-1",
      userId: "student-1",
    });

    expect(loans.map(({ id }) => id)).toEqual([
      "request-booking-1",
      "request-booking-2",
    ]);
    expect(
      loans.reduce(
        (total, loan) =>
          total +
          loan.bookingAssets.reduce((sum, item) => sum + item.quantity, 0),
        0
      )
    ).toBe(2);
  });

  it("keeps quantity-pool units and mixed assets independent in one loan", async () => {
    const borrowedAt = new Date("2026-10-20T09:00:00.000Z");
    const dueAt = new Date("2026-11-20T17:00:00.000Z");
    const makeQuantityAsset = (id: string, title: string) => ({
      id,
      title,
      type: "QUANTITY_TRACKED",
      sequentialId: null,
      maxBorrowDays: 45,
      extensionBorrowDays: null,
      returnHandling: "RETURN_TO_SHELF",
      mainImage: null,
      thumbnailImage: null,
      mainImageStoragePath: null,
      thumbnailImageStoragePath: null,
      assetModel: null,
      assetLocations: [],
    });
    vi.mocked(db.teamMember.findMany).mockResolvedValue([] as never);
    vi.mocked(db.kit.findMany).mockResolvedValue([] as never);
    vi.mocked(db.booking.findMany).mockResolvedValue([
      {
        id: "mixed-loan",
        name: "IOIO borrow — Makey Kit",
        status: "ONGOING",
        from: borrowedAt,
        to: dueAt,
        bookingAssets: [
          {
            id: "makey-booking-asset",
            quantity: 2,
            checkedOutAt: borrowedAt,
            checkedInAt: null,
            sourceKitId: null,
            asset: makeQuantityAsset("makey-kit", "Makey Kit"),
          },
          {
            id: "motor-booking-asset",
            quantity: 1,
            checkedOutAt: borrowedAt,
            checkedInAt: null,
            sourceKitId: null,
            asset: makeQuantityAsset("motor", "Motor"),
          },
        ],
        consumptionLogs: [],
      },
    ] as never);

    const loans = await getMyStudentLoans({
      organizationId: "org-1",
      userId: "student-1",
    });

    expect(loans[0]?.bookingAssets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          asset: expect.objectContaining({ id: "makey-kit" }),
          quantity: 2,
          borrowedQuantity: 2,
          outstandingQuantity: 2,
        }),
        expect.objectContaining({
          asset: expect.objectContaining({ id: "motor" }),
          quantity: 1,
          borrowedQuantity: 1,
          outstandingQuantity: 1,
        }),
      ])
    );
  });
});
