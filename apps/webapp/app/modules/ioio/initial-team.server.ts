import { Currency, OrganizationType } from "@prisma/client";
import type { Organization, Prisma, User } from "@prisma/client";
import type { ITXClientDenyList } from "@prisma/client/runtime/library";

import { db, type ExtendedPrismaClient } from "~/database/db.server";
import { createOrganization } from "~/modules/organization/service.server";
import { INSTANCE_NAME } from "~/utils/env";

/**
 * Reserve the one-time IOIO initialization slot for this transaction.
 * PostgreSQL advisory transaction locks serialize initialization even when
 * there is no Team row yet to lock.
 */
const IOIO_INITIAL_TEAM_LOCK_ID = 0x494f494f;

type InitializationTransaction = Omit<ExtendedPrismaClient, ITXClientDenyList>;

async function ensureInitialIoioTeamInTransaction({
  tx,
  userId,
}: {
  tx: InitializationTransaction;
  userId: User["id"];
}): Promise<Organization | null> {
  // Initialized installations are a strict no-op and never take the lock.
  const existingTeamCount = await tx.organization.count({
    where: { type: OrganizationType.TEAM },
  });
  if (existingTeamCount > 0) return null;

  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${IOIO_INITIAL_TEAM_LOCK_ID})`;

  // Recheck every condition after acquiring the lock. In particular, the
  // total user count includes the signup row when this runs inside createUser's
  // transaction, and prevents a later signup from claiming ownership.
  const [teamCount, userCount, currentUser] = await Promise.all([
    tx.organization.count({ where: { type: OrganizationType.TEAM } }),
    tx.user.count(),
    tx.user.findUnique({ where: { id: userId }, select: { id: true } }),
  ]);

  if (teamCount > 0 || userCount !== 1 || !currentUser) return null;

  const organization = await createOrganization({
    name: INSTANCE_NAME?.trim() || "IOIO Team",
    userId,
    image: null,
    currency: Currency.USD,
    tx: tx as Prisma.TransactionClient,
  });

  await tx.user.update({
    where: { id: userId },
    data: { lastSelectedOrganizationId: organization.id },
  });

  return organization;
}

/**
 * Ensure the sole Shelf user owns the initial IOIO Team when no Team exists.
 *
 * Signup passes its current transaction so creating the user, Team, OWNER
 * membership, and selected-organization value commits atomically. Login calls
 * this without a transaction so an interrupted one-user setup can recover.
 * Returns the Team only when this call created it; all other cases are
 * idempotent no-ops.
 */
export async function ensureInitialIoioTeamForUser({
  userId,
  tx,
}: {
  userId: User["id"];
  tx?: InitializationTransaction;
}): Promise<Organization | null> {
  if (tx) {
    return ensureInitialIoioTeamInTransaction({ tx, userId });
  }

  return db.$transaction(
    (transaction) =>
      ensureInitialIoioTeamInTransaction({
        tx: transaction as InitializationTransaction,
        userId,
      }),
    { maxWait: 6000, timeout: 10000 }
  );
}
