import { beforeEach, describe, expect, it, vi } from "vitest";

const { getStudentAssetsMock, requireStudentReadMock } = vi.hoisted(() => ({
  getStudentAssetsMock: vi.fn(),
  requireStudentReadMock: vi.fn(),
}));

vi.mock("./route.server", () => ({
  requireStudentRead: requireStudentReadMock,
}));
vi.mock("./service.server", () => ({
  getStudentAsset: vi.fn(),
  getStudentAssets: getStudentAssetsMock,
  getStudentKits: vi.fn(),
  getStudentLocations: vi.fn(),
  getMyStudentLoans: vi.fn(),
}));
vi.mock("~/utils/logger", () => ({
  Logger: { info: vi.fn(), warn: vi.fn() },
}));

import { executeIoioReadOnlyTool } from "./tools.server";

const context = {
  getSession: () => ({ userId: "student-1" }),
} as never;
const request = new Request("http://localhost:3000/ioio/ask");

describe("Ask IOIO inventory tool presentation results", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireStudentReadMock.mockResolvedValue({
      organizationId: "org-1",
      userId: "student-1",
    });
    getStudentAssetsMock.mockResolvedValue(
      Array.from({ length: 25 }, (_, index) => ({
        id: `unit-${index + 1}`,
        title: `Makey Kit #${String(index + 1).padStart(3, "0")}`,
        sequentialId: null,
        type: "INDIVIDUAL",
        category: null,
        quantity: null,
        availableQuantity: 1,
        availableToBook: true,
        status: "AVAILABLE",
        locations: [],
        kits: [],
        qrIds: [],
        mainImage: null,
        mainImageStoragePath: `org-1/makey/${index + 1}.jpg`,
      }))
    );
  });

  it("keeps the regular provider tool capped but gives Ollama complete resolved rows internally", async () => {
    const normalResult = await executeIoioReadOnlyTool(
      "search_inventory",
      { query: "kit" },
      { context, request }
    );
    const groundingResult = await executeIoioReadOnlyTool(
      "search_inventory",
      { query: "kit" },
      { context, request, includePresentationAssets: true }
    );
    const normalData = normalResult as {
      assets: Array<Record<string, unknown>>;
    };
    const groundingData = groundingResult as {
      assets: Array<Record<string, unknown>>;
      presentationAssets: Array<Record<string, unknown>>;
    };

    expect(normalResult).toMatchObject({ ok: true, assets: expect.any(Array) });
    expect(normalData.assets).toHaveLength(20);
    expect(normalResult).not.toHaveProperty("presentationAssets");
    expect(groundingData.assets).toHaveLength(20);
    expect(groundingData.presentationAssets).toHaveLength(25);
    expect(groundingData.assets[0]).not.toHaveProperty("mainImageStoragePath");
    expect(groundingData.presentationAssets[0]).toHaveProperty(
      "mainImageStoragePath"
    );
  });
});
