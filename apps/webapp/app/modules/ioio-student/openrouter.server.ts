import { z } from "zod";
import type { IoioToolDefinition } from "./tools.server";

export const OPENROUTER_API_URL =
  "https://openrouter.ai/api/v1/chat/completions";
export const OPENROUTER_MODEL = "minimax/minimax-m3:free";

export type IoioAiProvider = "claude" | "openrouter" | "ollama" | "fallback";

export type IoioAiProviderSelection = {
  provider: IoioAiProvider;
  model?: string;
  reason?: string;
};

/**
 * Ollama is preferred whenever the local service is configured. This keeps a
 * stale provider selector from routing Ask IOIO away from the local model.
 * Other providers remain available when Ollama is not configured, and a
 * provider without its required configuration never makes an outbound request.
 */
export function selectIoioAiProvider({
  configuredProvider,
  claudeApiKey,
  openRouterApiKey,
  ollamaConfigured = false,
  ollamaModel,
}: {
  configuredProvider?: string | null;
  claudeApiKey?: string | null;
  openRouterApiKey?: string | null;
  ollamaConfigured?: boolean;
  ollamaModel?: string;
}): IoioAiProviderSelection {
  const provider = configuredProvider?.trim().toLowerCase();

  if (ollamaConfigured) {
    return { provider: "ollama", model: ollamaModel };
  }

  if (provider === "openrouter") {
    return openRouterApiKey
      ? { provider: "openrouter", model: OPENROUTER_MODEL }
      : { provider: "fallback", reason: "OpenRouter is not configured." };
  }

  if (provider === "ollama") {
    return ollamaConfigured
      ? { provider: "ollama", model: ollamaModel }
      : { provider: "fallback", reason: "Ollama is not configured." };
  }

  if (provider === "claude" || (!provider && claudeApiKey)) {
    return claudeApiKey
      ? { provider: "claude" }
      : { provider: "fallback", reason: "Claude is not configured." };
  }

  return claudeApiKey
    ? { provider: "claude" }
    : { provider: "fallback", reason: "Claude is not configured." };
}

export type OpenRouterToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type OpenRouterMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: OpenRouterToolCall[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

export type OpenRouterCompletion = {
  content: string;
  toolCalls: OpenRouterToolCall[];
};

export type OpenRouterToolChoice = "auto" | "required";

const openRouterResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable().optional(),
          tool_calls: z
            .array(
              z.object({
                id: z.string().min(1),
                type: z.literal("function"),
                function: z.object({
                  name: z.string().min(1),
                  arguments: z.string(),
                }),
              })
            )
            .optional(),
        }),
      })
    )
    .min(1),
});

export class OpenRouterProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenRouterProviderError";
  }
}

export function toOpenRouterTools(tools: readonly IoioToolDefinition[]) {
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }));
}

export function parseOpenRouterResponse(value: unknown): OpenRouterCompletion {
  const parsed = openRouterResponseSchema.safeParse(value);
  if (!parsed.success) {
    throw new OpenRouterProviderError("malformed-response");
  }

  const message = parsed.data.choices[0].message;
  return {
    content: message.content?.trim() ?? "",
    toolCalls: message.tool_calls ?? [],
  };
}

export async function callOpenRouter({
  apiKey,
  messages,
  tools,
  toolChoice = "auto",
  fetchImpl = fetch,
}: {
  apiKey: string;
  messages: OpenRouterMessage[];
  tools: readonly IoioToolDefinition[];
  toolChoice?: OpenRouterToolChoice;
  fetchImpl?: typeof fetch;
}): Promise<OpenRouterCompletion> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);

  try {
    const response = await fetchImpl(OPENROUTER_API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        max_tokens: 700,
        messages,
        tools: toOpenRouterTools(tools),
        tool_choice: toolChoice,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new OpenRouterProviderError(`http-${response.status}`);
    }

    return parseOpenRouterResponse(await response.json());
  } catch (error) {
    if (error instanceof OpenRouterProviderError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new OpenRouterProviderError("timeout");
    }
    throw new OpenRouterProviderError("network-error");
  } finally {
    clearTimeout(timeout);
  }
}
