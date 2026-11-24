import { AsyncLocalStorage } from "node:async_hooks";
import { ShelfError } from "~/utils/error";

type ImportPhase = "PREPARE" | "REVIEW" | "APPLY";
type PersistenceDiagnostics = {
  phase: ImportPhase;
  operationId: string | null;
  analysisCandidateCount: number;
  draftRowsPersisted: number;
  canonicalWritesAttempted: number;
  canonicalWritesCommitted: number;
  historyRowsPersisted: number;
  finalOperationState: string;
};
const phase = new AsyncLocalStorage<PersistenceDiagnostics>();
export function getImportPersistenceDiagnostics() {
  return { ...phase.getStore() };
}
export function setImportPersistenceDiagnostics(
  values: Partial<PersistenceDiagnostics>
) {
  const current = phase.getStore();
  if (current) Object.assign(current, values);
}
export function recordImportWriteAttempt() {
  const current = phase.getStore();
  if (current) current.canonicalWritesAttempted += 1;
}
export function recordImportWriteCommit() {
  const current = phase.getStore();
  if (current) current.canonicalWritesCommitted += 1;
}
export const IMPORT_REVIEW_REQUIRED =
  "Inventory changes require explicit Apply of approved import rows.";

function reject(): never {
  throw new ShelfError({
    cause: null,
    message: IMPORT_REVIEW_REQUIRED,
    label: "Assets",
    status: 403,
    shouldBeCaptured: false,
  });
}

/** Preparation/review cannot escalate into Apply, including through async helpers. */
export function withImportPhase<T>(next: ImportPhase, work: () => T): T {
  const current = phase.getStore()?.phase;
  if (next === "APPLY" && (current === "PREPARE" || current === "REVIEW"))
    reject();
  return phase.run(
    {
      phase: next,
      operationId: null,
      analysisCandidateCount: 0,
      draftRowsPersisted: 0,
      canonicalWritesAttempted: 0,
      canonicalWritesCommitted: 0,
      historyRowsPersisted: 0,
      finalOperationState: "UNKNOWN",
    },
    work
  );
}

/** Import-only canonical writers fail closed outside the Apply service. */
export function assertImportApplyPhase() {
  if (phase.getStore()?.phase !== "APPLY") reject();
}
