// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "~/database/db.server";
import { getAssetAvailabilityBatch } from "~/modules/asset/availability.server";
import { resolveAssetImagesForPresentation } from "~/modules/asset/service.server";
import { getIoioArchivedItemIds } from "~/modules/ioio-staff/archive.server";
import { refreshExpiredKitImages } from "~/modules/kit/service.server";
import {
  getStudentAssets,
  getStudentKits,
  getStudentLocations,
} from "./service.server";

vi.mock("~/database/db.server", () => ({
  db: {
    asset: { findMany: vi.fn() },
    kit: { findMany: vi.fn() },
    location: { findMany: vi.fn() },
  },
}));
vi.mock("~/modules/asset/availability.server", () => ({
  getAssetAvailabilityBatch: vi.fn(),
}));
vi.mock("~/modules/asset/individual-product-quantity.server", () => ({
  getIndividualUnitAvailability: vi.fn(() => Promise.resolve({ available: 1 })),
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
    vi.mocked(getIoioArchivedItemIds).mockImplementation(({ itemType }) =>
      Promise.resolve(
        itemType === "ASSET" ? ["archived-asset"] : ["archived-kit"]
      )
    );
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
      new Map([["asset-1", { physicalAvailable: 5 } as never]])
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
      window: null,
    });
    expect(resolveAssetImagesForPresentation).toHaveBeenCalledTimes(1);
    expect(assets[0]).toMatchObject({
      id: "asset-1",
      title: "Arduino Nano",
      mainImage: "https://images.example/nano.jpg",
      quantity: 8,
      availableQuantity: 5,
      category: { id: "category-1", name: "Boards & Embedded Systems" },
      locations: [{ id: "shelf-1", name: "Shelf A1", quantity: 8 }],
      qrIds: ["qr-1"],
    });
    expect(assets[0]).not.toHaveProperty("organizationId");
    expect(assets[0].category).not.toHaveProperty("organizationId");
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
      select: { assetLocations: { select: { locationId: true } } },
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
  });
});
