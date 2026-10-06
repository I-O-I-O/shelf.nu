import { useCallback, useEffect, useRef, useState } from "react";
import {
  Form,
  Link,
  useActionData,
  useFetcher,
  useLoaderData,
} from "react-router";
import {
  data,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  type MetaFunction,
} from "react-router";
import { z } from "zod";
import {
  ChatHistoryPanel,
  CHAT_HISTORY_UPDATED_EVENT,
  getChatHistoryStorageKey,
  makeChatTitle,
  readChatHistory,
  upsertChatSession,
  writeChatHistory,
  type ChatHistoryStore,
} from "~/components/ioio-student/chat-history";
import {
  AssetCard,
  formatStudentDateOnly,
  formatStudentLabel,
  SectionHeading,
} from "~/components/ioio-student/student-ui";
import {
  answerInventoryAssistant,
  type InventoryAssistantAnswer,
} from "~/modules/ioio-student/assistant.server";
import {
  borrowItem,
  cancelBorrowItem,
  type PreparedBorrowProposal,
} from "~/modules/ioio-student/borrow-item.server";
import { getIoioChatScope } from "~/modules/ioio-student/chat-scope.server";
import {
  normalizeConversationHistory,
  cleanAssistantText,
  parseConversationHistory,
  parseEntityContext,
  parseEntityContextQuery,
  type IoioConversationMessage,
  type IoioEntityContext,
} from "~/modules/ioio-student/conversation.shared";
import {
  cancelReportProblem,
  ioioReportTypeSchema,
  reportProblem,
  type PreparedReportProposal,
} from "~/modules/ioio-student/report-problem.server";
import {
  cancelReturnItem,
  prepareReturnProblemReport,
  returnItem,
  type PreparedReturnProposal,
} from "~/modules/ioio-student/return-item.server";
import { requireStudentRead } from "~/modules/ioio-student/route.server";
import { makeShelfError, ShelfError } from "~/utils/error";
import { error, payload } from "~/utils/http.server";

export const meta: MetaFunction<typeof loader> = () => [{ title: "Ask IOIO" }];

const ActionSchema = z.object({
  intent: z.enum([
    "ask",
    "confirm-report",
    "cancel-report",
    "confirm-borrow",
    "cancel-borrow",
    "confirm-return",
    "cancel-return",
    "prepare-return-report",
  ]),
  confirmationToken: z.string().uuid().optional(),
  question: z.string().trim().min(1).max(500).optional(),
  history: z.string().max(30_000).optional(),
  entityContext: z.string().max(5_000).optional(),
  reportType: ioioReportTypeSchema.optional(),
  description: z.string().trim().min(3).max(2000).optional(),
  quantity: z.coerce.number().int().min(1).max(1000).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});

