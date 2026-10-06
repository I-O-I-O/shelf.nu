import { OrganizationRoles } from "@prisma/client";
import { db } from "~/database/db.server";

export async function completeStudentLabIntroduction({
  organizationId,
  userId,
}: {
  organizationId: string;
  userId: string;
}) {
  const result = await db.userOrganization.updateMany({
    where: {
      organizationId,
      userId,
      roles: { has: OrganizationRoles.SELF_SERVICE },
      labIntroductionCompleted: false,
    },
    data: { labIntroductionCompleted: true },
  });

  return result.count === 1;
}
