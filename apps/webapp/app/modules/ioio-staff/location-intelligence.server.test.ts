import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  locations: vi.fn(),
  categories: vi.fn(),
  models: vi.fn(),
  placements: vi.fn(),
  helper: vi.fn(),
}));
vi.mock("~/database/db.server", () => ({
  db: {
    location: { findMany: mocks.locations },
    category: { findMany: mocks.categories },
    assetModel: { findMany: mocks.models },
    assetLocation: { findMany: mocks.placements },
  },
}));
vi.mock("~/modules/ioio-staff/import-helper-client.server", () => ({
  requestImportHelperProposal: mocks.helper,
}));

import {
  buildLocationIntelligenceSnapshot,
  createInventoryPlacementTaskPlan,
  currentPlacementIsBest,
  generateInventoryOrganizationProposal,
  rankPlacementLocations,
} from "./location-intelligence.server";

describe("live location intelligence snapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    mocks.helper.mockResolvedValue({
      status: "manual",
      reason: "helper_not_configured",
    });
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
      unitCount: 1,
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

  it("uses category and location names in the instruction to scope model retrieval", async () => {
    await generateInventoryOrganizationProposal({
      organizationId: "org-1",
      instruction:
        "Find better locations for Development Boards in Electronics.",
      categoryIds: ["boards"],
      locationIds: ["room"],
    });
    const inventoryQuery = mocks.models.mock.calls[1]?.[0];
    expect(inventoryQuery.where.assets.some.categoryId.in).toEqual(["boards"]);
    expect(
      inventoryQuery.where.assets.some.assetLocations.some.locationId.in
    ).toEqual(["room", "drawer"]);
    expect(mocks.helper).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "INVENTORY_REORGANIZATION",
        scope: { categoryIds: ["boards"], locationIds: ["room"] },
      })
    );
  });

  it("normalizes placement requests with the selected inventory source and overflow constraint", () => {
    expect(
      createInventoryPlacementTaskPlan({
        instruction: "These items are overflowing. Find better locations.",
        hasStaffSelection: true,
        placementPressure: "USER_REPORTED_HIGH",
      })
    ).toMatchObject({
      taskType: "INVENTORY_PLACEMENT",
      sources: [{ type: "SHELF_INVENTORY" }, { type: "SHELF_LOCATIONS" }],
      steps: [
        { capability: "SELECT_MODELS", selection: "STAFF_SELECTED" },
        {
          capability: "PROPOSE_LOCATION_CHANGE",
          placementPressure: "USER_REPORTED_HIGH",
        },
      ],
      mutationPolicy: "PROPOSAL_ONLY",
      expectedOutput: "INVENTORY_PROPOSAL",
    });
  });

  it.each([
    "These items are overflowing. Find better locations.",
    "Where else could this go?",
    "Spread these out.",
  ])("does not guess the inventory selection for '%s'", async (instruction) => {
    const result = await generateInventoryOrganizationProposal({
      organizationId: "org-1",
      instruction,
    });

    expect(result.diagnostics.requiresSelection).toBe(true);
    expect(result.diagnostics.modelsConsidered).toBe(0);
    expect(mocks.models).toHaveBeenCalledTimes(1); // Canonical map only; no inventory selection query.
    expect(mocks.helper).not.toHaveBeenCalled();
  });

  it("ranks cross-branch category locations, relieves crowded placement, and keeps alternatives", async () => {
    const locations = [
      { id: "lab", name: "IOIO Lab - B477", parentId: null, description: null },
      {
        id: "section-a",
        name: "Seciton A",
        parentId: "lab",
        description: null,
      },
      {
        id: "shelf-a1",
        name: "Shelf A1",
        parentId: "section-a",
        description: null,
      },
      {
        id: "crowded",
        name: "Container A1-1.1",
        parentId: "shelf-a1",
        description: null,
      },
      {
        id: "other-current",
        name: "Container A1-2",
        parentId: "shelf-a1",
        description: null,
      },
      {
        id: "storage",
        name: "Storage Room - B442",
        parentId: null,
        description: null,
      },
      {
        id: "cables",
        name: "Cable Drawer",
        parentId: "storage",
        description: "USB leads and adapters",
      },
      {
        id: "boards",
        name: "Development Boards Shelf",
        parentId: "storage",
        description: "Arduino and microcontrollers",
      },
      {
        id: "motors",
        name: "Motor and Robotics Drawer",
        parentId: "storage",
        description: "Motors and robotics parts",
      },
      {
        id: "prototyping",
        name: "Prototyping Drawer",
        parentId: "storage",
        description: "Prototyping and making supplies",
      },
      {
        id: "empty",
        name: "Empty Container",
        parentId: "storage",
        description: null,
      },
    ];
    const categories = [
      { id: "cables-cat", name: "Cables & adapters", description: null },
      { id: "electronics-cat", name: "Electronics", description: null },
      { id: "making-cat", name: "Prototyping & making", description: null },
    ];
    const model = (
      id: string,
      name: string,
      categoryId: string,
      locationId: string,
      quantity = 1
    ) => ({
      id,
      name,
      description: null,
      defaultCategoryId: categoryId,
      assets: [
        {
          categoryId,
          quantity,
          assetLocations: [{ locationId, quantity }],
        },
      ],
    });
    const selectedModels = [
      model("usb", "USB-C Cable", "cables-cat", "crowded", 20),
      model("arduino", "Arduino Nano", "electronics-cat", "crowded", 5),
      model("motor", "Motor", "electronics-cat", "crowded", 10),
      model("smalaa", "Smalaa", "making-cat", "other-current", 3),
    ];
    const snapshotModels = [
      ...selectedModels,
      model("cable-reference", "USB Cable Extension", "cables-cat", "cables"),
      model("board-reference", "Arduino Mega", "electronics-cat", "boards"),
      model("motor-reference", "Robotics Motor", "electronics-cat", "motors"),
      model("making-reference", "Makey Kit", "making-cat", "prototyping"),
    ];
    mocks.locations.mockResolvedValue(locations);
    mocks.categories.mockResolvedValue(categories);
    mocks.models
      .mockResolvedValueOnce(snapshotModels)
      .mockResolvedValueOnce(selectedModels);
    mocks.placements.mockResolvedValue(
      snapshotModels.flatMap((entry) =>
        entry.assets.map((asset, index) => ({
          assetId: `${entry.id}-${index}`,
          locationId: asset.assetLocations[0]!.locationId,
          quantity: asset.assetLocations[0]!.quantity,
          asset: { assetModelId: entry.id, categoryId: asset.categoryId },
        }))
      )
    );
    mocks.helper.mockResolvedValue({
      status: "ready",
      proposal: {
        mode: "INVENTORY_REORGANIZATION",
        schemaVersion: 1,
        proposals: [
          {
            modelId: "usb",
            suggestedCategoryId: null,
            categoryConfidence: 0.4,
            suggestedLocationId: "cables",
            locationConfidence: 0.42,
            reason: "Cables are grouped in this drawer.",
          },
          {
            modelId: "arduino",
            suggestedCategoryId: null,
            categoryConfidence: 0.4,
            suggestedLocationId: "boards",
            locationConfidence: 0.46,
            reason: "Similar boards are stored here.",
          },
          {
            modelId: "motor",
            suggestedCategoryId: null,
            categoryConfidence: 0.2,
            suggestedLocationId: "foreign-location",
            locationConfidence: 0.9,
            reason: "This ID is not in the current allowlist.",
          },
          {
            modelId: "smalaa",
            suggestedCategoryId: null,
            categoryConfidence: 0.2,
            suggestedLocationId: "other-current",
            locationConfidence: 0.9,
            reason: "This is already the current location.",
          },
        ],
      },
    });

    const result = await generateInventoryOrganizationProposal({
      organizationId: "org-1",
      instruction: "These items are overflowing. Find better locations.",
      selectedModelIds: ["usb", "arduino", "motor", "smalaa"],
    });
    const helperRequest = mocks.helper.mock.calls[0]?.[0];
    const selectedQuery = mocks.models.mock.calls[1]?.[0];

    expect(selectedQuery.where.id.in).toEqual([
      "usb",
      "arduino",
      "motor",
      "smalaa",
    ]);
    expect(result.diagnostics).toMatchObject({
      selectedModelCount: 4,
      modelsConsidered: 4,
      modelsSentToClaude: 4,
      placementPressure: "USER_REPORTED_HIGH",
    });
    expect(
      helperRequest.items.map((item: { modelId: string }) => item.modelId)
    ).toEqual(["arduino", "motor", "smalaa", "usb"]);
    expect(helperRequest.locations.length).toBeGreaterThan(3);
    expect(helperRequest.locations.length).toBeLessThanOrEqual(20);
    expect(
      helperRequest.locations.some((location: { path: string }) =>
        location.path.includes("Storage Room - B442")
      )
    ).toBe(true);
    expect(result.proposalItems).toHaveLength(4);
    const byName = new Map(
      result.proposalItems.map((item) => [item.productName, item])
    );
    expect(byName.get("USB-C Cable")).toMatchObject({
      locationId: "cables",
      strength: "POSSIBLE",
    });
    expect(byName.get("Arduino Nano")).toMatchObject({
      locationId: "boards",
      strength: "POSSIBLE",
    });
    expect(byName.get("Motor")?.locationId).toBe("motors");
    expect(byName.get("Smalaa")?.locationId).toBe("prototyping");
    expect(byName.get("USB-C Cable")?.alternatives.length).toBeGreaterThan(1);
    expect(result.diagnostics.validationRejectedCount).toBeGreaterThanOrEqual(
      2
    );
    expect(result.previewOnly).toBe(true);
    expect(mocks.locations.mock.calls.length).toBe(1);
  });

  it("keeps current location when it wins but still displays ranked alternatives", () => {
    const location = (overrides: Record<string, unknown>) => ({
      id: "current",
      name: "Cable Drawer",
      path: "Electronics / Cable Drawer",
      parentId: "room",
      hierarchyDepth: 1,
      childCount: 0,
      assignable: true,
      description: null,
      modelCount: 4,
      assetCount: 4,
      unitCount: 20,
      categoryDistribution: [
        {
          categoryId: "cables-cat",
          name: "Cables & adapters",
          count: 4,
        },
      ],
      representativeConcepts: ["cable", "usb", "adapters"],
      ...overrides,
    });
    const ranked = rankPlacementLocations({
      locations: [
        location({}),
        location({
          id: "empty-storage",
          name: "Empty Storage Container",
          path: "Storage Room / Empty Storage Container",
          assetCount: 0,
          modelCount: 0,
          categoryDistribution: [],
          representativeConcepts: ["storage", "empty"],
        }),
      ],
      productName: "USB-C Cable",
      categoryName: "Cables & adapters",
      categoryId: "cables-cat",
      currentLocationIds: ["current"],
      selectedCurrentLocationCounts: new Map([["current", 1]]),
      placementPressure: "NORMAL",
    });
    expect(ranked[0]?.id).toBe("current");
    expect(ranked.some(({ id }) => id === "empty-storage")).toBe(true);
    expect(
      currentPlacementIsBest({
        placementPressure: "USER_REPORTED_HIGH",
        currentScore: ranked.find(({ id }) => id === "current")!.score,
        bestAlternativeScore: ranked.find(({ id }) => id === "empty-storage")!
          .score,
        currentRawScore: ranked.find(({ id }) => id === "current")!.rawScore,
        bestAlternativeRawScore: ranked.find(
          ({ id }) => id === "empty-storage"
        )!.rawScore,
      })
    ).toBe(true);
    const pressured = rankPlacementLocations({
      locations: [
        location({}),
        location({ id: "empty-storage", assetCount: 0 }),
      ],
      productName: "USB-C Cable",
      categoryName: "Cables & adapters",
      categoryId: "cables-cat",
      currentLocationIds: ["current"],
      selectedCurrentLocationCounts: new Map([["current", 3]]),
      placementPressure: "USER_REPORTED_HIGH",
    });
    const pressuredCurrent = pressured.find(({ id }) => id === "current");
    expect(pressuredCurrent!.score).toBeLessThan(pressuredCurrent!.rawScore);
  });

  it("shows lower-confidence alternatives for a selected product even when current remains best", async () => {
    const result = await generateInventoryOrganizationProposal({
      organizationId: "org-1",
      instruction: "Where else could this go?",
      selectedModelIds: ["model-1"],
    });

    expect(result.proposalItems).toHaveLength(1);
    expect(result.proposalItems[0]).toMatchObject({
      strength: "KEEP_CURRENT",
      locationId: null,
      alternatives: [{ locationId: "room" }],
    });
    expect(result.diagnostics.selectedModelCount).toBe(1);
  });
});

