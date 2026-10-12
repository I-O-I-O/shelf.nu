import { Currency, OrganizationType } from "@prisma/client";
import type { Prisma, User } from "@prisma/client";
import type { ITXClientDenyList } from "@prisma/client/runtime/library";

import type { ExtendedPrismaClient } from "~/database/db.server";
import { createOrganization } from "~/modules/organization/service.server";
import { INSTANCE_NAME } from "~/utils/env";

/**
 * Reserve the one-time IOIO initialization slot for this transaction.
 * PostgreSQL advisory transaction locks serialize signups even when there is
 * no Team row yet to lock. The key spells "IOIO" and is local to this feature.
 */
const IOIO_INITIAL_TEAM_LOCK_ID = 0x494f494f;

type SignupTransaction = Omit<ExtendedPrismaClient, ITXClientDenyList>;

/**
 * A fresh IOIO instance has no Team organization and no Shelf users. This is
 * checked before the new signup row is inserted, while holding a transaction
 * lock, so only one signup can qualify. A previous user row also prevents a
 * later signup from recreating bootstrap ownership if a Team was removed.
 */
export async function isFreshIoioInstanceForSignup(tx: SignupTransaction) {
  const [knownTeam, knownUser] = await Promise.all([
    tx.organization.findFirst({
      where: { type: OrganizationType.TEAM },
      select: { id: true },
    }),
    tx.user.findFirst({ select: { id: true } }),
  ]);

  if (knownTeam || knownUser) return false;

  // Only a possibly fresh database needs the global lock. Later signups skip
  // it because their persisted Team or User row already proves initialization.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${IOIO_INITIAL_TEAM_LOCK_ID})`;

  const [team, user] = await Promise.all([
    tx.organization.findFirst({
      where: { type: OrganizationType.TEAM },
      select: { id: true },
    }),
    tx.user.findFirst({ select: { id: true } }),
  ]);

  return !team && !user;
}

/** Create the initial Team through Shelf and persist Shelf's selected-org state. */
export async function createInitialIoioTeam({
  tx,
  userId,
}: {
  tx: SignupTransaction;
  userId: User["id"];
}) {
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
