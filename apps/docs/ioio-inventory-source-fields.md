# Explicit inventory source fields

The active `/staff/import` and legacy Home `analyze-file` actions share
`prepareStaffInventoryImport`. PDF extraction and OCR are unchanged. Detected
Mouser invoices retain their vendor parser. For simple inventory tables, the
source-field parser reads explicit bin/name/count columns and lab/room metadata;
the existing helper supplies semantic enrichment. Delimited tables and text
layers with one table cell per line are supported. No source PDF is rewritten.

## Previous failure modes

The generic mapper retained only RECEIVED/SHIPPED quantities. Estimates marked
UNKNOWN were turned into null, and the old table parser did not recognize the
estimated-quantity column as authoritative. The response had no separate lab,
room or source-bin fields; location handling ranked suggested canonical IDs
without requiring the source room/bin relationship. A room suggestion could
also take precedence over an explicit source location.

## Field mapping

| Source concept           | Helper response                        | Preview / stored proposal                           | Canonical Apply target                                                                       |
| ------------------------ | -------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Item identity            | `productName`                          | `title`, `sourceItemName`                           | `Asset.title`                                                                                |
| Explicit count           | `quantity`                             | `quantity`, `sourceQuantity`, `quantityIsEstimated` | Reviewed `Asset.quantity` for stock; unit count for individually tracked assets              |
| Lab / organization label | `organization`                         | `sourceOrganization`                                | Source provenance; actual `Asset.organizationId` always comes from authenticated staff scope |
| Room                     | `room`                                 | `sourceRoom`, resolved `roomLocationId`             | Existing ancestor `Location`; no separate Asset room column                                  |
| Storage/bin              | `location` (source code, not an ID)    | `sourceStorageLocation`, resolved `locationId`      | `AssetLocation.locationId`, through canonical `createAsset({ locationId })`                  |
| Description              | `description`, `assetModelDescription` | `sourceDescription`, `assetModelDescription`        | Existing stock-asset / individual-model description flow                                     |
| Category                 | `categorySuggestion.categoryId`        | Existing category review fields                     | Existing org-scoped category ID                                                              |

The CLI JSON schema explicitly requires separate nullable organization, room,
and location fields. The webapp accepts older helper responses that omit these
new fields so deployment can be staged; deterministic source normalization still
protects structured tables. No new credentials or AI integration are introduced.

## Precedence and review

Explicit source fields win over helper claims. Candidate evidence is joined to
a unique source row using its source page and bin code, with unique item-name
evidence as a fallback. Array order is never used. Ambiguous page-wide evidence
cannot move enrichment between rows. Missing helper rows are reconstructed from
the table; extra/unmatched helper rows cannot replace explicit table rows.

Source item names and counts survive exactly, including counts of 1000. An
estimated quantity remains numeric in preview with `quantityIsEstimated: true`
and `quantityStatus: UNKNOWN`, requiring staff confirmation. Approval submits
that number through the existing review contract and confirms it for Apply;
it is never implicitly changed to 1. Missing or invalid counts remain null.

A source bin resolves only to a unique existing location with that exact code
(bare or prefixed by Container/Bin) under the source room ancestor. Intermediate shelves are supported. A room is
never substituted for its missing bin, and a bin in another room is not a
match. Missing or duplicate bins stay unresolved and block Apply until the exact
source container can be resolved. The import does not create a parallel hierarchy or
automatically create locations.

Source lab, room, bin and original estimated count are retained in import
provenance when creating assets, including stock with an enriched description.
Authenticated organization scoping, review, ledger and stale-location checks
remain authoritative. Source labels never switch the active organization.

## Validation and existing data

Regressions cover all six A1 rows and five A2 rows from the IOIO examples,
incorrect helper counts/room/bin/identity, the response contract, PDF-to-preview
mapping, actual reviewed creation arguments, and the preview's form submission.
Missing/ambiguous bins and unknown quantities do not trigger guessing.
These tests use controlled helper/storage/database boundaries; they do not
constitute production deployment or live CLI-inference verification.

