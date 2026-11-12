import { createHash } from "node:crypto";
import { Logger } from "~/utils/logger";
import type { ImportHelperClientResult } from "./import-helper-client.server";
import type {
  ImportHelperRequest,
  ImportHelperResponse,
} from "./import-helper-contract.server";
import {
  getInventoryDocumentContext,
  parseExplicitInventorySources,
} from "./inventory-source.server";

export const INVENTORY_CHUNK_ROWS = 20;
export const INVENTORY_CHUNK_CHARACTERS = 12_000;
const RETENTION_MS = 15 * 60_000;
// Bounded process-local retry cache. Keys include the entire authorized request,
// including allowlists, so results cannot cross organization/context boundaries.
const completed = new Map<
  string,
  { expires: number; proposal: ImportHelperResponse }
>();

export function splitInventoryDocument(
  request: ImportHelperRequest
): ImportHelperRequest[] {
  const sources = parseExplicitInventorySources(request.document.pages);
  const size = request.document.pages.reduce(
    (sum, page) => sum + page.text.length,
    0
  );
  if (
    sources.length <= INVENTORY_CHUNK_ROWS &&
    size <= INVENTORY_CHUNK_CHARACTERS
  )
    return [request];
  const context = getInventoryDocumentContext(request.document.pages);
  const prefix = [
    context.sourceOrganization && `Organization: ${context.sourceOrganization}`,
    context.sourceRoom && `Room: ${context.sourceRoom}`,
  ]
    .filter(Boolean)
    .join("\n");
  // Explicit table rows are indivisible. For unrecognized layouts keep whole
  // pages: guessing newline boundaries could split a multi-line invoice row.
  const units = sources.length
    ? sources.map((row) => ({
        sourceRef: row.sourceRef,
        page: row.page,
        text: row.sourceText,
      }))
    : request.document.pages;
  const batches: (typeof units)[] = [];
  let batch: typeof units = [];
  let characters = 0;
  for (const unit of units) {
    if (
      batch.length &&
      (batch.length >= INVENTORY_CHUNK_ROWS ||
        characters + unit.text.length > INVENTORY_CHUNK_CHARACTERS)
    ) {
      batches.push(batch);
      batch = [];
      characters = 0;
    }
    batch.push(unit);
    characters += unit.text.length;
  }
  if (batch.length) batches.push(batch);
  return batches.map((units) => {
    const pages = new Map<
      string,
      ImportHelperRequest["document"]["pages"][number]
    >();
    for (const unit of units) {
      const page = pages.get(unit.sourceRef);
      if (page) page.text += `\n${unit.text}`;
      else {
        const original = request.document.pages.find(
          (page) => page.sourceRef === unit.sourceRef
        );
        const firstSource = sources.find(
          (row) => row.sourceRef === unit.sourceRef
        );
        const preamble =
          original && firstSource
            ? original.text.slice(
                0,
                Math.max(0, original.text.indexOf(firstSource.sourceText))
              )
            : "";
        pages.set(unit.sourceRef, {
          ...unit,
          text: `${preamble}\n${prefix}\n${unit.text}`,
        });
      }
    }
    return {
      ...request,
      document: { ...request.document, pages: [...pages.values()] },
    };
  });
}

/** One proposal only after all chunks succeed. Retried successful chunks replace
 * their slot rather than appending rows. Nothing here applies inventory writes. */
export async function analyzeInventoryChunks(
  request: ImportHelperRequest,
  analyze: (request: ImportHelperRequest) => Promise<ImportHelperClientResult>
): Promise<ImportHelperClientResult> {
  const chunks = splitInventoryDocument(request);
  const sources = parseExplicitInventorySources(request.document.pages);
  Logger.info({
    event: "ioio_inventory_document_analysis",
    extractedTextLength: request.document.pages.reduce(
      (sum, page) => sum + page.text.length,
      0
    ),
    lineItemCount: sources.length,
    sectionCount: new Set(sources.map((row) => row.sourceStorageLocation)).size,
    chunkingUsed: chunks.length > 1,
    chunkCount: chunks.length,
  });
  if (chunks.length === 1) return analyze(chunks[0]);
  for (const [key, value] of completed)
    if (value.expires <= Date.now()) completed.delete(key);
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(request))
    .digest("hex");
  const results: ImportHelperResponse[] = [];
  for (const [index, chunk] of chunks.entries()) {
    const key = `${fingerprint}:${index}`;
    const cached = completed.get(key);
    const result = cached
      ? { status: "ready" as const, proposal: cached.proposal }
      : await analyze(chunk);
    const sections = [
      ...new Set(
        parseExplicitInventorySources(chunk.document.pages).map(
          (row) => row.sourceStorageLocation
        )
      ),
    ];
    if (result.status === "manual") {
      const diagnostic = `Section ${
        sections.join(", ") || `chunk ${index + 1}`
      } failed; ${results.length}/${
        chunks.length
      } chunks completed. Successful chunks are retained for retry for 15 minutes on this Shelf process.`;
      Logger.info({
        event: "ioio_inventory_chunk_failed",
        chunk: index + 1,
        completedChunks: results.length,
        chunkCount: chunks.length,
        reason: result.reason,
      });
      return { ...result, diagnostic };
    }
    if ("mode" in result.proposal)
      return {
        status: "manual",
        reason: "invalid_response",
        diagnostic: `Chunk ${index + 1} returned the wrong response mode.`,
      };
    let proposal = result.proposal;
    const explicit = parseExplicitInventorySources(chunk.document.pages);
    if (explicit.length) {
      // Join by exact evidence, never item identity alone: identical products in
      // separate bins remain separate source rows. Drop repeated model outputs.
      const rows: ImportHelperResponse["rows"] = [];
      for (const source of explicit) {
        const row = proposal.rows.find((candidate) =>
          candidate.evidence.some(
            (quote) =>
              quote.sourceRef === source.sourceRef &&
              quote.text.includes(source.sourceText)
          )
        );
        if (!row)
          return {
            status: "manual",
            reason: "invalid_response",
            diagnostic: `Section ${
              source.sourceStorageLocation
            } was missing from chunk ${index + 1}; ${results.length}/${
              chunks.length
            } chunks retained for retry.`,
          };
        rows.push({
          ...row,
          productName: source.sourceItemName,
          quantity: source.quantity,
          organization: source.sourceOrganization,
          room: source.sourceRoom,
          location: source.sourceStorageLocation,
        });
      }
      proposal = { ...proposal, rows };
    }
    results.push(proposal);
    if (!cached) {
      while (completed.size >= 128)
        completed.delete(completed.keys().next().value!);
      completed.set(key, { expires: Date.now() + RETENTION_MS, proposal });
    }
  }
  return {
    status: "ready",
    proposal: {
      ...results[0],
      rows: results.flatMap((proposal) => proposal.rows),
      questions: [
        ...new Set(results.flatMap((proposal) => proposal.questions)),
      ],
    },
  };
}
