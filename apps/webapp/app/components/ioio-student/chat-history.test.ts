import { describe, expect, it } from "vitest";
import {
  getChatHistoryStorageKey,
  makeChatTitle,
  readChatHistory,
  upsertChatSession,
  writeChatHistory,
  type ChatHistorySession,
} from "./chat-history";

describe("IOIO chat history", () => {
  it("keeps storage keys separate by role and account scope", () => {
    expect(getChatHistoryStorageKey("student", "account-a")).not.toBe(
      getChatHistoryStorageKey("staff", "account-a")
    );
    expect(getChatHistoryStorageKey("student", "account-a")).not.toBe(
      getChatHistoryStorageKey("student", "account-b")
    );
  });

  it("creates concise titles from the first meaningful question", () => {
    expect(makeChatTitle("Can I borrow an Arduino Nano?")).toBe(
      "Arduino Nano borrowing"
    );
    expect(makeChatTitle("Where are the multimeters?")).toBe(
      "Finding multimeters"
    );
  });

  it("round-trips sessions and keeps the active session first", () => {
    // why: the history module accepts the browser Storage interface; this
    // tiny in-memory adapter keeps the test independent of browser state.
    let value: string | null = null;
    const storage = {
      getItem: () => value,
      setItem: (_key: string, next: string) => {
        value = next;
      },
    };
    const session: ChatHistorySession = {
      id: "chat-1",
      title: "Finding multimeters",
      messages: [
        {
          id: "message-1",
          role: "user",
          content: "Where are the multimeters?",
        },
      ],
      entityContext: {},
      createdAt: "2026-09-07T10:00:00.000Z",
      updatedAt: "2026-09-07T10:00:00.000Z",
    };

    const next = upsertChatSession(
      { activeChatId: null, sessions: [] },
      session
    );
    writeChatHistory(storage, "history", next);

    expect(readChatHistory(storage, "history")).toEqual(next);
    expect(next.activeChatId).toBe("chat-1");
  });
});
