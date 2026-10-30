import { afterEach, describe, expect, it, vi } from "vitest";
import { Logger } from "~/utils/logger";
import { requestImportHelperProposal } from "./import-helper-client.server";
import {
  createMouserEnrichmentRequest,
  createImportHelperRequest,
  importHelperRequestSchema,
  parseAndValidateImportHelperResponse,
  validateImportHelperResponse,
  type ImportHelperRequest,
} from "./import-helper-contract.server";

function makeMouserRequest() {
  return createMouserEnrichmentRequest({
    fileSha256: "a".repeat(64),
    lineItems: [
      {
        sourceRef: "mouser-p1-line1",
        sourcePage: 1,
        supplierProductNumber: "713-101010001",
        mpn: "101010001",
        rawDescription: "Seeed Studio 24GHz mmWave Sensor",
        quantity: 4,
      },
    ],
    activeCategories: [
      {
        id: "category-electronics",
        name: "Electronics",
        description: "General storage and electronic equipment",
      },
    ],
    relevantLocations: [
      {
        id: "sensors-drawer",
        name: "Sensors drawer",
        pathLabel: "Electronics / Sensors drawer",
        description: null,
        parentId: null,
        hasChildren: false,
      },
    ],
  });
}

function makeMouserResponse() {
  return {
    mode: "MOUSER_LINE_ITEM_ENRICHMENT",
    schemaVersion: 2,
    rows: [
      {
        sourceRef: "mouser-p1-line1",
        supplierProductNumber: "713-101010001",
        mpn: "101010001",
        productName: "Seeed Studio 24GHz mmWave Sensor",
        manufacturer: "Seeed Studio",
        description: "Seeed Studio 24GHz mmWave Sensor",
        quantity: 4,
        categoryId: "category-electronics",
        categoryConfidence: 0.94,
        locationId: "sensors-drawer",
        locationConfidence: 0.88,
        confidence: 0.94,
      },
    ],
  };
}

function makeRequest(): ImportHelperRequest {
  return createImportHelperRequest({
    document: {
      pages: [
        {
          sourceRef: "page-1",
          page: 1,
          text: "Invoice line: Arduino Nano, quantity 5, by Arduino, MPN ABX00071.\n713-101010001\nSeeed Studio Seeed Studio 24GHz mmWave Sensor – TARIC: 123456\nT\nillv\n. Artikelnr: 1\n260,76\nContinued\nRadnr\nLine No.\nBeskrivning",
        },
      ],
    },
    activeCategories: [{ id: "category-electronics", name: "Electronics" }],
    relevantLocations: [
      {
        id: "location-storage",
        pathLabel: "IOIO Lab / Electronics / Shelf A",
        occupancy: {
          currentUnits: 18,
          proposedUnits: 5,
          capacity: null,
          context: "Capacity is not configured",
        },
      },
    ],
    productCandidates: [
      {
        id: "model-nano",
        name: "Arduino Nano",
        manufacturer: "Arduino",
        mpn: "ABX00071",
      },
    ],
    allowedTrackingModes: ["QUANTITY_TRACKED"],
    allowedSettings: [
      { key: "minQuantity", minimum: 0, maximum: 1000 },
      { key: "unitOfMeasure", allowedValues: ["pcs", "boxes"] },
      { key: "consumptionType", allowedValues: ["ONE_WAY", "TWO_WAY"] },
    ],
  });
}

