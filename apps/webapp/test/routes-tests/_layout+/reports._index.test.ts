import type { LoaderFunctionArgs } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { createLoaderArgs } from "@mocks/remix";
import { loader as reportsIndexLoader } from "~/routes/_layout+/reports._index";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

const mocks = vi.hoisted(() => ({ requirePermission: vi.fn() }));

// why: the route test verifies the authorization boundary without a database.
vi.mock("~/utils/roles.server", () => ({
  requirePermission: mocks.requirePermission,
}));

describe("IOIO Analytics landing route", () => {
  const context = {
    getSession: () => ({ userId: "staff-1" }),
  } as LoaderFunctionArgs["context"];

  it("requires reports read permission and returns the Analytics header", async () => {
    mocks.requirePermission.mockResolvedValueOnce({ organizationId: "team-1" });
    const args = createLoaderArgs({
      context,
      request: new Request("http://localhost/reports"),
    });

    const result = await reportsIndexLoader(args);

    expect(requirePermission).toHaveBeenCalledWith({
      userId: "staff-1",
      request: args.request,
      entity: PermissionEntity.reports,
      action: PermissionAction.read,
    });
    expect(result).toMatchObject({
      data: {
        header: {
          title: "Analytics",
          subHeading: "Understand lab activity and inventory usage.",
        },
      },
    });
  });

  it("denies a Student when the modern reports permission check rejects access", async () => {
    mocks.requirePermission.mockRejectedValueOnce(
      new Response("Forbidden", { status: 403 })
    );
    const args = createLoaderArgs({
      context: {
        getSession: () => ({ userId: "student-1" }),
      } as LoaderFunctionArgs["context"],
      request: new Request("http://localhost/reports"),
    });

    await expect(reportsIndexLoader(args)).rejects.toMatchObject({
      status: 403,
    });
  });
});
