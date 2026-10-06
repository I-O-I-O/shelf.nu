import { describe, expect, it } from "vitest";
import {
  classifyAskIoioRequest,
  getHandbookContributionSource,
  getHandbookContributionTitle,
} from "./request-routing.shared";

const groveContribution =
  "The Grove Kit contains an Arduino Nano 33 BLE Sense Rev2, Grove carrier board, button board, slide potentiometer, vibration motor, passive buzzer, RGB LED stick, OWIIC to Grove adapter, Grove servo cable and USB cable. This is useful IOIO knowledge. Log it appropriately in the Handbook.";

describe("Ask IOIO intent and retrieval routing", () => {
  it.each([
    ["How many Grove Kits do we have?", "inventory_query", "live_inventory"],
    ["Where are the Grove Kits?", "location_query", "live_location"],
    ["How do I use the Grove Kit?", "handbook_query", "none"],
    ["What can I use to control a fan?", "recommendation", "live_inventory"],
    [groveContribution, "knowledge_contribution", "none"],
    [
      "We learned that cleaning X before Y fixes Z. Log this.",
      "knowledge_contribution",
      "none",
    ],
    [
      "Change the Grove Kit Handbook entry to include the vibration motor.",
      "handbook_update",
      "none",
    ],
    ["Add 3 Grove Kits to inventory.", "action_request", "entity_resolution"],
  ] as const)("routes %s", (question, intent, shelf) => {
    const route = classifyAskIoioRequest(question);
    expect(route.intent).toBe(intent);
    expect(route.retrieval.shelf).toBe(shelf);
  });

  it("does not let inventory nouns override an explicit knowledge contribution", () => {
    const route = classifyAskIoioRequest(groveContribution);
    expect(route.intent).toBe("knowledge_contribution");
    expect(route.retrieval).toEqual({
      handbook: "related_for_review",
      shelf: "none",
    });
    expect(route.retrieval.shelf).not.toBe("live_inventory");
  });

  it("keeps an ordinary greeting out of Shelf and Handbook retrieval", () => {
    expect(classifyAskIoioRequest("Hi")).toMatchObject({
      intent: "general",
      retrieval: { handbook: "none", shelf: "none" },
    });
  });

  it("does not turn a request to record knowledge into a live inventory search", () => {
    expect(
      classifyAskIoioRequest(
        "We learned that checking each component before return catches missing parts. Please record this for review."
      )
    ).toMatchObject({
      intent: "knowledge_contribution",
      retrieval: { handbook: "related_for_review", shelf: "none" },
    });
  });

  it("routes a follow-up using the immediately relevant user subject", () => {
    expect(
      classifyAskIoioRequest("What about the motors?", {
        history: [
          { role: "user", content: "How many Grove Kits do we have?" },
          { role: "assistant", content: "Shelf found five Grove Kits." },
        ],
      })
    ).toMatchObject({
      intent: "inventory_query",
      confidence: "medium",
      reason: "follow-up to recent inventory query",
    });
  });

  it("uses prior user-authored facts for a Handbook follow-up, not AI prose", () => {
    const facts =
      "The Grove Kit contains a carrier board and a vibration motor.";
    expect(
      getHandbookContributionSource(
        "Add that component list to the Handbook.",
        [
          { role: "user", content: facts },
          {
            role: "assistant",
            content: "It also contains a temperature sensor.",
          },
        ]
      )
    ).toBe(facts);
  });

  it("marks a referenced prior AI answer as an unverified draft for review", () => {
    const result = getHandbookContributionSource(
      "Add that component list to the Handbook.",
      [
        { role: "user", content: "Tell me about the Grove Kit." },
        {
          role: "assistant",
          content: "It may include a carrier board and sensor components.",
        },
      ]
    );
    expect(result).toContain(
      "Assistant-provided draft requested for Staff verification"
    );
    expect(result).toContain("carrier board and sensor components");
  });

  it("removes the request clause from direct submitted knowledge and derives a title", () => {
    const content = getHandbookContributionSource(groveContribution);
    expect(content).toContain("vibration motor");
    expect(content).not.toContain("Log it appropriately");
    expect(getHandbookContributionTitle(content)).toBe(
      "The Grove Kit knowledge"
    );
  });
});
