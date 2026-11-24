import type { LoaderFunctionArgs } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  callOllamaMock,
  executeToolMock,
  getAssetMock,
  getLocationsMock,
  getGuidelinesMock,
} = vi.hoisted(() => ({
  callOllamaMock: vi.fn(),
  executeToolMock: vi.fn(),
  getAssetMock: vi.fn(),
  getLocationsMock: vi.fn(),
  getGuidelinesMock: vi.fn(),
}));

vi.mock("~/modules/ioio-ai-guidelines/service.server", () => ({
  getIoioAiGuidelinesForPrompt: getGuidelinesMock,
}));

vi.mock("./ollama.server", () => ({
  callOllama: callOllamaMock,
  getOllamaModel: () => "qwen3:8b",
}));
vi.mock("./tools.server", () => ({
  executeIoioReadOnlyTool: executeToolMock,
}));
vi.mock("./service.server", () => ({
  formatStudentLocationPath: (
    id: string,
    locations: Array<{ id: string; name: string; parentId: string | null }>
  ) => {
    const byId = new Map(locations.map((location) => [location.id, location]));
    const path: string[] = [];
    let current = byId.get(id);
    while (current) {
      path.unshift(current.name);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return path.join(" → ");
  },
  getStudentAsset: getAssetMock,
  getStudentLocations: getLocationsMock,
}));

import { runGroundedOllamaAssistant } from "./ollama-grounding.server";

const context = {
  getSession: () => ({ userId: "student-1" }),
} as unknown as LoaderFunctionArgs["context"];

const locationTree = [
  {
    id: "room-1",
    name: "IOIO Lab - B477",
    parentId: null,
    imageUrl: null,
    thumbnailUrl: null,
    children: [
      {
        id: "shelf-1",
        name: "Shelf A1",
        parentId: "room-1",
        imageUrl: null,
        thumbnailUrl: null,
        children: [],
        assetCount: 1,
      },
    ],
    assetCount: 1,
  },
];

function callAssistant(
  question: string,
  history: Array<{ role: "user" | "assistant"; content: string }> = [],
  entityContext: Record<string, string> = {},
  requiresEvidence = true,
  requestIntent?: "recommendation"
) {
  return runGroundedOllamaAssistant({
    question,
    history,
    context,
    request: new Request("http://localhost:3000/ioio/ask"),
    organizationId: "org-1",
    requiresEvidence,
    entityContext,
    requestIntent,
  });
}

describe("Ask IOIO Ollama inventory grounding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getGuidelinesMock.mockResolvedValue({
      generalBehaviour: "Keep responses brief.",
      inventory: "",
      borrowing: "",
      locations: "",
      studentSupport: "",
      staffSupport: "",
      actions: "",
    });
    getLocationsMock.mockResolvedValue(locationTree);
    getAssetMock.mockImplementation(
      async ({ assetId }: { assetId: string }) => {
        const toolResults = await Promise.all(
          executeToolMock.mock.results.map((result) =>
            Promise.resolve(result.value)
          )
        );
        const record = toolResults
          .flatMap((result) =>
            result && typeof result === "object" && Array.isArray(result.assets)
              ? result.assets
              : []
          )
          .find(
            (asset) =>
              asset && typeof asset === "object" && asset.id === assetId
          );
        if (!record) return null;
        return {
          ...record,
          assetModel: record.assetModel ?? null,
          assetModelId: record.assetModelId ?? record.assetModel?.id ?? null,
          locations: record.locations ?? [],
          kits: record.kits ?? [],
          qrIds: record.qrIds ?? [],
        };
      }
    );
    callOllamaMock.mockResolvedValue({
      model: "qwen3:8b",
      content: "Shelf shows the item in IOIO Lab.",
    });
  });

  it("adds organization guidance to the system prompt without replacing grounding", async () => {
    executeToolMock.mockResolvedValue({
      ok: true,
      assets: [{ id: "asset-1", title: "Arduino Uno", quantity: 1 }],
    });
    await callAssistant("How many Arduino Unos are available?");

    const systemMessage = callOllamaMock.mock.calls[0][0].messages[0];
    expect(systemMessage.role).toBe("system");
    expect(systemMessage.content).toContain("Never use model knowledge");
    expect(systemMessage.content).toContain("Keep responses brief.");
    expect(systemMessage.content).toContain("cannot authorize actions");
  });

  it("uses the latest saved guidance on the next Ask IOIO request", async () => {
    getGuidelinesMock
      .mockResolvedValueOnce({
        generalBehaviour: "Call the space IOIO Lab.",
        inventory: "",
        borrowing: "",
        locations: "",
        studentSupport: "",
        staffSupport: "",
        actions: "",
      })
      .mockResolvedValueOnce({
        generalBehaviour: "Call the space IOIO workshop.",
        inventory: "",
        borrowing: "",
        locations: "",
        studentSupport: "",
        staffSupport: "",
        actions: "",
      });

    await callAssistant("Hi", [], {}, false);
    await callAssistant("Hi", [], {}, false);

    const firstPrompt = callOllamaMock.mock.calls[0][0].messages[0].content;
    const nextPrompt = callOllamaMock.mock.calls[1][0].messages[0].content;
    expect(firstPrompt).toContain("Call the space IOIO Lab.");
    expect(nextPrompt).toContain("Call the space IOIO workshop.");
    expect(nextPrompt).not.toContain("Call the space IOIO Lab.");
  });

  it("omits the editable block when all guideline sections are empty", async () => {
    getGuidelinesMock.mockResolvedValueOnce({
      generalBehaviour: "",
      inventory: "",
      borrowing: "",
      locations: "",
      studentSupport: "",
      staffSupport: "",
      actions: "",
    });

    await callAssistant("Hi", [], {}, false);

    const systemPrompt = callOllamaMock.mock.calls[0][0].messages[0].content;
    expect(systemPrompt).toContain("Never use model knowledge");
    expect(systemPrompt).not.toContain("BEGIN STAFF-EDITABLE");
  });

  it("normalizes plural inventory names into searchable Shelf queries", async () => {
    const { extractInventorySearchQueries, extractInventorySearchTerms } =
      await import("./ollama-grounding.server");
    expect(
      extractInventorySearchQueries("How many Arduino Unos are available?")
    ).toContain("arduino uno");
    expect(
      extractInventorySearchQueries("Do we have soldering irons?")
    ).toContain("soldering iron");
    expect(
      extractInventorySearchTerms(
        "How many motors do we have and where is it located?"
      )
    ).toEqual(["motor"]);
    expect(
      extractInventorySearchQueries(
        "How many motors do we have and where is it located?"
      )
    ).toEqual(["motor"]);
    expect(extractInventorySearchQueries("Do we have a motor?")).toEqual([
      "motor",
    ]);
  });

  it("keeps project concepts and equipment names as recommendation search terms", async () => {
    const { extractRecommendationTerms } = await import(
      "./ollama-grounding.server"
    );
    expect(
      extractRecommendationTerms(
        "I'm new to IOIO Lab and want to build something with sensors. What equipment would you suggest and why?"
      )
    ).toEqual(["sensor"]);
    expect(
      extractRecommendationTerms(
        "I want to make something with a motor and Arduino. What could I use?"
      )
    ).toEqual(["motor", "arduino"]);
  });

  it("sends only relevant, available live candidates to Qwen for recommendations", async () => {
    const inventory = [
      {
        id: "sensor-1",
        title: "Ultrasonic Sensor",
        description: "Distance sensor for beginner electronics projects.",
        type: "QUANTITY",
        quantity: 3,
        availableQuantity: 2,
        availableToBook: true,
        status: "AVAILABLE",
        mainImage: null,
        assetModel: null,
        locations: [],
        kits: [],
        category: { id: "cat-1", name: "Sensors" },
        qrIds: [],
      },
      {
        id: "unavailable-sensor",
        title: "Environmental Sensor",
        description: null,
        type: "QUANTITY",
        quantity: 1,
        availableQuantity: 0,
        availableToBook: false,
        status: "CHECKED_OUT",
        mainImage: null,
        assetModel: null,
        locations: [],
        kits: [],
        category: { id: "cat-1", name: "Sensors" },
        qrIds: [],
      },
      {
        id: "unrelated-1",
        title: "Soldering Iron",
        description: null,
        type: "QUANTITY",
        quantity: 4,
        availableQuantity: 4,
        availableToBook: true,
        status: "AVAILABLE",
        mainImage: null,
        assetModel: null,
        locations: [],
        kits: [],
        category: { id: "cat-2", name: "Tools" },
        qrIds: [],
      },
    ];
    executeToolMock.mockResolvedValue({ ok: true, assets: inventory });

    const result = await callAssistant(
      "I'm new to IOIO Lab and want to build something with sensors. What equipment would you suggest and why?",
      [],
      {},
      true,
      "recommendation"
    );
    const recommendationContext = callOllamaMock.mock.calls[0][0].messages[1]
      .content as string;

    expect(executeToolMock).toHaveBeenCalledWith(
      "search_inventory",
      { query: "sensor" },
      expect.anything()
    );
    expect(recommendationContext).toContain("Ultrasonic Sensor");
    expect(recommendationContext).not.toContain("Environmental Sensor");
    expect(recommendationContext).not.toContain("Soldering Iron");
    expect(recommendationContext).toContain('"availableQuantity":2');
    expect(result.assets?.map(({ id }) => id)).toEqual(["sensor-1"]);
  });

  it.each([
    ["What kind of kits do we have?", ["kit"]],
    ["What types of kits do we have?", ["kit"]],
    ["What kinds of sensors do we have?", ["sensor"]],
    ["What sort of motors do we have?", ["motor"]],
    ["What sorts of cables are available?", ["cable"]],
    ["Do we have any kits?", ["kit"]],
    ["Show me Arduino Unos", ["arduino", "uno"]],
    ["Tell me about soldering irons", ["soldering", "iron"]],
    ["What about the motors?", ["motor"]],
  ])(
    "extracts inventory concepts from conversational phrasing: %s",
    async (question, terms) => {
      const { extractInventorySearchQueries, extractInventorySearchTerms } =
        await import("./ollama-grounding.server");

      expect(extractInventorySearchTerms(question)).toEqual(terms);
      expect(extractInventorySearchQueries(question)[0]).toBe(terms.join(" "));
    }
  );

  it("searches for the kit concept and aggregates units for a kinds-of question", async () => {
    executeToolMock.mockResolvedValue({
      ok: true,
      assets: Array.from({ length: 5 }, (_, index) => ({
        id: `kit-unit-${index + 1}`,
        title: `Makey Kit #${String(index + 1).padStart(3, "0")}`,
        type: "INDIVIDUAL",
        quantity: 1,
        availableQuantity: 1,
        availableToBook: true,
        status: "ACTIVE",
        category: { id: "boards", name: "Boards & Embedded Systems" },
        assetModel: { id: "makey-model", name: "Makey Kit" },
        locations: [{ id: "shelf-1", name: "Container A1-13", quantity: 1 }],
        kits: [],
      })),
    });
    callOllamaMock.mockResolvedValue({
      model: "qwen3:8b",
      content: "Shelf currently lists Makey Kit as one logical product.",
    });

    const result = await callAssistant("What kind of kits do we have?");
    const searchInputs = executeToolMock.mock.calls.map(([, input]) => input);
    const evidence = JSON.parse(
      callOllamaMock.mock.calls[0][0].messages[1].content.split("JSON):\n")[1]
    );

    expect(searchInputs).toEqual([{ query: "kit" }]);
    expect(result.state).toBe("answered");
    expect(result.assetIds).toEqual([
      "kit-unit-1",
      "kit-unit-2",
      "kit-unit-3",
      "kit-unit-4",
      "kit-unit-5",
    ]);
    expect(evidence.searches).toEqual(["kit"]);
    expect(evidence.matchCount).toBe(1);
    expect(evidence.matches[0].name).toBe("Makey Kit");
    expect(evidence.matches[0].totalQuantity).toBe(5);
  });

  it("uses the normalized subject in a genuine zero-result response", async () => {
    executeToolMock.mockResolvedValue({ ok: true, assets: [] });

    const result = await callAssistant("What kind of kits do we have?");

    expect(executeToolMock).toHaveBeenCalledWith(
      "search_inventory",
      { query: "kit" },
      expect.anything()
    );
    expect(result.state).toBe("no-match");
    expect(result.content).toBe(
      "I couldn't find any kits in the current IOIO inventory."
    );
  });

  it("aggregates physical Kit units into one logical product for general questions", async () => {
    executeToolMock.mockResolvedValue({
      ok: true,
      assets: Array.from({ length: 5 }, (_, index) => ({
        id: `makey-${index + 1}`,
        title: `Makey Kit #${String(index + 1).padStart(3, "0")}`,
        type: "INDIVIDUAL",
        quantity: 1,
        availableQuantity: 1,
        availableToBook: true,
        status: "ACTIVE",
        category: { id: "boards", name: "Boards & Embedded Systems" },
        assetModel: { id: "makey-model", name: "Makey Kit" },
        locations: [{ id: "shelf-1", name: "Container A1-13", quantity: 1 }],
        kits: [],
      })),
    });

    const result = await callAssistant("How many Makey Kits do we have?");

    expect(result.state).toBe("answered");
    expect(result.unitLevel).toBe(false);
    expect(result.assetIds).toEqual([
      "makey-1",
      "makey-2",
      "makey-3",
      "makey-4",
      "makey-5",
    ]);
    const evidence = JSON.parse(
      callOllamaMock.mock.calls[0][0].messages[1].content.split("JSON):\n")[1]
    );
    expect(evidence.matchCount).toBe(1);
    expect(evidence.matches[0].name).toBe("Makey Kit");
    expect(evidence.matches[0].totalQuantity).toBe(5);
    expect(evidence.matches[0].availableQuantity).toBe(5);
    expect(evidence.matches[0].locations).toEqual([
      "IOIO Lab - B477 · Shelf A1",
    ]);
    expect(evidence.matches[0].name).not.toContain("#001");
  });

  it("uses all resolved rows for multi-product counts while keeping Qwen evidence compact and image-free", async () => {
    const presentationAssets = [
      ...Array.from({ length: 23 }, (_, index) => ({
        id: `arduino-${index + 1}`,
        title: `Arduino Kit #${String(index + 1).padStart(3, "0")}`,
        description: null,
        type: "INDIVIDUAL",
        quantity: null,
        availableQuantity: 1,
        availableToBook: true,
        status: "AVAILABLE",
        assetModelId: "arduino-model",
        mainImage: null,
        mainImageExpiration: null,
        thumbnailImage: null,
        assetModel: {
          id: "arduino-model",
          name: "Arduino Kit",
          image: "https://storage.example/arduino-cover.jpg",
          thumbnailImage: "https://storage.example/arduino-thumb.jpg",
        },
        category: { id: "boards", name: "Boards & Embedded Systems" },
        locations: [{ id: "shelf-1", name: "Container A1-13", quantity: 1 }],
        kits: [],
        qrIds: [`private-arduino-qr-${index + 1}`],
      })),
      ...Array.from({ length: 2 }, (_, index) => ({
        id: `makey-${index + 1}`,
        title: `Makey Kit #${String(index + 1).padStart(3, "0")}`,
        description: null,
        type: "INDIVIDUAL",
        quantity: null,
        availableQuantity: index === 0 ? 1 : 0,
        availableToBook: index === 0,
        status: index === 0 ? "AVAILABLE" : "CHECKED_OUT",
        assetModelId: "makey-model",
        mainImage: null,
        mainImageExpiration: null,
        thumbnailImage: null,
        assetModel: {
          id: "makey-model",
          name: "Makey Kit",
          image: null,
          thumbnailImage: null,
        },
        category: { id: "boards", name: "Boards & Embedded Systems" },
        locations: [{ id: "shelf-1", name: "Container A1-13", quantity: 1 }],
        kits: [],
        qrIds: [`private-makey-qr-${index + 1}`],
      })),
    ];
    executeToolMock.mockResolvedValue({
      ok: true,
      assets: presentationAssets.slice(0, 20),
      presentationAssets,
    });

    const result = await callAssistant("How many kits do we have?");
    const evidence = JSON.parse(
      callOllamaMock.mock.calls[0][0].messages[1].content.split("JSON):\n")[1]
    );

    expect(executeToolMock).toHaveBeenCalledWith(
      "search_inventory",
      { query: "kit" },
      expect.objectContaining({ includePresentationAssets: true })
    );
    expect(result.assets).toHaveLength(25);
    expect(result.assetIds).toHaveLength(25);
    expect(getAssetMock).not.toHaveBeenCalled();
    expect(evidence.matchCount).toBe(2);
    expect(evidence.matches).toMatchObject([
      { name: "Arduino Kit", totalQuantity: 23, availableQuantity: 23 },
      { name: "Makey Kit", totalQuantity: 2, availableQuantity: 1 },
    ]);
    const serializedEvidence =
      callOllamaMock.mock.calls[0][0].messages[1].content;
    expect(serializedEvidence).not.toContain("arduino-cover.jpg");
    expect(serializedEvidence).not.toContain("private-arduino-qr-");
    expect(serializedEvidence).not.toContain("arduino-001");
    expect(getGuidelinesMock).toHaveBeenCalledWith("org-1");
  });

  it("aggregates every matching unit by logical product before Qwen sees evidence", async () => {
    const physicalAssets = [
      ...Array.from({ length: 23 }, (_, index) => ({
        id: `arduino-${index + 1}`,
        title: `Arduino Kit #${String(index + 1).padStart(3, "0")}`,
        description: null,
        type: "INDIVIDUAL",
        quantity: null,
        availableQuantity: 1,
        availableToBook: true,
        status: "AVAILABLE",
        assetModelId: "arduino-model",
        mainImage: null,
        mainImageExpiration: null,
        thumbnailImage: null,
        assetModel: {
          id: "arduino-model",
          name: "Arduino Kit",
          image: "https://storage.example/arduino-cover.jpg",
          thumbnailImage: "https://storage.example/arduino-thumb.jpg",
        },
        category: { id: "boards", name: "Boards & Embedded Systems" },
        locations: [{ id: "shelf-1", name: "Container A1-13", quantity: 1 }],
        kits: [],
        qrIds: [`private-qr-${index + 1}`],
      })),
      ...Array.from({ length: 2 }, (_, index) => ({
        id: `makey-${index + 1}`,
        title: `Makey Kit #${String(index + 1).padStart(3, "0")}`,
        description: null,
        type: "INDIVIDUAL",
        quantity: null,
        availableQuantity: index === 0 ? 1 : 0,
        availableToBook: index === 0,
        status: index === 0 ? "AVAILABLE" : "CHECKED_OUT",
        assetModelId: "makey-model",
        mainImage: null,
        mainImageExpiration: null,
        thumbnailImage: null,
        assetModel: {
          id: "makey-model",
          name: "Makey Kit",
          image: null,
          thumbnailImage: null,
        },
        category: { id: "boards", name: "Boards & Embedded Systems" },
        locations: [{ id: "shelf-1", name: "Container A1-13", quantity: 1 }],
        kits: [],
        qrIds: [`makey-qr-${index + 1}`],
      })),
    ];
    executeToolMock.mockResolvedValue({
      ok: true,
      assets: physicalAssets.slice(0, 20),
      presentationAssets: physicalAssets,
    });

    const result = await callAssistant("How many kits do we have?");
    const evidence = JSON.parse(
      callOllamaMock.mock.calls[0][0].messages[1].content.split("JSON):\n")[1]
    );

    expect(executeToolMock).toHaveBeenCalledWith(
      "search_inventory",
      { query: "kit" },
      expect.objectContaining({ includePresentationAssets: true })
    );
    expect(result.assets).toHaveLength(25);
    expect(result.assetIds).toHaveLength(25);
    expect(getAssetMock).not.toHaveBeenCalled();
    expect(evidence.matchCount).toBe(2);
    expect(evidence.matches).toMatchObject([
      { name: "Arduino Kit", totalQuantity: 23, availableQuantity: 23 },
      { name: "Makey Kit", totalQuantity: 2, availableQuantity: 1 },
    ]);
    const qwenEvidence = callOllamaMock.mock.calls[0][0].messages[1].content;
    expect(qwenEvidence).not.toContain("arduino-cover.jpg");
    expect(qwenEvidence).not.toContain("private-qr-");
    expect(qwenEvidence).not.toContain("arduino-001");
  });

  it("keeps exact unit-level questions expanded", async () => {
    executeToolMock.mockResolvedValue({
      ok: true,
      assets: [
        {
          id: "makey-3",
          title: "Makey Kit #003",
          type: "INDIVIDUAL",
          quantity: 1,
          availableQuantity: 0,
          availableToBook: false,
          category: { id: "boards", name: "Boards & Embedded Systems" },
          assetModel: { id: "makey-model", name: "Makey Kit" },
          locations: [{ id: "shelf-1", name: "Container A1-13", quantity: 1 }],
          kits: [],
        },
      ],
    });

    const result = await callAssistant("Where is Makey Kit #003?");
    const evidence = JSON.parse(
      callOllamaMock.mock.calls[0][0].messages[1].content.split("JSON):\n")[1]
    );

    expect(result.unitLevel).toBe(true);
    expect(result.assetIds).toEqual(["makey-3"]);
    expect(evidence.matchCount).toBe(1);
    expect(evidence.matches[0].name).toBe("Makey Kit #003");
  });

  it("rejects unrelated Shelf fallback rows before they can reach Qwen", async () => {
    executeToolMock.mockResolvedValue({
      ok: true,
      assets: [
        {
          id: "makey-1",
          title: "Makey Kit #001",
          type: "INDIVIDUAL",
          quantity: 1,
          category: { name: "Computing" },
          description: "A controller kit.",
        },
        {
          id: "makey-2",
          title: "Makey Kit #002",
          type: "INDIVIDUAL",
          quantity: 1,
          category: { name: "Computing" },
          description: null,
        },
      ],
    });

    const result = await callAssistant(
      "How many motors do we have and where is it located?"
    );

    expect(result.state).toBe("no-match");
    expect(result.content).toMatch(/couldn't find any motor/i);
    expect(callOllamaMock).not.toHaveBeenCalled();
  });

  it.each([
    "How many motors do we have and where are they located?",
    "Do we have a motor?",
    "Where are the Quantum Banana Controllers?",
  ])("returns a grounded zero-result answer for %s", async (question) => {
    executeToolMock.mockResolvedValue({
      ok: true,
      assets: [
        {
          id: "makey-1",
          title: "Makey Kit #001",
          type: "INDIVIDUAL",
          quantity: 1,
          category: { name: "Boards & Embedded Systems" },
          description: "A controller kit.",
        },
      ],
    });

    const result = await callAssistant(question);

    expect(result.state).toBe("no-match");
    expect(result.assetIds).toEqual([]);
    expect(result.content).toMatch(/couldn't find any/i);
    expect(callOllamaMock).not.toHaveBeenCalled();
  });

  it("accepts records genuinely related through their canonical category", async () => {
    executeToolMock.mockResolvedValue({
      ok: true,
      assets: [
        {
          id: "dc-motor",
          title: "DC Motor",
          type: "QUANTITY_TRACKED",
          quantity: 5,
          availableQuantity: 3,
          category: { name: "Motors, Power & Actuation" },
          description: null,
          locations: [{ id: "shelf-1", name: "Shelf A1", quantity: 5 }],
          kits: [],
        },
        {
          id: "makey-1",
          title: "Makey Kit #001",
          category: { name: "Computing" },
          description: "A controller kit.",
        },
      ],
    });

    const result = await callAssistant(
      "How many motors do we have and where is it located?"
    );

    expect(result.state).toBe("answered");
    expect(result.assetIds).toEqual(["dc-motor"]);
    const systemEvidence = callOllamaMock.mock.calls[0][0].messages[1].content;
    expect(systemEvidence).toContain("DC Motor");
    expect(systemEvidence).not.toContain("Makey Kit");
  });

  it("does not let a previous inventory question contaminate the current Qwen answer", async () => {
    executeToolMock.mockResolvedValue({
      ok: true,
      assets: [
        {
          id: "motor",
          title: "Motor",
          type: "QUANTITY_TRACKED",
          quantity: 10,
          availableQuantity: 10,
          availableToBook: true,
          category: { id: "motors", name: "Motors, Power & Actuation" },
          locations: [{ id: "shelf-1", name: "Container A1-13", quantity: 10 }],
          kits: [],
        },
        {
          id: "makey-1",
          title: "Makey Kit #001",
          type: "INDIVIDUAL",
          quantity: 1,
          category: { id: "boards", name: "Boards & Embedded Systems" },
          assetModel: { id: "makey-model", name: "Makey Kit" },
          description: "A controller kit.",
          locations: [],
          kits: [],
        },
      ],
    });

    const result = await callAssistant(
      "How many motors do we have and where are they located?",
      [{ role: "user", content: "How many Makey Kits do we have?" }]
    );

    expect(result.state).toBe("answered");
    expect(result.assetIds).toEqual(["motor"]);
    const messages = callOllamaMock.mock.calls[0][0].messages;
    expect(messages).toHaveLength(4);
    expect(messages[1].content).toContain('"name":"Motor"');
    expect(messages[1].content).not.toContain("Makey Kit");
    expect(messages[3].content).toBe(
      "How many motors do we have and where are they located?"
    );
  });

  it("searches a newly named item instead of reusing the previous asset context", async () => {
    executeToolMock.mockResolvedValue({
      ok: true,
      assets: [
        {
          id: "motor",
          title: "Motor",
          type: "QUANTITY_TRACKED",
          quantity: 10,
          availableQuantity: 10,
          availableToBook: true,
          category: { id: "motors", name: "Motors, Power & Actuation" },
          locations: [{ id: "shelf-1", name: "Container A1-13", quantity: 10 }],
          kits: [],
        },
        {
          id: "makey-2",
          title: "Makey Kit #002",
          type: "INDIVIDUAL",
          quantity: 1,
          availableQuantity: 1,
          availableToBook: true,
          category: { id: "boards", name: "Boards & Embedded Systems" },
          description: "A controller kit.",
          assetModel: { id: "makey-model", name: "Makey Kit" },
          locations: [],
          kits: [],
        },
      ],
    });

    const result = await callAssistant(
      "How many motors do we have and where are they located?",
      [],
      { activeAssetId: "makey-2" }
    );

    expect(result.state).toBe("answered");
    expect(result.assetIds).toEqual(["motor"]);
    expect(executeToolMock).toHaveBeenCalledWith(
      "search_inventory",
      { query: "motor" },
      expect.any(Object)
    );
    expect(executeToolMock).not.toHaveBeenCalledWith(
      "get_item",
      expect.anything(),
      expect.anything()
    );
  });

  it("keeps broad cable searches relevant to cable names or categories", async () => {
    executeToolMock.mockResolvedValue({
      ok: true,
      assets: [
        {
          id: "usb-c-cable",
          title: "USB-C Cable",
          type: "QUANTITY_TRACKED",
          quantity: 8,
          availableQuantity: 6,
          category: { name: "Cables & Adapters" },
        },
        {
          id: "makey-1",
          title: "Makey Kit #001",
          category: { name: "Computing" },
        },
      ],
    });

    const result = await callAssistant("Do we have cables?");

    expect(result.state).toBe("answered");
    expect(result.assetIds).toEqual(["usb-c-cable"]);
    const systemEvidence = callOllamaMock.mock.calls[0][0].messages[1].content;
    expect(systemEvidence).toContain("USB-C Cable");
    expect(systemEvidence).not.toContain("Makey Kit");
  });

  it("resolves a known item's location without admitting unrelated search rows", async () => {
    executeToolMock.mockResolvedValue({
      ok: true,
      assets: [
        {
          id: "multimeter",
          title: "Multimeter",
          type: "QUANTITY_TRACKED",
          quantity: 3,
          availableQuantity: 2,
          category: { name: "Measuring" },
          description: null,
          locations: [{ id: "shelf-1", name: "Shelf A1", quantity: 3 }],
        },
        {
          id: "makey-1",
          title: "Makey Kit #001",
          category: { name: "Computing" },
        },
      ],
    });

    const result = await callAssistant("Where is the multimeter?");

    expect(result.state).toBe("answered");
    expect(result.assetIds).toEqual(["multimeter"]);
    const systemEvidence = callOllamaMock.mock.calls[0][0].messages[1].content;
    expect(systemEvidence).toContain("IOIO Lab - B477 · Shelf A1");
    expect(systemEvidence).not.toContain("Makey Kit");
  });

  it("treats an empty Shelf search as real zero results and never asks Qwen to fill the gap", async () => {
    executeToolMock.mockResolvedValue({ ok: true, assets: [] });

    const result = await callAssistant("How many Arduino Unos are available?");

    expect(result.state).toBe("no-match");
    expect(result.content).toMatch(/couldn't find any arduino uno/i);
    expect(result.toolsUsed).toContain("search_inventory");
    expect(executeToolMock).toHaveBeenCalledWith(
      "search_inventory",
      { query: "arduino uno" },
      expect.any(Object)
    );
    expect(callOllamaMock).not.toHaveBeenCalled();
  });

  it("passes only matching canonical facts and human-readable locations to Qwen", async () => {
    executeToolMock.mockResolvedValue({
      ok: true,
      assets: [
        {
          id: "internal-asset-id",
          title: "Multimeter",
          type: "QUANTITY_TRACKED",
          quantity: 4,
          availableQuantity: 2,
          availableToBook: true,
          status: "ACTIVE",
          category: { id: "category-id", name: "Measuring" },
          locations: [{ id: "shelf-1", name: "Shelf A1", quantity: 4 }],
          kits: [],
          qrIds: ["private-qr-id"],
        },
      ],
    });

    const result = await callAssistant("How many multimeters are available?");

    expect(result.state).toBe("answered");
    expect(result.assetIds).toEqual(["internal-asset-id"]);
    const systemEvidence = callOllamaMock.mock.calls[0][0].messages[1].content;
    expect(systemEvidence).toContain('"name":"Multimeter"');
    expect(systemEvidence).toContain('"availableQuantity":2');
    expect(systemEvidence).toContain("IOIO Lab - B477 · Shelf A1");
    expect(systemEvidence).not.toContain("internal-asset-id");
    expect(systemEvidence).not.toContain("private-qr-id");
  });

  it("fails closed when Shelf inventory cannot be retrieved", async () => {
    executeToolMock.mockRejectedValue(new Error("database unavailable"));

    const result = await callAssistant("Do we have Arduino Unos?");

    expect(result.state).toBe("unavailable");
    expect(result.content).toMatch(
      /couldn't check the current IOIO inventory/i
    );
    expect(callOllamaMock).not.toHaveBeenCalled();
  });

  it("provides multiple matches to Qwen so an ambiguous request can be clarified", async () => {
    executeToolMock.mockResolvedValue({
      ok: true,
      assets: [
        { id: "asset-1", title: "Voltage meter", quantity: 1 },
        { id: "asset-2", title: "Voltage sensor", quantity: 3 },
      ],
    });

    await callAssistant("What do we have for voltage?");

    const systemEvidence = callOllamaMock.mock.calls[0][0].messages[1].content;
    expect(systemEvidence).toContain('"matchCount":2');
    expect(systemEvidence).toContain("Voltage meter");
    expect(systemEvidence).toContain("Voltage sensor");
  });
});
