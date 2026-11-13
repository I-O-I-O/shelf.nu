# Inventory description repair

The importer formerly appended `buildImportedDescription` to stock descriptions
and used it as each individual unit's description. This included the filename,
lab, room, bin, raw description and manufacturer, truncated at 2,000 characters.
New asset and model writes use bounded product text (two sentences maximum),
reject known provenance markers and name-only descriptions, or leave it blank.
No product facts are invented by the server. Restart Shelf and the helper to
load the updated prompts and write policy.

Traceability remains in `IoioWriteOperation.description.proposal`: source filename,
raw source fields and row evidence. `IoioImportItem` retains operation/row/unit
and asset identities. The staff import review details remain the dedicated source
surface. Neither ordinary staff nor student descriptions need this evidence.
Both detail routes pass `asset.description` into their UI; list/search data uses
the same canonical records. No display-only stripping hides stored garbage.

## Existing A1–A5 records

No database has been inspected or changed as part of this code change. Identify
the intended environment and organization before running anything. The supplied
script deliberately allows only a local development database. Never point it at
production; a remote repair requires a separately reviewed environment-specific
execution path.

First inspect recent `INVENTORY_IMPORT` operations for the organization, their
created dates and `proposal.source.filename`, and select the exact A1–A5 import
IDs. From `apps/webapp`, preview with:

```sh
pnpm exec dotenv -e ../../.env -- tsx scripts/repair-import-descriptions.ts ORGANIZATION_ID OPERATION_ID_1 OPERATION_ID_2
```

The script follows DONE creation ledger entries only, checks organization and
A1–A5 filenames, and reconstructs the historical generator's output, including
its truncation and enriched prefix. It prints asset IDs, before and after text.
Only exact matches qualify. Manual text, appended edits, changed source values,
missing proposals and unmatched legacy records are skipped for human review.
Review these skipped records as well: a zero-change preview is not proof that
all descriptions are clean. In particular, reviewed description overrides may
differ from the stored original proposal and will be skipped safely.

Retain the preview securely as a repair record. Add `--apply` to the same command
only after reviewing it. Writes compare both description and timestamp, so a
concurrent edit is preserved. Source operations and ledger entries are never
modified. Re-running after repair is harmless. Review descriptions in staff and
student detail/list views after applying; this code change alone does not repair
existing persisted records.

No schema change or migration is required. Likely merge conflicts are in IOIO
inventory orchestration/helper files; the shared detail-layout test is also
modified. Shelf's core asset routes and database architecture are unchanged.

## Mac local fixture preview

A database-free preview is available from `apps/webapp`:

```sh
node --import tsx scripts/preview-import-descriptions.ts
```

This uses synthetic A1–A5 fixtures, loads no environment or database client, and
makes no HTTP requests. No local or remote inventory records are changed. The
Mac `.env` source and local Supabase are not required for this preview.

| Synthetic record        | Before (product text plus generated provenance)                                                          | After                                                                                 |
| ----------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `fixture-a1`            | Imported from A1 PDF; source lab/room/bin; “Assorted wires.”                                             | Blank                                                                                 |
| `fixture-a2`            | Imported from A2 PDF; source lab/room/bin; breadboard description                                        | Solderless breadboards for building temporary electronics circuits without soldering. |
| `fixture-a3`            | Joystick description; imported from A3 PDF; source lab/room/bin; repeated name; “Manufacturer: TinkerKi” | TinkerKit joystick module for directional input in Arduino and electronics projects.  |
| `fixture-a4`            | Imported from A4 PDF; source lab/room/bin; multimeter description                                        | Multimeter for measuring voltage, current and resistance in electronics circuits.     |
| `fixture-a5`            | Imported from A5 PDF; nested “Source description”; malformed manufacturer fragment                       | Blank                                                                                 |
| `fixture-manual`        | Manually written joystick instructions                                                                   | Preserved exactly                                                                     |
| `fixture-manual-append` | Generated description followed by a staff note                                                           | Preserved for manual review                                                           |

The command prints full before/after strings for every fixture. The five synthetic
A1–A5 records qualify; the two manually edited examples do not. These are not live
asset IDs, and this preview makes no claim about which real A1–A5 records exist.
Regression tests exercise the same cases and canonical import creation arguments,
source-field retention, helper prompts and student detail rendering. No migrations,
seeds, destructive cleanup or deployment are needed or performed.

## Changed files

- `apps/webapp/app/modules/ioio-staff/import-description.ts`
- `apps/webapp/app/modules/ioio-staff/import-description.test.ts`
- `apps/webapp/app/modules/ioio-staff/inventory-import.server.ts`
- `apps/webapp/app/modules/ioio-staff/inventory-import.server.test.ts`
- `apps/webapp/app/modules/ioio-staff/import-helper-service.server.ts`
- `apps/webapp/app/components/ioio-staff/ioio-asset-detail-layout.test.tsx`
- `apps/webapp/test/factories/ioio-import-descriptions.ts`
- `apps/webapp/scripts/preview-import-descriptions.ts`
- `apps/webapp/scripts/repair-import-descriptions.ts`
- `apps/docs/ioio-import-description-repair.md`
