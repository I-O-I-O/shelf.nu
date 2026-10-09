import { describe, expect, it } from "vitest";
import {
  enforceIoioRoleDestination,
  resolveIoioAccountMembership,
  isIoioStaffRoute,
  resolveIoioAccountDestination,
  resolveIoioAccountSurface,
} from "./ioio-role-routing";

describe("IOIO account surface routing", () => {
  it("uses the SELF_SERVICE membership for the Student landing surface", () => {
    expect(resolveIoioAccountSurface(["SELF_SERVICE"])).toBe("student");
    expect(resolveIoioAccountDestination(["SELF_SERVICE"])).toBe("/ioio");
  });

  it("uses the staff landing surface for OWNER and ADMIN memberships", () => {
    expect(resolveIoioAccountDestination(["OWNER"])).toBe("/home");
    expect(resolveIoioAccountDestination(["ADMIN"])).toBe("/home");
  });

  it("uses the sole Student Team membership when the current organization is Personal", () => {
    const studentMembership = {
      organizationId: "ioio-team-1",
      roles: ["SELF_SERVICE"],
      organization: { type: "TEAM" },
    };

    expect(
      resolveIoioAccountMembership(
        [
          {
            organizationId: "personal-1",
            roles: ["OWNER"],
            organization: { type: "PERSONAL" },
          },
          studentMembership,
        ],
        "personal-1",
        "PERSONAL"
      )
    ).toEqual(studentMembership);
  });

  it("keeps requested destinations within the selected account surface", () => {
    expect(
      resolveIoioAccountDestination(["SELF_SERVICE"], "/bookings?mine=1")
    ).toBe("/ioio");
    expect(resolveIoioAccountDestination(["OWNER"], "/ioio/loans")).toBe(
      "/home"
    );
    expect(resolveIoioAccountDestination(["SELF_SERVICE"], "/ioio/loans")).toBe(
      "/ioio/loans"
    );
  });

  it("protects the staff route families from direct Student URLs", () => {
    for (const pathname of [
      "/home",
      "/assets",
      "/bookings",
      "/calendar",
      "/reports",
      "/settings",
      "/operations",
      "/staff/ask",
    ]) {
      expect(isIoioStaffRoute(pathname)).toBe(true);
      expect(enforceIoioRoleDestination(pathname, "student", pathname)).toBe(
        "/ioio"
      );
    }
  });

  it("does not classify Student routes as staff routes", () => {
    expect(isIoioStaffRoute("/ioio/loans")).toBe(false);
    expect(isIoioStaffRoute("/ioio/settings")).toBe(false);
  });
});