No database migration is required. Deploy/restart Shelf and the persistent
helper to load the new normalization and CLI schema/prompt. Re-upload old pending
proposals to regenerate explicit source fields. Previously imported wrong counts
or placements are not repaired automatically: audit them against their original
PDFs and correct them through existing Shelf quantity/placement workflows.
Likely merge conflicts are confined to the IOIO import/helper modules and panel.

## Changed files

- `apps/webapp/app/modules/ioio-staff/inventory-source.server.ts`
- `apps/webapp/app/modules/ioio-staff/inventory-source.server.test.ts`
- `apps/webapp/app/modules/ioio-staff/inventory-import.server.ts`
- `apps/webapp/app/modules/ioio-staff/inventory-import.server.test.ts`
- `apps/webapp/app/modules/ioio-staff/import-helper-contract.server.ts`
- `apps/webapp/app/modules/ioio-staff/import-helper-contract.server.test.ts`
- `apps/webapp/app/modules/ioio-staff/import-helper-service.server.ts`
- `apps/webapp/app/modules/ioio-staff/import-helper-service.server.test.ts`
- `apps/webapp/app/components/ioio-staff/staff-import-panel.tsx`
- `apps/webapp/app/components/ioio-staff/staff-import-panel.test.tsx`
- `apps/webapp/test/factories/ioio-inventory-source.ts`
- `apps/docs/ioio-inventory-source-fields.md`

## Pending review and canonical containers

Review completion is derived from the existing import ledger, not merely the
parent operation's status. Implemented rows require a DONE root and all physical
units DONE. Explicit removal resolves a candidate through its SKIPPED root while
preserving any physical-unit write evidence. Missing, PENDING, IN_FLIGHT, FAILED,
and CONFLICT rows keep the review open. Partial Apply persists PREPARED with no
completion timestamp while any row remains unresolved. Reloading a legacy
SUCCEEDED/PARTIAL session with unresolved rows reopens that staff-owned session
without changing ledger entries or replaying successful writes. Result-only
historical records without a proposal remain read-only.

The panel derives closure from applied/ignored/reverted row numbers and excludes
resolved rows from Pending review. Apply requires a ready, approved pending row,
an idle Apply request, no duplicate-file block, and an active session. It submits
current decisions directly; autosave completion and a stale client "applied"
state do not gate it. Autosave uses a description comparison to avoid replacing
a newer partial Apply result.

Source codes already accept one to three digits after the dash. The matching
bug was the canonical name: `Container A3-10` did not equal `A3-10`.
Resolution now accepts exact bare codes or exact `Container`/`Bin` role labels,
still requiring a unique match under the source room ancestor. It does not match
prefixes (`A3-1` versus `A3-10`) or substitute `Shelf A3`/`B477`.

For pending previews, `sourceStorageLocation` and `sourceRoom` resolve to
`locationId` (the exact container's Location.id) and `roomLocationId` (the room's
Location.id). Existing `Location.parentId` links preserve section and shelf
ancestry. Display labels, default review decisions, and Apply use that same
container ID. Legacy pending rows with null IDs are projected from their existing
organization location options without changing their immutable proposal/hash.
Apply rechecks current organization locations and rejects replacing an explicit
container with its room, shelf, another container, or an unassigned placement.
Missing containers display `Location A3-10 not found` and block creation.
`createAsset({ locationId })` continues to write through Shelf's canonical
AssetLocation services; no separate location model or database migration exists.

Tests cover A3-1, A3-9, A3-10, A3-11, A4-8 and A5-7 through parsing, PDF preview
and canonical creation arguments. A combined 45-row workflow applies 44 rows,
reloads the remaining Push buttons row, applies it at A3-10, and closes only once
all 45 rows are implemented. FAILED and CONFLICT ledger rows remain pending.
No migration or environment changes are required; restart Shelf to load the fix.
The existing IOIO import orchestration, readiness rules and review panel are the
likely conflict points for future upstream integrations.

