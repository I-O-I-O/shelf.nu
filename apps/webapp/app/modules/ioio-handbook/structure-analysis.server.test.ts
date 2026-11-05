import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  apiKey: "test-api-key",
  baseUrl: "https://anthropic.example/v1/messages",
  model: "claude-test",
}));

// why: provider credentials must stay server-side and the test needs a
// deterministic response without making a network request.
vi.mock("~/utils/env", () => ({
  ANTHROPIC_API_KEY: mocks.apiKey,
  ANTHROPIC_BASE_URL: mocks.baseUrl,
  ANTHROPIC_MODEL: mocks.model,
}));

import {
  improveHandbookStructureWithClaude,
  isHandbookStructureAnalysisAvailable,
} from "./structure-analysis.server";

const draft = {
  title: "PDF title stays out of the Claude request",
  content: "## Setup\n\nPrepare the work area.",
  sourceUrls: ["https://example.com/private-reference"],
  sourceName: "Private file name.pdf",
  categorySuggestion: "Laser Cutting",
  referencesByHeading: {},
  sourceOutline: [
    {
      id: "source-setup",
      sourceOrder: 0,
      title: "Setup",
      level: 2 as const,
      sourcePage: 1,
    },
    {
      id: "source-operation",
      sourceOrder: 1,
      title: "Operation",
      level: 2 as const,
      sourcePage: 2,
    },
  ],
  sections: [
    {
      id: "source-setup",
      sourceOrder: 0,
      title: "Setup",
      level: 2 as const,
      markdown: "## Setup\n\nPrepare the work area.",
      sourceUrls: [],
    },
    {
      id: "source-operation",
      sourceOrder: 1,
      title: "Operation",
      level: 2 as const,
      markdown: "## Operation\n\nUse the machine controls.",
      sourceUrls: [],
    },
  ],
  articles: [],
  hierarchyDetected: true,
  fallback: false,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("optional Handbook Claude structure analysis", () => {
  it("sends only extracted sections and maps suggestions back to original Markdown", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                categorySuggestion: "Workshop Operations",
                articles: [
                  {
                    title: "Operating the machine",
                    sourceSections: ["source-operation", "source-setup"],
                    proposedOutline: ["Setup", "Operation"],
                    rationale: "These sections describe one workflow.",
                  },
                ],
              }),
            },
          ],
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await improveHandbookStructureWithClaude(draft);

    expect(isHandbookStructureAnalysisAvailable()).toBe(true);
    expect(result.articles[0]?.sections.map(({ id }) => id)).toEqual([
      "source-setup",
      "source-operation",
    ]);
    const requestBody = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(requestBody.messages[0].content).toContain("source-setup");
    expect(requestBody.messages[0].content).not.toContain("Private file name");
    expect(requestBody.messages[0].content).not.toContain("private-reference");
    expect(requestBody.messages[0].content).not.toContain(
      "PDF title stays out of the Claude request"
    );
  });

  it("rejects a suggestion that omits a source section", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                categorySuggestion: "Workshop Operations",
                articles: [
                  {
                    title: "Operating the machine",
                    sourceSections: ["source-setup"],
                    proposedOutline: ["Setup"],
                    rationale: "The other source section was omitted.",
                  },
                ],
              }),
            },
          ],
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(improveHandbookStructureWithClaude(draft)).rejects.toThrow(
      "did not preserve every source section exactly once"
    );
  });
});
