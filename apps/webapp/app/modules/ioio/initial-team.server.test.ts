import { describe, expect, it, vi } from "vitest";

const createOrganizationMock = vi.hoisted(() => vi.fn());

// why: Shelf organization creation is the boundary under test; the database
// and its nested writes are covered by the organization service tests.
vi.mock("~/modules/organization/service.server", () => ({
  createOrganization: createOrganizationMock,
}));

// why: pin instance configuration so the initial Team name is deterministic.
vi.mock("~/utils/env", () => ({ INSTANCE_NAME: "  IOIO Self-Hosted  " }));

import {
  createInitialIoioTeam,
  isFreshIoioInstanceForSignup,
} from "./initial-team.server";

function transaction(overrides?: {
  team?: { id: string } | null;
  user?: { id: string } | null;
}) {
  return {
    $executeRaw: vi.fn().mockResolvedValue(1),
    organization: {
      findFirst: vi.fn().mockResolvedValue(overrides?.team ?? null),
    },
    user: {
      findFirst: vi.fn().mockResolvedValue(overrides?.user ?? null),
      update: vi.fn().mockResolvedValue({}),
    },
  } as unknown as Parameters<typeof isFreshIoioInstanceForSignup>[0];
}

describe("initial IOIO Team bootstrap", () => {
  it("recognizes an empty Shelf database after a serialized state recheck", async () => {
    const events: string[] = [];
    const tx = transaction();
    vi.mocked(tx.$executeRaw).mockImplementation(() => {
      events.push("lock");
      return Promise.resolve(1);
    });
    let teamReads = 0;
    let userReads = 0;
    vi.mocked(tx.organization.findFirst).mockImplementation(() => {
      events.push(`team-${++teamReads}`);
      return Promise.resolve(null as never);
    });
    vi.mocked(tx.user.findFirst).mockImplementation(() => {
      events.push(`user-${++userReads}`);
      return Promise.resolve(null as never);
    });

    await expect(isFreshIoioInstanceForSignup(tx)).resolves.toBe(true);

    expect(events).toEqual(["team-1", "user-1", "lock", "team-2", "user-2"]);
    const [query, lockId] = vi.mocked(tx.$executeRaw).mock.calls[0];
    expect(query.join(" ")).toContain("pg_advisory_xact_lock");
    expect(lockId).toBe(0x494f494f);
  });

  it.each([
    ["an existing Team", { team: { id: "team-1" } }],
    ["an existing Shelf user", { user: { id: "user-1" } }],
  ])("does not bootstrap when %s exists", async (_description, state) => {
    const tx = transaction(state);

    await expect(isFreshIoioInstanceForSignup(tx)).resolves.toBe(false);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it("creates through Shelf and persists the initial Team as selected", async () => {
    const tx = transaction();
    vi.mocked(createOrganizationMock).mockResolvedValue({ id: "team-1" });

    await createInitialIoioTeam({ tx, userId: "first-user" });

    expect(createOrganizationMock).toHaveBeenCalledWith({
      name: "IOIO Self-Hosted",
      userId: "first-user",
      image: null,
      currency: "USD",
      tx,
    });
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: "first-user" },
      data: { lastSelectedOrganizationId: "team-1" },
    });
  });

  it("allows only one of two concurrent empty-instance signups to claim bootstrap", async () => {
    let lockTail = Promise.resolve();
    let teamExists = false;
    let userCount = 0;

    async function signup() {
      let releaseLock: (() => void) | undefined;
      let stagedTeam = false;
      let stagedUser = false;
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
          findFirst: vi.fn(() =>
            Promise.resolve(teamExists || stagedTeam ? { id: "team-1" } : null)
          ),
        },
        user: {
          findFirst: vi.fn(() =>
            Promise.resolve(
              userCount > 0 || stagedUser ? { id: "user-1" } : null
            )
          ),
          update: vi.fn(),
        },
      } as unknown as Parameters<typeof isFreshIoioInstanceForSignup>[0];

      try {
        const fresh = await isFreshIoioInstanceForSignup(tx);
        if (fresh) {
          stagedUser = true;
          stagedTeam = true;
        }
        return fresh;
      } finally {
        if (stagedUser) userCount += 1;
        if (stagedTeam) teamExists = true;
        releaseLock?.();
      }
    }

    const results = await Promise.all([signup(), signup()]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(teamExists).toBe(true);
    expect(userCount).toBe(1);
  });
});
