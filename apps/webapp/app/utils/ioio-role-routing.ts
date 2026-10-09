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
 * A new Shelf account has a Personal workspace. When it also has one IOIO
 * Student membership, use that organization for the Student app instead of
 * landing it in the Personal workspace's staff surface. Existing team
 * selections and accounts with a staff Team membership stay unchanged.
 */
export function resolveIoioAccountMembership(
  memberships: readonly IoioOrganizationMembership[],
  selectedOrganizationId: string,
  selectedOrganizationType: string
) {
  const selected = memberships.find(
    (membership) => membership.organizationId === selectedOrganizationId
  );
  if (!selected || selectedOrganizationType !== "PERSONAL") return selected;

  const staffTeamMembershipExists = memberships.some(
    (membership) =>
      membership.organization.type !== "PERSONAL" &&
      (membership.roles.includes("OWNER") || membership.roles.includes("ADMIN"))
  );
  if (staffTeamMembershipExists) return selected;

  const studentMemberships = memberships.filter(
    (membership) =>
      membership.organization.type !== "PERSONAL" &&
      membership.roles.includes("SELF_SERVICE") &&
      !membership.roles.includes("OWNER") &&
      !membership.roles.includes("ADMIN")
  );
  return studentMemberships.length === 1 ? studentMemberships[0] : selected;
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
