import { access, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Location } from "@prisma/client";
import { db } from "~/database/db.server";
import type {
  ReviewCandidate,
  ReviewDecision,
  ReviewLocation,
  ReviewRecord,
  ReviewState,
  ReviewDiagnostics,
} from "./review";

const reviewColumns = [
  "candidate_id",
  "human_decision",
  "final_name",
  "final_tracking_type",
  "final_quantity",
  "final_category",
  "final_location_id",
  "final_location_name",
  "kit_decision",
  "human_note",
  "reviewed_at",
  "special_handling",
];

const approvedColumns = [
  "candidate_id",
  "approved_display_name",
  "approved_category",
  "approved_tracking_type",
  "approved_quantity",
  "approved_location",
  "approved_kit_status",
  "human_decision",
  "approval_notes",
];
const milestone8ReviewColumns = [
  ...reviewColumns.slice(0, 8),
  "final_consumption_type",
  ...reviewColumns.slice(8),
];
const milestone8ApprovedColumns = [
  ...approvedColumns.slice(0, 6),
  "approved_consumption_type",
  ...approvedColumns.slice(6),
];

function parseCsvLine(line: string) {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      cells.push(cell);
      cell = "";
    } else {
      cell += character;
    }
  }
  cells.push(cell);
  return cells;
}

function parseCsv(contents: string): Record<string, string>[] {
  const lines = contents
    .replace(/^\uFEFF/, "")
    .trimEnd()
    .split(/\r?\n/);
  if (!lines.length || !lines[0]) return [];
  const headers = parseCsvLine(lines[0]);
  return lines
    .slice(1)
    .filter(Boolean)
    .map((line) => {
      const values = parseCsvLine(line);
      return Object.fromEntries(
        headers.map((header, index) => [header, values[index] ?? ""])
      );
    });
}

function csvEscape(value: unknown) {
  const string = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(string) ? `"${string.replaceAll('"', '""')}"` : string;
}

function toCsv(rows: Record<string, unknown>[], columns: string[]) {
  return (
    [
      columns.join(","),
      ...rows.map((row) =>
        columns.map((column) => csvEscape(row[column])).join(",")
      ),
    ].join("\n") + "\n"
  );
}

function normalize(value: string | null | undefined) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

async function findProjectRoot(milestone = 6) {
  const moduleProjectRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../../"
  );
  const candidates = [
    process.cwd(),
    path.resolve(process.cwd(), "../.."),
    path.resolve(process.cwd(), "../../.."),
    moduleProjectRoot,
  ];
  const uniqueCandidates = [...new Set(candidates)];
  for (const candidate of uniqueCandidates) {
    try {
      await access(
        path.join(
          candidate,
          `analysis/milestone-${milestone}/M${milestone}-import-plan.csv`
        )
      );
      return candidate;
    } catch {
      // Try the next local monorepo-root candidate.
    }
  }
  // Keep the running app diagnostic useful even when the expected file is
  // missing; the review page can then show the exact path it attempted.
  return uniqueCandidates[0];
}

function buildLocationPath(
  location: Pick<Location, "id" | "name" | "parentId">,
  byId: Map<string, Pick<Location, "id" | "name" | "parentId">>,
  visiting = new Set<string>()
): string {
  if (!location.parentId || visiting.has(location.id)) return location.name;
  const parent = byId.get(location.parentId);
  if (!parent) return location.name;
  visiting.add(location.id);
  return `${buildLocationPath(parent, byId, visiting)} → ${location.name}`;
}

function decisionRowsFromCsv(rows: Record<string, string>[]): ReviewRecord[] {
  return rows.map((row) => ({
    candidate_id: row.candidate_id,
    human_decision: row.human_decision as ReviewDecision,
    final_name: row.final_name,
    final_tracking_type: row.final_tracking_type,
    final_quantity: row.final_quantity,
    final_category: row.final_category,
    final_location_id: row.final_location_id,
    final_location_name: row.final_location_name,
    kit_decision: row.kit_decision,
    final_consumption_type: row.final_consumption_type ?? "",
    human_note: row.human_note,
    reviewed_at: row.reviewed_at,
    special_handling: row.special_handling,
  }));
}

