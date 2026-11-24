import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getStudentAssetsMock,
  getStudentAssetMock,
  prepareBorrowItemMock,
  prepareReportProblemMock,
  requireStudentReadMock,
  runGroundedOllamaAssistantMock,
  selectProviderMock,
} = vi.hoisted(() => ({
  getStudentAssetsMock: vi.fn(),
  getStudentAssetMock: vi.fn(),
  prepareBorrowItemMock: vi.fn(),
  prepareReportProblemMock: vi.fn(),
  requireStudentReadMock: vi.fn(),
  runGroundedOllamaAssistantMock: vi.fn(),
  selectProviderMock: vi.fn(),
}));

vi.mock("~/components/ioio-student/inventory-presentation", () => ({
  groupStudentAssets: (assets: unknown[]) => assets,
  selectStudentAssistantDisplayAssets: () => [],
}));
vi.mock("~/modules/ioio-handbook/service.server", () => ({
  getHandbookContextForAssistant: vi.fn().mockResolvedValue(""),
}));
vi.mock("~/utils/env", () => ({
  ANTHROPIC_API_KEY: "",
  ANTHROPIC_BASE_URL: "",
  ANTHROPIC_MODEL: "",
  IOIO_AI_PROVIDER: "ollama",
  OPENROUTER_API_KEY: "",
}));
vi.mock("~/utils/logger", () => ({
  Logger: { info: vi.fn(), warn: vi.fn() },
}));
vi.mock("./borrow-item.server", () => ({
  prepareBorrowItem: prepareBorrowItemMock,
}));
vi.mock("./ollama-grounding.server", () => ({
  extractInventorySearchTerms: (value: string) =>
    value.toLowerCase().match(/[a-z0-9]+/g) ?? [],
  extractRecommendationTerms: () => [],
  runGroundedOllamaAssistant: runGroundedOllamaAssistantMock,
}));
vi.mock("./ollama.server", () => ({
  OllamaProviderError: class OllamaProviderError extends Error {},
  getOllamaModel: () => "qwen3:8b",
  isOllamaConfigured: () => true,
}));
vi.mock("./openrouter.server", () => ({
  OPENROUTER_MODEL: "test-model",
  OpenRouterProviderError: class OpenRouterProviderError extends Error {},
  callOpenRouter: vi.fn(),
  selectIoioAiProvider: selectProviderMock,
}));
vi.mock("./report-problem.server", () => ({
  prepareReportProblem: prepareReportProblemMock,
}));
vi.mock("./request-routing.server", () => ({
  submitAskIoioKnowledge: vi.fn(),
}));
vi.mock("./return-item.server", () => ({
  prepareReturnItem: vi.fn(),
}));
vi.mock("./route.server", () => ({
  requireStudentRead: requireStudentReadMock,
}));
vi.mock("./service.server", () => ({
  answerStudentQuestion: vi.fn(),
  findStudentAssetFuzzyMatches: vi.fn(),
  formatStudentLocationPath: vi.fn(),
  getMyStudentLoans: vi.fn(),
  getStudentAsset: getStudentAssetMock,
  getStudentAssets: getStudentAssetsMock,
  getStudentKits: vi.fn(),
  getStudentLocations: vi.fn(),
}));
vi.mock("./tools.server", () => ({
  executeIoioReadOnlyTool: vi.fn(),
  IOIO_READ_ONLY_TOOLS: [],
}));
vi.mock("~/utils/error", () => ({
  isLikeShelfError: () => false,
}));

import { answerInventoryAssistant } from "./assistant.server";
import type { PreparedBorrowProposal } from "./borrow-item.server";
import type { StudentAsset } from "./service.server";

const context = { getSession: () => ({ userId: "student-1" }) } as never;
const request = new Request("http://localhost:3000/ioio/ask");
const asset = {
  id: "asset-1",
  title: "Arduino",
  type: "QUANTITY_TRACKED",
  locations: [],
} as unknown as StudentAsset;
const borrowProposal = {
  confirmationToken: "confirmation-token",
  operationId: "operation-1",
  asset: {
    id: "asset-1",
    title: "Arduino",
    type: "QUANTITY_TRACKED",
    location: null,
  },
  kit: null,
  quantity: 1,
  selectedPhysicalUnitIds: [],
  availableQuantity: 3,
  from: "2026-10-01T00:00:00.000Z",
  to: "2026-10-08T00:00:00.000Z",
  restriction: null,
  requiresApproval: false,
  requiresStaffPreparation: false,
  staffReservationWarning: null,
} satisfies PreparedBorrowProposal;

