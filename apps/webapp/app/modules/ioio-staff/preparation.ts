import { DAY_NAMES } from "~/modules/working-hours/constants";
import type { WorkingHoursData } from "~/modules/working-hours/types";

export const IOIO_OPENING_HOURS_GUIDANCE =
  "Most browsing, borrowing, pickups, and returns should happen during opening hours. TAs are normally available to help during these hours. If something is urgent, you can try to get help outside these hours, but a TA may not be available.";

export const PREPARATION_PICKUP_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
export const PREPARATION_PICKUP_EXPIRED_COMMENT =
  "Pickup expired after 7 days.";

export function getPreparationCancellationLabel(
  reviewComment: string | null | undefined
) {
  return reviewComment?.startsWith(PREPARATION_PICKUP_EXPIRED_COMMENT)
    ? "Pickup expired"
    : "Cancelled";
}

export function getPreparationPickupDeadline(readyAt: Date) {
  return new Date(readyAt.getTime() + PREPARATION_PICKUP_EXPIRY_MS);
}

/**
 * Find the next configured opening date after a borrowing request is
 * confirmed. Preparation timing follows the organization's opening schedule,
 * rather than promising an arbitrary number of days.
 */
export function getPreparationTargetDate(
  confirmedAt: Date,
  workingHours?: { enabled: boolean; weeklySchedule: unknown }
) {
  if (!workingHours?.enabled) return null;

  const schedule = workingHours.weeklySchedule as
    | WorkingHoursData["weeklySchedule"]
    | null;
  if (!schedule) return null;
  const target = new Date(confirmedAt);
  target.setUTCHours(0, 0, 0, 0);

  // Start tomorrow: a request made during today's hours is still prepared in
  // a future opening session, and date-only output stays timezone-stable.
  for (let offset = 1; offset <= 14; offset++) {
    const candidate = new Date(target);
    candidate.setUTCDate(target.getUTCDate() + offset);
    const day = schedule[String(candidate.getUTCDay())];
    if (day?.isOpen && day.openTime && day.closeTime) return candidate;
  }

  return null;
}

export function formatPickupHours(workingHours: {
  enabled: boolean;
  weeklySchedule: unknown;
}) {
  if (!workingHours.enabled) return "See the IOIO Lab opening hours.";
  const weeklySchedule =
    (workingHours.weeklySchedule as
      | WorkingHoursData["weeklySchedule"]
      | null) ?? {};
  const entries = Object.entries(weeklySchedule)
    .filter(([, value]) => value?.isOpen && value.openTime && value.closeTime)
    .map(([dayNumber, value]) => {
      const dayName = DAY_NAMES[Number(dayNumber) as keyof typeof DAY_NAMES];
      return `${dayName ?? "Opening day"} ${value.openTime} - ${
        value.closeTime
      }`;
    });
  return entries.length
    ? entries.join(", ")
    : "See the IOIO Lab opening hours.";
}
