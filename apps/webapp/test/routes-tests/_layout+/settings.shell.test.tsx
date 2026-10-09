import { describe, expect, it, vi } from "vitest";
import { createLoaderArgs } from "@mocks/remix";

const mocks = vi.hoisted(() => ({ requirePermission: vi.fn() }));

// why: the route test controls membership roles without requiring a database.
vi.mock("~/utils/roles.server", () => ({
  requirePermission: mocks.requirePermission,
}));

import { getIoioSettingsTabs, loader } from "~/routes/_layout+/settings";
import { loader as settingsIndexLoader } from "~/routes/_layout+/settings.index";

const teamOrganization = { id: "team-1", type: "TEAM", name: "IOIO" };

describe("IOIO staff Settings shell", () => {
  it("shows the exact IOIO tab order for a Team workspace", () => {
    expect(getIoioSettingsTabs(false).map((item) => item.content)).toEqual([
      "Emails",
      "Lab information",
      "Access approval",
      "AI",
      "Backup",
      "IOIO Lab Access",
      "IOIO Users",
    ]);
  });

  it("keeps Personal workspaces on the safe Backup tab", () => {
    expect(getIoioSettingsTabs(true)).toEqual([
      { to: "backup", content: "Backup" },
    ]);
  });

  it("does not expose workspace management in the IOIO Settings navigation", () => {
    const tabs = getIoioSettingsTabs(false);
    expect(tabs.map(({ content }) => content)).not.toContain(
      "Workspace management"
    );
    expect(tabs.map(({ to }) => to)).not.toContain("account-details/workspace");
  });

  it("allows an Owner and rejects a SELF_SERVICE account server-side", async () => {
    const args = createLoaderArgs({
      context: { getSession: () => ({ userId: "user-1" }) } as never,
      request: new Request("http://localhost/settings"),
    });
    for (const role of ["OWNER", "ADMIN"] as const) {
      mocks.requirePermission.mockResolvedValueOnce({
        currentOrganization: teamOrganization,
        role,
      });
      await expect(loader(args)).resolves.toMatchObject({
        _isPersonalOrg: false,
      });
    }

    mocks.requirePermission.mockResolvedValueOnce({
      currentOrganization: teamOrganization,
      role: "SELF_SERVICE",
    });
    await expect(loader(args)).rejects.toMatchObject({
      data: { error: { message: expect.any(String) } },
    });
  });

  it("redirects /settings to the existing Backup destination", () => {
    const result = settingsIndexLoader();
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).headers.get("Location")).toBe("backup");
  });
});
