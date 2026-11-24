# Inventory document analysis budgets

Readable PDFs use extracted text, never PDF bytes/base64. Shelf parses explicit
inventory tables before calling Claude. The helper sends those rows as source
evidence with concise enrichment instructions and existing Shelf allowlists;
it does not also repeat the original PDF text. Generic invoice extraction keeps
the existing prompt and strict response validation.

The old UI timeout message conflated Shelf HTTP AbortController expiration with
helper HTTP 504. With both configured at 90000 ms, Shelf starts its timer before
the helper starts inference. Existing logs distinguish client abort (null HTTP
status) from helper 504, but a screenshot alone cannot prove which fired on a
historical request.

| Layer                                 | Document analysis   | Other calls                            |
| ------------------------------------- | ------------------- | -------------------------------------- |
| Shelf HTTP client                     | 240000 ms per chunk | Existing 20000 ms default / legacy env |
| Helper watchdog and Claude subprocess | 210000 ms per chunk | Existing 90000 ms default / legacy env |
| Health HTTP probe                     | 1200 ms             | No inference                           |
| Helper request body / headers         | 30000 / 10000 ms    | Only receiving request, not inference  |

No independent analysis timer exists in the browser/import action. The client
timer covers fetch and response reading. JSON parsing/validation is synchronous
and size-bounded (2 MB response); it has no separate timer. Client disconnects
abort helper inference. Logs identify `shelf_http_client`, `claude_subprocess`,
or `helper_watchdog` without logging source content or credentials.

Document budgets ignore the legacy 90-second environment settings. Optional
`IOIO_IMPORT_HELPER_ANALYSIS_TIMEOUT_MS` overrides the Shelf document HTTP budget
(default 240000, maximum 300000).
`IOIO_IMPORT_HELPER_DOCUMENT_PROCESS_TIMEOUT_MS` overrides helper document
processing (default 210000, maximum 240000). Keep HTTP above processing to allow
the helper to return its error. No environment edits are required with defaults.
Restart both Shelf and the helper after deploying these changes.

Explicit inventories exceeding 20 rows or 12000 source characters are analyzed
sequentially in bounded batches of intact rows, with original page references,
headers and shared organization/room context. Unrecognized layouts use whole
pages as indivisible units to avoid cutting multiline rows. A single oversized
unrecognized page stays intact. Exact source evidence determines merge order;
source names, quantities and bin locations override model suggestions. Duplicate
model outputs do not create duplicate source rows. Different source rows remain
separate even for the same product/bin.

A failed chunk returns a section diagnostic and does not create/apply a proposal.
Completed chunks are retained in a bounded, in-memory retry cache for 15 minutes,
keyed by the full request including allowlists and document hash. Retry on the
same Shelf process reuses completed chunks and rebuilds the merged proposal.
Restarting Shelf or routing a retry to another worker loses that cache; it never
changes inventory or causes duplicate inventory writes. Existing explicit Apply
and import-ledger protections remain in place. No database changes are needed.

Regression coverage uses 48 A3-style rows across A3-1 through A3-6, plus small
and multiline inventories, simulated 100-second inference and subprocesses,
health limits, partial retry, duplicate outputs and UI timeout classification.
The main upstream-owned touchpoints are the existing IOIO helper service/client
and staff inventory import orchestration; future merges touching those paths
may need manual reconciliation.
