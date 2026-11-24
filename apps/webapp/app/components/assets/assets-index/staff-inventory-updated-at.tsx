import { formatDate } from "~/utils/date-format";
import type { ResolvedFormatPrefs } from "~/utils/date-format";

export const STAFF_INVENTORY_UPDATED_AT_HEADING = "Last updated";

function formatStaffInventoryDate(
  value: Date | string,
  prefs: ResolvedFormatPrefs
) {
  return formatDate(
    value,
    { ...prefs, dateFormat: "DD_MM_YYYY" },
    { day: "2-digit", month: "2-digit", year: "numeric" }
  ).replaceAll("/", ".");
}

export function StaffInventoryUpdatedAt({
  value,
  prefs,
}: {
  value: Date | string;
  prefs: ResolvedFormatPrefs;
}) {
  return (
    <time dateTime={new Date(value).toISOString()}>
      {formatStaffInventoryDate(value, prefs)}
    </time>
  );
}
