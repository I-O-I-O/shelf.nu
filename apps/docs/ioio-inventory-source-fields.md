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

A source bin resolves only to a unique existing location with that exact name
under the source room ancestor. Intermediate shelves are supported. A room is
never substituted for its missing bin, and a bin in another room is not a
match. Missing or duplicate bins stay unresolved and block Apply until staff
chooses a valid location. The import does not create a parallel hierarchy or
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
