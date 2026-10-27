import { describe, expect, it, vi } from "vitest";
import { requestImportHelperProposal } from "./import-helper-client.server";
import {
  createMouserEnrichmentRequest,
  createImportHelperRequest,
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
    activeCategories: [{ id: "category-electronics", name: "Electronics" }],
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
    allowedTrackingModes: ["INDIVIDUAL", "QUANTITY_TRACKED"],
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
        trackingSuggestion: { mode: "INDIVIDUAL", confidence: 0.95 },
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

describe("import helper contract", () => {
  it("accepts minimal Mouser enrichment while preserving deterministic fields", () => {
    const request = makeMouserRequest();
    const response = parseAndValidateImportHelperResponse(
      JSON.stringify(makeMouserResponse()),
      request
    );

    expect("mode" in response).toBe(true);
    if (!("mode" in response)) throw new Error("Expected Mouser response");
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
    if (!("mode" in validated)) throw new Error("Expected Mouser response");
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

    if ("mode" in response) throw new Error("Expected generic proposal");
    expect(response.rows[0]?.productMatch.candidateId).toBe("model-nano");
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
    if ("mode" in validated) throw new Error("Expected generic proposal");
    expect(validated.rows[0]?.categorySuggestion).toMatchObject({
      categoryId: null,
      confidence: 0,
    });
  });

  it("rejects invalid quantities and unsupported tracking suggestions", () => {
    const zeroQuantity = makeResponse();
    zeroQuantity.rows[0]!.quantity = 0;
    expect(() =>
      parseAndValidateImportHelperResponse(
        JSON.stringify(zeroQuantity),
        makeRequest()
      )
    ).toThrow("malformed or unsupported response");

    const unsupportedTracking = makeResponse();
    unsupportedTracking.rows[0]!.trackingSuggestion.mode =
      "SERIALIZED" as "INDIVIDUAL";
    expect(() =>
      parseAndValidateImportHelperResponse(
        JSON.stringify(unsupportedTracking),
        makeRequest()
      )
    ).toThrow("malformed or unsupported response");
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

  it("enforces the individual-unit limits in the helper proposal", () => {
    const tooManyOnRow = makeResponse();
    tooManyOnRow.rows[0]!.quantity = 101;
    expect(() =>
      parseAndValidateImportHelperResponse(
        JSON.stringify(tooManyOnRow),
        makeRequest()
      )
    ).toThrow("individual-unit row limit");

    const tooManyAcrossImport = makeResponse();
    tooManyAcrossImport.rows = Array.from({ length: 6 }, (_, index) => ({
      ...makeResponse().rows[0]!,
      sourceRef: "page-1",
      quantity: 100,
      productName: `Arduino Nano ${index}`,
    }));
    expect(() =>
      parseAndValidateImportHelperResponse(
        JSON.stringify(tooManyAcrossImport),
        makeRequest()
      )
    ).toThrow("individual-unit import limit");
  });

  it("returns safe manual mode for malformed JSON", async () => {
    // why: exercise the HTTP boundary with an invalid body that cannot be represented by a valid response object.
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response("{not-json", { status: 200 }))
    );
    const result = await requestImportHelperProposal(makeRequest(), {
      endpoint: "https://helper.example.test/import",
      authToken: "test-secret",
      fetchImpl,
    });

    expect(result).toEqual({ status: "manual", reason: "invalid-response" });
  });

  it("returns safe manual mode when the helper is not configured or unavailable", async () => {
    const notConfigured = await requestImportHelperProposal(makeRequest(), {});
    expect(notConfigured).toEqual({
      status: "manual",
      reason: "not-configured",
    });

    // why: simulate an upstream service outage without making a network request.
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response("unavailable", { status: 503 }))
    );
    const unavailable = await requestImportHelperProposal(makeRequest(), {
      endpoint: "https://helper.example.test/import",
      authToken: "test-secret",
      fetchImpl,
    });
    expect(unavailable).toEqual({ status: "manual", reason: "unavailable" });
  });

  it("returns safe manual mode when the helper times out", async () => {
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
  });

  it("sends only the schema payload and keeps credentials in the auth header", async () => {
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
  });
});