describe("explicit product selection invariant", () => {
  const instructions = [
    [
      "Find better locations for USB-C Cable, Arduino Nano, Motor, and Smalaa. Do not restrict the search to Shelf A1 or neighboring containers. Search the relevant existing sections, shelves, and containers across the live Shelf location hierarchy and propose the strongest destination for each product.",
      ["USB-C Cable", "Arduino Nano", "Motor", "Smalaa"],
    ],
    [
      "Container A1-1.1 currently holds USB-C Cable quantity 20, Arduino Nano quantity 5, and Motor quantity 10. Treat this location as user-reported overcrowded. Propose a redistribution that reduces concentration and groups products with more appropriate existing inventory. Also review Smalaa in Container A1-2 and decide whether it should stay or move. Use only existing Shelf locations and do not apply anything.",
      ["USB-C Cable", "Arduino Nano", "Motor", "Smalaa"],
    ],
    ["Find a better place for Motor.", ["Motor"]],
    ["Where should Arduino Nano go?", ["Arduino Nano"]],
    ["Move USB-C Cable and Motor somewhere better.", ["USB-C Cable", "Motor"]],
  ] as const;
  it.each(
    instructions.flatMap(([instruction, expected]) => [
      {
        instruction,
        expected,
        selectedModelIds: undefined as string[] | undefined,
      },
      { instruction, expected, selectedModelIds: ["model-4"] },
    ])
  )(
    "analyzes exactly the named products: $instruction",
    async ({ instruction, expected, selectedModelIds }) => {
      const catalog = [
        "USB-C Cable",
        "Arduino Nano",
        "Motor",
        "Smalaa",
        "Makey Kit",
      ].map((name, index) => ({
        id: `model-${index}`,
        name,
        description: null,
        defaultCategoryId: null,
        assets: [
          {
            categoryId: null,
            quantity: 2,
            assetLocations: [{ locationId: "current", quantity: 2 }],
          },
        ],
      }));
      mocks.models.mockImplementation(({ where }) =>
        where.id
          ? catalog.filter((model) => where.id.in.includes(model.id))
          : catalog
      );
      mocks.categories.mockResolvedValue([]);
      mocks.placements.mockResolvedValue([]);
      mocks.locations.mockResolvedValue([
        {
          id: "current",
          name: "Container A1-1.1",
          parentId: null,
          description: null,
        },
        {
          id: "storage",
          name: "Storage Room - B442",
          parentId: null,
          description: null,
        },
        {
          id: "destination",
          name: "Empty container",
          parentId: "storage",
          description: null,
        },
      ]);
      // why: helper transport is external; no successful language interpretation is needed for canonical phrase matching.
      mocks.helper.mockResolvedValue({
        status: "manual",
        reason: "helper_not_configured",
      });
      const result = await generateInventoryOrganizationProposal({
        organizationId: "org-1",
        instruction,
        selectedModelIds,
      });
      expect(result.proposalItems.map((row) => row.productName).sort()).toEqual(
        [...expected].sort()
      );
      expect(result.diagnostics.modelsConsidered).toBe(expected.length);
      if (!("grounding" in result)) throw new Error("Expected grounding");
      expect(result.grounding).toMatchObject({
        inventorySelectionMode: "EXPLICIT_PRODUCTS",
        explicitInventoryRefCount: expected.length,
        resolvedInventoryRefCount: expected.length,
      });
      expect(result.proposalItems.every((item) => Boolean(item.strength))).toBe(
        true
      );
      expect(
        result.proposalItems.some((item) => item.productName === "Makey Kit")
      ).toBe(false);
      expect(result.diagnostics.candidateLocationCountBeforeRanking).toBe(3);
      expect(result.previewOnly).toBe(true);
    }
  );
});