## Reviewed approval through Apply

A checked, eligible row is represented as `reviewDecisions[rowNumber].decision`
with the literal value `APPROVE`. The form submits `intent=apply-import`,
`operationId`, `proposalHash`, and a `reviewDecisions` JSON array containing the
numeric `rowNumber`, that approval value, reviewed quantity/category/location
IDs, tracking and product choices. The action forwards this JSON unchanged;
the server parser accepts the same literal and selects `APPROVE` decisions.
The row number joins to proposal rows and ledger `row-${rowNumber}` within the
authenticated operation/organization. Helper candidate IDs and PDF source refs
are extraction evidence, not alternate approval keys.

The remaining mismatch was later in execution: a pending review row could be
Ready and APPROVE while its earlier ledger entry remained FAILED/CONFLICT.
Apply immediately continued past those terminal rejection entries without
claiming or executing the corrected row. This reproduced `succeededRows: 0`,
`remainingRows: 1`, despite a valid reviewed payload. The partial-result panel
also omitted the stored rejection reason.

After current values pass readiness and canonical validation, Apply can requeue
only known pre-write errors (location/category changes, a changed create target,
or ROW_REJECTED), with no written result, target IDs or physical-unit entries.
The existing ledger ID and idempotency keys remain stable. Requeue is conditional
on the previous status, code and timestamp while the parent Apply lease is held.
Successful/ignored rows are never reset. Uncertain writes, physical-unit plans
and inconsistent terminal rows require reconciliation and return explicit review
issues before a new Apply claim. These restrictions are exposed to the shared
readiness validator on reload, so blocked rows are not misleadingly Ready.

Reviewed quantity, category ID, exact source-container location ID, and product
choice determine execution. Canonical category names come from current validated
records, avoiding a late exact-label rejection after normalized validation.
Images are optional. Unsupported actions or missing actionable changes produce
row failures rather than being silently skipped. Selection logs record row
numbers, approval and exclusion reasons without source content or credentials.
Partial and complete results show the applied count; failures/conflicts list
product names and reasons. Corrected pre-write rejections can be retried without
replaying completed rows. Unknown write outcomes are never blindly retried.

The 45-row regression first implements 44 items, persists/reloads approval for
Push buttons, then retries a prior rejection at A3-10 with reviewed quantity 37,
Electronics and no image. It verifies one creation, one applied result, 45 final
implemented rows, zero pending and closed review. Separate tests exercise action
payload forwarding, restored checkbox state, creation failures and preservation
of written/physical-unit evidence. No migration or environment changes are
required; restart Shelf. Existing wrongly created records are not repaired by
this retry change.

## Remove from draft

Every pending row has Edit and Remove from draft actions, including duplicate,
failed and unresolved candidates. Removal uses the shared staff import engine's
`skip-row` action, independently of approval, quantity, images and canonical
readiness. It persists `reviewDraft.decision: IGNORE` and root ledger status
`SKIPPED`. Source proposal rows and hashes remain immutable. Pending excludes
those roots after reload; a persisted removed-row count explains the difference
between products found and Implemented rows.

Removal claims the staff-owned parent operation, changes only its candidate root
and review metadata, then recomputes completion from the ledger. Removing the last
pending row completes the parent; earlier implementations remain intact. The
action is idempotent and refuses to remove fully implemented rows. Active writes
must finish before removal. Failure releases the parent lease for retry.

No asset create, update, move or delete service is called. Existing assets,
recorded target IDs, written results, physical-unit entries and original rejection
reasons remain untouched. A SKIPPED candidate does not assert that an uncertain
past inventory write was undone or reconciled. The history/evidence is retained.

The exact-title guard previously compared current assets against only the
original preview's match candidates. A prior partial Apply could therefore make
its own new asset look like an external asset that appeared after review. Title
alone still cannot establish that a legacy uncertain write belongs to this row.
Completed same-row results are excluded from reapplication by the ledger.

