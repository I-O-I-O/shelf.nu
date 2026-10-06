export const MAX_CONVERSATION_MESSAGES = 12;
export const MAX_CONVERSATION_MESSAGE_LENGTH = 2000;

export type IoioConversationRole = "user" | "assistant";

export type IoioConversationMessage = {
  role: IoioConversationRole;
  content: string;
};

export type IoioAssistantIntent =
  | "search"
  | "borrow"
  | "return"
  | "report"
  | "general";

export type IoioPendingAction = "borrow" | "return" | "report";

export type IoioResolvedEntity = {
  kind: "asset" | "kit" | "location" | "booking";
  id: string;
  name: string;
};

export type IoioEntityContext = {
  currentAssetId?: string;
  activeAssetId?: string;
  activeAssetName?: string;
  currentKitId?: string;
  activeKitId?: string;
  currentLocationId?: string;
  activeLocationId?: string;
  currentBookingId?: string;
  activeBookingId?: string;
  lastIntent?: IoioAssistantIntent;
  activeIntent?: IoioAssistantIntent;
  pendingAction?: IoioPendingAction;
  requestedQuantity?: number;
  borrowFrom?: string;
  borrowTo?: string;
  reportType?: string;
  recentEntities?: IoioResolvedEntity[];
};

const emailPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const phonePattern = /(?:\+?\d[\d\s().-]{7,}\d)/g;
const studentIdPattern =
  /\b(?:student\s*(?:id|number)|student-id)\s*[:#-]?\s*[A-Z0-9-]+\b/gi;

/**
 * Conversation history is sent to an AI provider only for the active turn.
 * Keep it short and remove common contact/student identifiers before it leaves
 * the Shelf server. Tool results remain the only source of workspace facts.
 */
export function sanitizeConversationContent(value: string) {
  const withoutControlCharacters = [...value]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return !(
        (code >= 0 && code <= 8) ||
        code === 11 ||
        code === 12 ||
        (code >= 14 && code <= 31) ||
        code === 127
      );
    })
    .join("");
  return withoutControlCharacters
    .replace(emailPattern, "[redacted email]")
    .replace(phonePattern, "[redacted contact]")
    .replace(studentIdPattern, "[redacted student ID]")
    .trim()
    .slice(0, MAX_CONVERSATION_MESSAGE_LENGTH);
}

export function normalizeConversationHistory(
  history: readonly IoioConversationMessage[] | undefined
) {
  return (history ?? [])
    .filter(
      (message) =>
        (message.role === "user" || message.role === "assistant") &&
        typeof message.content === "string"
    )
    .map((message) => ({
      role: message.role,
      content: sanitizeConversationContent(message.content),
    }))
    .filter((message) => message.content.length > 0)
    .slice(-MAX_CONVERSATION_MESSAGES);
}

export function parseConversationHistory(value: string | null | undefined) {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return normalizeConversationHistory(
      parsed.filter(
        (message): message is IoioConversationMessage =>
          typeof message === "object" &&
          message !== null &&
          ((message as { role?: unknown }).role === "user" ||
            (message as { role?: unknown }).role === "assistant") &&
          typeof (message as { content?: unknown }).content === "string"
      )
    );
  } catch {
    return [];
  }
}

export function parseEntityContext(value: string | null | undefined) {
  if (!value) return {} satisfies IoioEntityContext;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return {};
    const input = parsed as Record<string, unknown>;
    const context: IoioEntityContext = {};
    for (const key of [
      "currentAssetId",
      "activeAssetId",
      "activeAssetName",
      "currentKitId",
      "activeKitId",
      "currentLocationId",
      "activeLocationId",
      "currentBookingId",
      "activeBookingId",
      "borrowFrom",
      "borrowTo",
      "reportType",
    ] as const) {
      if (typeof input[key] === "string" && input[key].trim()) {
        context[key] = input[key].trim().slice(0, 100);
      }
    }
    if (
      Number.isInteger(input.requestedQuantity) &&
      Number(input.requestedQuantity) >= 1 &&
      Number(input.requestedQuantity) <= 1000
    ) {
      context.requestedQuantity = Number(input.requestedQuantity);
    }
    if (
      input.pendingAction === "borrow" ||
      input.pendingAction === "return" ||
      input.pendingAction === "report"
    ) {
      context.pendingAction = input.pendingAction;
    }
    if (
      input.lastIntent === "search" ||
      input.lastIntent === "borrow" ||
      input.lastIntent === "return" ||
      input.lastIntent === "report" ||
      input.lastIntent === "general"
    ) {
      context.lastIntent = input.lastIntent;
    }
    if (
      input.activeIntent === "search" ||
      input.activeIntent === "borrow" ||
      input.activeIntent === "return" ||
      input.activeIntent === "report" ||
      input.activeIntent === "general"
    ) {
      context.activeIntent = input.activeIntent;
    }
    if (Array.isArray(input.recentEntities)) {
      context.recentEntities = input.recentEntities
        .filter(
          (entity): entity is IoioResolvedEntity =>
            !!entity &&
            typeof entity === "object" &&
            (entity as { kind?: unknown }).kind !== undefined &&
            ["asset", "kit", "location", "booking"].includes(
              String((entity as { kind: unknown }).kind)
            ) &&
            typeof (entity as { id?: unknown }).id === "string" &&
            typeof (entity as { name?: unknown }).name === "string"
        )
        .slice(-8)
        .map((entity) => ({
          kind: entity.kind,
          id: entity.id.trim().slice(0, 100),
          name: sanitizeConversationContent(entity.name).slice(0, 160),
        }))
        .filter((entity) => entity.id && entity.name);
    }
    return context;
  } catch {
    return {};
  }
}

