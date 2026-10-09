import {
  Popover,
  PopoverContent,
  PopoverPortal,
  PopoverTrigger,
} from "@radix-ui/react-popover";
import { CircleHelp } from "lucide-react";
import type { IoioAiGuidelineKey } from "~/modules/ioio-ai-guidelines/guidelines.shared";

type GuidelineHelp = {
  explanation: string;
  good: string;
  bad: string;
  why: string;
};

const GUIDELINE_HELP: Record<IoioAiGuidelineKey, GuidelineHelp> = {
  generalBehaviour: {
    explanation:
      "Use this for tone, answer length, structure and general communication preferences.",
    good: "Give the direct answer first. Keep simple factual answers to 1-3 sentences unless more detail is requested.",
    bad: "Be helpful and give good answers.",
    why: "Specific instructions are easier for Ask IOIO to follow.",
  },
  inventory: {
    explanation:
      "Use this for how Ask IOIO should present inventory information. Actual inventory facts still come from live Shelf data.",
    good: "For quantity questions, give the total first. Group physical units by logical product and only discuss individual units when relevant.",
    bad: "Tell users about our inventory.",
    why: "This guides presentation without replacing current inventory data.",
  },
  borrowing: {
    explanation:
      "Use this for how borrowing information should be communicated. It does not change borrowing rules.",
    good: "State the borrowing answer first. Explain only restrictions relevant to the question.",
    bad: "Explain borrowing thoroughly.",
    why: "Focused guidance keeps answers useful without changing policy.",
  },
  locations: {
    explanation:
      "Use this for how Ask IOIO should present locations supplied by Shelf.",
    good: "Use human-readable location names. Never show internal database IDs.",
    bad: "Give detailed location information.",
    why: "Clear presentation helps people find items without exposing internal IDs.",
  },
  studentSupport: {
    explanation:
      "Use this for communication preferences when Ask IOIO is helping Students.",
    good: "Use simple language. Briefly explain unfamiliar equipment terminology and give the useful answer first.",
    bad: "Be friendly and helpful to students.",
    why: "Concrete preferences are more actionable than general tone requests.",
  },
  staffSupport: {
    explanation:
      "Use this for communication preferences when Ask IOIO is helping Staff.",
    good: "Prioritize exact current facts and keep routine operational answers concise unless Staff asks for more detail.",
    bad: "Give Staff detailed information.",
    why: "This sets a clear default while leaving room for requested detail.",
  },
  actions: {
    explanation:
      "Use this for how Ask IOIO should communicate about available actions. Guidelines never grant additional capabilities or permissions.",
    good: "Clearly state what would change before proposing an action. Point out duplicates, ambiguity or concrete consequences.",
    bad: "Do whatever Staff asks.",
    why: "Guidelines can shape explanations, but cannot grant capabilities or permissions.",
  },
};

export function AiGuidelineFieldHelp({
  sectionKey,
  title,
  open,
  onOpenChange,
}: {
  sectionKey: IoioAiGuidelineKey;
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const help = GUIDELINE_HELP[sectionKey];

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Guideline examples for ${title}`}
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-full border border-gray-200 bg-white text-gray-500 hover:border-gray-300 hover:bg-gray-50 hover:text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2"
        >
          <CircleHelp className="size-4" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverPortal>
        <PopoverContent
          side="bottom"
          align="end"
          sideOffset={8}
          collisionPadding={12}
          className="z-50 w-[calc(100vw-2rem)] max-w-sm rounded-lg border border-gray-200 bg-white p-4 text-left shadow-lg outline-none"
        >
          <h3 className="text-sm font-semibold text-gray-900">
            Writing this guideline
          </h3>
          <p className="mt-1 text-sm text-gray-600">{help.explanation}</p>

          <div className="mt-3 space-y-2">
            <div className="rounded-md border border-green-200 bg-green-50 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-green-800">
                Good
              </p>
              <p className="mt-1 text-sm text-green-950">“{help.good}”</p>
            </div>
            <div className="rounded-md border border-gray-200 bg-gray-50 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-600">
                Bad
              </p>
              <p className="mt-1 text-sm text-gray-700">“{help.bad}”</p>
            </div>
          </div>

          <p className="mt-3 text-xs text-gray-600">
            <span className="font-semibold text-gray-800">Why:</span> {help.why}
          </p>
        </PopoverContent>
      </PopoverPortal>
    </Popover>
  );
}
