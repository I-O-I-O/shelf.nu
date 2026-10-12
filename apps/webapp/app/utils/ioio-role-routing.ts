export type IoioAccountSurface = "staff" | "student";

type IoioOrganizationMembership = {
  organizationId: string;
  roles: readonly string[];
  organization: { type: string };
};

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
  "/account-details/workspace",
];

export function resolveIoioAccountSurface(
  roles: readonly string[] | null | undefined
): IoioAccountSurface | null {
  if (!roles?.length) return null;
  if (roles.includes("ADMIN") || roles.includes("OWNER")) return "staff";
  if (roles.includes("SELF_SERVICE")) return "student";
  return null;
}

/**
 * Resolve an IOIO Team membership without treating Shelf's Personal workspace
 * as the IOIO organization. Shelf's current Team selection wins; if Personal
 * is selected, its cross-device last selection disambiguates multiple Team
 * memberships, and a sole eligible Team membership is otherwise safe to use.
 * Ambiguous or non-IOIO memberships fail closed.
 */
export function resolveIoioAccountMembership(
  memberships: readonly IoioOrganizationMembership[],
  selectedOrganizationId: string,
  selectedOrganizationType: string,
  lastSelectedOrganizationId?: string | null
) {
  const selected = memberships.find(
    (membership) => membership.organizationId === selectedOrganizationId
  );
  const isIoioTeamMembership = (membership: IoioOrganizationMembership) =>
    membership.organization.type === "TEAM" &&
    resolveIoioAccountSurface(membership.roles) !== null;

  if (
    selected &&
    selectedOrganizationType === "TEAM" &&
    isIoioTeamMembership(selected)
  ) {
    return selected;
  }

  const teamMemberships = memberships.filter(isIoioTeamMembership);
  const lastSelectedTeam = teamMemberships.find(
    (membership) => membership.organizationId === lastSelectedOrganizationId
  );
  if (lastSelectedTeam) return lastSelectedTeam;

  return teamMemberships.length === 1 ? teamMemberships[0] : null;
}

export function isIoioStaffRoute(pathname: string) {
  return staffRoutePrefixes.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
}

export function isIoioStudentRoute(pathname: string) {
  if (
    pathname === "/handbook/new" ||
    pathname.startsWith("/handbook/new/") ||
    /^\/handbook\/[^/]+\/edit(?:\/|$)/.test(pathname)
  ) {
    return false;
  }

  return (
    pathname === "/ioio" ||
    pathname.startsWith("/ioio/") ||
    pathname === "/handbook" ||
    pathname.startsWith("/handbook/")
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
  if (surface === "student" && !isIoioStudentRoute(pathname)) {
    return "/ioio";
  }
  return destination;
}

/** Resolve the default authenticated destination and keep requested deep links
 * within the signed-in user's IOIO surface. The caller remains responsible for
 * sanitizing `destination` before passing it here. */
export function resolveIoioAccountDestination(
  roles: readonly string[] | null | undefined,
  destination?: string
) {
  const surface = resolveIoioAccountSurface(roles);
  if (!surface) return null;

  const defaultDestination = surface === "student" ? "/ioio" : "/home";
  const requestedDestination = destination ?? defaultDestination;
  const pathname = new URL(requestedDestination, "http://ioio.local").pathname;

  return enforceIoioRoleDestination(pathname, surface, requestedDestination);
}