/** Read only the safe entity identifiers supplied by an item-detail handoff. */
export function parseEntityContextQuery(params: URLSearchParams) {
  const context: IoioEntityContext = {};
  const values = [
    ["assetId", "currentAssetId"],
    ["kitId", "currentKitId"],
    ["locationId", "currentLocationId"],
  ] as const;

  for (const [queryKey, contextKey] of values) {
    const value = params.get(queryKey)?.trim();
    if (value) context[contextKey] = value.slice(0, 100);
  }

  return context;
}

export function isReferencePhrase(question: string) {
  return (
    /^\s*(?:one|those|it)\s*(?:[,?.!]|$)/i.test(question) ||
    /^\s*(?:this|that|these)\s*[,.?!]\s*$/i.test(question) ||
    /\bthe same(?:\s+(?:one|item))?\b/i.test(question) ||
    /\b(?:that|this|these|those|it)\s+(?:one|item|kit|board|asset|unit)\b/i.test(
      question
    ) ||
    /\b(?:what|how)\s+about\s+(?:it|that|those|them)\b/i.test(question) ||
    /\b(?:borrow|return|report|take|check\s*out|locate|where\s+is)\s+(?:it|that\s+one|those)\b/i.test(
      question
    ) ||
    /\bthe\s+(?:nano|uno|multimeter|oscilloscope|kit)\b/i.test(question)
  );
}

export function inferAssistantIntent(
  question: string,
  previous?: IoioEntityContext
): IoioAssistantIntent {
  if (/\b(borrow|loan|check\s*out|take)\b/i.test(question)) {
    return "borrow";
  }
  if (/\b(return|check\s*in|give\s+back|bring\s+back)\b/i.test(question)) {
    return "return";
  }
  if (
    /\b(damaged|broken|missing|wrong\s+location|cannot\s+find|can't\s+find|report\s+(?:a\s+)?problem)\b/i.test(
      question
    )
  ) {
    return "report";
  }
  if (/\b(who|whose)\b[\s\S]*\b(borrow|has|have|holds?)\b/i.test(question)) {
    return "search";
  }
  if (
    previous?.requestedQuantity &&
    (previous.currentAssetId || previous.activeAssetId) &&
    /\b(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{4}-\d{2}-\d{2})\b/i.test(
      question
    )
  ) {
    return "borrow";
  }
  if (
    (previous?.lastIntent ?? previous?.activeIntent) &&
    (isReferencePhrase(question) ||
      /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+|today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(
        question
      )) &&
    ["borrow", "return", "report"].includes(
      previous.lastIntent ?? previous.activeIntent ?? ""
    )
  ) {
    return (previous.lastIntent ??
      previous.activeIntent) as IoioAssistantIntent;
  }
  return /\?|\b(where|how many|how much|what|which|find|available|have)\b/i.test(
    question
  )
    ? "search"
    : "general";
}

export function mergeEntityContext(
  previous: IoioEntityContext,
  next: Partial<IoioEntityContext>
) {
  const recentEntities = next.recentEntities ?? previous.recentEntities;
  return {
    ...previous,
    ...next,
    ...(next.lastIntent ? { lastIntent: next.lastIntent } : {}),
    ...(next.activeIntent ? { activeIntent: next.activeIntent } : {}),
    ...(recentEntities ? { recentEntities: recentEntities.slice(-8) } : {}),
  } satisfies IoioEntityContext;
}

/** Convert provider markdown escapes into readable chat prose. */
export function cleanAssistantText(value: string) {
  return value
    .replace(/\\([\\`*_{}()#+.!>~-])/g, "$1")
    .replace(/\*\*/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}
