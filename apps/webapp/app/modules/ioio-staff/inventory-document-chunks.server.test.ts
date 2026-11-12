import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getImportHelperHealth,
  requestImportHelperProposal,
} from "./import-helper-client.server";
import {
  createImportHelperRequest,
  type ImportHelperResponse,
} from "./import-helper-contract.server";
import { splitInventoryDocument } from "./inventory-document-chunks.server";
import { parseExplicitInventorySources } from "./inventory-source.server";
import { a3InventoryText } from "../../../test/factories/ioio-inventory-source";

function request(count = 48, sha = "a") {
  return createImportHelperRequest({
    document: {
      sha256: sha.repeat(64),
      pages: [{ sourceRef: "page-1", page: 1, text: a3InventoryText(count) }],
    },
    activeCategories: [],
    relevantLocations: [],
    productCandidates: [],
    allowedTrackingModes: ["QUANTITY_TRACKED"],
    allowedSettings: [],
  });
}
function response(input: ReturnType<typeof request>): ImportHelperResponse {
  return {
    schemaVersion: 1,
    questions: [],
    rows: parseExplicitInventorySources(input.document.pages).map((row) => ({
      sourceRef: row.sourceRef,
      productName: row.sourceItemName,
      organization: row.sourceOrganization,
      room: row.sourceRoom,
      location: row.sourceStorageLocation,
      quantity: row.quantity,
      quantityStatus: "UNKNOWN",
      manufacturer: null,
      mpn: null,
      supplierProductNumber: null,
      description: null,
      productMatch: { matchType: "NEW", candidateId: null, confidence: 1 },
      categorySuggestion: {
        categoryId: null,
        proposedName: null,
        confidence: 0,
      },
      trackingSuggestion: { mode: "QUANTITY_TRACKED", confidence: 1 },
      kitHint: { isKit: false, name: null, confidence: 1 },
      settingsSuggestions: [],
      locationSuggestions: [],
      questions: [],
      evidence: [{ sourceRef: row.sourceRef, text: row.sourceText }],
    })),
  };
}
const config = { endpoint: "http://localhost:18787", authToken: "test-only" };
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("inventory document budgets and batches", () => {
  it("uses one helper HTTP request for a small inventory", async () => {
    // why: replace external inference HTTP while exercising the real contract.
    const fetchImpl = vi.fn(() =>
      Promise.resolve(Response.json(response(request(6))))
    );
    expect(
      (await requestImportHelperProposal(request(6), { ...config, fetchImpl }))
        .status
    ).toBe("ready");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("accepts 48 A3 rows, preserves bin/count/name/context and removes duplicate outputs", async () => {
    const original = request();
    const chunks = splitInventoryDocument(original);
    expect(chunks).toHaveLength(3);
    expect(
      chunks.every((chunk) =>
        chunk.document.pages[0].text.includes("Room: B477")
      )
    ).toBe(true);
    // why: model duplicated output and wrong numeric/context suggestions at the HTTP boundary.
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) => {
        const proposal = response(JSON.parse(String(init?.body)));
        proposal.rows = [...proposal.rows, proposal.rows[0]].map((row) => ({
          ...row,
          quantity: 1,
          location: "B477",
        }));
        return Promise.resolve(Response.json(proposal));
      }
    );
    const result = await requestImportHelperProposal(original, {
      ...config,
      fetchImpl,
    });
    expect(result.status).toBe("ready");
    if (result.status !== "ready" || "mode" in result.proposal)
      throw new Error("Expected inventory");
    const sources = parseExplicitInventorySources(original.document.pages);
    expect(
      result.proposal.rows.map((row) => [
        row.productName,
        row.quantity,
        row.location,
        row.room,
      ])
    ).toEqual(
      sources.map((row) => [
        row.sourceItemName,
        row.quantity,
        row.sourceStorageLocation,
        "B477",
      ])
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("keeps multiline source rows intact with their estimated-count headers", () => {
    const original = request();
    original.document.pages[0].text = [
      "Organization: IOIO Lab",
      "Room: B477",
      "Location",
      "Item",
      "Estimated quantity",
      "Description",
      ...Array.from({ length: 48 }, (_, index) =>
        [
          `A3-${index + 1}`,
          `Component ${index + 1}`,
          String(index + 1),
          `Description ${index + 1}`,
        ].join("\n")
      ),
    ].join("\n");
    const rows = splitInventoryDocument(original).flatMap((chunk) =>
      parseExplicitInventorySources(chunk.document.pages)
    );
    expect(rows).toHaveLength(48);
    expect(
      rows.every((row) => row.quantityIsEstimated && row.sourceRoom === "B477")
    ).toBe(true);
    expect(rows.map((row) => row.quantity)).toEqual(
      Array.from({ length: 48 }, (_, index) => index + 1)
    );
  });

  it("retains completed chunks after a section failure and reuses them on retry", async () => {
    const original = request(48, "b");
    let fail = true;
    // why: simulate one helper subprocess timeout without running Claude.
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) => {
        const input = JSON.parse(String(init?.body));
        if (
          fail &&
          input.document.pages[0].text.includes("Workshop component 21 |")
        )
          return Promise.resolve(new Response("", { status: 504 }));
        return Promise.resolve(Response.json(response(input)));
      }
    );
    const first = await requestImportHelperProposal(original, {
      ...config,
      fetchImpl,
    });
    expect(first).toMatchObject({
      status: "manual",
      reason: "processing_timeout",
      diagnostic: expect.stringContaining("1/3 chunks completed"),
    });
    expect(first).toMatchObject({
      diagnostic: expect.stringContaining("A3-3"),
    });
    fail = false;
    const retried = await requestImportHelperProposal(original, {
      ...config,
      fetchImpl,
    });
    expect(
      retried.status === "ready" &&
        "rows" in retried.proposal &&
        retried.proposal.rows
    ).toHaveLength(48);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("lets document analysis exceed legacy 90-second configuration", async () => {
    vi.useFakeTimers();
    vi.stubEnv("IOIO_IMPORT_HELPER_URL", config.endpoint);
    vi.stubEnv("IOIO_IMPORT_HELPER_AUTH_TOKEN", config.authToken);
    vi.stubEnv("IOIO_IMPORT_HELPER_TIMEOUT_MS", "90000");
    // why: simulate a slow network response using virtual time.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url, init) =>
          new Promise((resolve, reject) => {
            init.signal.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError"))
            );
            setTimeout(
              () => resolve(Response.json(response(request(6)))),
              100_000
            );
          })
      )
    );
    const result = requestImportHelperProposal(request(6));
    await vi.advanceTimersByTimeAsync(100_000);
    expect((await result).status).toBe("ready");
    vi.unstubAllGlobals();
  });

  it("keeps health at 1.2 seconds even with a long analysis budget", async () => {
    vi.useFakeTimers();
    // why: keep the HTTP probe pending until its own timeout aborts it.
    const fetchImpl = vi.fn(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) =>
          init.signal.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError"))
          )
        )
    );
    const result = getImportHelperHealth({
      ...config,
      analysisTimeoutMs: 240_000,
      fetchImpl,
    });
    await vi.advanceTimersByTimeAsync(1200);
    expect(await result).toMatchObject({ status: "unavailable" });
  });
});
