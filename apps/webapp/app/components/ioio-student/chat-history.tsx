import { useEffect, useState } from "react";
import { Link } from "react-router";
import type { IoioEntityContext } from "~/modules/ioio-student/conversation.shared";
import { tw } from "~/utils/tw";

export type ChatHistoryMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  answer?: unknown;
};

export type ChatHistorySession = {
  id: string;
  title: string;
  messages: ChatHistoryMessage[];
  entityContext: IoioEntityContext;
  createdAt: string;
  updatedAt: string;
};

export type ChatHistoryStore = {
  activeChatId: string | null;
  sessions: ChatHistorySession[];
};

export const CHAT_HISTORY_UPDATED_EVENT = "ioio-chat-history-updated";
export const MAX_CHAT_HISTORY_SESSIONS = 20;

type StorageLike = Pick<Storage, "getItem" | "setItem">;

export function getChatHistoryStorageKey(namespace: string, scope: string) {
  return `ioio-chat-history:${namespace}:${scope}`;
}

export function createEmptyChatHistory(): ChatHistoryStore {
  return { activeChatId: null, sessions: [] };
}

export function readChatHistory(
  storage: StorageLike,
  storageKey: string
): ChatHistoryStore {
  try {
    const raw = storage.getItem(storageKey);
    if (!raw) return createEmptyChatHistory();
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return createEmptyChatHistory();
    }

    const record = parsed as Record<string, unknown>;
    const sessions = Array.isArray(record.sessions)
      ? record.sessions
          .filter(isChatHistorySession)
          .slice(0, MAX_CHAT_HISTORY_SESSIONS)
      : [];
    const activeChatId =
      typeof record.activeChatId === "string" &&
      sessions.some((session) => session.id === record.activeChatId)
        ? record.activeChatId
        : null;

    return { activeChatId, sessions };
  } catch {
    return createEmptyChatHistory();
  }
}

export function writeChatHistory(
  storage: StorageLike,
  storageKey: string,
  value: ChatHistoryStore
) {
  storage.setItem(
    storageKey,
    JSON.stringify({
      activeChatId: value.activeChatId,
      sessions: value.sessions.slice(0, MAX_CHAT_HISTORY_SESSIONS),
    })
  );
}

export function upsertChatSession(
  store: ChatHistoryStore,
  session: ChatHistorySession
): ChatHistoryStore {
  const sessions = [
    session,
    ...store.sessions.filter((candidate) => candidate.id !== session.id),
  ].slice(0, MAX_CHAT_HISTORY_SESSIONS);
  return { activeChatId: session.id, sessions };
}

export function makeChatTitle(firstUserMessage: string): string {
  const text = firstUserMessage.trim().replace(/[?.!]+$/u, "");
  const borrowing = text.match(
    /\b(?:can I|I want to|please)?\s*borrow\s+(?:an?\s+|one\s+)?(.+?)(?:\s+until\b|$)/iu
  );
  if (borrowing?.[1]) return `${truncateTitle(borrowing[1])} borrowing`;

  const finding = text.match(/\bwhere\s+(?:are|is)\s+(?:the\s+)?(.+)/iu);
  if (finding?.[1]) return `Finding ${truncateTitle(finding[1])}`;

  return truncateTitle(text) || "New IOIO chat";
}

function truncateTitle(value: string) {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length > 34
    ? `${normalized.slice(0, 31).trimEnd()}...`
    : normalized;
}

function isChatHistorySession(value: unknown): value is ChatHistorySession {
  if (!value || typeof value !== "object") return false;
  const session = value as Record<string, unknown>;
  const messages = Array.isArray(session.messages)
    ? session.messages.filter(isChatHistoryMessage).slice(-12)
    : [];
  return (
    typeof session.id === "string" &&
    typeof session.title === "string" &&
    typeof session.createdAt === "string" &&
    typeof session.updatedAt === "string" &&
    !!session.entityContext &&
    typeof session.entityContext === "object" &&
    messages.length > 0
  );
}

function isChatHistoryMessage(value: unknown): value is ChatHistoryMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  return (
    typeof message.id === "string" &&
    (message.role === "user" || message.role === "assistant") &&
    typeof message.content === "string"
  );
}

function sessionGroup(session: ChatHistorySession) {
  const today = new Date();
  const created = new Date(session.createdAt);
  return today.toDateString() === created.toDateString() ? "Today" : "Previous";
}

