import { describe, expect, it } from "vitest";
import type { StudentAsset } from "~/modules/ioio-student/service.server";
import {
  asksForPhysicalUnits,
  filterStudentInventory,
  groupStudentAssets,
  getStudentLabAreaFilters,
  requestsStudentAssistantAssetCards,
  selectStudentAssistantDisplayAssets,
} from "./inventory-presentation";

function asset(overrides: Partial<StudentAsset>): StudentAsset {
  return {
    id: "asset-id",
    title: "Teensy 4.1",
    description: null,
    mainImage: null,
    mainImageExpiration: null,
    thumbnailImage: null,
    assetModel: null,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    assetModelId: null,
    status: "AVAILABLE",
    type: "QUANTITY_TRACKED",
    quantity: 1,
    availableQuantity: 1,
    availableToBook: true,
    sequentialId: null,
    category: null,
    locations: [],
    kits: [],
    qrIds: [],
    ...overrides,
  } as StudentAsset;
}

describe("student inventory presentation", () => {
  it("shows product summaries for general inventory questions without unit requests", () => {
    expect(
      requestsStudentAssistantAssetCards("What kind of kits do we have?")
    ).toBe(true);
    expect(
      requestsStudentAssistantAssetCards("How many Makey Kits do we have?")
    ).toBe(true);
    expect(
      asksForPhysicalUnits("How many physical units are in the Makey Kit?")
    ).toBe(false);
    expect(requestsStudentAssistantAssetCards("Do we have Makey Kits?")).toBe(
      true
    );
    expect(
      requestsStudentAssistantAssetCards(
        "What can I use to make an interactive controller?"
      )
    ).toBe(false);
    expect(
      requestsStudentAssistantAssetCards("Where are the Makey Kits?")
    ).toBe(true);
    expect(
      requestsStudentAssistantAssetCards("Which Makey Kit is available?")
    ).toBe(true);
    expect(
      selectStudentAssistantDisplayAssets("Which Makey Kit is available?", [
        asset({
          id: "unit-001",
          title: "Makey Kit #001",
          type: "INDIVIDUAL",
          quantity: null,
          assetModelId: "makey-model",
          assetModel: {
            id: "makey-model",
            name: "Makey Kit",
            image: null,
            thumbnailImage: null,
          },
        }),
        asset({
          id: "unit-002",
          title: "Makey Kit #002",
          type: "INDIVIDUAL",
          quantity: null,
          assetModelId: "makey-model",
          assetModel: {
            id: "makey-model",
            name: "Makey Kit",
            image: null,
            thumbnailImage: null,
          },
        }),
      ])
    ).toMatchObject([{ title: "Makey Kit", quantity: 2 }]);
  });

  it("shows one logical product for an explicit product-level result request", () => {
    const units = [1, 2, 3, 4, 5].map((number) =>
      asset({
        id: `makey-${number}`,
        title: `Makey Kit #${String(number).padStart(3, "0")}`,
        type: "INDIVIDUAL",
        quantity: null,
        assetModelId: "makey-model",
        assetModel: {
          id: "makey-model",
          name: "Makey Kit",
          image: null,
          thumbnailImage: null,
        },
      })
    );

    expect(
      selectStudentAssistantDisplayAssets("Show me Makey Kits", units)
    ).toMatchObject([
      {
        title: "Makey Kit",
        quantity: 5,
        sourceAssetIds: units.map(({ id }) => id),
      },
    ]);
  });

  it("shows one logical result for the reported general kits question", () => {
    const units = [1, 2, 3, 4, 5].map((number) =>
      asset({
        id: `makey-${number}`,
        title: `Makey Kit #${String(number).padStart(3, "0")}`,
        type: "INDIVIDUAL",
        quantity: null,
        assetModelId: "makey-model",
        assetModel: {
          id: "makey-model",
          name: "Makey Kit",
          image: null,
          thumbnailImage: null,
        },
      })
    );

    expect(
      selectStudentAssistantDisplayAssets(
        "What kind of kits do we have?",
        units
      )
    ).toMatchObject([{ title: "Makey Kit", quantity: 5 }]);
  });

  it("uses the logical product name and quantity for a single tracked unit", () => {
    expect(
      groupStudentAssets([
        asset({
          id: "only-unit",
          title: "Arduino Kit #003",
          type: "INDIVIDUAL",
          quantity: null,
          assetModelId: "arduino-model",
          assetModel: {
            id: "arduino-model",
            name: "Arduino Kit",
            image: null,
            thumbnailImage: null,
          },
        }),
      ])
    ).toMatchObject([{ title: "Arduino Kit", quantity: 1 }]);
  });

  it("groups by the persisted AssetModel id even when a legacy model relation is not hydrated", () => {
    const grouped = groupStudentAssets([
      asset({
        id: "unit-001",
        title: "Makey Kit #001",
        type: "INDIVIDUAL",
        quantity: null,
        assetModelId: "model-1",
      }),
      asset({
        id: "unit-002",
        title: "Makey Kit #002",
        type: "INDIVIDUAL",
        quantity: null,
        assetModelId: "model-1",
      }),
    ]);

    expect(grouped).toMatchObject([
      {
        title: "Makey Kit",
        quantity: 2,
        sourceAssetIds: ["unit-001", "unit-002"],
      },
    ]);
  });

  it("shows physical units only when the request explicitly asks for them", () => {
    const units = [1, 2, 3].map((number) =>
      asset({
        id: `makey-${number}`,
        title: `Makey Kit #${String(number).padStart(3, "0")}`,
        type: "INDIVIDUAL",
        quantity: null,
        assetModelId: "makey-model",
        assetModel: {
          id: "makey-model",
          name: "Makey Kit",
          image: null,
          thumbnailImage: null,
        },
      })
    );

    expect(
      selectStudentAssistantDisplayAssets(
        "Show me all the units individually",
        units
      )
    ).toEqual(units);
    expect(
      selectStudentAssistantDisplayAssets("Where is Makey Kit #003?", units)
    ).toEqual([units[2]]);
  });

  it("uses the Staff canonical record for same-name duplicates without summing stock", () => {
    const grouped = groupStudentAssets([
      asset({
        id: "teensy-1",
        title: "Teensy 4.1",
        quantity: 6,
        availableQuantity: 6,
      }),
      asset({
        id: "teensy-2",
        title: "Teensy 4.1",
        quantity: 6,
        availableQuantity: 6,
      }),
    ]);

    expect(grouped).toHaveLength(1);
    expect(grouped[0]).toMatchObject({
      id: "teensy-1",
      title: "Teensy 4.1",
      quantity: 6,
      availableQuantity: 6,
      sourceAssetIds: ["teensy-1", "teensy-2"],
    });
  });

  it("does not borrow an image or availability from a non-canonical duplicate", () => {
    const grouped = groupStudentAssets([
      asset({ id: "a-without-image", availableQuantity: 1 }),
      asset({
        id: "with-image",
        availableQuantity: 1,
        mainImage: "https://storage.example/arduino.jpg",
      }),
    ]);

    expect(grouped).toMatchObject([
      { id: "a-without-image", mainImage: null, availableQuantity: 1 },
    ]);
  });

  it("aggregates availability only for individually tracked units sharing one Shelf AssetModel", () => {
    const grouped = groupStudentAssets([
      asset({
        id: "unit-001",
        title: "Makey Makey #001",
        type: "INDIVIDUAL",
        quantity: null,
        assetModelId: "model-1",
        assetModel: {
          id: "model-1",
          name: "Makey Makey",
          image: "https://storage.example/model.jpg",
          thumbnailImage: null,
        },
        availableQuantity: 1,
      }),
      asset({
        id: "unit-002",
        title: "Makey Makey #002",
        type: "INDIVIDUAL",
        quantity: null,
        assetModelId: "model-1",
        assetModel: {
          id: "model-1",
          name: "Makey Makey",
          image: "https://storage.example/model.jpg",
          thumbnailImage: null,
        },
        availableQuantity: 0,
        status: "CHECKED_OUT",
      }),
    ]);

    expect(grouped).toMatchObject([
      {
        id: "unit-001",
        title: "Makey Makey",
        quantity: 2,
        availableQuantity: 1,
        sourceAssetIds: ["unit-001", "unit-002"],
      },
    ]);
  });

  it("uses a stable numbered unit image when the product and canonical unit have none", () => {
    const grouped = groupStudentAssets([
      asset({
        id: "unit-001",
        title: "Makey Kit #001",
        type: "INDIVIDUAL",
        quantity: null,
        assetModelId: "model-1",
        assetModel: {
          id: "model-1",
          name: "Makey Kit",
          image: null,
          thumbnailImage: null,
        },
      }),
      asset({
        id: "unit-002",
        title: "Makey Kit #002",
        type: "INDIVIDUAL",
        quantity: null,
        assetModelId: "model-1",
        assetModel: {
          id: "model-1",
          name: "Makey Kit",
          image: null,
          thumbnailImage: null,
        },
        mainImage: "https://storage.example/makey-002.jpg",
        thumbnailImage: "https://storage.example/makey-002-thumb.jpg",
      }),
    ]);

    expect(grouped).toMatchObject([
      {
        title: "Makey Kit",
        mainImage: "https://storage.example/makey-002.jpg",
        thumbnailImage: "https://storage.example/makey-002-thumb.jpg",
      },
    ]);
  });

  it("prefers the shared logical product image over a physical-unit photo", () => {
    const grouped = groupStudentAssets([
      asset({
        id: "unit-001",
        title: "Arduino Kit #001",
        type: "INDIVIDUAL",
        quantity: null,
        assetModelId: "model-1",
        mainImage: "https://storage.example/unit-001.jpg",
        assetModel: {
          id: "model-1",
          name: "Arduino Kit",
          image: "https://storage.example/canonical-product.jpg",
          thumbnailImage: "https://storage.example/canonical-thumb.jpg",
        },
      }),
      asset({
        id: "unit-002",
        title: "Arduino Kit #002",
        type: "INDIVIDUAL",
        quantity: null,
        assetModelId: "model-1",
        assetModel: {
          id: "model-1",
          name: "Arduino Kit",
          image: "https://storage.example/canonical-product.jpg",
          thumbnailImage: "https://storage.example/canonical-thumb.jpg",
        },
      }),
    ]);

    expect(grouped).toMatchObject([
      {
        mainImage: null,
        thumbnailImage: null,
        assetModel: {
          image: "https://storage.example/canonical-product.jpg",
          thumbnailImage: "https://storage.example/canonical-thumb.jpg",
        },
      },
    ]);
  });

  it("uses a resolved native Kit cover as representative fallback and tolerates no image", () => {
    const groupedWithKitCover = groupStudentAssets([
      asset({
        id: "unit-001",
        title: "Makey Kit #001",
        type: "INDIVIDUAL",
        quantity: null,
        assetModelId: "model-1",
        assetModel: {
          id: "model-1",
          name: "Makey Kit",
          image: null,
          thumbnailImage: null,
        },
      }),
      asset({
        id: "unit-002",
        title: "Makey Kit #002",
        type: "INDIVIDUAL",
        quantity: null,
        assetModelId: "model-1",
        assetModel: {
          id: "model-1",
          name: "Makey Kit",
          image: null,
          thumbnailImage: null,
        },
        kitImage: "https://storage.example/resolved-kit-cover.jpg",
      }),
    ]);
    const groupedWithoutImage = groupStudentAssets([
      asset({
        id: "bare-001",
        title: "Arduino Kit #001",
        type: "INDIVIDUAL",
        quantity: null,
        assetModelId: "bare-model",
        assetModel: {
          id: "bare-model",
          name: "Arduino Kit",
          image: null,
          thumbnailImage: null,
        },
      }),
      asset({
        id: "bare-002",
        title: "Arduino Kit #002",
        type: "INDIVIDUAL",
        quantity: null,
        assetModelId: "bare-model",
        assetModel: {
          id: "bare-model",
          name: "Arduino Kit",
          image: null,
          thumbnailImage: null,
        },
      }),
    ]);

    expect(groupedWithKitCover).toMatchObject([
      { kitImage: "https://storage.example/resolved-kit-cover.jpg" },
    ]);
    expect(groupedWithoutImage).toMatchObject([
      { mainImage: null, assetModel: { image: null } },
    ]);
    expect(groupedWithoutImage[0].kitImage ?? null).toBeNull();
  });

  it("aggregates multiple logical products independently", () => {
    const products = [
      ...[1, 2, 3].map((number) =>
        asset({
          id: `arduino-${number}`,
          title: `Arduino Kit #${String(number).padStart(3, "0")}`,
          type: "INDIVIDUAL",
          quantity: null,
          assetModelId: "arduino-model",
          assetModel: {
            id: "arduino-model",
            name: "Arduino Kit",
            image: null,
            thumbnailImage: null,
          },
        })
      ),
      ...[1, 2].map((number) =>
        asset({
          id: `makey-${number}`,
          title: `Makey Kit #${String(number).padStart(3, "0")}`,
          type: "INDIVIDUAL",
          quantity: null,
          assetModelId: "makey-model",
          assetModel: {
            id: "makey-model",
            name: "Makey Kit",
            image: null,
            thumbnailImage: null,
          },
        })
      ),
    ];
    const grouped = groupStudentAssets(products);

    expect(grouped).toMatchObject([
      { title: "Arduino Kit", quantity: 3 },
      { title: "Makey Kit", quantity: 2 },
    ]);
    expect(
      selectStudentAssistantDisplayAssets("How many kits do we have?", products)
    ).toMatchObject([
      { title: "Arduino Kit", quantity: 3 },
      { title: "Makey Kit", quantity: 2 },
    ]);
  });

  it("keeps clearly different variants separate", () => {
    const grouped = groupStudentAssets([
      asset({ id: "nano", title: "Arduino Nano" }),
      asset({ id: "uno", title: "Arduino Uno" }),
    ]);

    expect(grouped.map((item) => item.title)).toEqual([
      "Arduino Nano",
      "Arduino Uno",
    ]);
  });

  it("filters a grouped presentation item by availability", () => {
    const grouped = groupStudentAssets([
      asset({ id: "available", availableQuantity: 1 }),
      asset({ id: "unavailable", availableQuantity: 0 }),
    ]);

    expect(
      filterStudentInventory(grouped, { availability: "available" })
    ).toHaveLength(1);
  });

  it("filters by the Shelf category id used by Categories", () => {
    const grouped = groupStudentAssets([
      asset({
        id: "boards",
        category: { id: "category-boards", name: "Boards", color: "#000" },
      }),
      asset({
        id: "tools",
        category: { id: "category-tools", name: "Tools", color: "#111" },
      }),
    ]);

    expect(
      filterStudentInventory(grouped, { categoryId: "category-boards" })
    ).toMatchObject([{ id: "boards" }]);
  });

  it("builds Student lab-area filters from high-level locations under the Lab room", () => {
    const locations = getStudentLabAreaFilters([
      {
        id: "lab-room",
        name: "IOIO Lab - B477",
        parentId: null,
        children: [
          {
            id: "section-a",
            name: "Section A",
            parentId: "lab-room",
            children: [
              {
                id: "shelf-a1",
                name: "Shelf A1",
                parentId: "section-a",
                children: [
                  {
                    id: "container-a1-13",
                    name: "Container A1-13",
                    parentId: "shelf-a1",
                    children: [],
                    assetCount: 1,
                    imageUrl: null,
                    thumbnailUrl: null,
                  },
                ],
                assetCount: 0,
                imageUrl: null,
                thumbnailUrl: null,
              },
            ],
            assetCount: 0,
            imageUrl: null,
            thumbnailUrl: null,
          },
          {
            id: "section-b",
            name: "Section B",
            parentId: "lab-room",
            children: [],
            assetCount: 1,
            imageUrl: null,
            thumbnailUrl: null,
          },
          ...["Pickup Zone", "Pick-Up Zone", "Return Zone", "Broken Zone"].map(
            (name, index) => ({
              id: `zone-${index}`,
              name,
              parentId: "lab-room",
              children: [],
              assetCount: 0,
              imageUrl: null,
              thumbnailUrl: null,
            })
          ),
        ],
        assetCount: 0,
        imageUrl: null,
        thumbnailUrl: null,
      },
    ]);

    expect(locations).toEqual([
      { key: "all", label: "All areas", code: null, locationId: null },
      {
        key: "section-a",
        label: "Section A",
        code: null,
        locationId: "section-a",
      },
      {
        key: "section-b",
        label: "Section B",
        code: null,
        locationId: "section-b",
      },
    ]);
  });
});
