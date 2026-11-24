import { afterEach, describe, expect, it, vi } from "vitest";
import { callOllama, OLLAMA_DEFAULT_MODEL } from "./ollama.server";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Ollama transport", () => {
  it("sends the non-streaming Qwen chat request server-side", async () => {
    vi.stubEnv("OLLAMA_BASE_URL", "http://ollama.test:11434/");
    vi.stubEnv("OLLAMA_MODEL", OLLAMA_DEFAULT_MODEL);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          model: OLLAMA_DEFAULT_MODEL,
          message: { role: "assistant", content: "Hello from IOIO." },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    await expect(
      callOllama({
        messages: [
          { role: "system", content: "You are the IOIO Lab assistant." },
          { role: "user", content: "Hi" },
        ],
        fetchImpl: fetchMock,
      })
    ).resolves.toEqual({
      model: OLLAMA_DEFAULT_MODEL,
      content: "Hello from IOIO.",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://ollama.test:11434/api/chat",
      expect.objectContaining({ method: "POST" })
    );
    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(requestBody).toMatchObject({
      model: OLLAMA_DEFAULT_MODEL,
      think: false,
      stream: false,
    });
    expect(requestBody.messages).toHaveLength(2);
  });

  it("turns an offline response into a provider error", async () => {
    vi.stubEnv("OLLAMA_BASE_URL", "http://ollama.test:11434");
    const fetchMock = vi.fn().mockRejectedValue(new Error("offline"));

    await expect(
      callOllama({
        messages: [{ role: "user", content: "Hi" }],
        fetchImpl: fetchMock,
      })
    ).rejects.toMatchObject({
      name: "OllamaProviderError",
      message: "network-error",
    });
  });
});
