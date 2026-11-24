import { describe, expect, it } from "vitest";
import {
  extractBorrowQuantity,
  extractBorrowReturnDate,
} from "./borrow-item.shared";
import {
  cleanAssistantText,
  inferAssistantIntent,
  isReferencePhrase,
  normalizeConversationHistory,
  parseEntityContextQuery,
  sanitizeConversationContent,
} from "./conversation.shared";
import { extractReturnQuantity } from "./return-item.shared";

describe("IOIO conversation context", () => {
  it("keeps a short multi-turn history for follow-up questions", () => {
    const history = normalizeConversationHistory([
      { role: "user", content: "What Arduino boards do we have?" },
      { role: "assistant", content: "Shelf found Arduino Nano." },
    ]);

    expect(history).toEqual([
      { role: "user", content: "What Arduino boards do we have?" },
      { role: "assistant", content: "Shelf found Arduino Nano." },
    ]);
    expect(
      inferAssistantIntent("Where is the Nano?", { lastIntent: "search" })
    ).toBe("search");
  });

  it("continues an unambiguous borrow intent from resolved context", () => {
    expect(isReferencePhrase("One, Friday.")).toBe(true);
    expect(isReferencePhrase("Where is the Nano?")).toBe(true);
    expect(
      isReferencePhrase(
        "This is useful IOIO knowledge. Log it appropriately in the Handbook."
      )
    ).toBe(false);
    expect(
      inferAssistantIntent("One, Friday.", {
        currentAssetId: "asset-1",
        lastIntent: "borrow",
      })
    ).toBe("borrow");
    expect(extractBorrowQuantity("2 until Friday.")).toBe(2);
    expect(extractBorrowQuantity("I just need one")).toBe(1);
    expect(extractBorrowQuantity("One, Friday.")).toBe(1);
    expect(extractBorrowReturnDate("2030-01-15")).toBe("2030-01-15");
    expect(extractBorrowReturnDate("2 until Friday.")).toMatch(
      /^\d{4}-\d{2}-\d{2}$/
    );
    expect(extractBorrowReturnDate("Friday.")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(
      inferAssistantIntent("Friday.", {
        currentAssetId: "asset-1",
        requestedQuantity: 1,
        lastIntent: "search",
      })
    ).toBe("borrow");
  });

  it("turns an item-detail handoff into structured entity context", () => {
    const params = new URLSearchParams(
      "new=1&q=What%20is%20Arduino%20Nano%3F&assetId=asset-1&locationId=location-1"
    );

    expect(parseEntityContextQuery(params)).toEqual({
      currentAssetId: "asset-1",
      currentLocationId: "location-1",
    });
  });

  it("continues return and report references without broadening loan access", () => {
    expect(
      inferAssistantIntent("Return one of those", {
        currentBookingId: "booking-1",
        lastIntent: "return",
      })
    ).toBe("return");
    expect(
      inferAssistantIntent("This one is damaged", {
        currentAssetId: "asset-1",
        lastIntent: "search",
      })
    ).toBe("report");
    expect(extractReturnQuantity("Return one of those")).toBe(1);
  });

  it("redacts common personal identifiers before history reaches a provider", () => {
    expect(
      sanitizeConversationContent(
        "student ID: ST-42, email test@example.edu, phone +45 12 34 56 78"
      )
    ).toBe(
      "[redacted student ID], email [redacted email], phone [redacted contact]"
    );
  });

  it("cleans escaped markdown before assistant prose reaches the chat bubble", () => {
    expect(cleanAssistantText("\\- \\*\\*Arduino Nano\\*\\*")).toBe(
      "- Arduino Nano"
    );
  });
});
