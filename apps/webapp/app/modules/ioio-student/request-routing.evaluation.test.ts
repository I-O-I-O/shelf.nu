import { describe, expect, it } from "vitest";
import {
  classifyAskIoioRequest,
  getHandbookContributionSource,
} from "./request-routing.shared";

type EvaluationCase = {
  category: string;
  message: string;
  intent: ReturnType<typeof classifyAskIoioRequest>["intent"];
  handbook: "none" | "published_and_related" | "related_for_review";
  shelf: "none" | "live_inventory" | "live_location" | "entity_resolution";
  history?: Array<{ role: "user" | "assistant"; content: string }>;
};

const cases: EvaluationCase[] = [
  {
    category: "inventory",
    message: "How many Grove Kits do we have?",
    intent: "inventory_query",
    handbook: "none",
    shelf: "live_inventory",
  },
  {
    category: "inventory",
    message: "How many motors are available?",
    intent: "inventory_query",
    handbook: "none",
    shelf: "live_inventory",
  },
  {
    category: "inventory",
    message: "Do we have any Arduino boards?",
    intent: "inventory_query",
    handbook: "none",
    shelf: "live_inventory",
  },
  {
    category: "inventory",
    message: "Is a multimeter available?",
    intent: "inventory_query",
    handbook: "none",
    shelf: "live_inventory",
  },
  {
    category: "inventory",
    message: "Do we have any motors to borrow?",
    intent: "inventory_query",
    handbook: "none",
    shelf: "live_inventory",
  },
  {
    category: "inventory",
    message: "List the equipment available for borrowing.",
    intent: "inventory_query",
    handbook: "none",
    shelf: "live_inventory",
  },
  {
    category: "typo",
    message: "how many mtoors do we have",
    intent: "inventory_query",
    handbook: "none",
    shelf: "live_inventory",
  },
  {
    category: "typo",
    message: "do we have ardunio boards",
    intent: "inventory_query",
    handbook: "none",
    shelf: "live_inventory",
  },
  {
    category: "typo",
    message: "where are the microbt kits",
    intent: "location_query",
    handbook: "none",
    shelf: "live_location",
  },
  {
    category: "location",
    message: "Where are the Grove Kits?",
    intent: "location_query",
    handbook: "none",
    shelf: "live_location",
  },
  {
    category: "location",
    message: "Where can I find motors?",
    intent: "location_query",
    handbook: "none",
    shelf: "live_location",
  },
  {
    category: "location",
    message: "Where is the soldering station?",
    intent: "location_query",
    handbook: "none",
    shelf: "live_location",
  },
  {
    category: "handbook",
    message: "What is a Grove Kit and what can I use it for?",
    intent: "handbook_query",
    handbook: "published_and_related",
    shelf: "none",
  },
  {
    category: "handbook",
    message: "Tell me about the Grove Kit.",
    intent: "handbook_query",
    handbook: "published_and_related",
    shelf: "none",
  },
  {
    category: "handbook",
    message: "What's the difference between a Grove Kit and a Breadboard Kit?",
    intent: "handbook_query",
    handbook: "published_and_related",
    shelf: "none",
  },
  {
    category: "handbook",
    message:
      "I'm new to IOIO Lab. What should I know before borrowing equipment?",
    intent: "handbook_query",
    handbook: "published_and_related",
    shelf: "none",
  },
  {
    category: "handbook",
    message: "What do we know about the Grove Kit?",
    intent: "handbook_query",
    handbook: "published_and_related",
    shelf: "none",
  },
  {
    category: "handbook",
    message: "How do I get started with a Grove Kit?",
    intent: "handbook_query",
    handbook: "published_and_related",
    shelf: "none",
  },
  {
    category: "handbook",
    message: "What should I check before returning a kit?",
    intent: "handbook_query",
    handbook: "published_and_related",
    shelf: "none",
  },
  {
    category: "handbook",
    message: "How do I use the Grove Kit?",
    intent: "handbook_query",
    handbook: "published_and_related",
    shelf: "none",
  },
  {
    category: "handbook",
    message: "How do I borrow an Arduino?",
    intent: "handbook_query",
    handbook: "published_and_related",
    shelf: "none",
  },
  {
    category: "general",
    message: "What is an Arduino?",
    intent: "general",
    handbook: "none",
    shelf: "none",
  },
  {
    category: "general",
    message: "What's a breadboard used for?",
    intent: "general",
    handbook: "none",
    shelf: "none",
  },
  {
    category: "general",
    message: "Explain why LEDs need a resistor.",
    intent: "general",
    handbook: "none",
    shelf: "none",
  },
  {
    category: "general",
    message: "What does the word broken mean in electronics?",
    intent: "general",
    handbook: "none",
    shelf: "none",
  },
  {
    category: "general",
    message: "What is voltage?",
    intent: "general",
    handbook: "none",
    shelf: "none",
  },
  {
    category: "recommendation",
    message:
      "I'm new to IOIO Lab and want to build something with sensors. What equipment would you suggest and why?",
    intent: "recommendation",
    handbook: "published_and_related",
    shelf: "live_inventory",
  },
  {
    category: "recommendation",
    message:
      "I want to make something with a motor and Arduino. What could I use?",
    intent: "recommendation",
    handbook: "published_and_related",
    shelf: "live_inventory",
  },
  {
    category: "recommendation",
    message: "What should I use to measure voltage in a beginner project?",
    intent: "recommendation",
    handbook: "published_and_related",
    shelf: "live_inventory",
  },
  {
    category: "follow-up",
    message: "What about the motors?",
    intent: "inventory_query",
    handbook: "none",
    shelf: "live_inventory",
    history: [{ role: "user", content: "How many Grove Kits do we have?" }],
  },
  {
    category: "follow-up",
    message: "Where are they?",
    intent: "location_query",
    handbook: "none",
    shelf: "live_location",
    history: [{ role: "user", content: "Where are the Grove Kits?" }],
  },
  {
    category: "follow-up",
    message: "How many are available?",
    intent: "inventory_query",
    handbook: "none",
    shelf: "live_inventory",
    history: [{ role: "user", content: "How many Grove Kits do we have?" }],
  },
  {
    category: "knowledge contribution",
    message:
      "The Grove Kit contains a carrier board and a vibration motor. Log this as IOIO knowledge for review.",
    intent: "knowledge_contribution",
    handbook: "related_for_review",
    shelf: "none",
  },
  {
    category: "knowledge contribution",
    message:
      "The Ultimaker feeder jam happened again. Cleaning the gear before recalibrating fixed it. Add this to our knowledge.",
    intent: "knowledge_contribution",
    handbook: "related_for_review",
    shelf: "none",
  },
  {
    category: "knowledge contribution",
    message: "Add that to the Handbook.",
    intent: "knowledge_contribution",
    handbook: "related_for_review",
    shelf: "none",
    history: [
      {
        role: "user",
        content:
          "Checking every component in a Grove Kit before return helps notice missing parts.",
      },
      { role: "assistant", content: "That sounds useful." },
    ],
  },
  {
    category: "action",
    message: "Create a section.",
    intent: "action_request",
    handbook: "none",
    shelf: "entity_resolution",
  },
  {
    category: "action",
    message: "Create a section called Electronics in B477.",
    intent: "action_request",
    handbook: "none",
    shelf: "entity_resolution",
  },
  {
    category: "action",
    message: "Report the Arduino as broken.",
    intent: "action_request",
    handbook: "none",
    shelf: "entity_resolution",
  },
  {
    category: "action",
    message: "creat a container called Sensors in the electornics section",
    intent: "action_request",
    handbook: "none",
    shelf: "entity_resolution",
  },
  {
    category: "action",
    message: "How do I borrow the Arduino?",
    intent: "handbook_query",
    handbook: "published_and_related",
    shelf: "none",
  },
  {
    category: "action",
    message: "I want to borrow the Arduino.",
    intent: "action_request",
    handbook: "none",
    shelf: "entity_resolution",
  },
  {
    category: "ambiguity guard",
    message: "Tell me about motors.",
    intent: "general",
    handbook: "none",
    shelf: "none",
  },
  {
    category: "ambiguity guard",
    message: "What is a motor used for?",
    intent: "general",
    handbook: "none",
    shelf: "none",
  },
  {
    category: "ambiguity guard",
    message: "What do we know about motor safety?",
    intent: "handbook_query",
    handbook: "published_and_related",
    shelf: "none",
  },
];

describe("Ask IOIO realistic request-routing evaluation", () => {
  it.each(cases)(
    "$category: $message",
    ({ message, intent, handbook, shelf, history }) => {
      const route = classifyAskIoioRequest(message, { history });
      expect(route.intent).toBe(intent);
      expect(route.retrieval).toEqual({ handbook, shelf });
    }
  );

  it("keeps knowledge contribution source grounded in user-authored facts", () => {
    const source = getHandbookContributionSource("Add that to the Handbook.", [
      {
        role: "user",
        content:
          "Checking every component in a Grove Kit before return helps notice missing parts.",
      },
      { role: "assistant", content: "That sounds useful." },
    ]);
    expect(source).toContain("Checking every component");
    expect(source).not.toContain("That sounds useful");
  });
});
