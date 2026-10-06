export type IoioAccountSurface = "staff" | "student";

const staffRoutePrefixes = [
  "/assets",
  "/categories",
  "/locations",
  "/bookings",
  "/reports",
  "/settings",
  "/users",
  "/staff",
  "/home",
  "/operations",
  "/purchasing",
  "/ta-hours",
  "/calendar",
  "/labels",
  "/kits",
  "/audits",
  "/admin-dashboard",
];

export function resolveIoioAccountSurface(
  roles: readonly string[] | null | undefined
): IoioAccountSurface | null {
  if (!roles?.length) return null;
  if (roles.includes("ADMIN") || roles.includes("OWNER")) return "staff";
  if (roles.includes("SELF_SERVICE")) return "student";
  return null;
}

export function isIoioStaffRoute(pathname: string) {
  return staffRoutePrefixes.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
}

/** Keep deep links when they match the account's app surface. */
export function enforceIoioRoleDestination(
  pathname: string,
  surface: IoioAccountSurface,
  destination: string
) {
  if (
    surface === "staff" &&
    (pathname === "/ioio" || pathname.startsWith("/ioio/"))
  ) {
    return "/home";
  }
  if (surface === "student" && isIoioStaffRoute(pathname)) {
    return "/ioio";
  }
  return destination;
}
