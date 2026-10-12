import { describe, expect, it, vi } from "vitest";

const createOrganizationMock = vi.hoisted(() => vi.fn());
const databaseTransactionMock = vi.hoisted(() => vi.fn());

// why: Shelf organization creation is the boundary under test; its nested
// OWNER membership writes are covered by the organization service tests.
vi.mock("~/modules/organization/service.server", () => ({
  createOrganization: createOrganizationMock,
}));

// why: login recovery exercises the transaction wrapper with an in-memory
// transaction; avoid constructing the application Prisma client in tests.
vi.mock("~/database/db.server", () => ({
  db: { $transaction: databaseTransactionMock },
}));

// why: pin instance configuration so the initial Team name is deterministic.
vi.mock("~/utils/env", () => ({ INSTANCE_NAME: "  IOIO Self-Hosted  " }));

import { ensureInitialIoioTeamForUser } from "./initial-team.server";

type InitializationTransaction = NonNullable<
  Parameters<typeof ensureInitialIoioTeamForUser>[0]["tx"]
>;

function transaction({
  teamCount = 0,
  userCount = 1,
  currentUser = true,
}: {
  teamCount?: number;
  userCount?: number;
  currentUser?: boolean;
} = {}) {
  return {
    $executeRaw: vi.fn().mockResolvedValue(1),
    organization: {
      count: vi.fn().mockResolvedValue(teamCount),
    },
    user: {
      count: vi.fn().mockResolvedValue(userCount),
      findUnique: vi
        .fn()
        .mockResolvedValue(currentUser ? { id: "user-1" } : null),
      update: vi.fn().mockResolvedValue({}),
    },
  } as unknown as InitializationTransaction;
}

describe("initial IOIO Team initialization", () => {
  it("uses a Shelf transaction for login recovery", async () => {
    const tx = transaction();
    databaseTransactionMock.mockImplementationOnce(
      (
        callback: (transaction: InitializationTransaction) => Promise<unknown>
      ) => callback(tx)
    );
    vi.mocked(createOrganizationMock).mockResolvedValue({ id: "team-1" });

    await expect(
      ensureInitialIoioTeamForUser({ userId: "user-1" })
    ).resolves.toEqual({ id: "team-1" });

    expect(databaseTransactionMock).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: 6000,
      timeout: 10000,
    });
    expect(tx.$executeRaw).toHaveBeenCalledOnce();
  });

  it("creates a Team for the sole pre-existing Shelf user and selects it", async () => {
    const events: string[] = [];
    const tx = transaction();
    vi.mocked(tx.organization.count).mockImplementation(() => {
      events.push("team-count");
      return Promise.resolve(0 as never);
    });
    vi.mocked(tx.user.count).mockImplementation(() => {
      events.push("user-count");
      return Promise.resolve(1 as never);
    });
    vi.mocked(tx.user.findUnique).mockImplementation(() => {
      events.push("current-user");
      return Promise.resolve({ id: "user-1" } as never);
    });
    vi.mocked(tx.$executeRaw).mockImplementation(() => {
      events.push("lock");
      return Promise.resolve(1);
    });
    vi.mocked(createOrganizationMock).mockResolvedValue({ id: "team-1" });

    await expect(
      ensureInitialIoioTeamForUser({ tx, userId: "user-1" })
    ).resolves.toEqual({ id: "team-1" });

    expect(events).toEqual([
      "team-count",
      "lock",
      "team-count",
      "user-count",
      "current-user",
    ]);
    const [query, lockId] = vi.mocked(tx.$executeRaw).mock.calls[0];
    expect(query.join(" ")).toContain("pg_advisory_xact_lock");
    expect(lockId).toBe(0x494f494f);
    expect(createOrganizationMock).toHaveBeenCalledWith({
      name: "IOIO Self-Hosted",
      userId: "user-1",
      image: null,
      currency: "USD",
      tx,
    });
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { lastSelectedOrganizationId: "team-1" },
    });
  });

  it("fails closed when more than one Shelf user exists and there is no Team", async () => {
    const tx = transaction({ userCount: 2 });

    await expect(
      ensureInitialIoioTeamForUser({ tx, userId: "user-1" })
    ).resolves.toBeNull();

    expect(tx.$executeRaw).toHaveBeenCalledOnce();
    expect(createOrganizationMock).not.toHaveBeenCalled();
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it("fails closed if the current authenticated user is not in Shelf", async () => {
    const tx = transaction({ currentUser: false });

    await expect(
      ensureInitialIoioTeamForUser({ tx, userId: "missing-user" })
    ).resolves.toBeNull();

    expect(createOrganizationMock).not.toHaveBeenCalled();
  });

  it("does not bootstrap or write when a Team already exists", async () => {
    const tx = transaction({ teamCount: 1 });

    await expect(
      ensureInitialIoioTeamForUser({ tx, userId: "user-1" })
    ).resolves.toBeNull();

    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(createOrganizationMock).not.toHaveBeenCalled();
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it("is idempotent across repeated recovery attempts", async () => {
    let teamCount = 0;
    const tx = transaction();
    vi.mocked(tx.organization.count).mockImplementation(() =>
      Promise.resolve(teamCount as never)
    );
    vi.mocked(createOrganizationMock).mockImplementation(() => {
      teamCount = 1;
      return Promise.resolve({ id: "team-1" } as never);
    });

    await ensureInitialIoioTeamForUser({ tx, userId: "user-1" });
    await expect(
      ensureInitialIoioTeamForUser({ tx, userId: "user-1" })
    ).resolves.toBeNull();

    expect(createOrganizationMock).toHaveBeenCalledOnce();
    expect(tx.user.update).toHaveBeenCalledOnce();
  });

  it("allows only one of two concurrent signup transactions to initialize", async () => {
    let lockTail = Promise.resolve();
    let teamExists = false;
    let committedUsers = 0;

    async function signup(userId: string) {
      let releaseLock: (() => void) | undefined;
      const tx = {
        $executeRaw: vi.fn(async () => {
          const previous = lockTail;
          let release!: () => void;
          lockTail = new Promise<void>((resolve) => {
            release = resolve;
          });
          await previous;
          releaseLock = release;
          return 1;
        }),
        organization: {
          count: vi.fn(() => Promise.resolve(teamExists ? 1 : 0)),
        },
        user: {
          count: vi.fn(() => Promise.resolve(committedUsers + 1)),
          findUnique: vi.fn(() => Promise.resolve({ id: userId })),
          update: vi.fn(),
        },
      } as unknown as InitializationTransaction;

      try {
        const createdTeam = await ensureInitialIoioTeamForUser({ tx, userId });
        if (createdTeam) teamExists = true;
        return createdTeam;
      } finally {
        committedUsers += 1;
        releaseLock?.();
      }
    }

    vi.mocked(createOrganizationMock).mockImplementation(() =>
      Promise.resolve({ id: "team-1" })
    );

    const results = await Promise.all([signup("user-1"), signup("user-2")]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(teamExists).toBe(true);
    expect(committedUsers).toBe(2);
    expect(createOrganizationMock).toHaveBeenCalledOnce();
  });
});
