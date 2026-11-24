import type {
  IoioConversationMessage,
  IoioEntityContext,
} from "./conversation.shared";

export type AskIoioRequestIntent =
  | "inventory_query"
  | "location_query"
  | "handbook_query"
  | "knowledge_contribution"
  | "handbook_update"
  | "recommendation"
  | "action_request"
  | "general";

export type AskIoioRetrievalPlan = {
  handbook: "none" | "published_and_related" | "related_for_review";
  shelf: "none" | "live_inventory" | "live_location" | "entity_resolution";
};

export type AskIoioRoute = {
  intent: AskIoioRequestIntent;
  confidence: "high" | "medium" | "low";
  reason: string;
  retrieval: AskIoioRetrievalPlan;
};

const contributionSignals =
  /\b(?:log|record|capture|document|contribute|save|write\s+down|add|submit)\b/i;
const knowledgeTargets =
  /\b(?:handbook|knowledge(?:\s+base)?|documentation|guide|notes?)\b/i;
const updateSignals =
  /\b(?:change|update|edit|revise|correct|replace|amend)\b/i;

function getRoute(
  intent: AskIoioRequestIntent,
  confidence: AskIoioRoute["confidence"],
  reason: string
): AskIoioRoute {
  const retrieval: AskIoioRetrievalPlan = {
    handbook: "none",
    shelf: "none",
  };

  switch (intent) {
    case "knowledge_contribution":
    case "handbook_update":
      retrieval.handbook = "related_for_review";
      break;
    case "handbook_query":
      retrieval.handbook = "published_and_related";
      break;
    case "recommendation":
      retrieval.handbook = "published_and_related";
      retrieval.shelf = "live_inventory";
      break;
    case "inventory_query":
      retrieval.shelf = "live_inventory";
      break;
    case "location_query":
      retrieval.shelf = "live_location";
      break;
    case "action_request":
      retrieval.shelf = "entity_resolution";
      break;
    case "general":
      break;
  }

  return { intent, confidence, reason, retrieval };
}

