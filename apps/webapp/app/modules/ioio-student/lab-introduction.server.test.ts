import { OrganizationRoles } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  userOrganization: { updateMany: vi.fn() },
}));

vi.mock("~/database/db.server", () => ({ db: dbMock }));

import { completeStudentLabIntroduction } from "./lab-introduction.server";

describe("completeStudentLabIntroduction", () => {
  beforeEach(() => vi.clearAllMocks());

  it("marks only the authenticated Student's incomplete organization membership complete", async () => {
    dbMock.userOrganization.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      completeStudentLabIntroduction({
        organizationId: "ioio-lab",
        userId: "student-1",
      })
    ).resolves.toBe(true);

    expect(dbMock.userOrganization.updateMany).toHaveBeenCalledWith({
      where: {
        organizationId: "ioio-lab",
        userId: "student-1",
        roles: { has: OrganizationRoles.SELF_SERVICE },
        labIntroductionCompleted: false,
      },
      data: { labIntroductionCompleted: true },
    });
  });

  it("does not claim completion when the membership was not updated", async () => {
    dbMock.userOrganization.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      completeStudentLabIntroduction({
        organizationId: "ioio-lab",
        userId: "student-1",
      })
    ).resolves.toBe(false);
  });
});
