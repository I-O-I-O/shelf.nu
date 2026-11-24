import { z } from "zod";

export const OLLAMA_DEFAULT_MODEL = "qwen3:8b";
export const OLLAMA_TIMEOUT_MS = 20_000;

export type OllamaMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

const ollamaResponseSchema = z.object({
  model: z.string().optional(),
  message: z.object({
    role: z.literal("assistant"),
    content: z.string(),
  }),
});

export class OllamaProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OllamaProviderError";
  }
}

function getOllamaBaseUrl() {
  return process.env.OLLAMA_BASE_URL?.trim().replace(/\/+$/, "") ?? "";
}

export function getOllamaModel() {
  return process.env.OLLAMA_MODEL?.trim() || OLLAMA_DEFAULT_MODEL;
}

export function isOllamaConfigured() {
  return Boolean(getOllamaBaseUrl());
}

export async function callOllama({
  messages,
  fetchImpl = fetch,
}: {
  messages: OllamaMessage[];
  fetchImpl?: typeof fetch;
}) {
  const baseUrl = getOllamaBaseUrl();
  if (!baseUrl) throw new OllamaProviderError("missing-base-url");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);

  try {
    const response = await fetchImpl(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: getOllamaModel(),
        think: false,
        stream: false,
        messages,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new OllamaProviderError(`http-${response.status}`);
    }

    const parsed = ollamaResponseSchema.safeParse(await response.json());
    if (!parsed.success || !parsed.data.message.content.trim()) {
      throw new OllamaProviderError("malformed-response");
    }

    return {
      model: parsed.data.model ?? getOllamaModel(),
      content: parsed.data.message.content.trim(),
    };
  } catch (error) {
    if (error instanceof OllamaProviderError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new OllamaProviderError("timeout");
    }
    throw new OllamaProviderError("network-error");
  } finally {
    clearTimeout(timeout);
  }
}
