import { describe, expect, it } from "vitest";
import {
  isStudentLabIntroductionRequired,
  isStudentOnlyMembership,
} from "./lab-introduction.shared";

describe("isStudentLabIntroductionRequired", () => {
  it("requires first-use orientation for an incomplete Student membership", () => {
    expect(
      isStudentLabIntroductionRequired({
        roles: ["SELF_SERVICE"],
        completed: false,
      })
    ).toBe(true);
  });

  it("does not redirect completed Students or Staff", () => {
    expect(
      isStudentLabIntroductionRequired({
        roles: ["SELF_SERVICE"],
        completed: true,
      })
    ).toBe(false);
    expect(
      isStudentLabIntroductionRequired({
        roles: ["SELF_SERVICE", "ADMIN"],
        completed: false,
      })
    ).toBe(false);
  });

  it("keeps the introduction separate from non-Student access roles", () => {
    expect(
      isStudentLabIntroductionRequired({
        roles: ["BASE"],
        completed: false,
      })
    ).toBe(false);
  });

  it("marks only newly created Student-only memberships incomplete", () => {
    expect(isStudentOnlyMembership(["SELF_SERVICE"])).toBe(true);
    expect(isStudentOnlyMembership(["SELF_SERVICE", "BASE"])).toBe(true);
    expect(isStudentOnlyMembership(["SELF_SERVICE", "ADMIN"])).toBe(false);
    expect(isStudentOnlyMembership(["ADMIN"])).toBe(false);
  });
});