export async function action({ context, request }: ActionFunctionArgs) {
  const auth = await requireStudentRead({
    context,
    request,
  });
  const { userId, organizationId } = auth;
  try {
    const formData = await request.formData();
    const parsed = ActionSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) {
      throw new ShelfError({
        cause: null,
        message: "Invalid Ask Shelf request.",
        label: "Request validation",
        status: 400,
        shouldBeCaptured: false,
      });
    }

    if (parsed.data.intent === "ask") {
      if (!parsed.data.question) {
        throw new ShelfError({
          cause: null,
          message: "Ask a question first.",
          label: "Request validation",
          status: 400,
          shouldBeCaptured: false,
        });
      }
      return payload({
        kind: "assistant" as const,
        answer: await answerInventoryAssistant({
          context,
          request,
          question: parsed.data.question,
          history: parseConversationHistory(parsed.data.history),
          entityContext: parseEntityContext(parsed.data.entityContext),
        }),
      });
    }

    if (!parsed.data.confirmationToken) {
      throw new ShelfError({
        cause: null,
        message: "This Shelf proposal is missing its confirmation token.",
        label: "Request validation",
        status: 400,
        shouldBeCaptured: false,
      });
    }

    if (parsed.data.intent === "cancel-report") {
      return payload({
        ...(await cancelReportProblem(parsed.data.confirmationToken, {
          context,
          request,
        })),
        kind: "report" as const,
      });
    }
    if (parsed.data.intent === "cancel-borrow") {
      return payload({
        ...(await cancelBorrowItem(parsed.data.confirmationToken, {
          context,
          request,
        })),
        kind: "borrow" as const,
      });
    }
    if (parsed.data.intent === "cancel-return") {
      return payload({
        ...(await cancelReturnItem(parsed.data.confirmationToken, {
          context,
          request,
          auth,
        })),
        kind: "return" as const,
      });
    }
    if (parsed.data.intent === "prepare-return-report") {
      return payload({
        status: "prepared" as const,
        proposal: await prepareReturnProblemReport(
          parsed.data.confirmationToken,
          { context, request, auth }
        ),
        kind: "report" as const,
      });
    }
    if (parsed.data.intent === "confirm-return") {
      if (parsed.data.quantity === undefined) {
        throw new ShelfError({
          cause: null,
          message: "Review the return quantity before submitting.",
          label: "Booking",
          status: 400,
          shouldBeCaptured: false,
        });
      }
      return payload({
        ...(await returnItem(
          {
            confirmationToken: parsed.data.confirmationToken,
            quantity: parsed.data.quantity,
          },
          { context, request, auth }
        )),
        kind: "return" as const,
      });
    }
    if (parsed.data.intent === "confirm-borrow") {
      if (
        parsed.data.quantity === undefined ||
        !parsed.data.from ||
        !parsed.data.to
      ) {
        throw new ShelfError({
          cause: null,
          message: "Review the borrow quantity and dates before submitting.",
          label: "Booking",
          status: 400,
          shouldBeCaptured: false,
        });
      }
      return payload({
        ...(await borrowItem(
          {
            confirmationToken: parsed.data.confirmationToken,
            quantity: parsed.data.quantity,
            from: parsed.data.from,
            to: parsed.data.to,
          },
          { context, request }
        )),
        kind: "borrow" as const,
      });
    }
    if (!parsed.data.reportType || !parsed.data.description) {
      throw new ShelfError({
        cause: null,
        message: "Review the report type and description before submitting.",
        label: "Report",
        status: 400,
        shouldBeCaptured: false,
      });
    }
    return payload({
      ...(await reportProblem(
        {
          confirmationToken: parsed.data.confirmationToken,
          reportType: parsed.data.reportType,
          description: parsed.data.description,
        },
        { context, request }
      )),
      kind: "report" as const,
    });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId, organizationId });
    return data(error(reason), { status: reason.status });
  }
}

export async function loader({ context, request }: LoaderFunctionArgs) {
  const { userId, organizationId, role } = await requireStudentRead({
    context,
    request,
  });
  return data(
    payload({
      ready: true,
      chatScope: getIoioChatScope(userId, organizationId, role),
    })
  );
}

type ChatMessage = IoioConversationMessage & {
  id: string;
  answer?: InventoryAssistantAnswer;
};

type ActionState = {
  kind?: "borrow" | "return" | "report";
  status?: string;
  remainingQuantity?: number;
  proposal?: PreparedReportProposal;
};

const STARTER_PROMPTS = [
  "I need a board for controlling a motor",
  "Where are the Arduino Nanos?",
  "What do I currently have borrowed?",
  "I need something for measuring voltage",
];