describe("Ask IOIO controlled action orchestration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireStudentReadMock.mockResolvedValue({
      organizationId: "ioio-lab",
      userId: "student-1",
      role: "SELF_SERVICE",
    });
    selectProviderMock.mockReturnValue({
      provider: "ollama",
      model: "qwen3:8b",
    });
    getStudentAssetsMock.mockResolvedValue([asset]);
    getStudentAssetMock.mockResolvedValue(null);
    prepareBorrowItemMock.mockResolvedValue(borrowProposal);
    prepareReportProblemMock.mockResolvedValue({
      confirmationToken: "report-token",
      reportType: "ITEM_DAMAGED",
      description: "The Motor is broken.",
      asset: { id: "motor-asset", title: "Motor" },
      kit: null,
      location: null,
    });
    runGroundedOllamaAssistantMock.mockResolvedValue({
      state: "answered",
      content: "Shelf has motors.",
      assets: [],
      assetIds: [],
      toolsUsed: [],
      unitLevel: false,
      model: "qwen3:8b",
    });
  });

  it("preflights a supported borrow before calling the model and returns only a proposal", async () => {
    const result = await answerInventoryAssistant({
      context,
      request,
      question: "I want to borrow one Arduino",
    });

    expect(result.borrowProposal).toBe(borrowProposal);
    expect(result.answer).toContain("Nothing has been borrowed yet");
    expect(prepareBorrowItemMock).toHaveBeenCalledOnce();
    expect(getStudentAssetsMock).toHaveBeenCalledWith({
      organizationId: "ioio-lab",
      query: "Arduino",
    });
    expect(runGroundedOllamaAssistantMock).not.toHaveBeenCalled();
  });

  it("keeps availability questions informational even when they mention borrowing", async () => {
    await answerInventoryAssistant({
      context,
      request,
      question: "Do we have any motors to borrow?",
    });

    expect(prepareBorrowItemMock).not.toHaveBeenCalled();
    expect(runGroundedOllamaAssistantMock).toHaveBeenCalledOnce();
  });

  it("asks for a missing item without fetching the whole inventory", async () => {
    const result = await answerInventoryAssistant({
      context,
      request,
      question: "I want to borrow one",
    });

    expect(result.answer).toContain("Which item would you like to borrow");
    expect(getStudentAssetsMock).not.toHaveBeenCalled();
    expect(prepareBorrowItemMock).not.toHaveBeenCalled();
  });

  it("does not advertise unsupported inventory writes as provider actions", async () => {
    const result = await answerInventoryAssistant({
      context,
      request,
      question: "Create a section called Electronics in B477.",
    });

    expect(result.answer).toContain("I can't make inventory changes");
    expect(prepareBorrowItemMock).not.toHaveBeenCalled();
    expect(runGroundedOllamaAssistantMock).not.toHaveBeenCalled();
  });

  it("keeps an explicitly named new item ahead of stale selected-item context", async () => {
    const oldAsset = { ...asset, id: "old-arduino", title: "Arduino" };
    const motor = { ...asset, id: "motor-asset", title: "Motor" };
    getStudentAssetMock.mockResolvedValue(oldAsset);
    getStudentAssetsMock.mockResolvedValue([motor]);
    prepareBorrowItemMock.mockResolvedValue({
      ...borrowProposal,
      asset: { ...borrowProposal.asset, id: "motor-asset", title: "Motor" },
    });

    const result = await answerInventoryAssistant({
      context,
      request,
      question: "I want to borrow one Motor",
      entityContext: {
        currentAssetId: "old-arduino",
        activeAssetId: "old-arduino",
        activeAssetName: "Arduino",
        pendingAction: "borrow",
        lastIntent: "borrow",
        activeIntent: "borrow",
      },
    });

    expect(prepareBorrowItemMock).toHaveBeenCalledWith(
      expect.objectContaining({ asset_id: "motor-asset" }),
      expect.anything()
    );
    expect(result.entityContext.currentAssetId).toBe("motor-asset");
  });

  it("retains the resolved report target when the user supplies the issue in a follow-up", async () => {
    const motor = { ...asset, id: "motor-asset", title: "Motor" };
    getStudentAssetsMock.mockResolvedValue([motor]);
    getStudentAssetMock.mockResolvedValue(motor);
    const first = await answerInventoryAssistant({
      context,
      request,
      question: "Report a problem with the Motor",
    });

    expect(first.answer).toContain("What problem should I report");
    expect(first.entityContext.currentAssetId).toBe("motor-asset");

    const second = await answerInventoryAssistant({
      context,
      request,
      question: "It is broken",
      history: [
        { role: "user", content: "Report a problem with the Motor" },
        { role: "assistant", content: first.answer },
      ],
      entityContext: first.entityContext,
    });

    expect(prepareReportProblemMock).toHaveBeenCalledWith(
      expect.objectContaining({
        asset_id: "motor-asset",
        report_type: "ITEM_DAMAGED",
      }),
      expect.anything()
    );
    expect(second.proposal).toMatchObject({
      asset: { id: "motor-asset", title: "Motor" },
    });
    expect(runGroundedOllamaAssistantMock).not.toHaveBeenCalled();
  });
});
