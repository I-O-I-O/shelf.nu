export const RETURN_HANDLING = {
  STORAGE: "RETURN_TO_STORAGE",
  RETURN_ZONE: "RETURN_TO_RETURN_ZONE",
} as const;

export type ReturnHandling =
  (typeof RETURN_HANDLING)[keyof typeof RETURN_HANDLING];

export type ReturnDestination = "STORAGE" | "RETURN_ZONE" | "BROKEN_ZONE";

export function resolveReturnDestination({
  hasProblem,
  returnHandling,
}: {
  hasProblem: boolean;
  returnHandling: ReturnHandling;
}): ReturnDestination {
  if (hasProblem) return "BROKEN_ZONE";
  return returnHandling === RETURN_HANDLING.RETURN_ZONE
    ? "RETURN_ZONE"
    : "STORAGE";
}

export function requiresStaffReturnCheck({
  hasProblem,
  returnHandling,
}: {
  hasProblem: boolean;
  returnHandling: ReturnHandling;
}) {
  return hasProblem || returnHandling === RETURN_HANDLING.RETURN_ZONE;
}
