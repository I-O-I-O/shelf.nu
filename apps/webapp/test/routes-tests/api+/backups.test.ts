// @vitest-environment node
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActionFunctionArgs } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { action, loader } from "~/routes/api+/backups";
const auth = vi.hoisted(() => ({ permission: vi.fn() }));
// why: session/database membership lookup is external. Keep the real staff
// gate and organization resolver to exercise the authorization boundary.
vi.mock("~/utils/roles.server", () => ({ requirePermission: auth.permission }));
// why: cookie serialization is irrelevant for authorized Team requests.
vi.mock("~/modules/organization/context.server", () => ({
  setSelectedOrganizationIdCookie: vi.fn(),
}));
let directory: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(join(tmpdir(), "ioio-backup-route-"));
  vi.stubEnv("IOIO_BACKUP_DIR", directory);
  auth.permission.mockReset();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(directory, { recursive: true, force: true });
});
function permission(role: string) {
  auth.permission.mockResolvedValue({
    role,
    organizationId: "team-1",
    currentOrganization: { type: "TEAM" },
    userOrganizations: [
      {
        organizationId: "team-1",
        roles: [role],
        organization: { type: "TEAM" },
      },
    ],
  });
}
function args(method: string, origin = "http://localhost"): ActionFunctionArgs {
  const request = new Request("http://localhost/api/backups", {
    method,
    headers: { Origin: origin },
  });
  return {
    request,
    context: { getSession: () => ({ userId: "test-user" }) },
    params: {},
    pattern: "*",
    url: new URL(request.url),
  } as unknown as ActionFunctionArgs;
}
describe("staff backup endpoint", () => {
  it.each(["ADMIN", "OWNER"])("allows %s to see status", async (role) => {
    permission(role);
    const response = await loader(args("GET"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      backup: { status: "never" },
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
  it.each(["SELF_SERVICE", "BASE"])(
    "blocks %s reads and backup actions",
    async (role) => {
      permission(role);
      await expect(loader(args("GET"))).rejects.toMatchObject({ status: 403 });
      await expect(action(args("POST"))).rejects.toMatchObject({ status: 403 });
      expect(await fs.readdir(directory)).toEqual([]);
    }
  );
  it("blocks unauthenticated requests before reading status or creating a lock", async () => {
    auth.permission.mockRejectedValue(new Response(null, { status: 401 }));
    await expect(action(args("POST"))).rejects.toMatchObject({ status: 401 });
    await expect(loader(args("GET"))).rejects.toMatchObject({ status: 401 });
    expect(await fs.readdir(directory)).toEqual([]);
  });
  it("rejects cross-origin submissions", async () => {
    permission("ADMIN");
    expect((await action(args("POST", "https://other.example"))).status).toBe(
      403
    );
    expect(await fs.readdir(directory)).toEqual([]);
  });
  it("reports an existing lock without running PostgreSQL", async () => {
    permission("ADMIN");
    await fs.mkdir(join(directory, ".lock"));
    const response = await action(args("POST"));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ backup: { running: true } });
  });
});
