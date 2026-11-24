import { OrganizationRoles } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { ioioRoleLabel } from "./role-label";

describe("ioioRoleLabel", () => {
  it("presents Shelf self-service accounts as Student", () => {
    expect(ioioRoleLabel(OrganizationRoles.SELF_SERVICE)).toBe("Student");
  });

  it("presents elevated and legacy Shelf roles as Staff", () => {
    expect(ioioRoleLabel(OrganizationRoles.ADMIN)).toBe("Staff");
    expect(ioioRoleLabel(OrganizationRoles.BASE)).toBe("Staff");
    expect(ioioRoleLabel(OrganizationRoles.OWNER)).toBe("Staff");
  });
});
