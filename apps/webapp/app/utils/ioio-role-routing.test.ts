import { describe, expect, it } from "vitest";
import {
  enforceIoioRoleDestination,
  resolveIoioAccountMembership,
  isIoioStaffRoute,
  isIoioStudentRoute,
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

  it("resolves a staff user's Personal selection to their sole authorized Team", () => {
    const staffMembership = {
      organizationId: "ioio-team-1",
      roles: ["ADMIN"],
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
          staffMembership,
        ],
        "personal-1",
        "PERSONAL"
      )
    ).toEqual(staffMembership);
  });

  it("resolves a Student's Personal selection to their sole authorized Team", () => {
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

  it("preserves the selected authorized Team when another Team was last selected", () => {
    const selectedMembership = {
      organizationId: "team-current",
      roles: ["ADMIN"],
      organization: { type: "TEAM" },
    };

    expect(
      resolveIoioAccountMembership(
        [
          selectedMembership,
          {
            organizationId: "team-last-used",
            roles: ["ADMIN"],
            organization: { type: "TEAM" },
          },
        ],
        "team-current",
        "TEAM",
        "team-last-used"
      )
    ).toEqual(selectedMembership);
  });

  it("uses Shelf's last selected Team to disambiguate multiple memberships", () => {
    const lastSelectedMembership = {
      organizationId: "team-last-used",
      roles: ["ADMIN"],
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
          {
            organizationId: "team-other",
            roles: ["ADMIN"],
            organization: { type: "TEAM" },
          },
          lastSelectedMembership,
        ],
        "personal-1",
        "PERSONAL",
        "team-last-used"
      )
    ).toEqual(lastSelectedMembership);
  });

  it("fails closed when membership is missing, unauthorized, or ambiguous", () => {
    expect(
      resolveIoioAccountMembership(
        [
          {
            organizationId: "personal-1",
            roles: ["OWNER"],
            organization: { type: "PERSONAL" },
          },
          {
            organizationId: "unrelated-team",
            roles: ["MEMBER"],
            organization: { type: "TEAM" },
          },
        ],
        "personal-1",
        "PERSONAL"
      )
    ).toBeNull();

    expect(
      resolveIoioAccountMembership(
        [
          {
            organizationId: "team-one",
            roles: ["ADMIN"],
            organization: { type: "TEAM" },
          },
          {
            organizationId: "team-two",
            roles: ["SELF_SERVICE"],
            organization: { type: "TEAM" },
          },
        ],
        "personal-1",
        "PERSONAL"
      )
    ).toBeNull();
  });

  it("keeps requested destinations within the selected account surface", () => {
    expect(
      resolveIoioAccountDestination(["SELF_SERVICE"], "/bookings?mine=1")
    ).toBe("/ioio");
    expect(
      resolveIoioAccountDestination(
        ["SELF_SERVICE"],
        "/account-details/general"
      )
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
      "/account-details/workspace",
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

  it("keeps only student routes inside the Student shell", () => {
    expect(isIoioStudentRoute("/ioio/loans")).toBe(true);
    expect(isIoioStudentRoute("/handbook/article")).toBe(true);
    expect(isIoioStudentRoute("/handbook/contribute")).toBe(true);
    expect(isIoioStudentRoute("/handbook/new")).toBe(false);
    expect(isIoioStudentRoute("/handbook/article/edit")).toBe(false);
    expect(isIoioStudentRoute("/operations/tasks")).toBe(false);
    expect(isIoioStudentRoute("/account-details/general")).toBe(false);
  });
});
