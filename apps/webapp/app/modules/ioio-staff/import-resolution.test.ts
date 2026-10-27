import { describe, expect, it } from "vitest";
import {
  getImportLocationPath,
  getOperationalImportLocationIds,
  buildImportLocationAffinities,
  matchesReviewedImportLocationPath,
  normalizeImportLabel,
  resolveImportCategory,
  resolveImportCategorySuggestion,
  resolveImportLocation,
  resolveImportLocationSuggestion,
} from "./import-resolution";
import { MOUSER_REAL_FIRST_PAGE_EXPECTED } from "../../../test/fixtures/mouser-invoice-fragments";

describe("import category resolution", () => {
  const categories = [
    { id: "electronics", name: "Electronics" },
    { id: "archived", name: "Old Electronics", archived: true },
  ];

  it("reuses active names after case and whitespace normalization", () => {
    expect(resolveImportCategory("  ELECTRONICS   ", categories)).toEqual({
      status: "ACTIVE_MATCH",
      category: categories[0],
    });
    expect(normalizeImportLabel("  Power   Supplies ")).toBe("power supplies");
  });

  it("marks archived matches for review and does not propose a duplicate", () => {
    expect(resolveImportCategory("old electronics", categories)).toEqual({
      status: "ARCHIVED_MATCH",
      category: categories[1],
    });
  });

  it("returns an explicit new-category proposal when no category matches", () => {
    expect(resolveImportCategory("Sensors", categories)).toEqual({
      status: "NEW_PROPOSED",
      name: "Sensors",
    });
  });

  it("does not choose arbitrarily among duplicate normalized categories", () => {
    expect(
      resolveImportCategory("ELECTRONICS", [
        ...categories,
        { id: "electronics-2", name: " electronics " },
      ]).status
    ).toBe("AMBIGUOUS");
  });
});

describe("import location resolution", () => {
  const locations = [
    {
      id: "lab",
      name: "IOIO Lab – B477",
      parentId: null,
      pathLabel: "IOIO Lab – B477",
      operational: false,
      currentUnits: 18,
    },
    {
      id: "container",
      name: "Container A1-1.1",
      parentId: "lab",
      pathLabel: "IOIO Lab – B477 · Container A1-1.1",
      operational: false,
      currentUnits: 18,
    },
    {
      id: "container-duplicate",
      name: "Container A1-1.1",
      parentId: null,
      pathLabel: "Container A1-1.1",
      operational: false,
      currentUnits: 0,
    },
    {
      id: "pickup",
      name: "Pickup Zone",
      parentId: "lab",
      pathLabel: "IOIO Lab – B477 · Pickup Zone",
      operational: true,
      currentUnits: 2,
    },
  ];

  it("builds useful hierarchy labels", () => {
    expect(getImportLocationPath("container", locations)).toBe(
      "IOIO Lab – B477 · Container A1-1.1"
    );
  });

  it("reports duplicate names as ambiguous and accepts exact full paths", () => {
    expect(resolveImportLocation("Container A1-1.1", locations).status).toBe(
      "AMBIGUOUS"
    );
    expect(
      resolveImportLocation("IOIO Lab – B477 · Container A1-1.1", locations)
    ).toMatchObject({ status: "MATCH", location: { id: "container" } });
  });

  it("marks operational matches and excludes broken, pickup and return areas", () => {
    expect(resolveImportLocation("Pickup Zone", locations).status).toBe(
      "OPERATIONAL"
    );
    expect(
      getOperationalImportLocationIds({
        locations,
        brokenSectionId: "container",
        pickupZoneName: "Pickup Zone",
        reportReturnPath: "IOIO Lab – B477 · Pickup Zone",
      })
    ).toEqual(new Set(["container", "pickup"]));
  });

  it("preserves occupancy context without adding capacity rules", () => {
    expect(locations[1]).toMatchObject({ currentUnits: 18 });
    expect(
      resolveImportLocation("IOIO Lab – B477 · Container A1-1.1", locations)
    ).toMatchObject({ status: "MATCH" });
  });

  it("detects a removed location and a changed hierarchy before Apply", () => {
    const reviewedPath = "IOIO Lab – B477 · Container A1-1.1";
    expect(
      matchesReviewedImportLocationPath({
        expectedPath: reviewedPath,
        currentPath: reviewedPath,
        currentName: "Container A1-1.1",
      })
    ).toBe(true);
    expect(
      matchesReviewedImportLocationPath({
        expectedPath: reviewedPath,
        currentPath: "IOIO Lab – B477 · Other Room · Container A1-1.1",
        currentName: "Container A1-1.1",
      })
    ).toBe(false);
    expect(
      matchesReviewedImportLocationPath({
        expectedPath: reviewedPath,
        currentPath: "",
        currentName: "",
      })
    ).toBe(false);
  });
});

