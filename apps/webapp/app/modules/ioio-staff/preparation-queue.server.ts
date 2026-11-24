import { db } from "~/database/db.server";

type OrganizationMembership = {
  organization: { id: string; type: string };
  roles: string[];
};

/**
 * Resolve the Staff preparation queue without widening it across organizations.
 * If Staff landed in Personal and exactly one authorized Team has pending
 * preparation operations, use that Team for the preparation queue.
 */
export async function getStaffPreparationQueueOrganizationId({
  organizationId,
  organizationType,
  userOrganizations,
}: {
  organizationId: string;
  organizationType: string;
  userOrganizations: OrganizationMembership[];
}) {
  if (organizationType !== "PERSONAL") return organizationId;

  const staffTeamIds = [
    ...new Set(
      userOrganizations
        .filter(
          ({ organization, roles }) =>
            organization.type === "TEAM" &&
            roles.some((role) => role === "OWNER" || role === "ADMIN")
        )
        .map(({ organization }) => organization.id)
    ),
  ];
  if (!staffTeamIds.length) return organizationId;

  const pendingOrganizations = await db.ioioWriteOperation.findMany({
    where: {
      organizationId: { in: staffTeamIds },
      operationType: "IOIO_PREPARATION",
      status: "PENDING_PREPARATION",
      source: { in: ["IOIO_PREPARATION_REQUEST", "IOIO_ASSISTANT"] },
    },
    select: { organizationId: true },
    distinct: ["organizationId"],
  });
  return pendingOrganizations.length === 1
    ? pendingOrganizations[0]!.organizationId
    : organizationId;
}