function makeResponse() {
  return {
    schemaVersion: 1,
    rows: [
      {
        sourceRef: "page-1",
        productName: "Arduino Nano",
        supplierProductNumber: null,
        quantity: 5,
        quantityStatus: "SHIPPED",
        manufacturer: "Arduino",
        mpn: "ABX00071",
        description: null,
        productMatch: {
          matchType: "EXISTING",
          candidateId: "model-nano",
          confidence: 0.99,
        },
        categorySuggestion: {
          categoryId: "category-electronics",
          proposedName: null,
          confidence: 0.9,
        },
        trackingSuggestion: { mode: "QUANTITY_TRACKED", confidence: 0.95 },
        kitHint: { isKit: false, name: null, confidence: 0.99 },
        settingsSuggestions: [
          { key: "unitOfMeasure", value: "pcs", confidence: 0.8 },
        ],
        locationSuggestions: [
          { locationId: "location-storage", confidence: 0.75 },
        ],
        questions: [],
        evidence: [{ sourceRef: "page-1", text: "Arduino Nano, quantity 5" }],
      },
    ],
    questions: [],
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function expectDiagnostic(
  loggerInfo: ReturnType<typeof vi.spyOn>,
  result: string,
  httpStatus: number | null,
  requestMode = "GENERIC_IMPORT"
) {
  expect(loggerInfo).toHaveBeenCalledWith(
    expect.objectContaining({
      event: "ioio_import_helper_client_result",
      httpStatus,
      result,
      requestMode,
      requestBytes: expect.any(Number),
      durationMs: expect.any(Number),
    })
  );
}

describe("import helper contract", () => {
  it("accepts only bounded create-location operations with allowlisted parents", () => {
    const request = importHelperRequestSchema.parse({
      mode: "LOCATION_STRUCTURE",
      schemaVersion: 1,
      instruction: "Create a section",
      existingLocations: [
        {
          id: "room-1",
          name: "Storage Room",
          parentId: null,
          path: "Storage Room",
          description: null,
        },
      ],
    });
    const valid = {
      mode: "LOCATION_STRUCTURE",
      schemaVersion: 1,
      operations: [
        {
          action: "CREATE_LOCATION",
          temporaryId: "section-a",
          parentLocationId: "room-1",
          parentTemporaryId: null,
          name: "Section A",
          description: null,
        },
      ],
    };
    expect(validateImportHelperResponse(valid, request)).toMatchObject({
      operations: [{ action: "CREATE_LOCATION", parentLocationId: "room-1" }],
    });
    expect(() =>
      validateImportHelperResponse(
        {
          ...valid,
          operations: [
            { ...valid.operations[0], parentLocationId: "other-org-location" },
          ],
        },
        request
      )
    ).toThrow(/outside the supplied organization hierarchy/);
    expect(() =>
      validateImportHelperResponse(
        {
          ...valid,
          operations: [{ ...valid.operations[0], action: "DELETE_LOCATION" }],
        },
        request
      )
    ).toThrow();
  });

  it("bounds organization context and rejects model IDs outside the supplied batch", () => {
    const request = {
      mode: "INVENTORY_REORGANIZATION",
      schemaVersion: 1,
      instruction: "Find better locations",
      scope: {},
      items: [
        {
          modelId: "model-1",
          productName: "XIAO ESP32",
          manufacturer: null,
          shortDescription: null,
          currentCategoryId: "cat-1",
          currentLocationId: "loc-1",
          quantity: 2,
        },
      ],
      categories: [
        { id: "cat-1", name: "Development Boards", description: null },
      ],
      locations: [
        {
          id: "loc-1",
          name: "Boards drawer",
          path: "Electronics / Boards drawer",
          hierarchyDepth: 1,
          categoryAffinitySummary: "Development Boards: 12",
        },
      ],
    };
    const parsed = importHelperRequestSchema.parse(request);
    expect(() =>
      validateImportHelperResponse(
        {
          mode: "INVENTORY_REORGANIZATION",
          schemaVersion: 1,
          proposals: [
            {
              modelId: "other-model",
              suggestedCategoryId: "cat-1",
              categoryConfidence: 0.9,
              suggestedLocationId: "loc-1",
              locationConfidence: 0.9,
              reason: "Category concentration",
            },
          ],
        },
        parsed
      )
    ).toThrow(/unknown or duplicate model ID/);
    const validated = validateImportHelperResponse(
      {
        mode: "INVENTORY_REORGANIZATION",
        schemaVersion: 1,
        proposals: [
          {
            modelId: "model-1",
            suggestedCategoryId: "outside-category",
            categoryConfidence: 0.9,
            suggestedLocationId: "outside-location",
            locationConfidence: 0.9,
            reason: "Unknown IDs",
          },
        ],
      },
      parsed
    );
    expect("proposals" in validated && validated.proposals[0]).toMatchObject({
      suggestedCategoryId: null,
      categoryConfidence: 0,
      suggestedLocationId: null,
      locationConfidence: 0,
    });
    expect(() =>
      importHelperRequestSchema.parse({
        ...request,
        items: Array.from({ length: 41 }, (_, index) => ({
          ...request.items[0],
          modelId: `model-${index}`,
        })),
      })
    ).toThrow();
  });

  it("validates semantic structure references against bounded live location context", () => {
    const request = importHelperRequestSchema.parse({
      mode: "ORGANIZATION_PLAN",
      schemaVersion: 1,
      instruction: "remove all containers in Section A",
      locationContext: [
        {
          name: "Storage Room",
          path: "Storage Room",
          childSummary: "1 direct children",
        },
        {
          name: "Section A",
          path: "Storage Room / Section A",
          childSummary: "2 direct children",
        },
      ],
    });
    const response = {
      mode: "ORGANIZATION_PLAN",
      schemaVersion: 1,
      domain: "LOCATION_STRUCTURE",
      operations: [
        {
          operation: "DELETE_CHILDREN",
          targetRef: { name: "Section A", ancestorName: "Storage Room" },
          childTypeHint: "container",
          quantity: { mode: "ALL" },
        },
      ],
    };
    expect(validateImportHelperResponse(response, request)).toMatchObject({
      domain: "LOCATION_STRUCTURE",
    });
    const typedOperation = {
      operation: "DELETE_CHILDREN",
      targetRef: { name: "Section A" },
      childRole: "CONTAINER",
      quantity: { mode: "ALL" },
    };
    expect(
      validateImportHelperResponse(
        { ...response, operations: [typedOperation] },
        request
      )
    ).toMatchObject({ operations: [{ childRole: "CONTAINER" }] });
    for (const operation of [
      { ...typedOperation, childRole: "STORAGE_BIN" },
      { ...typedOperation, childTypeHint: "shelf" },
    ])
      expect(() =>
        validateImportHelperResponse(
          { ...response, operations: [operation] },
          request
        )
      ).toThrow(/malformed organization plan/);

    expect(
      validateImportHelperResponse(
        {
          ...response,
          scope: { ancestorRef: { name: "Storage Room" } },
          operations: [
            { ...response.operations[0], targetRef: { name: "Section A" } },
          ],
        },
        request
      )
    ).toMatchObject({
      scope: { ancestorRef: { name: "Storage Room" } },
      operations: [{ targetRef: { name: "Section A" } }],
    });
    expect(() =>
      validateImportHelperResponse(
        {
          ...response,
          operations: [
            {
              ...response.operations[0],
              targetRef: { name: "Section A", ancestorName: "Other Room" },
            },
          ],
        },
        request
      )
    ).toThrow(/outside the supplied organization context/);
    expect(() =>
      validateImportHelperResponse(
        { ...response, operations: [{ operation: "RUN_SQL" }] },
        request
      )
    ).toThrow(/malformed organization plan/);
  });

  it("accepts bounded task interpretation and rejects invented IDs or unsupported capabilities", () => {
    const request = importHelperRequestSchema.parse({
      mode: "SHELF_TASK_PLAN",
      schemaVersion: 1,
      instruction: "what is in Section B?",
      availableSources: [{ type: "SHELF_LOCATIONS" }],
      locationContext: [
        {
          name: "Section B",
          path: "Storage Room / Section B",
          childSummary: "2 direct children",
        },
      ],
    });
    const response = {
      mode: "SHELF_TASK_PLAN",
      schemaVersion: 1,
      taskPlan: {
        taskType: "ANALYSIS",
        goal: "Read location tree",
        sources: [{ type: "SHELF_LOCATIONS" }],
        steps: [
          {
            id: "section",
            capability: "RESOLVE_LOCATION",
            ref: { name: "Section B", withinRef: { name: "Storage Room" } },
          },
          { id: "tree", capability: "READ_LOCATION_TREE", within: "section" },
        ],
        writesRequested: false,
        mutationPolicy: "PROPOSAL_ONLY",
        expectedOutput: "LOCATION_SUMMARY",
      },
    };
    expect(validateImportHelperResponse(response, request)).toEqual(response);
    const placementRequest = importHelperRequestSchema.parse({
      mode: "SHELF_TASK_PLAN",
      schemaVersion: 1,
      instruction: "These selected items are overflowing; suggest locations.",
      availableSources: [
        { type: "SHELF_INVENTORY" },
        { type: "SHELF_LOCATIONS" },
      ],
      locationContext: [],
    });
    const placementResponse = {
      mode: "SHELF_TASK_PLAN",
      schemaVersion: 1,
      taskPlan: {
        taskType: "INVENTORY_PLACEMENT",
        goal: "Redistribute selected products",
        sources: [{ type: "SHELF_INVENTORY" }, { type: "SHELF_LOCATIONS" }],
        steps: [
          {
            id: "models",
            capability: "SELECT_MODELS",
            selection: "STAFF_SELECTED",
          },
          {
            id: "placement",
            capability: "PROPOSE_LOCATION_CHANGE",
            selection: "models",
            placementPressure: "USER_REPORTED_HIGH",
          },
        ],
        writesRequested: true,
        mutationPolicy: "PROPOSAL_ONLY",
        expectedOutput: "INVENTORY_PROPOSAL",
      },
    };
    expect(
      validateImportHelperResponse(placementResponse, placementRequest)
    ).toEqual(placementResponse);
    expect(() =>
      validateImportHelperResponse(
        {
          ...response,
          taskPlan: {
            ...response.taskPlan,
            steps: [{ id: "sql", capability: "RUN_SQL" }],
          },
        },
        request
      )
    ).toThrow();
    expect(() =>
      validateImportHelperResponse(
        {
          ...response,
          taskPlan: {
            ...response.taskPlan,
            steps: [
              {
                id: "section",
                capability: "RESOLVE_LOCATION",
                ref: { name: "Section B", id: "invented" },
              },
            ],
          },
        },
        request
      )
    ).toThrow();
    expect(() =>
      importHelperRequestSchema.parse({
        ...request,
        DATABASE_URL: "must-not-pass",
      })
    ).toThrow();
  });

  afterEach(() => vi.restoreAllMocks());

  it("keeps both request modes compatible with the strict helper schema at 2c17389d", () => {
    const genericRequest = makeRequest();
    const mouserRequest = makeMouserRequest();

    expect(importHelperRequestSchema.parse(genericRequest)).toEqual(
      genericRequest
    );
    expect(importHelperRequestSchema.parse(mouserRequest)).toEqual(
      mouserRequest
    );
    expect(genericRequest.activeCategories[0]).not.toHaveProperty("color");
    expect(genericRequest.relevantLocations[0]).not.toHaveProperty(
      "operational"
    );
    expect(mouserRequest.lineItems[0]).not.toHaveProperty(
      "supplierDescription"
    );
    expect(mouserRequest.relevantLocations?.[0]).not.toHaveProperty(
      "operational"
    );
  });

  it("accepts minimal Mouser enrichment while preserving deterministic fields", () => {
    const request = makeMouserRequest();
    const response = parseAndValidateImportHelperResponse(
      JSON.stringify(makeMouserResponse()),
      request
    );

    expect("mode" in response).toBe(true);
    if (
      !("mode" in response) ||
      response.mode !== "MOUSER_LINE_ITEM_ENRICHMENT"
    )
      throw new Error("Expected Mouser response");
    expect(response.rows).toEqual([makeMouserResponse().rows[0]]);
  });

  it.each([
    ["quantity", { quantity: 99 }],
    ["supplier product number", { supplierProductNumber: "713-000000000" }],
    ["MPN", { mpn: "different-mpn" }],
  ])("rejects a Claude change to deterministic %s", (_label, change) => {
    const response = makeMouserResponse();
    Object.assign(response.rows[0], change);
    expect(() =>
      validateImportHelperResponse(response, makeMouserRequest())
    ).toThrow("changed a deterministic Mouser identifier or quantity");
  });

  it("clears invented Mouser category and location IDs and rejects missing line rows", () => {
    const inventedCategory = makeMouserResponse();
    inventedCategory.rows[0]!.categoryId = "invented-category";
    inventedCategory.rows[0]!.locationId = "invented-location";
    const validated = validateImportHelperResponse(
      inventedCategory,
      makeMouserRequest()
    );
    if (
      !("mode" in validated) ||
      validated.mode !== "MOUSER_LINE_ITEM_ENRICHMENT"
    )
      throw new Error("Expected Mouser response");
    expect(validated.rows[0]).toMatchObject({
      categoryId: null,
      categoryConfidence: 0,
      locationId: null,
      locationConfidence: 0,
    });

    const missing = { ...makeMouserResponse(), rows: [] };
    expect(() =>
      validateImportHelperResponse(missing, makeMouserRequest())
    ).toThrow("exactly one enriched row");
  });

  it("accepts a valid versioned proposal and verifiable evidence", () => {
    const request = makeRequest();
    const response = parseAndValidateImportHelperResponse(
      JSON.stringify(makeResponse()),
      request
    );

    if (!("rows" in response)) throw new Error("Expected generic proposal");
    const row = response.rows[0];
    if (!row || !("productMatch" in row))
      throw new Error("Expected generic proposal row");
    expect(row.productMatch.candidateId).toBe("model-nano");
    expect(row.categorySuggestion.categoryId).toBe("category-electronics");
    expect(row.locationSuggestions[0]?.locationId).toBe("location-storage");
    expect(request.document.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects unknown response fields", () => {
    const response = {
      ...makeResponse(),
      executableSql: "INSERT INTO Asset ...",
    };
    expect(() =>
      parseAndValidateImportHelperResponse(
        JSON.stringify(response),
        makeRequest()
      )
    ).toThrow("malformed or unsupported response");
  });

  it("clears category IDs outside Shelf-provided allowlists", () => {
    const response = makeResponse();
    response.rows[0]!.categorySuggestion.categoryId = "category-from-helper";
    const validated = parseAndValidateImportHelperResponse(
      JSON.stringify(response),
      makeRequest()
    );
    if (!("rows" in validated)) throw new Error("Expected generic proposal");
    const row = validated.rows[0];
    if (!row || !("categorySuggestion" in row))
      throw new Error("Expected generic proposal row");
    expect(row.categorySuggestion).toMatchObject({
      categoryId: null,
      confidence: 0,
    });

    const invalidLocation = makeResponse();
    invalidLocation.rows[0]!.locationSuggestions[0]!.locationId =
      "location-from-helper";
    const checkedLocation = parseAndValidateImportHelperResponse(
      JSON.stringify(invalidLocation),
      makeRequest()
    );
    if ("mode" in checkedLocation) throw new Error("Expected generic proposal");
    expect(checkedLocation.rows[0]?.locationSuggestions).toEqual([]);
  });

  it("normalizes individual suggestions to quantity and rejects unsupported modes", () => {
    const zeroQuantity = makeResponse();
    zeroQuantity.rows[0]!.quantity = 0;
    expect(() =>
      parseAndValidateImportHelperResponse(
        JSON.stringify(zeroQuantity),
        makeRequest()
      )
    ).toThrow("malformed or unsupported response");

    const individualTracking = makeResponse();
    individualTracking.rows[0]!.trackingSuggestion.mode =
      "INDIVIDUAL" as "QUANTITY_TRACKED";
    expect(
      parseAndValidateImportHelperResponse(
        JSON.stringify(individualTracking),
        makeRequest()
      )
    ).toMatchObject({
      rows: [
        {
          trackingSuggestion: { mode: "QUANTITY_TRACKED" },
        },
      ],
    });

    const unsupportedTracking = makeResponse();
    unsupportedTracking.rows[0]!.trackingSuggestion.mode =
      "SERIALIZED" as "QUANTITY_TRACKED";
    expect(() =>
      parseAndValidateImportHelperResponse(
        JSON.stringify(unsupportedTracking),
        makeRequest()
      )
    ).toThrow("malformed or unsupported response");
  });

  it("only allows quantity tracking in import helper requests", () => {
    const request = makeRequest();
    expect(request.allowedTrackingModes).toEqual(["QUANTITY_TRACKED"]);
    expect(() =>
      importHelperRequestSchema.parse({
        ...request,
        allowedTrackingModes: ["INDIVIDUAL", "QUANTITY_TRACKED"],
      })
    ).toThrow();
  });

  it("filters invoice headers, prices, and fragments while cleaning code-only titles", () => {
    const base = makeResponse().rows[0]!;
    const noisyNames = [
      "T",
      "illv",
      ". Artikelnr: 1",
      "260,76",
      "Continued",
      "Radnr",
      "Line No.",
      "Beskrivning",
    ];
    const response = {
      schemaVersion: 1,
      rows: [
        {
          ...base,
          productName: "713-101010001",
          supplierProductNumber: "713-101010001",
          manufacturer: "Seeed Studio",
          mpn: "101010001",
          description:
            "Seeed Studio Seeed Studio 24GHz mmWave Sensor – TARIC: 123456",
          evidence: [{ sourceRef: "page-1", text: "713-101010001" }],
        },
        ...noisyNames.map((productName) => ({
          ...base,
          productName,
          description: null,
          evidence: [{ sourceRef: "page-1", text: productName }],
        })),
      ],
      questions: [],
    };

    const validated = parseAndValidateImportHelperResponse(
      JSON.stringify(response),
      makeRequest()
    );

    if (!("rows" in validated)) throw new Error("Expected generic proposal");
    expect(validated.rows).toHaveLength(1);
    expect(validated.rows[0]).toMatchObject({
      productName: "Seeed Studio 24GHz mmWave Sensor",
      description: "Seeed Studio 24GHz mmWave Sensor",
      supplierProductNumber: "713-101010001",
      mpn: "101010001",
    });
  });

  it("rejects oversized generic helper output instead of returning hundreds of candidate rows", () => {
    const baseRow = makeResponse().rows[0]!;
    const oversizedResponse = {
      schemaVersion: 1,
      rows: Array.from({ length: 101 }, () => ({ ...baseRow })),
      questions: [],
    };

    expect(() =>
      parseAndValidateImportHelperResponse(
        JSON.stringify(oversizedResponse),
        makeRequest()
      )
    ).toThrow("malformed or unsupported response");
  });

  it("rejects unsupported settings and unverifiable evidence", () => {
    const invalidSetting = makeResponse();
    invalidSetting.rows[0]!.settingsSuggestions[0]!.value = "not-allowed";
    expect(() =>
      parseAndValidateImportHelperResponse(
        JSON.stringify(invalidSetting),
        makeRequest()
      )
    ).toThrow("disallowed unitOfMeasure");

    const invalidEvidence = makeResponse();
    invalidEvidence.rows[0]!.evidence[0]!.text = "This quote is absent";
    expect(() =>
      parseAndValidateImportHelperResponse(
        JSON.stringify(invalidEvidence),
        makeRequest()
      )
    ).toThrow("evidence that cannot be verified");
  });

  it("returns safe manual mode for malformed JSON", async () => {
    // why: exercise the HTTP boundary with an invalid body that cannot be represented by a valid response object.
    const loggerInfo = vi.spyOn(Logger, "info").mockImplementation(() => {});
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response("{not-json", { status: 200 }))
    );
    const result = await requestImportHelperProposal(makeRequest(), {
      endpoint: "https://helper.example.test/import",
      authToken: "test-secret",
      fetchImpl,
    });

    expect(result).toEqual({ status: "manual", reason: "invalid_response" });
    expectDiagnostic(loggerInfo, "invalid_response", 200);
  });

  it("returns safe manual mode when the helper is not configured or unavailable", async () => {
    const loggerInfo = vi.spyOn(Logger, "info").mockImplementation(() => {});
    const notConfigured = await requestImportHelperProposal(makeRequest(), {});
    expect(notConfigured).toEqual({
      status: "manual",
      reason: "helper_not_configured",
    });
    expectDiagnostic(loggerInfo, "helper_not_configured", null);

    // why: simulate an upstream service outage without making a network request.
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response("unavailable", { status: 503 }))
    );
    const unavailable = await requestImportHelperProposal(makeRequest(), {
      endpoint: "https://helper.example.test/import",
      authToken: "test-secret",
      fetchImpl,
    });
    expect(unavailable).toEqual({
      status: "manual",
      reason: "helper_busy_503",
    });
    expectDiagnostic(loggerInfo, "helper_busy_503", 503);
  });

  it.each([
    [400, "invalid_request_400"],
    [401, "unauthorized_401"],
    [502, "helper_inference_502"],
  ] as const)("classifies helper HTTP %s", async (status, classification) => {
    const loggerInfo = vi.spyOn(Logger, "info").mockImplementation(() => {});
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response("ignored", { status }))
    );

    const result = await requestImportHelperProposal(makeRequest(), {
      endpoint: "https://helper.example.test/import",
      authToken: "test-secret",
      fetchImpl,
    });

    expect(result).toEqual({ status: "manual", reason: classification });
    expectDiagnostic(loggerInfo, classification, status);
    expect(JSON.stringify(loggerInfo.mock.calls)).not.toContain("test-secret");
  });

  it("classifies network failures without logging exception or request content", async () => {
    const loggerInfo = vi.spyOn(Logger, "info").mockImplementation(() => {});
    const fetchImpl = vi.fn(() =>
      Promise.reject(new TypeError("socket error: sensitive detail"))
    );

    const result = await requestImportHelperProposal(makeRequest(), {
      endpoint: "https://helper.example.test/import",
      authToken: "test-secret",
      fetchImpl,
    });

    expect(result).toEqual({ status: "manual", reason: "network_error" });
    expectDiagnostic(loggerInfo, "network_error", null);
    const logged = JSON.stringify(loggerInfo.mock.calls);
    expect(logged).not.toContain("test-secret");
    expect(logged).not.toContain("socket error");
    expect(logged).not.toContain("Arduino Nano");
  });

  it("returns safe manual mode when the helper times out", async () => {
    const loggerInfo = vi.spyOn(Logger, "info").mockImplementation(() => {});
    // why: hold the fake request open until the client's AbortController fires.
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError"))
          );
        })
    );
    const result = await requestImportHelperProposal(makeRequest(), {
      endpoint: "https://helper.example.test/import",
      authToken: "test-secret",
      timeoutMs: 1,
      fetchImpl,
    });

    expect(result).toEqual({ status: "manual", reason: "timeout" });
    expectDiagnostic(loggerInfo, "timeout", null);
  });

  it("sends only the schema payload and keeps credentials in the auth header", async () => {
    const loggerInfo = vi.spyOn(Logger, "info").mockImplementation(() => {});
    const request = makeRequest();
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body).toEqual(request);
        expect(JSON.stringify(body)).not.toContain("test-secret");
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer test-secret"
        );
        return Promise.resolve(jsonResponse(makeResponse()));
      }
    );

    const result = await requestImportHelperProposal(request, {
      endpoint: "https://helper.example.test/import",
      authToken: "test-secret",
      fetchImpl,
    });

    expect(result.status).toBe("ready");
    expectDiagnostic(loggerInfo, "success", 200);
    expect(JSON.stringify(loggerInfo.mock.calls)).not.toContain("test-secret");
  });

  it("logs the Mouser request mode on success", async () => {
    const loggerInfo = vi.spyOn(Logger, "info").mockImplementation(() => {});
    const fetchImpl = vi.fn(() =>
      Promise.resolve(jsonResponse(makeMouserResponse()))
    );

    const result = await requestImportHelperProposal(makeMouserRequest(), {
      endpoint: "https://helper.example.test/import",
      authToken: "test-secret",
      fetchImpl,
    });

    expect(result.status).toBe("ready");
    expectDiagnostic(loggerInfo, "success", 200, "MOUSER_LINE_ITEM_ENRICHMENT");
  });
});
