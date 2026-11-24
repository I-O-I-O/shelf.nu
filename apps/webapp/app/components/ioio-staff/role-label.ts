import { OrganizationRoles } from "@prisma/client";

/**
 * IOIO keeps the underlying Shelf roles intact while presenting only the two
 * account types used by the lab.
 */
export function ioioRoleLabel(
  role: OrganizationRoles | string
): "Student" | "Staff" {
  return role === OrganizationRoles.SELF_SERVICE ? "Student" : "Staff";
}
