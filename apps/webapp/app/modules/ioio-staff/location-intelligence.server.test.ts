import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  locations: vi.fn(),
  categories: vi.fn(),
  models: vi.fn(),
  placements: vi.fn(),
}));
vi.mock("~/database/db.server", () => ({
  db: {
    location: { findMany: mocks.locations },
    category: { findMany: mocks.categories },
    assetModel: { findMany: mocks.models },
    assetLocation: { findMany: mocks.placements },
  },
}));

import { buildLocationIntelligenceSnapshot } from "./location-intelligence.server";

describe("live location intelligence snapshot", () => {
  beforeEach(() => {
    mocks.locations.mockResolvedValue([
      { id: "room", name: "Electronics", parentId: null, description: null },
      {
        id: "drawer",
        name: "Boards drawer",
        parentId: "room",
        description: "Microcontrollers",
      },
    ]);
    mocks.categories.mockResolvedValue([
      { id: "boards", name: "Development Boards", description: null },
    ]);
    mocks.models.mockResolvedValue([
      {
        id: "model-1",
        name: "XIAO ESP32",
        defaultCategoryId: "boards",
        assets: [
          { categoryId: "boards", assetLocations: [{ locationId: "drawer" }] },
        ],
      },
    ]);
    mocks.placements.mockResolvedValue([
      {
        assetId: "asset-1",
        locationId: "drawer",
        asset: { assetModelId: "model-1", categoryId: "boards" },
      },
    ]);
  });

  it("reconstructs hierarchy and derives category placement counts from current Shelf rows", async () => {
    const snapshot = await buildLocationIntelligenceSnapshot("org-1");
    expect(
      snapshot.locations.find((location) => location.id === "drawer")
    ).toMatchObject({
      path: "Electronics / Boards drawer",
      parentId: "room",
      hierarchyDepth: 1,
      childCount: 0,
      modelCount: 1,
      assetCount: 1,
      categoryDistribution: [{ categoryId: "boards", count: 1 }],
    });
    expect(snapshot.categories[0]?.commonLocations).toEqual([
      { locationId: "drawer", path: "Electronics / Boards drawer", count: 1 },
    ]);
    mocks.locations.mockResolvedValue([
      { id: "room", name: "New room name", parentId: null, description: null },
    ]);
    const updated = await buildLocationIntelligenceSnapshot("org-1");
    expect(updated.locations.map((location) => location.path)).toContain(
      "New room name"
    );
  });
});
