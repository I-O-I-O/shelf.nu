# Inventory import review boundary

## Confirmed regression paths

`prepareStaffInventoryImport` used the file/org/user idempotency key to retrieve
a prior operation. For `SUCCEEDED` or `PARTIAL`, it returned that operation's
stored result rather than a review proposal. Both `/staff/import` and legacy
Home `analyze-file` actions converted this to `kind: import-result`.
`StaffImportPanel` displayed “Import finished. Created 1…” from that historical
result, with no proposal/Pending review rows. This applied to any document size.

Tracing the checked-out code found no canonical Asset/AssetModel write during
preparation. The cached-result path explains the reported completion message;
it does not demonstrate that a new asset was created by that upload. No live
operation or production database was accessed to infer otherwise.

Separately, Apply used `applyOnlyRowNumber`/`applyOnlyRowNumbers` to silently change
non-ignored decisions (including null) to APPROVE. That bypassed explicit row
approval for scoped Apply requests, though upload did not invoke this path.
The coercion is removed: all Apply variants require submitted approved decisions.
Single-row and multi-row documents use the same review contract.

## Current workflow

PDF upload → extraction → deterministic parsing → helper enrichment → PREPARED
proposal/session and pending ledger rows → editable Pending review → explicit
approval and Apply → canonical inventory writes → successful rows Implemented.

Preparation's return type is now proposal-only. Re-upload after a completed or
historical PARTIAL session creates a new review session; old history/ledger rows
are untouched. An active PREPARED draft can still be resumed. Existing duplicate
checks continue to block re-applying completed inventory unless staff explicitly
reviews and overrides an allowed same-file reimport. Upload never overrides it.

Draft edits/autosave can change proposal metadata and decisions only. No canonical
quantity, category, location, model or asset write happens before Apply. Review
keeps the existing product, quantity, category, location and image controls;
borrowability is not introduced by this fix. Unapproved rows stay pending after
partial Apply. Analysis failure cannot create inventory. No special one-row
shortcut exists. A stale completion message is hidden while a new upload runs.

## Enforced write phases

`import-phase.server.ts` uses request-local AsyncLocalStorage, isolated across
concurrent async tasks. The exported preparation, draft-save and Apply services
enter PREPARE, REVIEW and APPLY respectively. PREPARE/REVIEW cannot enter APPLY.
Import-only canonical asset creation/update and AssetModel resolution fail closed
outside APPLY. The existing operation allowlist also guards model enrichment.
Shelf's ordinary non-import services and APIs are unchanged. This is an internal
write invariant; staff permission, submitted approval, proposal hash, organization
scoping, ledger claims, duplicate detection and existing resume rules remain
required independently.

No migration, seed, reset or environment-variable changes are required. Restart
or deploy the webapp through the normal reviewed workflow to load this server
code; the helper has no changed contract or restart requirement. Nothing was
deployed or applied to real inventory for this change. The service/UI/route
regressions use controlled database, HTTP and storage boundaries.

## Validation and files

Eight focused suites passed 356 tests, covering 1/2/20-item PDF/helper preparation,
UI upload → Pending review → edit → approved Apply → Implemented, remaining
unapproved rows, failed analysis, cached completion replay, standalone canonical
writers and async phase isolation. Existing draft-save tests cover quantity,
category and location edits without inventory writes. Existing importer tests
exercise canonical Apply and ledger persistence rather than only mocked UI
responses. ESLint, Prettier and `git diff --check` are run on the changes.

- `apps/webapp/app/modules/ioio-staff/import-phase.server.ts`
- `apps/webapp/app/modules/ioio-staff/import-phase.server.test.ts`
- `apps/webapp/app/modules/ioio-staff/inventory-import.server.ts`
- `apps/webapp/app/modules/ioio-staff/inventory-import.server.test.ts`
- `apps/webapp/app/modules/ioio-staff/import-inventory-writes.server.ts`
- `apps/webapp/app/modules/ioio-staff/import-inventory-writes.server.test.ts`
- `apps/webapp/app/modules/ioio-staff/import-asset-model.server.ts`
- `apps/webapp/app/modules/ioio-staff/import-asset-model.server.test.ts`
- `apps/webapp/app/components/ioio-staff/staff-import-panel.tsx`
- `apps/webapp/app/components/ioio-staff/staff-import-panel.test.tsx`
- `apps/webapp/app/routes/_layout+/staff.import.tsx`
- `apps/webapp/app/routes/_layout+/home.tsx`
- `apps/webapp/test/routes-tests/_layout+/staff.import.test.ts`
- `apps/webapp/test/routes-tests/_layout+/home.test.ts`
- `apps/docs/ioio-import-review-gate.md`
- `apps/docs/ioio-spreadsheet-import.md`

Likely upstream conflicts are in the IOIO import orchestration, panel and route
handlers, particularly Home. No schema or core Shelf asset service was changed.

## Persistence reporting and local audit

The old displayed Created count was the length of the stored result.createdIds
array, not proof of a write by the current upload. Upload no longer renders that
legacy result. Apply summaries require matching operation IDs and a verified
result. Verification checks organization-scoped canonical Asset existence and
DONE ledger writtenState for every claimed created/updated/reused Asset. Counts
are derived from persisted DONE ledger rows; the result is returned only after
operation persistence succeeds. Failed canonical writes record zero committed
writes. Persistence errors surface as errors, without invented success counts.

Structured diagnostics include operation ID, analysis candidates, persisted
draft/ledger rows, attempted/committed canonical writes, history rows and final
state. No credentials are logged. Completed history is no longer hidden by the
24-hour draft expiry filter; expired reviews remain read-only.

A read-only audit of the loopback local database found 30 import operations and
zero matching IOIO_Lab_B477_Section_A_Blue_Organisers_Claude_Import.pdf. Therefore
no local persisted result can be attributed to that filename. The newest local
operation (41e0fc29-af0d-484d-b72e-e673e986abc8) belongs to a different PDF:
20 proposal/ledger rows and one DONE row with an existing canonical Asset.
The already-open failing browser tab was remote, not localhost. Its database was
not inspected or modified and nothing was deployed. Its exact write outcome
remains unverified under the local-only restriction.

Local Firefox confirmed quantity-tracked.pdf history shows Implemented (1) after
reload. Uploading the supplied PDF was not verified: the native picker left Open
disabled. Regression tests exercise analysis persistence, failures, rollback,
reload/history and stale results through controlled database/HTTP boundaries.
Additional files: import-persistence.server.ts and its co-located test.