export async function getReviewState(
  organizationId: string,
  milestone = 6
): Promise<ReviewState> {
  const root = await findProjectRoot(milestone);
  const planPath = path.join(
    root,
    `analysis/milestone-${milestone}/M${milestone}-import-plan.csv`
  );
  const reviewPath = path.join(
    root,
    `analysis/milestone-${milestone}/M${milestone}-human-review.csv`
  );
  const [planText, masterText, historyText, decisionsText, locations] =
    await Promise.all([
      readFile(planPath, "utf8").catch(() => ""),
      readFile(
        path.join(root, "analysis/milestone-4/M4-review-master.csv"),
        "utf8"
      ),
      readFile(
        path.join(root, "analysis/milestone-5/M5-sanitized-history.csv"),
        "utf8"
      ),
      readFile(reviewPath, "utf8").catch(() => ""),
      db.location.findMany({
        where: { organizationId },
        select: { id: true, name: true, parentId: true },
        orderBy: { name: "asc" },
      }),
    ]);

  const planRows = parseCsv(planText);
  const planExists = Boolean(planText);
  const diagnostics: ReviewDiagnostics = {
    processCwd: process.cwd(),
    projectRoot: root,
    planPath,
    planExists,
    planBytes: Buffer.byteLength(planText, "utf8"),
    parsedRows: planRows.length,
    status: !planExists ? "MISSING" : planRows.length === 0 ? "EMPTY" : "OK",
    message: !planExists
      ? `M${milestone}-import-plan.csv was not found at the resolved path.`
      : planRows.length === 0
      ? `M${milestone}-import-plan.csv was found but parsed to zero candidate rows.`
      : `Loaded ${planRows.length} candidate rows from M${milestone}-import-plan.csv.`,
  };
  const masterById = new Map(
    parseCsv(masterText).map((row) => [row.candidate_id, row])
  );
  const notesByItem = new Map<string, string[]>();
  for (const row of parseCsv(historyText)) {
    const note = row.sanitized_inventory_note?.trim();
    if (!note) continue;
    const key = normalize(row.item_reference);
    const notes = notesByItem.get(key) ?? [];
    if (!notes.includes(note)) notes.push(note);
    notesByItem.set(key, notes);
  }

  const locationById = new Map(
    locations.map((location) => [location.id, location])
  );
  const reviewLocations = locations.map((location) => ({
    ...location,
    path: buildLocationPath(location, locationById),
  }));

  return {
    candidates: planRows.map((row) => {
      const master = masterById.get(row.candidate_id) ?? {};
      const notes = notesByItem.get(normalize(row.source_item_name)) ?? [];
      return {
        candidateId: row.candidate_id,
        sourceSheet: row.source_sheet,
        sourceRow: row.source_row,
        sourceItemName: row.source_item_name,
        originalQuantity: master.quantity_raw || "—",
        originalCategory: master.source_category || "—",
        suggestedCategory: row.proposed_category || "—",
        originalLocationText: master.source_location_text || "—",
        duplicateClassification: row.duplicate_classification || "DISTINCT",
        kitClassification:
          master.kit_candidate === "YES" ? "KIT CANDIDATE" : "NOT A KIT",
        proposedTrackingType: row.proposed_tracking_type,
        proposedQuantity: row.proposed_quantity,
        sourceClassification: row.source_classification || "UNCLASSIFIED",
        proposedConsumptionType:
          row.proposed_consumption_type || "PENDING_HUMAN_REVIEW",
        proposedLocation: row.proposed_location,
        sourceNote: notes.slice(0, 3).join(" | "),
      };
    }),
    locations: reviewLocations,
    decisions: decisionsText
      ? decisionRowsFromCsv(parseCsv(decisionsText)).filter((row) =>
          ["APPROVE", "REJECT", "NEEDS_MORE_INFO"].includes(row.human_decision)
        )
      : [],
    diagnostics,
  };
}

export async function saveReviewDecision({
  record,
  milestone = 6,
}: {
  record: ReviewRecord;
  milestone?: number;
}) {
  const root = await findProjectRoot(milestone);
  const reviewPath = path.join(
    root,
    `analysis/milestone-${milestone}/M${milestone}-human-review.csv`
  );
  const approvedPath = path.join(
    root,
    milestone === 8
      ? "analysis/milestone-8/M8-approved-pilot.csv"
      : "analysis/milestone-4/M4-approved-pilot.csv"
  );
  const existingText = await readFile(reviewPath, "utf8").catch(() => "");
  const existing = existingText
    ? decisionRowsFromCsv(parseCsv(existingText))
    : [];
  const next = [
    ...existing.filter((row) => row.candidate_id !== record.candidate_id),
    record,
  ].sort((left, right) => left.candidate_id.localeCompare(right.candidate_id));

  const planText = await readFile(
    path.join(
      root,
      `analysis/milestone-${milestone}/M${milestone}-import-plan.csv`
    ),
    "utf8"
  );
  const planById = new Map(
    parseCsv(planText).map((row) => [row.candidate_id, row])
  );
  const approvedRows = next
    .filter((row) => row.human_decision === "APPROVE")
    .map((row) => ({
      candidate_id: row.candidate_id,
      approved_display_name: row.final_name,
      approved_category: row.final_category,
      approved_tracking_type: row.final_tracking_type,
      approved_quantity: row.final_quantity,
      approved_location: row.final_location_id || "UNASSIGNED",
      ...(milestone === 8
        ? { approved_consumption_type: row.final_consumption_type }
        : {}),
      approved_kit_status: row.kit_decision,
      human_decision: row.human_decision,
      approval_notes: [
        planById.get(row.candidate_id)?.source_item_name,
        row.final_location_name
          ? `location_name=${row.final_location_name}`
          : "",
        row.special_handling ? `special_handling=${row.special_handling}` : "",
        row.human_note,
      ]
        .filter(Boolean)
        .join("; "),
    }));

  await writeAtomically(
    reviewPath,
    toCsv(next, milestone === 8 ? milestone8ReviewColumns : reviewColumns)
  );
  await writeAtomically(
    approvedPath,
    toCsv(
      approvedRows,
      milestone === 8 ? milestone8ApprovedColumns : approvedColumns
    )
  );
}

async function writeAtomically(targetPath: string, contents: string) {
  const temporaryPath = `${targetPath}.tmp`;
  await writeFile(temporaryPath, contents, "utf8");
  await rename(temporaryPath, targetPath);
}