function newMessageId() {
  return `chat-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isAssistantResult(
  value: unknown
): value is { kind: "assistant"; answer: InventoryAssistantAnswer } {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { kind?: unknown }).kind === "assistant" &&
    typeof (value as { answer?: unknown }).answer === "object"
  );
}

function getPersistedMessages(messages: readonly ChatMessage[]) {
  return messages.slice(-12).map((message) => {
    if (!message.answer) return message;
    const answer = Object.fromEntries(
      Object.entries(message.answer).filter(
        ([key]) =>
          ![
            "proposal",
            "borrowProposal",
            "returnProposal",
            "toolsUsed",
            "providerModel",
            "mode",
            "fallbackReason",
          ].includes(key)
      )
    ) as InventoryAssistantAnswer;
    return { ...message, answer };
  });
}

function actionWasResolved(
  actionState: ActionState | undefined,
  kind: string,
  proposalToken: string,
  submittedProposalToken: string | null
) {
  if (proposalToken !== submittedProposalToken) return false;
  return (
    (actionState?.kind === kind &&
      ["submitted", "duplicate", "cancelled"].includes(
        actionState.status ?? ""
      )) ||
    (kind === "return" &&
      actionState?.kind === "report" &&
      actionState.status === "prepared")
  );
}

function displayAssistantText(value: string) {
  return formatStudentLabel(cleanAssistantText(value));
}

function BorrowCard({
  proposal,
  onAction,
}: {
  proposal: PreparedBorrowProposal;
  onAction: (token: string) => void;
}) {
  return (
    <Form
      method="post"
      onSubmit={() => onAction(proposal.confirmationToken)}
      className="mt-4 space-y-4 rounded-2xl border border-blue-200 bg-blue-50 p-4"
    >
      <input
        type="hidden"
        name="confirmationToken"
        value={proposal.confirmationToken}
      />
      <input type="hidden" name="quantity" value={proposal.quantity} />
      <input type="hidden" name="from" value={proposal.from} />
      <input type="hidden" name="to" value={proposal.to} />
      <div>
        <h3 className="font-semibold text-gray-950">Borrow proposal</h3>
        <p className="text-sm text-gray-700">Nothing has been borrowed yet.</p>
      </div>
      <dl className="space-y-1 text-sm text-gray-800">
        <div>
          <dt className="inline font-semibold">Item: </dt>
          <dd className="inline">{formatStudentLabel(proposal.asset.title)}</dd>
        </div>
        <div>
          <dt className="inline font-semibold">Quantity: </dt>
          <dd className="inline">
            {proposal.quantity} of {proposal.availableQuantity} available
          </dd>
        </div>
        <div>
          <dt className="inline font-semibold">Return by: </dt>
          <dd className="inline">{formatStudentDateOnly(proposal.to)}</dd>
        </div>
        <div>
          <dt className="inline font-semibold">Location: </dt>
          <dd className="inline">{proposal.asset.location ?? "Not placed"}</dd>
        </div>
      </dl>
      {proposal.restriction ? (
        <p className="text-sm font-medium text-amber-800">
          Restriction: {proposal.restriction}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          name="intent"
          value="confirm-borrow"
          className="min-h-11 rounded-xl bg-red-600 px-4 font-semibold text-white hover:bg-red-700"
        >
          Confirm borrow
        </button>
        <button
          type="submit"
          name="intent"
          value="cancel-borrow"
          formNoValidate
          className="min-h-11 rounded-xl border border-gray-300 bg-white px-4 font-semibold text-gray-800 hover:bg-gray-50"
        >
          Cancel
        </button>
      </div>
    </Form>
  );
}

function ReturnCard({
  proposal,
  onAction,
}: {
  proposal: PreparedReturnProposal;
  onAction: (token: string) => void;
}) {
  return (
    <Form
      method="post"
      onSubmit={() => onAction(proposal.confirmationToken)}
      className="mt-4 space-y-4 rounded-2xl border border-green-200 bg-green-50 p-4"
    >
      <input
        type="hidden"
        name="confirmationToken"
        value={proposal.confirmationToken}
      />
      <input type="hidden" name="quantity" value={proposal.quantity} />
      <h3 className="font-semibold text-gray-950">Return proposal</h3>
      <p className="text-sm text-gray-700">Nothing has been returned yet.</p>
      <dl className="space-y-1 text-sm text-gray-800">
        <div>
          <dt className="inline font-semibold">Item: </dt>
          <dd className="inline">{formatStudentLabel(proposal.asset.title)}</dd>
        </div>
        <div>
          <dt className="inline font-semibold">Quantity: </dt>
          <dd className="inline">{proposal.quantity}</dd>
        </div>
        <div>
          <dt className="inline font-semibold">Remaining quantity: </dt>
          <dd className="inline">{proposal.remainingQuantity}</dd>
        </div>
      </dl>
      {proposal.restriction ? (
        <p className="text-sm font-medium text-amber-800">
          Restriction: {proposal.restriction}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          name="intent"
          value="confirm-return"
          className="min-h-11 rounded-xl bg-red-600 px-4 font-semibold text-white hover:bg-red-700"
        >
          Confirm return
        </button>
        <button
          type="submit"
          name="intent"
          value="prepare-return-report"
          formNoValidate
          className="min-h-11 rounded-xl border border-red-300 bg-white px-4 font-semibold text-red-800 hover:bg-red-50"
        >
          Report a problem
        </button>
        <button
          type="submit"
          name="intent"
          value="cancel-return"
          formNoValidate
          className="min-h-11 rounded-xl border border-gray-300 bg-white px-4 font-semibold text-gray-800 hover:bg-gray-50"
        >
          Cancel
        </button>
      </div>
    </Form>
  );
}

function ReportCard({
  proposal,
  onAction,
}: {
  proposal: PreparedReportProposal;
  onAction: (token: string) => void;
}) {
  return (
    <Form
      method="post"
      onSubmit={() => onAction(proposal.confirmationToken)}
      className="mt-4 space-y-4 rounded-2xl border border-red-200 bg-red-50 p-4"
    >
      <input
        type="hidden"
        name="confirmationToken"
        value={proposal.confirmationToken}
      />
      <h3 className="font-semibold text-gray-950">Problem report</h3>
      {proposal.asset ? (
        <p className="text-sm text-gray-800">
          <span className="font-semibold">Item:</span>{" "}
          {formatStudentLabel(proposal.asset.title ?? proposal.asset.id)}
        </p>
      ) : null}
      {proposal.kit ? (
        <p className="text-sm text-gray-800">
          <span className="font-semibold">Kit:</span>{" "}
          {formatStudentLabel(proposal.kit.name ?? proposal.kit.id)}
        </p>
      ) : null}
      {proposal.location ? (
        <p className="text-sm text-gray-800">
          <span className="font-semibold">Location:</span>{" "}
          {formatStudentLabel(proposal.location.name ?? proposal.location.id)}
        </p>
      ) : null}
      <label className="block text-sm font-medium text-gray-800">
        Problem type
        <select
          name="reportType"
          defaultValue={proposal.reportType}
          className="mt-1 block min-h-11 w-full rounded-xl border border-gray-300 bg-white px-3"
        >
          <option value="ITEM_MISSING">Item missing</option>
          <option value="ITEM_DAMAGED">Item damaged</option>
          <option value="WRONG_LOCATION">Wrong location</option>
          <option value="LOCATION_FULL">Location full</option>
          <option value="CANNOT_FIND">Cannot find</option>
          <option value="KIT_INCOMPLETE">Kit incomplete</option>
          <option value="OTHER">Other</option>
        </select>
      </label>
      <label className="block text-sm font-medium text-gray-800">
        Description
        <textarea
          name="description"
          defaultValue={proposal.description}
          required
          minLength={3}
          maxLength={2000}
          rows={3}
          className="mt-1 block w-full rounded-xl border border-gray-300 bg-white px-3 py-2"
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          name="intent"
          value="confirm-report"
          className="min-h-11 rounded-xl bg-red-600 px-4 font-semibold text-white hover:bg-red-700"
        >
          Submit report
        </button>
        <button
          type="submit"
          name="intent"
          value="cancel-report"
          formNoValidate
          className="min-h-11 rounded-xl border border-gray-300 bg-white px-4 font-semibold text-gray-800 hover:bg-gray-50"
        >
          Cancel
        </button>
      </div>
    </Form>
  );
}

function ActionStatus({
  actionState,
}: {
  actionState: ActionState | undefined;
}) {
  if (!actionState?.status || actionState.status === "prepared") return null;
  const text =
    actionState.status === "submitted"
      ? actionState.kind === "borrow"
        ? "Your borrow was recorded in Shelf."
        : actionState.kind === "return"
        ? "Your return was recorded in Shelf."
        : "Your problem report was submitted for staff review."
      : actionState.status === "duplicate"
      ? "Shelf already recorded this action; no duplicate was created."
      : actionState.status === "cancelled"
      ? "The proposal was cancelled."
      : "Shelf could not complete that action.";
  return (
    <p className="rounded-2xl border border-gray-200 bg-gray-50 p-4 text-sm text-gray-700">
      {text}
    </p>
  );
}

export default function IoioAsk() {
  const { chatScope } = useLoaderData<typeof loader>();
  const actionResult = useActionData<typeof action>();
  const fetcher = useFetcher<typeof action>();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatHistory, setChatHistory] = useState<ChatHistoryStore>({
    activeChatId: null,
    sessions: [],
  });
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [entityContext, setEntityContext] = useState<IoioEntityContext>({});
  const [draft, setDraft] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const [initialQuestion, setInitialQuestion] = useState<string | null>(null);
  const [submittedProposalToken, setSubmittedProposalToken] = useState<
    string | null
  >(null);
  const pendingQuestion = useRef<string | null>(null);
  const syncedChatSignature = useRef<string | null>(null);
  const actionState = actionResult as unknown as ActionState | undefined;
  const chatStorageKey = getChatHistoryStorageKey("student", chatScope);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const query = params.get("q")?.trim().slice(0, 500) || null;
    const startsNewChat = params.get("new") === "1";
    const requestedChatId = params.get("chat");
    const stored = readChatHistory(window.sessionStorage, chatStorageKey);
    const requestedChat = requestedChatId
      ? stored.sessions.find((session) => session.id === requestedChatId)
      : undefined;

    setChatHistory(stored);
    if (query || startsNewChat) {
      setMessages([]);
      setEntityContext(parseEntityContextQuery(params));
      setActiveChatId(null);
      setInitialQuestion(query);
      window.history.replaceState({}, "", window.location.pathname);
    } else if (requestedChat) {
      setMessages(requestedChat.messages as ChatMessage[]);
      setEntityContext(requestedChat.entityContext);
      setActiveChatId(requestedChat.id);
      window.history.replaceState({}, "", window.location.pathname);
    } else {
      const activeChat = stored.sessions.find(
        (session) => session.id === stored.activeChatId
      );
      setMessages((activeChat?.messages ?? []) as ChatMessage[]);
      setEntityContext(activeChat?.entityContext ?? {});
      setActiveChatId(activeChat?.id ?? null);
    }
    setHydrated(true);
  }, [chatStorageKey]);

  const sendMessage = useCallback(
    (value = draft) => {
      const question = value.trim().slice(0, 500);
      if (!question || fetcher.state !== "idle") return;
      const chatId = activeChatId ?? newMessageId();
      const now = new Date().toISOString();
      const existingSession = chatHistory.sessions.find(
        (session) => session.id === chatId
      );
      const userMessage = {
        id: newMessageId(),
        role: "user" as const,
        content: question,
      };
      setSubmittedProposalToken(null);
      const history = normalizeConversationHistory(
        messages.map(({ role, content }) => ({ role, content }))
      );
      setMessages((current) => [...current, userMessage]);
      setActiveChatId(chatId);
      setChatHistory((current) =>
        upsertChatSession(current, {
          id: chatId,
          title: existingSession?.title ?? makeChatTitle(question),
          messages: [
            ...(existingSession?.messages ?? getPersistedMessages(messages)),
            userMessage,
          ],
          entityContext,
          createdAt: existingSession?.createdAt ?? now,
          updatedAt: now,
        })
      );
      setDraft("");
      pendingQuestion.current = question;
      void fetcher.submit(
        {
          intent: "ask",
          question,
          history: JSON.stringify(history),
          entityContext: JSON.stringify(entityContext),
        },
        { method: "post" }
      );
    },
    [activeChatId, chatHistory, draft, entityContext, fetcher, messages]
  );

  useEffect(() => {
    if (!hydrated || !initialQuestion) return;
    setInitialQuestion(null);
    sendMessage(initialQuestion);
  }, [hydrated, initialQuestion, sendMessage]);

  useEffect(() => {
    if (!hydrated || !activeChatId) return;
    const persistedMessages = getPersistedMessages(messages);
    const signature = JSON.stringify([
      activeChatId,
      persistedMessages,
      entityContext,
    ]);
    if (syncedChatSignature.current === signature) return;
    syncedChatSignature.current = signature;
    setChatHistory((current) => {
      const session = current.sessions.find(
        (candidate) => candidate.id === activeChatId
      );
      if (!session) return current;
      return upsertChatSession(current, {
        ...session,
        messages: persistedMessages,
        entityContext,
        updatedAt: new Date().toISOString(),
      });
    });
  }, [activeChatId, entityContext, hydrated, messages]);

  useEffect(() => {
    if (!hydrated) return;
    const store = { activeChatId, sessions: chatHistory.sessions };
    writeChatHistory(window.sessionStorage, chatStorageKey, store);
    window.dispatchEvent(new Event(CHAT_HISTORY_UPDATED_EVENT));
  }, [activeChatId, chatHistory, chatStorageKey, hydrated]);

  useEffect(() => {
    if (fetcher.state !== "idle" || !pendingQuestion.current) return;
    if (isAssistantResult(fetcher.data)) {
      const answer = fetcher.data.answer;
      setMessages((current) => [
        ...current,
        {
          id: newMessageId(),
          role: "assistant",
          content: displayAssistantText(answer.answer),
          answer,
        },
      ]);
      setEntityContext(answer.entityContext);
    } else {
      setMessages((current) => [
        ...current,
        {
          id: newMessageId(),
          role: "assistant",
          content: "I could not complete that Shelf request. Please try again.",
        },
      ]);
    }
    pendingQuestion.current = null;
  }, [fetcher.data, fetcher.state]);

  function startNewChat() {
    if (fetcher.state !== "idle") return;
    setMessages([]);
    setEntityContext({});
    setSubmittedProposalToken(null);
    syncedChatSignature.current = null;
    pendingQuestion.current = null;
    setActiveChatId(null);
  }

  function openChat(chatId: string) {
    if (fetcher.state !== "idle") return;
    const session = chatHistory.sessions.find(
      (candidate) => candidate.id === chatId
    );
    if (!session) return;
    setMessages(session.messages as ChatMessage[]);
    setEntityContext(session.entityContext);
    setActiveChatId(session.id);
    setSubmittedProposalToken(null);
    syncedChatSignature.current = null;
    pendingQuestion.current = null;
  }

  const actionReportProposal =
    actionState?.kind === "report" ? actionState.proposal : undefined;

  return (
    <div>
      <div className="flex items-start justify-between gap-4">
        <SectionHeading
          title="Ask IOIO"
          text="Tell me what you need from the lab, and I’ll help you find it."
        />
        <div className="mt-5 flex shrink-0 gap-2">
          <Link to="/handbook/contribute" className="inline-flex items-center rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50">Contribute knowledge</Link>
          <button
            type="button"
            onClick={startNewChat}
            disabled={fetcher.state !== "idle"}
            className="rounded-xl border border-red-200 bg-white px-3 py-2 text-sm font-bold text-red-800 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            + New chat
          </button>
        </div>
      </div>

      <div className="mt-2 flex flex-col gap-3 lg:flex-row">
        <ChatHistoryPanel
          sessions={chatHistory.sessions}
          activeChatId={activeChatId}
          onNewChat={startNewChat}
          onOpenChat={openChat}
          to="/ioio/ask"
          className="hidden w-60 shrink-0 self-start lg:block"
        />
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <ChatHistoryPanel
            sessions={chatHistory.sessions}
            activeChatId={activeChatId}
            onNewChat={startNewChat}
            onOpenChat={openChat}
            to="/ioio/ask"
            className="lg:hidden"
          />
          <div className="flex min-h-[520px] flex-col rounded-[2rem] border border-red-100 bg-gray-50/70 p-3 shadow-sm sm:p-5">
            <div
              className="flex-1 space-y-4 overflow-y-auto pb-4"
              aria-live="polite"
            >
              {!messages.length ? (
                <div className="rounded-2xl border border-red-100 bg-white p-6 text-center sm:p-8">
                  <p className="text-xl font-bold text-gray-950">
                    What do you need help with?
                  </p>
                  <p className="mt-2 text-sm text-gray-600">
                    Ask about equipment, locations, kits, or your own loans.
                  </p>
                  <div className="mt-4 flex flex-wrap justify-center gap-2">
                    {STARTER_PROMPTS.map((prompt) => (
                      <button
                        key={prompt}
                        type="button"
                        onClick={() => sendMessage(prompt)}
                        disabled={fetcher.state !== "idle"}
                        className="rounded-full border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 hover:bg-red-100 disabled:opacity-50"
                      >
                        {prompt}
                      </button>
                    ))}
                  </div>
                  <Link
                    to="/ioio/browse"
                    className="mt-5 inline-block text-sm font-semibold text-red-700"
                  >
                    Browse Shelf inventory →
                  </Link>
                </div>
              ) : null}

              {messages.map((message) => (
                <div
                  key={message.id}
                  className={`flex ${
                    message.role === "user" ? "justify-end" : "justify-start"
                  }`}
                >
                  <div
                    className={`max-w-3xl rounded-2xl px-4 py-3 text-sm shadow-sm ${
                      message.role === "user"
                        ? "rounded-br-md bg-red-600 text-white"
                        : "rounded-bl-md border border-gray-200 bg-white text-gray-800"
                    }`}
                  >
                    <p className="whitespace-pre-wrap">{message.content}</p>
                    {message.answer ? (
                      <>
                        {message.answer.borrowProposal &&
                        !actionWasResolved(
                          actionState,
                          "borrow",
                          message.answer.borrowProposal.confirmationToken,
                          submittedProposalToken
                        ) ? (
                          <BorrowCard
                            proposal={message.answer.borrowProposal}
                            onAction={setSubmittedProposalToken}
                          />
                        ) : null}
                        {message.answer.returnProposal &&
                        !actionWasResolved(
                          actionState,
                          "return",
                          message.answer.returnProposal.confirmationToken,
                          submittedProposalToken
                        ) ? (
                          <ReturnCard
                            proposal={message.answer.returnProposal}
                            onAction={setSubmittedProposalToken}
                          />
                        ) : null}
                        {message.answer.proposal &&
                        !actionWasResolved(
                          actionState,
                          "report",
                          message.answer.proposal.confirmationToken,
                          submittedProposalToken
                        ) ? (
                          <ReportCard
                            proposal={message.answer.proposal}
                            onAction={setSubmittedProposalToken}
                          />
                        ) : null}
                        {message.answer.displayAssets?.length ? (
                          <div className="mt-4 grid gap-3 md:grid-cols-2">
                            {message.answer.displayAssets?.map((asset) => (
                              <AssetCard
                                key={asset.id}
                                asset={asset}
                                variant="assistant"
                              />
                            ))}
                          </div>
                        ) : null}
                      </>
                    ) : null}
                  </div>
                </div>
              ))}

              {fetcher.state !== "idle" ? (
                <div className="flex justify-start">
                  <p
                    className="rounded-2xl rounded-bl-md border border-gray-200 bg-white px-4 py-3 text-sm text-gray-500"
                    role="status"
                  >
                    Thinking…
                  </p>
                </div>
              ) : null}
              {submittedProposalToken ? (
                <ActionStatus actionState={actionState} />
              ) : null}
              {actionReportProposal &&
              !actionWasResolved(
                actionState,
                "report",
                actionReportProposal.confirmationToken,
                submittedProposalToken
              ) ? (
                <ReportCard
                  proposal={actionReportProposal}
                  onAction={setSubmittedProposalToken}
                />
              ) : null}
            </div>

            <form
              onSubmit={(event) => {
                event.preventDefault();
                sendMessage();
              }}
              className="sticky bottom-0 mt-auto flex items-end gap-2 rounded-2xl border border-gray-200 bg-white p-2 shadow-sm"
            >
              <label htmlFor="ask-q" className="sr-only">
                Message Ask IOIO
              </label>
              <textarea
                id="ask-q"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    sendMessage();
                  }
                }}
                placeholder="Ask about equipment…"
                rows={1}
                disabled={fetcher.state !== "idle"}
                className="min-h-11 flex-1 resize-none rounded-xl border-0 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-red-600 disabled:bg-gray-50"
              />
              <button
                type="submit"
                disabled={!draft.trim() || fetcher.state !== "idle"}
                className="min-h-11 rounded-xl bg-red-600 px-4 font-semibold text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Send
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
