# IOIO Shelf task planning

Organize interprets nontrivial location language with `SHELF_TASK_PLAN`. Claude
returns semantic references and bounded capabilities; it receives at most 100
concise location names, paths and child summaries, without IDs or credentials.
The helper's existing child-process environment allowlist remains authoritative.

`ShelfTaskPlan` separates goal, sources, dependency steps, typed selections,
requested writes, proposal-only mutation policy and expected output. The
independent validator rejects unsupported capabilities, unknown fields, forward
or cyclic dependencies, incompatible sources and analysis/mutation mismatches.
References can nest `withinRef` or use prior RESOLVE_LOCATION steps. Shelf resolves
ancestors first against the current organization snapshot. Missing or ambiguous
references retain their local candidate sets; they never widen to other roots.

Implemented capabilities:

- RESOLVE_LOCATION
- SELECT_LOCATIONS (typed selection used by deletion)
- SELECT_MODELS (staff selection or explicit inventory scope)
- READ_LOCATION_TREE
- READ_INVENTORY_SUMMARY (asset-placement counts and quantities)
- PROPOSE_CREATE_LOCATION (including temporary-parent dependencies)
- PROPOSE_DELETE_LOCATIONS (container/drawer selection through section shelves)
- PROPOSE_LOCATION_CHANGE (inventory placement proposal with pressure constraint)

The existing deterministic create/bulk parsers remain optimizations. Their
proposal graphs are exposed as the same validated task representation. Helper
plans are validated and resolved, then adapted to the existing structure
proposal builder. Canonical create/delete services and explicit staff approval
remain the only write path. Plan generation performs no writes. Destructive
roles, scope, occupancy checks and Apply revalidation are retained.

Analysis reads canonical placement aggregates in bulk. Its displayed tree is
bounded to 100 locations and explicitly reports truncation. It does not pretend
to enumerate product names or generate item-placement recommendations.

Inventory placement is represented as an `INVENTORY_PLACEMENT` task with a
`SHELF_INVENTORY` source, a `SELECT_MODELS` step and a proposal-only
`PROPOSE_LOCATION_CHANGE` step. The staff inventory bulk action carries distinct
AssetModel IDs to `/staff/organize`; Shelf revalidates the full selection in the
current organization and rejects a partial match instead of silently dropping
products. Pronouns such as “these items” require an explicit staff selection.
The location snapshot ranks up to 15 destinations per model across the
organization, then sends a bounded union of at most 20 candidates per helper
batch. Ranking uses category affinity, representative concepts, empty/light use,
and a user-reported crowding penalty. The current location remains comparison
context and is not treated as the destination search boundary. Shelf validates
returned destination IDs against each product's supplied candidate set and
retains up to three alternatives. Confidence selects Recommended, Suggested, or
Possible presentation; it does not remove a valid alternative. Placement
proposals remain preview-only.

SHELF_LOCATIONS, SHELF_INVENTORY and uploaded PDF/CSV/XLSX sources are representable.
This executor rejects uploaded-file execution until an adapter connects supplied,
authorized upload references to the existing inventory-import parsers. It does
not accept filenames as executable paths or invent upload contents. The existing
PDF/CSV/XLSX import and bounded inventory recommendation workflows remain intact.
Future model/category resolution, comparisons, file matching, rename/move and
ensure-count task capabilities require registered schemas, source validation and
Shelf executors; they are rejected rather than guessed today.

Diagnostics contain task type, interpreter choice, capabilities, reference
counts, source types, proposal count and duration. They exclude instruction text,
file contents, credentials and inventory descriptions. Language-service tests use
mocked constrained responses; they prove deterministic validation/execution, not
that a live model always parses every paraphrase correctly.

## Explicit inventory grounding

Inventory placement plans retain `inventoryRefs` (names, optional contextual quantities and current-location references), `locationRefs`, and a separate optional `candidateDestinationScope`. Selection modes distinguish explicit names, staff-selected IDs, and scoped inventory queries. Named references take priority over old UI selections and inferred categories/locations.

Shelf resolves references against the organization-scoped canonical model-name index from the live snapshot. Whole canonical phrases use the same matcher regardless of sentence wording; longest spans avoid selecting Motor inside Motor Driver. The bounded Shelf task planner preserves unknown names and contextual hints. Resolution uses exact/case-insensitive, normalized and uniquely close spellings; duplicate or missing records remain reviewable references. No unrelated model is substituted. Only the resulting ID allowlist is queried for placement. Contextual quantities never override canonical quantities.

Current locations are resolved compositionally with the shared task reference resolver. They do not constrain destinations. Canonical values appear in placement rows, with a note when parsed context disagrees. Review shows requested/resolved/unresolved counts and explicit names, and accepts validated clarification choices without writes.

Unscoped unsupported requests and failed interpretations do not fall back to default inventory samples. Broad retrieval requires a requested scope. Logs retain counts and resolution statuses; explicit product names are omitted from the new grounding diagnostic event.