function classifyWithoutHistory(question: string): AskIoioRoute {
  const text = question.trim();
  const hasKnowledgeTarget = knowledgeTargets.test(text);
  const hasContributionSignal = contributionSignals.test(text);
  const requestsUpdate = updateSignals.test(text) && hasKnowledgeTarget;

  // Route an explicit Handbook update before any entity or inventory signal.
  if (requestsUpdate) {
    return getRoute(
      "handbook_update",
      "high",
      "explicit request to change or update Handbook material"
    );
  }

  const learnedSomething =
    /\b(?:we|i)\s+(?:learned|discovered|found\s+out)\b/i.test(text);
  if (
    (hasContributionSignal && hasKnowledgeTarget) ||
    (learnedSomething && hasContributionSignal)
  ) {
    return getRoute(
      "knowledge_contribution",
      "high",
      "explicit request to record or contribute knowledge"
    );
  }

  const locationQuestion =
    /\bwhere\s+(?:is|are|can\s+(?:i|we)\s+find)|\bwhere\s+do\s+(?:i|we)\s+find|\blocation\s+of\b|\bwhich\s+(?:shelf|room|container|location)\b/i.test(
      text
    );
  if (locationQuestion) {
    return getRoute(
      "location_query",
      "high",
      "explicit request for a current Shelf location"
    );
  }

  const inventoryQuestion =
    /\b(?:how\s+many|how\s+much|available|availability|in\s+stock|quantity|stock\s+level|do\s+we\s+have|does\s+ioio\s+have|what\s+(?:items|equipment|kits|boards|parts)\s+(?:do\s+we\s+have|are\s+available)|list\s+(?:our|the)\s+(?:inventory|items|kits|assets)|search\s+(?:the\s+)?inventory)\b/i.test(
      text
    );
  if (inventoryQuestion) {
    return getRoute(
      "inventory_query",
      "high",
      "explicit request for current inventory, quantity, or availability"
    );
  }

  const specificExplanation =
    /\bwhat\s+(?:is|are)\s+(?:a|an|the)\b.{1,100}\b(?:kit|board|station|device|tool)\b/i.test(
      text
    ) ||
    /\bwhat(?:'s|\s+is)\s+the\s+difference\s+between\b.{1,120}\b(?:kit|board|station|device|tool)s?\b/i.test(
      text
    ) ||
    /\btell\s+me\s+about\b.{1,100}\b(?:kit|board|station|device|tool)s?\b/i.test(
      text
    );
  if (specificExplanation) {
    return getRoute(
      "handbook_query",
      "high",
      "user asks for an explanation of IOIO equipment"
    );
  }

  const handbookQuestion =
    /\b(?:how\s+(?:do|does|can|should)\s+(?:i|we|you|someone)\s+|how\s+to\s+|instructions?\s+for\s+|guide\s+to\s+|procedure\s+for\s+|rules\s+for\s+|what\s+is\s+the\s+procedure\s+for\s+)/i.test(
      text
    ) ||
    (hasKnowledgeTarget && /\b(?:tell\s+me\s+about|explain)\b/i.test(text)) ||
    /\bwhat\s+should\s+(?:i|we)\s+know\s+(?:before|about)\b/i.test(text) ||
    /\bwhat\s+(?:do\s+we|does\s+ioio)\s+know\s+about\b/i.test(text) ||
    /\bwhat\s+should\s+i\s+check\s+before\s+(?:returning|bringing\s+back)\b/i.test(
      text
    );
  if (handbookQuestion) {
    return getRoute(
      "handbook_query",
      "high",
      "question asks for a procedure or published IOIO guidance"
    );
  }

  const recommendationQuestion =
    /\b(?:recommend|suggest|what\s+(?:should|could|can)\s+i\s+use|what\s+equipment\s+(?:would|should)\s+(?:you|i)\s+(?:suggest|recommend)|what\s+could\s+i\s+use)\b/i.test(
      text
    );
  if (recommendationQuestion) {
    return getRoute(
      "recommendation",
      "high",
      "user requests equipment or project advice"
    );
  }

  const actionWords = [
    "add",
    "create",
    "remove",
    "delete",
    "change",
    "update",
    "edit",
    "move",
    "import",
    "archive",
    "retire",
  ];
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  const hasActionVerb = words.some((word) =>
    actionWords.some((verb) => isOneEditAway(word, verb))
  );
  const hasActionTarget =
    /\b(?:inventory|asset|item|kit|quantity|stock|location|section|container|room|shelf)\b/i.test(
      text
    );
  const actionRequest =
    (hasActionVerb && hasActionTarget) ||
    /\b(?:report|log|flag)\b[\s\S]{0,60}\b(?:problem|issue|damaged|broken|missing|not\s+working|wrong\s+location)\b/i.test(
      text
    ) ||
    /\b(?:problem|issue|damaged|broken|missing|not\s+working|wrong\s+location)\b[\s\S]{0,60}\b(?:report|log|flag)\b/i.test(
      text
    ) ||
    /\b(?:borrow|check\s*out|return|check\s*in|report\s+(?:a\s+)?problem)\b/i.test(
      text
    );
  if (actionRequest) {
    return getRoute(
      "action_request",
      "high",
      "request asks the application to perform or prepare an action"
    );
  }

  return getRoute("general", "low", "no Shelf or Handbook intent signal");
}

/** Small edit-distance tolerance for request verbs, not an equipment-name
 * dictionary. Entity resolution remains a separate, confidence-gated step. */
function isOneEditAway(left: string, right: string) {
  if (left === right) return true;
  if (Math.abs(left.length - right.length) > 1 || left.length < 4) return false;
  let leftIndex = 0;
  let rightIndex = 0;
  let edits = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex] === right[rightIndex]) {
      leftIndex += 1;
      rightIndex += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (left.length > right.length) leftIndex += 1;
    else if (right.length > left.length) rightIndex += 1;
    else {
      leftIndex += 1;
      rightIndex += 1;
    }
  }
  if (leftIndex < left.length || rightIndex < right.length) edits += 1;
  return edits <= 1;
}

function isFollowUp(question: string) {
  return /^\s*(?:and\b|what\s+about\b|how\s+about\b|there\b|those\b|them\b|it\b|that\b|what\s+of\b)/i.test(
    question
  );
}