function ChatHistoryEntries({
  sessions,
  activeChatId,
  to,
  onNavigate,
  onSelect,
}: {
  sessions: ChatHistorySession[];
  activeChatId: string | null;
  to: string;
  onNavigate?: () => void;
  onSelect?: (id: string) => void;
}) {
  return (
    <div className="space-y-4">
      {["Today", "Previous"].map((group) => {
        const groupSessions = sessions.filter(
          (session) => sessionGroup(session) === group
        );
        if (!groupSessions.length) return null;
        return (
          <section key={group}>
            <p className="mb-1 px-2 text-[0.68rem] font-bold uppercase tracking-[0.14em] text-gray-400">
              {group}
            </p>
            <div className="space-y-1">
              {groupSessions.map((session) => (
                <ChatHistoryEntry
                  key={session.id}
                  session={session}
                  active={activeChatId === session.id}
                  to={to}
                  onNavigate={onNavigate}
                  onSelect={onSelect}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function ChatHistoryEntry({
  session,
  active,
  to,
  onNavigate,
  onSelect,
}: {
  session: ChatHistorySession;
  active: boolean;
  to: string;
  onNavigate?: () => void;
  onSelect?: (id: string) => void;
}) {
  const className = tw(
    "block w-full rounded-xl px-3 py-2 text-left text-sm transition",
    active
      ? "bg-red-50 font-bold text-red-800"
      : "text-gray-700 hover:bg-gray-50 hover:text-red-800"
  );
  const content = (
    <>
      <span className="block truncate">{session.title}</span>
      <span className="mt-0.5 block text-xs text-gray-400">
        {session.messages.filter((message) => message.role === "user").length}{" "}
        message
        {session.messages.filter((message) => message.role === "user")
          .length === 1
          ? ""
          : "s"}
      </span>
    </>
  );

  return onSelect ? (
    <button
      type="button"
      onClick={() => onSelect(session.id)}
      aria-current={active ? "page" : undefined}
      className={className}
    >
      {content}
    </button>
  ) : (
    <Link
      to={`${to}?chat=${encodeURIComponent(session.id)}`}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={className}
    >
      {content}
    </Link>
  );
}

export function ChatHistoryPanel({
  sessions,
  activeChatId,
  onNewChat,
  onOpenChat,
  to,
  className,
}: {
  sessions: ChatHistorySession[];
  activeChatId: string | null;
  onNewChat: () => void;
  onOpenChat: (id: string) => void;
  to: string;
  className?: string;
}) {
  return (
    <aside
      aria-label="Chat history"
      className={tw(
        "rounded-2xl border border-gray-200 bg-white p-3",
        className
      )}
    >
      <button
        type="button"
        onClick={onNewChat}
        className="mb-3 flex min-h-10 w-full items-center justify-center rounded-xl border border-red-200 bg-red-50 px-3 text-sm font-bold text-red-800 hover:bg-red-100"
      >
        + New chat
      </button>
      {sessions.length ? (
        <ChatHistoryEntries
          sessions={sessions}
          activeChatId={activeChatId}
          to={to}
          onSelect={onOpenChat}
        />
      ) : (
        <p className="px-2 text-sm leading-5 text-gray-500">
          Previous chats will appear here.
        </p>
      )}
    </aside>
  );
}

export function ChatHistoryMenu({
  namespace,
  scope,
  to,
  onNavigate,
}: {
  namespace: string;
  scope?: string;
  to: string;
  onNavigate?: () => void;
}) {
  const [store, setStore] = useState<ChatHistoryStore>(createEmptyChatHistory);

  useEffect(() => {
    if (!scope) return;
    const storageKey = getChatHistoryStorageKey(namespace, scope);
    const refresh = () =>
      setStore(readChatHistory(window.sessionStorage, storageKey));
    refresh();
    window.addEventListener(CHAT_HISTORY_UPDATED_EVENT, refresh);
    return () =>
      window.removeEventListener(CHAT_HISTORY_UPDATED_EVENT, refresh);
  }, [namespace, scope]);

  if (!scope) return null;

  return (
    <section
      aria-label="Chat history"
      className="mt-4 border-t border-gray-100 pt-4"
    >
      <div className="mb-2 flex items-center justify-between gap-2 px-2">
        <p className="text-[0.68rem] font-bold uppercase tracking-[0.14em] text-gray-400">
          Chat history
        </p>
        <Link
          to={`${to}?new=1`}
          onClick={onNavigate}
          className="text-xs font-bold text-red-700 hover:text-red-800"
        >
          New chat
        </Link>
      </div>
      {store.sessions.length ? (
        <ChatHistoryEntries
          sessions={store.sessions}
          activeChatId={store.activeChatId}
          to={to}
          onNavigate={onNavigate}
        />
      ) : (
        <p className="px-2 text-sm text-gray-500">No previous chats yet.</p>
      )}
    </section>
  );
}
