import { describe, expect, it, vi } from "vitest";
import {
  callOpenRouter,
  OPENROUTER_API_URL,
  OPENROUTER_MODEL,
  parseOpenRouterResponse,
  selectIoioAiProvider,
  toOpenRouterTools,
} from "./openrouter.server";
import type { IoioToolDefinition } from "./tools.server";

const testTools: IoioToolDefinition[] = [
  "search_inventory",
  "get_item",
  "get_location",
  "get_location_contents",
  "get_kit_status",
  "get_my_loans",
].map((name) => ({
  name: name as IoioToolDefinition["name"],
  description: `${name} test tool`,
  input_schema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
}));

describe("IOIO AI provider selection", () => {
  it("keeps the existing deterministic fallback when no provider is configured", () => {
    expect(
      selectIoioAiProvider({
        configuredProvider: "",
        claudeApiKey: "",
        openRouterApiKey: "",
      })
    ).toEqual({
      provider: "fallback",
      reason: "Claude is not configured.",
    });
  });

  it("keeps Claude as the default when its existing key is present", () => {
    expect(
      selectIoioAiProvider({
        configuredProvider: "",
        claudeApiKey: "claude-test-key",
        openRouterApiKey: "openrouter-test-key",
      })
    ).toEqual({ provider: "claude" });
  });

  it("selects the fixed OpenRouter model only when explicitly enabled", () => {
    expect(
      selectIoioAiProvider({
        configuredProvider: "openrouter",
        claudeApiKey: "claude-test-key",
        openRouterApiKey: "openrouter-test-key",
      })
    ).toEqual({ provider: "openrouter", model: OPENROUTER_MODEL });
  });

  it("selects Ollama when it is configured and no provider override is set", () => {
    expect(
      selectIoioAiProvider({
        configuredProvider: "",
        claudeApiKey: "",
        openRouterApiKey: "",
        ollamaConfigured: true,
        ollamaModel: "qwen3:8b",
      })
    ).toEqual({ provider: "ollama", model: "qwen3:8b" });
  });

  it("prefers configured Ollama over a stale provider selector", () => {
    expect(
      selectIoioAiProvider({
        configuredProvider: "openrouter",
        claudeApiKey: "claude-test-key",
        openRouterApiKey: "openrouter-test-key",
        ollamaConfigured: true,
        ollamaModel: "qwen3:8b",
      })
    ).toEqual({ provider: "ollama", model: "qwen3:8b" });
  });

  it("falls back safely when OpenRouter is selected without a key", () => {
    expect(
      selectIoioAiProvider({
        configuredProvider: "openrouter",
        claudeApiKey: "claude-test-key",
        openRouterApiKey: "",
      })
    ).toEqual({
      provider: "fallback",
      reason: "OpenRouter is not configured.",
    });
  });
});

describe("OpenRouter tool-call adapter", () => {
  it("translates the explicit IOIO tools to OpenAI-compatible function tools", () => {
    const tools = toOpenRouterTools(testTools);

    expect(tools).toHaveLength(testTools.length);
    expect(tools[0]).toEqual({
      type: "function",
      function: expect.objectContaining({
        name: "search_inventory",
        parameters: expect.objectContaining({
          type: "object",
          additionalProperties: false,
        }),
      }),
    });
    expect(tools.map((tool) => tool.function.name)).not.toContain(
      "execute_sql"
    );
  });

  it("parses an OpenRouter function call without executing it", () => {
    expect(
      parseOpenRouterResponse({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call-1",
                  type: "function",
                  function: {
                    name: "search_inventory",
                    arguments: '{"query":"Arduino Nano"}',
                  },
                },
              ],
            },
          },
        ],
      })
    ).toEqual({
      content: "",
      toolCalls: [
        {
          id: "call-1",
          type: "function",
          function: {
            name: "search_inventory",
            arguments: '{"query":"Arduino Nano"}',
          },
        },
      ],
    });
  });

  it("sends the fixed model and explicit tools without exposing the key in the body", async () => {
    // why: this isolates the provider transport and verifies the request
    // contract without making a paid or external network request.
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: "Shelf found the item.",
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    await expect(
      callOpenRouter({
        apiKey: "openrouter-test-secret",
        messages: [
          { role: "user", content: "What Arduino boards do we have?" },
        ],
        tools: testTools,
        fetchImpl: fetchMock,
      })
    ).resolves.toEqual({ content: "Shelf found the item.", toolCalls: [] });

    expect(fetchMock).toHaveBeenCalledWith(
      OPENROUTER_API_URL,
      expect.objectContaining({
        headers: {
          "content-type": "application/json",
          authorization: "Bearer openrouter-test-secret",
        },
      })
    );
    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(requestBody).toMatchObject({
      model: OPENROUTER_MODEL,
      tool_choice: "auto",
    });
    expect(requestBody.tools).toHaveLength(testTools.length);
    expect(requestBody.tools).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "execute_sql" })])
    );
    expect(JSON.stringify(requestBody)).not.toContain("openrouter-test-secret");
  });

  it("can require Shelf evidence for an inventory-dependent turn", async () => {
    // why: this verifies the provider request contract without contacting
    // OpenRouter or relying on a particular model's tool-selection behavior.
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "Shelf checked the inventory." } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    await callOpenRouter({
      apiKey: "openrouter-test-secret",
      messages: [{ role: "user", content: "Where is the Nano?" }],
      tools: testTools,
      toolChoice: "required",
      fetchImpl: fetchMock,
    });

    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(requestBody.tool_choice).toBe("required");
  });
});