describe("deterministic category and location suggestions", () => {
  const categories = [
    { id: "electronics", name: "Electronics", description: null },
    {
      id: "development-boards",
      name: "Development Boards",
      description: "Microcontroller boards and embedded development platforms",
    },
    { id: "sensors", name: "Sensors", description: "Detection and ranging" },
    { id: "cables", name: "Cables", description: null },
    { id: "motors", name: "Motors", description: null },
  ];

  const locations = [
    {
      id: "lab",
      name: "Electronics Lab",
      parentId: null,
      pathLabel: "Electronics Lab",
      description: null,
      operational: false,
    },
    {
      id: "cabinet",
      name: "Cabinet B",
      parentId: "lab",
      pathLabel: "Electronics Lab · Cabinet B",
      description: null,
      operational: false,
    },
    {
      id: "boards-drawer",
      name: "Development Boards Drawer",
      parentId: "cabinet",
      pathLabel: "Electronics Lab · Cabinet B · Development Boards Drawer",
      description: "Microcontroller and embedded boards",
      operational: false,
    },
    {
      id: "sensors-cabinet",
      name: "Sensors",
      parentId: "lab",
      pathLabel: "Electronics Lab · Sensors",
      description: "Sensor storage",
      operational: false,
    },
    {
      id: "mmwave-drawer",
      name: "mmWave Drawer",
      parentId: "sensors-cabinet",
      pathLabel: "Electronics Lab · Sensors · mmWave Drawer",
      description: "Presence and distance sensors",
      operational: false,
    },
  ];

  it("uses raw product description when the visible product name is abbreviated", () => {
    const evidence = {
      manufacturer: "Seeed Studio",
      productName: "Seeed Studio XIAO ES",
      rawDescription:
        "Seeed Studio XIAO ESP32-S3 development board / multiprotocol development tool",
      mpn: "102010634",
    };
    const selection = resolveImportCategorySuggestion({
      claudeCategoryId: null,
      claudeConfidence: 0,
      evidence,
      categories,
    });
    expect(selection).toMatchObject({
      category: { id: "development-boards" },
      method: "deterministic-fallback",
    });
    expect(
      resolveImportLocationSuggestion({
        claudeLocationId: null,
        claudeConfidence: 0,
        evidence,
        category: selection.category,
        locations,
      })
    ).toMatchObject({
      location: { id: "boards-drawer" },
      method: "deterministic-fallback",
    });
  });

  it("accepts a valid high-confidence Claude category when deterministic evidence is weak", () => {
    expect(
      resolveImportCategorySuggestion({
        claudeCategoryId: "electronics",
        claudeConfidence: 0.93,
        evidence: {
          productName: "Replacement item",
          rawDescription: "Unclassified replacement component",
        },
        categories,
      })
    ).toMatchObject({
      category: { id: "electronics" },
      method: "claude",
    });
  });

  it("prefers a more specific category and deepest relevant child location", () => {
    const evidence = {
      manufacturer: "Seeed Studio",
      productName: "Seeed Studio 24GHz mmWave Sensor",
      rawDescription:
        "Seeed Studio 24GHz mmWave Human Presence Sensor, distance detection",
      mpn: "101010001",
    };
    const category = resolveImportCategorySuggestion({
      claudeCategoryId: "electronics",
      claudeConfidence: 0.96,
      evidence,
      categories,
    });
    expect(category).toMatchObject({
      category: { id: "sensors" },
      method: "deterministic-fallback",
    });
    expect(
      resolveImportLocationSuggestion({
        claudeLocationId: "lab",
        claudeConfidence: 0.95,
        evidence,
        category: category.category,
        locations,
      })
    ).toMatchObject({
      location: { id: "mmwave-drawer" },
      method: "deterministic-fallback",
    });
  });

  it("leaves weak category and location matches unresolved", () => {
    const evidence = {
      productName: "Mystery item",
      rawDescription: "Unknown replacement component",
    };
    const category = resolveImportCategorySuggestion({ evidence, categories });
    expect(category).toEqual({ category: null, method: "unresolved" });
    expect(
      resolveImportLocationSuggestion({
        evidence,
        category: categories[0],
        locations,
      })
    ).toEqual({ location: null, method: "unresolved" });
  });

  it("ranks motor, test-equipment, camera, cable, power, and tool categories from product evidence", () => {
    const candidates = [
      { id: "electronics", name: "Electronics" },
      { id: "motors", name: "Motors & robotics" },
      { id: "test", name: "Test & measurement equipment" },
      { id: "camera", name: "Cameras & vision" },
      { id: "cables", name: "Cables & adapters" },
      { id: "power", name: "Power supplies" },
      { id: "tools", name: "Tools & machinery" },
      { id: "boards", name: "Development Boards" },
    ];
    const examples = [
      ["Pololu 37D Metal Gearmotor", "motors"],
      ["NEMA 17 Stepper Motor", "motors"],
      ["UNI-T UT61E+ Digital Multimeter", "test"],
      ["Rigol DS1054Z Oscilloscope", "test"],
      ["Raspberry Pi Camera Module", "camera"],
      ["USB-C Cable", "cables"],
      ["Wera Screwdriver Set", "tools"],
      ["Mean Well LRS-50-12 Power Supply", "power"],
    ] as const;

    for (const [productName, expectedCategoryId] of examples) {
      expect(
        resolveImportCategorySuggestion({
          evidence: {
            productName,
            rawDescription: productName,
            supplierDescription: `Supplier description: ${productName}`,
            manufacturer: productName.startsWith("Pololu") ? "Pololu" : null,
            mpn: "fixture-mpn",
          },
          categories: candidates,
        })
      ).toMatchObject({
        category: { id: expectedCategoryId },
        method: "deterministic-fallback",
      });
    }

    expect(
      resolveImportCategorySuggestion({
        evidence: { productName: "Raspberry Pi Camera Module" },
        categories: [{ id: "sensors", name: "Sensors" }],
      })
    ).toMatchObject({ category: { id: "sensors" } });
  });

  it("assigns representative products to specific existing locations", () => {
    const categories = [
      { id: "electronics", name: "Electronics" },
      { id: "motors", name: "Motors & robotics" },
      { id: "test", name: "Test & measurement equipment" },
      { id: "camera", name: "Cameras & vision" },
      { id: "cables", name: "Cables & adapters" },
      { id: "power", name: "Power supplies" },
      { id: "tools", name: "Tools & machinery" },
    ];
    const locations = [
      {
        id: "lab",
        name: "Lab",
        parentId: null,
        pathLabel: "Lab",
        operational: false,
      },
      {
        id: "motors-drawer",
        name: "Motors Drawer",
        parentId: "lab",
        pathLabel: "Lab · Motors · Motors Drawer",
        description: "Gearmotors and motor storage",
        operational: false,
      },
      {
        id: "stepper-shelf",
        name: "Stepper Motor Shelf",
        parentId: "lab",
        pathLabel: "Lab · Motors · Stepper Motor Shelf",
        description: "Stepper motors and motion components",
        operational: false,
      },
      {
        id: "test-cabinet",
        name: "Test Equipment Cabinet",
        parentId: "lab",
        pathLabel: "Lab · Test Equipment Cabinet",
        description: "Multimeters and electrical measurement equipment",
        operational: false,
      },
      {
        id: "bench-test",
        name: "Bench Test Equipment",
        parentId: "lab",
        pathLabel: "Lab · Bench Test Equipment",
        description: "Oscilloscopes and signal testing equipment",
        operational: false,
      },
      {
        id: "camera-shelf",
        name: "Camera and Imaging Shelf",
        parentId: "lab",
        pathLabel: "Lab · Vision · Camera and Imaging Shelf",
        description: "Camera modules and vision components",
        operational: false,
      },
      {
        id: "cable-drawer",
        name: "Cable Drawer",
        parentId: "lab",
        pathLabel: "Lab · Cable Drawer",
        description: "Cables and connectors",
        operational: false,
      },
      {
        id: "usb-drawer",
        name: "USB Cable Drawer",
        parentId: "lab",
        pathLabel: "Lab · Cables · USB Cable Drawer",
        description: "USB-C cables and adapters",
        operational: false,
      },
      {
        id: "power-shelf",
        name: "Power Supply Shelf",
        parentId: "lab",
        pathLabel: "Lab · Power Supply Shelf",
        description: "Power supplies and converters",
        operational: false,
      },
      {
        id: "tool-cabinet",
        name: "Tool Cabinet",
        parentId: "lab",
        pathLabel: "Lab · Tools · Tool Cabinet",
        description: "Screwdrivers and hand tools",
        operational: false,
      },
    ];
    const examples = [
      ["Pololu 37D Metal Gearmotor", "motors", "motors-drawer"],
      ["NEMA 17 Stepper Motor", "motors", "stepper-shelf"],
      ["UNI-T UT61E+ Digital Multimeter", "test", "test-cabinet"],
      ["Rigol DS1054Z Oscilloscope", "test", "bench-test"],
      ["Raspberry Pi Camera Module", "camera", "camera-shelf"],
      ["USB-C Cable", "cables", "usb-drawer"],
      ["Wera Screwdriver Set", "tools", "tool-cabinet"],
      ["Mean Well LRS-50-12 Power Supply", "power", "power-shelf"],
    ] as const;

    for (const [productName, categoryId, locationId] of examples) {
      const evidence = { productName, rawDescription: productName };
      const category = resolveImportCategorySuggestion({
        evidence,
        categories,
      });
      expect(category.category?.id).toBe(categoryId);
      expect(
        resolveImportLocationSuggestion({
          evidence,
          category: category.category,
          locations,
        }),
        productName
      ).toMatchObject({
        location: { id: locationId },
        method: "deterministic-fallback",
      });
    }
  });

  it("accepts a valid confident Claude location and falls back when Claude has no location", () => {
    const cableCategory = { id: "cables", name: "Cables & adapters" };
    const evidence = { productName: "USB-C Cable" };
    const cableLocations = [
      {
        id: "lab",
        name: "Lab",
        parentId: null,
        pathLabel: "Lab",
        operational: false,
      },
      {
        id: "cable-drawer",
        name: "Cable Drawer",
        parentId: "lab",
        pathLabel: "Lab · Cable Drawer",
        operational: false,
      },
    ];

    expect(
      resolveImportLocationSuggestion({
        claudeLocationId: "cable-drawer",
        claudeConfidence: 0.95,
        evidence,
        category: cableCategory,
        locations: cableLocations,
      })
    ).toMatchObject({ location: { id: "cable-drawer" }, method: "claude" });
    expect(
      resolveImportLocationSuggestion({
        claudeLocationId: null,
        claudeConfidence: 0,
        evidence,
        category: cableCategory,
        locations: cableLocations,
      })
    ).toMatchObject({
      location: { id: "cable-drawer" },
      method: "deterministic-fallback",
    });
  });

  it("rejects an invalid Claude location ID and leaves weak location matches unresolved", () => {
    const locations = [
      {
        id: "lab",
        name: "Lab",
        parentId: null,
        pathLabel: "Lab",
        operational: false,
      },
      {
        id: "tool-drawer",
        name: "Tool Drawer",
        parentId: "lab",
        pathLabel: "Lab · Tool Drawer",
        operational: false,
      },
    ];
    const rejectedInvalidId = resolveImportLocationSuggestion({
      claudeLocationId: "invented-location",
      claudeConfidence: 1,
      evidence: { productName: "Wera Screwdriver Set" },
      category: { id: "tools", name: "Tools & machinery" },
      locations,
    });
    expect(rejectedInvalidId).toMatchObject({
      location: { id: "tool-drawer" },
      method: "deterministic-fallback",
    });
    expect(rejectedInvalidId.location?.id).not.toBe("invented-location");
    expect(
      resolveImportLocationSuggestion({
        evidence: { productName: "Mystery replacement item" },
        locations,
      })
    ).toEqual({ location: null, method: "unresolved" });
  });

  it("uses category inventory distribution as a strong location signal", () => {
    const categories = [{ id: "boards", name: "Development Boards" }];
    const locations = [
      {
        id: "electronics-cabinet",
        name: "Electronics Cabinet",
        parentId: null,
        pathLabel: "Electronics · Cabinet B",
        operational: false,
      },
      {
        id: "boards-drawer",
        name: "Development Boards Drawer",
        parentId: "electronics-cabinet",
        pathLabel: "Electronics · Cabinet B · Development Boards Drawer",
        operational: false,
      },
    ];
    const assets = [
      ...Array.from({ length: 17 }, (_, index) => ({
        categoryId: "boards",
        assetLocations: [
          { locationId: "boards-drawer", quantity: 1, assetKitId: null },
        ],
        id: `board-${index}`,
      })),
      ...Array.from({ length: 3 }, (_, index) => ({
        categoryId: "boards",
        assetLocations: [
          {
            locationId: "electronics-cabinet",
            quantity: 1,
            assetKitId: null,
          },
        ],
        id: `cabinet-board-${index}`,
      })),
    ];
    const affinities = buildImportLocationAffinities({
      assets,
      categories,
      locations,
    });
    const locationsWithAffinity = locations.map((location) => ({
      ...location,
      categoryAffinities: affinities.get(location.id) ?? [],
    }));

    expect(
      resolveImportLocationSuggestion({
        claudeLocationId: "electronics-cabinet",
        claudeConfidence: 0.95,
        evidence: { productName: "New ESP32 dev kit" },
        category: categories[0],
        locations: locationsWithAffinity,
      })
    ).toMatchObject({
      location: { id: "boards-drawer" },
      method: "deterministic-fallback",
    });
    expect(affinities.get("boards-drawer")).toEqual([
      {
        categoryId: "boards",
        categoryName: "Development Boards",
        assetCount: 17,
        units: 17,
      },
    ]);
  });

  it("assigns the real Mouser fixture using only existing category and location candidates", () => {
    const fixtureCategories = [
      { id: "electronics", name: "Electronics" },
      { id: "boards", name: "Development Boards" },
      { id: "sensors", name: "Sensors" },
    ];
    const fixtureLocations = [
      {
        id: "lab",
        name: "Electronics Lab",
        parentId: null,
        pathLabel: "Electronics Lab",
        operational: false,
      },
      {
        id: "boards-drawer",
        name: "Development Boards Drawer",
        parentId: "lab",
        pathLabel: "Electronics Lab · Cabinet B · Development Boards Drawer",
        description: "Microcontroller boards",
        operational: false,
      },
      {
        id: "sensors",
        name: "Sensors",
        parentId: "lab",
        pathLabel: "Electronics Lab · Sensors",
        operational: false,
      },
      {
        id: "mmwave-drawer",
        name: "mmWave Drawer",
        parentId: "sensors",
        pathLabel: "Electronics Lab · Sensors · mmWave Drawer",
        description: "Presence and distance sensors",
        operational: false,
      },
    ];
    const results = MOUSER_REAL_FIRST_PAGE_EXPECTED.map((item) => {
      const evidence = {
        manufacturer: "Seeed Studio",
        productName: item.description,
        rawDescription: item.description,
        mpn: item.mpn,
      };
      const category = resolveImportCategorySuggestion({
        evidence,
        categories: fixtureCategories,
      });
      const location = resolveImportLocationSuggestion({
        evidence,
        category: category.category,
        locations: fixtureLocations,
      });
      return {
        productName: item.description,
        categoryCandidate: category.category?.name ?? null,
        categorySelectionMethod: category.method,
        locationCandidate: location.location?.pathLabel ?? null,
        locationSelectionMethod: location.method,
      };
    });

    expect(results).toEqual([
      expect.objectContaining({
        categoryCandidate: "Sensors",
        categorySelectionMethod: "deterministic-fallback",
        locationCandidate: "Electronics Lab · Sensors · mmWave Drawer",
        locationSelectionMethod: "deterministic-fallback",
      }),
      expect.objectContaining({
        categoryCandidate: "Sensors",
        locationCandidate: "Electronics Lab · Sensors · mmWave Drawer",
      }),
      expect.objectContaining({
        categoryCandidate: "Sensors",
        locationCandidate: "Electronics Lab · Sensors · mmWave Drawer",
      }),
      expect.objectContaining({
        categoryCandidate: "Development Boards",
        categorySelectionMethod: "deterministic-fallback",
        locationCandidate:
          "Electronics Lab · Cabinet B · Development Boards Drawer",
      }),
      expect.objectContaining({
        categoryCandidate: "Development Boards",
        locationCandidate:
          "Electronics Lab · Cabinet B · Development Boards Drawer",
      }),
      expect.objectContaining({
        categoryCandidate: "Development Boards",
        locationCandidate:
          "Electronics Lab · Cabinet B · Development Boards Drawer",
      }),
    ]);
  });
});
