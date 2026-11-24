import { beforeEach, describe, expect, it, vi } from "vitest";
import { createActionArgs } from "@mocks/remix";
import { action } from "~/routes/_layout+/assets.$assetId.overview";
import { ShelfError } from "~/utils/error";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  setIndividualAssetAvailability: vi.fn(),
}));

// why: authorization results are controlled to verify the route passes its
// organization scope to the existing guarded availability service.
vi.mock("~/utils/roles.server", () => ({
  requirePermission: mocks.requirePermission,
}));

// why: the route test checks action dispatch and response handling; service
// transition semantics are covered by the asset service tests.
vi.mock("~/modules/asset/service.server", () => ({
  setIndividualAssetAvailability: mocks.setIndividualAssetAvailability,
}));

// why: this action path has no direct database reads; isolate the route from
// the Shelf database client while testing its permission and service boundary.
vi.mock("~/database/db.server", () => ({ db: {} }));

// why: the overview imports a scanner animation through its presentation
// components, and lottie-web accesses canvas APIs unavailable in Happy DOM.
vi.mock("lottie-react", () => ({ default: () => null }));

const context = { getSession: () => ({ userId: "staff-1" }) } as never;

function actionArgs({
  assetId = "product-1",
  fields,
}: {
  assetId?: string;
  fields: Record<string, string>;
}) {
  return createActionArgs({
    context,
    params: { assetId },
    request: new Request(`http://localhost/assets/${assetId}`, {
      method: "POST",
      body: new URLSearchParams(fields),
    }),
  });
}

describe("asset overview physical unit availability action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requirePermission.mockResolvedValue({ organizationId: "org-1" });
    mocks.setIndividualAssetAvailability.mockResolvedValue({
      status: "UNAVAILABLE",
      availableToBook: false,
    });
  });

  it("dispatches the unit transition under the authorized organization", async () => {
    const result = await action(
      actionArgs({
        fields: {
          intent: "physicalUnitAvailability",
          unitId: "unit-7",
          action: "unavailable",
          note: "Being repaired",
        },
      })
    );

    expect(mocks.requirePermission).toHaveBeenCalledWith({
      userId: "staff-1",
      request: expect.any(Request),
      entity: PermissionEntity.asset,
      action: PermissionAction.update,
    });
    expect(mocks.setIndividualAssetAvailability).toHaveBeenCalledWith({
      id: "unit-7",
      detailAssetId: "product-1",
      organizationId: "org-1",
      userId: "staff-1",
      action: "unavailable",
      note: "Being repaired",
    });
    expect(result).toMatchObject({
      data: {
        ok: true,
        intent: "physicalUnitAvailability",
        unitId: "unit-7",
        status: "UNAVAILABLE",
      },
    });
  });

  it("returns the overview's controlled conflict response for a disallowed transition", async () => {
    mocks.setIndividualAssetAvailability.mockRejectedValue(
      new ShelfError({
        cause: null,
        message: "This unit is part of an active loan or reservation.",
        label: "Assets",
        status: 409,
        shouldBeCaptured: false,
      })
    );

    const result = await action(
      actionArgs({
        fields: {
          intent: "physicalUnitAvailability",
          unitId: "unit-7",
          action: "unavailable",
        },
      })
    );

    expect(mocks.setIndividualAssetAvailability).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "unit-7",
        detailAssetId: "product-1",
        organizationId: "org-1",
      })
    );
    expect(result).toMatchObject({
      init: { status: 409 },
      data: {
        ok: false,
        intent: "physicalUnitAvailability",
        unitId: "unit-7",
        error: "This unit is part of an active loan or reservation.",
      },
    });
  });

  it("rejects a missing unit identifier without calling the transition service", async () => {
    const result = await action(
      actionArgs({
        fields: {
          intent: "physicalUnitAvailability",
          action: "unavailable",
        },
      })
    );

    expect(mocks.setIndividualAssetAvailability).not.toHaveBeenCalled();
    expect(result).toMatchObject({ init: { status: 400 } });
  });

  it("rejects a missing route asset identifier before permission or transition", async () => {
    await expect(
      action(
        createActionArgs({
          context,
          params: {},
          request: new Request("http://localhost/assets", {
            method: "POST",
            body: new URLSearchParams({
              intent: "physicalUnitAvailability",
              unitId: "unit-7",
              action: "unavailable",
            }),
          }),
        })
      )
    ).rejects.toMatchObject({ init: { status: 400 } });

    expect(mocks.requirePermission).not.toHaveBeenCalled();
    expect(mocks.setIndividualAssetAvailability).not.toHaveBeenCalled();
  });

  it("does not invoke the service when staff lacks permission", async () => {
    mocks.requirePermission.mockRejectedValue(
      new ShelfError({
        cause: null,
        message: "You do not have permission to access this resource",
        label: "Permission",
        status: 403,
        shouldBeCaptured: false,
      })
    );

    const result = await action(
      actionArgs({
        fields: {
          intent: "physicalUnitAvailability",
          unitId: "unit-7",
          action: "unavailable",
        },
      })
    );

    expect(mocks.setIndividualAssetAvailability).not.toHaveBeenCalled();
    expect(result).toMatchObject({ init: { status: 403 } });
  });
});
