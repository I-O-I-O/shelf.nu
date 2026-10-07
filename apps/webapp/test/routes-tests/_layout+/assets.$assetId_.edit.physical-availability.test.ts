import { beforeEach, describe, expect, it, vi } from "vitest";
import { action } from "~/routes/_layout+/assets.$assetId_.edit";

// why: the route's action delegates the guarded state transition to the asset
// service; this test verifies the IOIO editor posts that intent to the service.
vi.mock("~/modules/asset/service.server", () => ({
  setIndividualAssetAvailability: vi.fn().mockResolvedValue({
    availableToBook: false,
    status: "UNAVAILABLE",
  }),
}));
// why: permission resolution is an auth boundary and the route's update check
// is independent of this focused availability-action test.
vi.mock("~/utils/roles.server", () => ({
  requirePermission: vi.fn().mockResolvedValue({ organizationId: "org-1" }),
}));

import { setIndividualAssetAvailability } from "~/modules/asset/service.server";

function buildArgs(availabilityAction: "available" | "unavailable") {
  const request = new Request("http://localhost/assets/unit-1/edit", {
    method: "POST",
    body: new URLSearchParams({
      intent: "physical-unit-availability",
      availabilityAction,
    }),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });

  return {
    request,
    params: { assetId: "unit-1" },
    context: { getSession: () => ({ userId: "user-1" }) },
  } as unknown as Parameters<typeof action>[0];
}

describe("physical unit availability edit action", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses the guarded current availability service for a direct toggle", async () => {
    await action(buildArgs("unavailable"));

    expect(setIndividualAssetAvailability).toHaveBeenCalledWith({
      id: "unit-1",
      detailAssetId: "unit-1",
      organizationId: "org-1",
      userId: "user-1",
      action: "unavailable",
    });
  });
});
