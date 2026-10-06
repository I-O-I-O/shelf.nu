const OPERATIONS_VIEWS = new Set([
  "all",
  "overdue",
  "returns",
  "returned-with-issues",
  "broken",
  "to-prepare",
  "cancelled-pickups",
  "ready-for-pickup",
  "access-approvals",
]);

export function buildOperationsReturnTo(view: string | null) {
  return view && OPERATIONS_VIEWS.has(view)
    ? `/operations?view=${encodeURIComponent(view)}`
    : "/operations";
}

export function getSafeReturnTo(value: FormDataEntryValue | string | null) {
  if (typeof value !== "string" || !value.startsWith("/")) {
    return "/operations";
  }

  try {
    const url = new URL(value, "http://ioio.local");
    if (url.origin !== "http://ioio.local" || url.hash) {
      return "/operations";
    }
    if (url.pathname === "/bookings" && !url.search) {
      return "/bookings";
    }
    if (url.pathname === "/operations") {
      const entries = [...url.searchParams.entries()];
      if (
        entries.length === 0 ||
        (entries.length === 1 &&
          entries[0][0] === "view" &&
          OPERATIONS_VIEWS.has(entries[0][1]))
      ) {
        return url.searchParams.has("view")
          ? `/operations?view=${encodeURIComponent(
              url.searchParams.get("view")!
            )}`
          : "/operations";
      }
    }
  } catch {
    // Invalid URL values fall through to the safe Staff landing page.
  }

  return "/operations";
}

export function withReturnTo(path: string, returnTo: string) {
  return `${path}${path.includes("?") ? "&" : "?"}returnTo=${encodeURIComponent(
    getSafeReturnTo(returnTo)
  )}`;
}
