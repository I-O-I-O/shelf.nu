export const ACCESS_APPROVAL_RENEWAL_MODE = {
  ACADEMIC_YEAR: "ACADEMIC_YEAR",
  TWELVE_MONTHS: "TWELVE_MONTHS",
  SIX_MONTHS: "SIX_MONTHS",
  CUSTOM: "CUSTOM",
} as const;

export function getAnnualAccessNoticeEventKey({
  status,
  approvalId,
  eventAt,
}: {
  status: "APPROVED" | "REVOKED";
  approvalId: string;
  eventAt: Date | string | null | undefined;
}) {
  const timestamp =
    eventAt instanceof Date ? eventAt.toISOString() : eventAt || "legacy";
  return `${status}:${approvalId}:${timestamp}`;
}

export function formatApprovalDate(date: Date) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}