/** Intent decides retrieval. Product words alone never make a request an
 * inventory lookup; explicit contribution/update language has priority. */
export function classifyAskIoioRequest(
  question: string,
  options: {
    history?: readonly IoioConversationMessage[];
    entityContext?: IoioEntityContext;
  } = {}
): AskIoioRoute {
  const direct = classifyWithoutHistory(question);
  if (direct.intent !== "general" || !isFollowUp(question)) return direct;

  const previousUserMessage = [...(options.history ?? [])]
    .reverse()
    .find((message) => message.role === "user" && message.content.trim());
  if (previousUserMessage) {
    const previousRoute = classifyWithoutHistory(previousUserMessage.content);
    if (
      previousRoute.intent === "inventory_query" ||
      previousRoute.intent === "location_query" ||
      previousRoute.intent === "handbook_query"
    ) {
      return getRoute(
        previousRoute.intent,
        "medium",
        `follow-up to recent ${previousRoute.intent.replaceAll("_", " ")}`
      );
    }
  }

  const hasRecentShelfEntity = Boolean(
    options.entityContext?.activeAssetId ||
      options.entityContext?.currentAssetId ||
      options.entityContext?.activeKitId ||
      options.entityContext?.currentKitId
  );
  return hasRecentShelfEntity
    ? getRoute(
        "inventory_query",
        "low",
        "follow-up refers to a resolved Shelf item"
      )
    : direct;
}

/** For a follow-up contribution, reuse only the user's own recent text as the
 * source material; provider-generated assistant prose is never persisted as a
 * factual contribution. */
export function getHandbookContributionSource(
  question: string,
  history: readonly IoioConversationMessage[] = [],
  intent:
    | "knowledge_contribution"
    | "handbook_update" = "knowledge_contribution"
) {
  const explicit = question.trim();
  if (intent === "handbook_update" && explicit.length > 20) {
    return `Requested Handbook update for Staff review: ${explicit}`.slice(
      0,
      4000
    );
  }
  const hasFactLikeContent =
    explicit.length > 45 &&
    !/^\s*(?:add|log|record|save|document|submit|contribute)\b/i.test(explicit);

  if (hasFactLikeContent) {
    const cleaned = explicit
      .replace(
        /\b(?:please\s+)?(?:log|record|save|document|add|submit|contribute)\s+(?:this|that|it|the above|the component list)[\s\S]*$/i,
        ""
      )
      .replace(/\bthis is useful ioio knowledge\.?\s*$/i, "")
      .trim();
    if (cleaned.length > 25) return cleaned.slice(0, 4000);
  }

  const previousUserMessage = [...history].reverse().find((message) => {
    if (message.role !== "user" || message.content.trim().length < 30) {
      return false;
    }
    return !/^(?:tell\s+me|how\s+do|how\s+to|what|where|why|can\s+you|do\s+we)\b/i.test(
      message.content.trim()
    );
  });
  if (previousUserMessage) {
    return previousUserMessage.content.trim().slice(0, 4000);
  }

  const explicitlyReferencesPriorAnswer =
    /\b(?:that|those|the above|previous)\s+(?:component\s+list|details|steps|instructions|information|answer)\b/i.test(
      explicit
    );
  const previousAssistantMessage = [...history]
    .reverse()
    .find((message) => message.role === "assistant" && message.content.trim());
  if (explicitlyReferencesPriorAnswer && previousAssistantMessage) {
    return `Assistant-provided draft requested for Staff verification before publication:\n${previousAssistantMessage.content}`.slice(
      0,
      4000
    );
  }
  return "";
}

export function getHandbookContributionTitle(content: string) {
  const subject = content.match(
    /^\s*(?:we\s+learned\s+that\s+|i\s+learned\s+that\s+)?(.{2,100}?)\s+(?:contains|includes|is|are|uses|works|fixes|prevents|helps)\b/i
  )?.[1];
  if (subject?.trim()) return `${subject.trim()} knowledge`.slice(0, 180);
  const firstSentence = content.split(/[.!?\n]/, 1)[0]?.trim();
  return (firstSentence || "IOIO knowledge contribution").slice(0, 180);
}