For explicitly new quantity stock in different source bins, the guard now
recognizes a creation proven by a completed root in this same operation, in the
same source room, and still placed exclusively at that original source bin.
Such an item is not an unrelated duplicate of stock in the requested different
bin. The check reads current ledger evidence so earlier rows in the same Apply
are recognized as well as rows from a prior partial Apply. Same-bin, moved and unrelated assets retain the existing duplicate guard.
This exception never adopts or replays an uncertain same-row write by title.
Staff can remove an unwanted candidate instead of resolving that conflict.

Tests cover 44 implemented products plus one duplicate-blocked Push buttons row,
its removal, persisted IGNORE/SKIPPED state, closed review on reload, unchanged
assets/history, and preserved unit evidence. Staff and legacy Home route wiring,
UI editing/removal, failed ledger persistence and duplicate protection are covered.
No migration or environment change is required. Restart Shelf; the helper is
unchanged. Future integrations touching Home/staff import routes, the IOIO import
service or review panel may require manual reconciliation.

## Non-destructive inventory invariant

Import may create inventory, set reviewed positive quantities/categories, assign
locations to new records and manage its own ledger. It cannot delete/archive
Asset or AssetModel records, clear categories, zero stock, change tracking type,
or replace/remove existing placements. Existing location changes must use Shelf's
separate placement workflow: the canonical single-location updater deliberately
removes manual placements before replacing them, so import cannot call that mode.

`import-inventory-writes.server.ts` is the server write boundary. It exposes only
validated creation and an allowlisted existing-asset patch. Unsupported lifecycle,
placement and non-positive-quantity fields fail before reaching a canonical
mutation. Original Shelf create/update services retain their own row locking,
placement constraints and transactions. Per-row ledger/reconciliation remains
necessary for interrupted requests; a whole batch is not wrapped around nested
canonical service transactions. Failed rows do not roll back or delete earlier
successful inventory. No cleanup deletes are used as compensation.

The former implemented-row Revert flow violated this invariant. It could call
canonical `deleteAsset` for created stock/units, restore an earlier quantity
(including zero), or replace old placements. Native deleteAsset hard-deletes the
Asset and its cascading relations and records ASSET_DELETED transactionally.
The import implementation first appeared with commit `0edee7f3c`. This code path
is a confirmed capability; attributing a particular missing record to it still
requires live ActivityEvent and import `revertHistory` evidence.

Implemented history is now read-only. Legacy HTTP revert intents are rejected,
and the direct server revert entrypoint is fail-closed too. Historical revert
metadata remains readable for investigation; no recovery evidence is erased.
Remove from draft and Cancel remain import-metadata-only operations. Duplicate
and stale-write handling records conflicts or verified idempotent results and
never deletes/replaces an existing inventory record to resolve a title match.
Preview-image expiry affects temporary Image records only, not Asset/AssetModel
records or their placements. There is no completed-session inventory cleanup.

Canonical write logs contain importSessionId, candidateId, operationType and
asset/model IDs. Model resolution/enrichment carries the same scope. No import
canonical write is a DELETE operation. Audit data excludes credentials and raw
source document payloads.

Regression coverage includes the eleven A1/A2 source bins with existing IDs,
model links, counts and placements. A3 and A4 imports, final-row removal, Cancel,
duplicate/stale protection and retired reversal leave that existing inventory
intact. Boundary tests exercise forged delete/archive/location/zero-quantity
requests directly on the server, rather than relying on disabled controls.

No migration is required. Deploy/restart Shelf to activate these protections;
local changes alone do not secure a still-running older server. Recovery is a
separate evidence-led operation: capture the before state, distinguish archive,
visibility, placement and hard deletion, use canonical restore services for
surviving records, and reconstruct only verified hard deletions. Never reset,
seed or purge the database as part of recovery. Source quantities are evidence,
not authorization to duplicate records that have not been proven missing.