it("preserves helper references, unresolved names, and contextual hints without broadening selection", async () => {
  const instruction =
    "Review Motor quantity 10 in Container A1-1.1 and Missing Widget.";
  const inventoryRefs = [
    {
      name: "Motor",
      contextualQuantity: 10,
      currentLocationRef: { name: "Container A1-1.1" },
    },
    { name: "Missing Widget" },
  ];
  const catalog = [
    {
      id: "motor",
      name: "Motor",
      description: null,
      defaultCategoryId: null,
      assets: [
        {
          categoryId: null,
          quantity: 2,
          assetLocations: [{ locationId: "current", quantity: 2 }],
        },
      ],
    },
    {
      id: "unrequested",
      name: "Makey Kit",
      description: null,
      defaultCategoryId: null,
      assets: [],
    },
  ];
  mocks.models.mockImplementation(({ where }) =>
    where.id
      ? catalog.filter((model) => where.id.in.includes(model.id))
      : catalog
  );
  mocks.categories.mockResolvedValue([]);
  mocks.placements.mockResolvedValue([]);
  mocks.locations.mockResolvedValue([
    {
      id: "current",
      name: "Container A1-1.1",
      parentId: null,
      description: null,
    },
    {
      id: "alternative",
      name: "Storage Container",
      parentId: null,
      description: null,
    },
  ]);
  // why: use a constrained language-planner response in place of external Claude transport.
  mocks.helper.mockImplementation((request) =>
    request.mode === "SHELF_TASK_PLAN"
      ? {
          status: "ready",
          proposal: {
            mode: "SHELF_TASK_PLAN",
            schemaVersion: 1,
            taskPlan: {
              ...createInventoryPlacementTaskPlan({
                instruction,
                inventoryRefs,
                hasStaffSelection: false,
                placementPressure: "NORMAL",
              }),
              locationRefs: [{ name: "Container A1-1.1" }],
            },
          },
        }
      : { status: "manual", reason: "helper_not_configured" }
  );
  const result = await generateInventoryOrganizationProposal({
    organizationId: "org-1",
    instruction,
  });
  if (!("grounding" in result)) throw new Error("Expected grounding");
  expect(result.grounding).toMatchObject({
    explicitInventoryRefCount: 2,
    resolvedInventoryRefCount: 1,
    unresolvedInventoryRefCount: 1,
    currentLocations: [{ id: "current" }],
  });
  expect(result.taskPlan.inventoryRefs).toEqual(inventoryRefs);
  expect(result.proposalItems).toHaveLength(1);
  expect(result.proposalItems[0]).toMatchObject({ modelId: "motor" });
  expect(result.proposalItems[0].reason).toContain("canonical Shelf state");
  expect(result.grounding.references[1]).toMatchObject({
    status: "NOT_FOUND",
    modelId: null,
  });
});
