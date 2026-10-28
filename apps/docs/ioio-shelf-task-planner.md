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
- READ_LOCATION_TREE
- READ_INVENTORY_SUMMARY (asset-placement counts and quantities)
- PROPOSE_CREATE_LOCATION (including temporary-parent dependencies)
- PROPOSE_DELETE_LOCATIONS (container/drawer selection through section shelves)

The existing deterministic create/bulk parsers remain optimizations. Their
proposal graphs are exposed as the same validated task representation. Helper
plans are validated and resolved, then adapted to the existing structure
proposal builder. Canonical create/delete services and explicit staff approval
remain the only write path. Plan generation performs no writes. Destructive
roles, scope, occupancy checks and Apply revalidation are retained.

Analysis reads canonical placement aggregates in bulk. Its displayed tree is
bounded to 100 locations and explicitly reports truncation. It does not pretend
to enumerate product names or generate item-placement recommendations.

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
