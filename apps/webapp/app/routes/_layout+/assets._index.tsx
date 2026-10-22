import type {
  ActionFunctionArgs,
  LinksFunction,
  LoaderFunctionArgs,
  MetaFunction,
  ShouldRevalidateFunctionArgs,
} from "react-router";
import { data, useLoaderData } from "react-router";
import { z } from "zod";
import { StaffInventoryList } from "~/components/assets/assets-index/staff-inventory-list";
import { ImportButton } from "~/components/assets/import-button";
import { NewAssetDropdown } from "~/components/assets/new-asset-dropdown";
import { InventoryQrScanner } from "~/components/ioio/inventory-qr-scanner";
import Header from "~/components/layout/header";
import When from "~/components/when/when";
import { db } from "~/database/db.server";

import { useUserRoleHelper } from "~/hooks/user-user-role-helper";
import { simpleModeLoader } from "~/modules/asset/data.server";
import { ASSET_LIFECYCLE_INTENT } from "~/modules/asset/lifecycle-intent";
import {
  addIndividualUnitsToAssetModel,
  bulkDeleteAssets,
} from "~/modules/asset/service.server";
import { CurrentSearchParamsSchema } from "~/modules/asset/utils.server";
import {
  CreatePresetFormSchema,
  RenamePresetFormSchema,
  DeletePresetFormSchema,
} from "~/modules/asset-filter-presets/schemas";
import {
  createPreset,
  deletePreset,
  togglePresetStar,
  listPresetsForUser,
  renamePreset,
} from "~/modules/asset-filter-presets/service.server";
import {
  changeMode,
  getAssetIndexSettings,
} from "~/modules/asset-index-settings/service.server";
import {
  archiveIoioItems,
  getIoioArchivedItemIds,
  trashIoioItems,
} from "~/modules/ioio-staff/archive.server";
import { returnResolvedAssetToService } from "~/modules/ioio-staff/lab-status.server";
import {
  setIoioAssetHidden,
  setIoioAssetsHidden,
} from "~/modules/ioio-staff/visibility.server";
import assetCss from "~/styles/assets.css?url";
import calendarStyles from "~/styles/layout/calendar.css?url";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { checkExhaustiveSwitch } from "~/utils/check-exhaustive-switch";
import { getClientHint } from "~/utils/client-hints";
import { resolveUserFormatPrefsById } from "~/utils/date-format.server";

import { sendNotification } from "~/utils/emitter/send-notification.server";
import { ShelfError, makeShelfError } from "~/utils/error";
import { payload, error, parseData } from "~/utils/http.server";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { userHasPermission } from "~/utils/permissions/permission.validator.client";
import { requirePermission } from "~/utils/roles.server";

export type AssetIndexLoaderData = typeof loader;

export const links: LinksFunction = () => [
  { rel: "stylesheet", href: assetCss },
  { rel: "stylesheet", href: calendarStyles },
];

export async function loader({ context, request }: LoaderFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;
  try {
    /** Validate permissions and fetch user */
    const [
      {
        organizationId,
        organizations,
        currentOrganization,
        role,
        canUseBarcodes,
        canSeeAllCustody,
      },
      user,
    ] = await Promise.all([
      requirePermission({
        userId,
        request,
        entity: PermissionEntity.asset,
        action: PermissionAction.read,
      }),
      db.user
        .findUniqueOrThrow({
          where: {
            id: userId,
          },
          select: {
            firstName: true,
            displayName: true,
          },
        })
        .catch((cause) => {
          throw new ShelfError({
            cause,
            message:
              "We can't find your user data. Please try again or contact support.",
            additionalData: { userId },
            label: "Assets",
          });
        }),
    ]);

    const settings = await getAssetIndexSettings({
      userId,
      organizationId,
      canUseBarcodes,
      role,
    });
    /** For base and self service users, we dont allow to view the advanced index */
    if (
      settings.mode === "ADVANCED" &&
      ["BASE", "SELF_SERVICE"].includes(role)
    ) {
      await changeMode({
        userId,
        organizationId,
        mode: "SIMPLE",
      });
      throw new ShelfError({
        cause: null,
        title: "Not allowed",
        message:
          "You don't have permission to access the advanced mode. We will automatically switch you back to 'simple' mode. Please reload the page.",
        label: "Assets",
        status: 403,
        shouldBeCaptured: false,
      });
    }

    // Staff Inventory is intentionally a single presentation. The underlying
    // Shelf loader and saved preference remain untouched, while the list view
    // omits the advanced-mode and availability-mode controls.
    const inventoryUrl = new URL(request.url);
    inventoryUrl.searchParams.set("per_page", "100");
    inventoryUrl.searchParams.set("getAll", "location");
    const inventoryRequest = new Request(inventoryUrl, {
      headers: request.headers,
    });
    const archivedAssetIds = await getIoioArchivedItemIds({
      organizationId,
      itemType: "ASSET",
    });

    return await simpleModeLoader({
      request: inventoryRequest,
      userId,
      organizationId,
      organizations,
      role,
      currentOrganization,
      user,
      settings,
      canSeeAllCustody,
      excludeAssetIds: archivedAssetIds,
      ioioHiddenOnly:
        inventoryUrl.searchParams.get("ioioVisibility") === "hidden",
    });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    throw data(error(reason), { status: reason.status });
  }
}

export async function action({ context, request }: ActionFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;

  try {
    const formData = await request.formData();

    const IntentSchema = z.enum([
      "bulk-delete",
      ASSET_LIFECYCLE_INTENT.ARCHIVE,
      ASSET_LIFECYCLE_INTENT.TRASH,
      "return-unit-to-service",
      "hide-asset",
      "unhide-asset",
      "add-individual-units",
      "create-preset",
      "rename-preset",
      "delete-preset",
      "toggle-star-preset",
    ]);

    const { intent } = parseData(formData, z.object({ intent: IntentSchema }), {
      message:
        "Unable to complete this inventory action because the request was invalid. Please try again.",
      shouldBeCaptured: false,
    });

    const intent2ActionMap: Record<
      z.infer<typeof IntentSchema>,
      PermissionAction
    > = {
      "bulk-delete": PermissionAction.delete,
      [ASSET_LIFECYCLE_INTENT.ARCHIVE]: PermissionAction.delete,
      [ASSET_LIFECYCLE_INTENT.TRASH]: PermissionAction.delete,
      "return-unit-to-service": PermissionAction.update,
      "hide-asset": PermissionAction.update,
      "unhide-asset": PermissionAction.update,
      "add-individual-units": PermissionAction.update,
      "create-preset": PermissionAction.read,
      "rename-preset": PermissionAction.read,
      "delete-preset": PermissionAction.read,
      "toggle-star-preset": PermissionAction.read,
    };

    let permissionEntity = PermissionEntity.asset;
    let visibilityAssetIds: string[] | undefined;
    let visibilityPermissionEntities: PermissionEntity[] = [];
    if (intent === "hide-asset" || intent === "unhide-asset") {
      const { assetId, assetIds } = parseData(
        formData,
        z
          .object({
            assetId: z.string().min(1).optional(),
            assetIds: z.array(z.string().min(1)).optional(),
          })
          .refine(
            ({ assetId: singleAssetId, assetIds: multipleAssetIds }) =>
              Boolean(singleAssetId || multipleAssetIds?.length),
            { message: "Select at least one inventory item." }
          )
      );
      visibilityAssetIds = Array.from(
        new Set([...(assetIds ?? []), ...(assetId ? [assetId] : [])])
      );
      const { organizationId: readOrganizationId } = await requirePermission({
        userId,
        request,
        entity: PermissionEntity.asset,
        action: PermissionAction.read,
      });
      if (assetIds?.length) {
        const assets = await db.asset.findMany({
          where: {
            id: { in: visibilityAssetIds },
            organizationId: readOrganizationId,
          },
          select: { id: true, assetModelId: true },
        });
        if (assets.length !== visibilityAssetIds.length) {
          throw new Response(
            "The selected inventory item could not be found.",
            { status: 404 }
          );
        }
        const assetModelIds = Array.from(
          new Set(
            assets
              .map(({ assetModelId }) => assetModelId)
              .filter((id): id is string => Boolean(id))
          )
        );
        const assetModels = assetModelIds.length
          ? await db.assetModel.findMany({
              where: {
                id: { in: assetModelIds },
                organizationId: readOrganizationId,
              },
              select: { id: true },
            })
          : [];
        const validModelIds = new Set(assetModels.map(({ id }) => id));
        visibilityPermissionEntities = Array.from(
          new Set(
            assets.map(({ assetModelId }) =>
              assetModelId && validModelIds.has(assetModelId)
                ? PermissionEntity.assetModel
                : PermissionEntity.asset
            )
          )
        );
        permissionEntity =
          visibilityPermissionEntities[0] ?? PermissionEntity.asset;
        visibilityPermissionEntities = visibilityPermissionEntities.slice(1);
      } else {
        const singleAssetId = visibilityAssetIds[0];
        const asset = await db.asset.findFirst({
          where: { id: singleAssetId, organizationId: readOrganizationId },
          select: { assetModelId: true },
        });
        if (!asset) {
          throw new Response(
            "The selected inventory item could not be found.",
            { status: 404 }
          );
        }
        if (asset.assetModelId) {
          const model = await db.assetModel.findFirst({
            where: {
              id: asset.assetModelId,
              organizationId: readOrganizationId,
            },
            select: { id: true },
          });
          if (model) permissionEntity = PermissionEntity.assetModel;
        }
      }
    }

    const { organizationId, canUseBarcodes, role } = await requirePermission({
      userId,
      request,
      entity: permissionEntity,
      action: intent2ActionMap[intent],
    });
    for (const entity of visibilityPermissionEntities) {
      await requirePermission({
        userId,
        request,
        entity,
        action: PermissionAction.update,
      });
    }

    // Fetch asset index settings to determine mode
    const settings = await getAssetIndexSettings({
      userId,
      organizationId,
      canUseBarcodes,
      role,
    });

    switch (intent) {
      case "hide-asset":
      case "unhide-asset": {
        const hidden = intent === "hide-asset";
        const assetIds = visibilityAssetIds ?? [];
        if (assetIds.length === 1) {
          await setIoioAssetHidden({
            assetId: assetIds[0],
            organizationId,
            hidden,
          });
        } else {
          await setIoioAssetsHidden({
            assetIds,
            organizationId,
            hidden,
          });
        }
        const subject = assetIds.length === 1 ? "Asset" : "Assets";
        sendNotification({
          title: hidden
            ? `${subject} hidden`
            : `${subject} visible to students`,
          message: hidden
            ? `Students can no longer discover or borrow ${
                assetIds.length === 1 ? "this item" : "these items"
              }. Existing loans are unchanged.`
            : `Students can discover and borrow ${
                assetIds.length === 1 ? "this item" : "these items"
              } again.`,
          icon: { name: "success", variant: "success" },
          senderId: authSession.userId,
        });
        return payload({
          success: true,
          assetIds,
          ...(assetIds.length === 1 ? { assetId: assetIds[0] } : {}),
          hidden,
        });
      }
      case "return-unit-to-service": {
        if (role !== "ADMIN" && role !== "OWNER") {
          throw new Response("Staff access required", { status: 403 });
        }
        const { assetId } = parseData(
          formData,
          z.object({ assetId: z.string().min(1) })
        );
        const result = await returnResolvedAssetToService({
          organizationId,
          assetId,
          staffUserId: userId,
        });
        return payload({ success: true, result });
      }
      case "add-individual-units": {
        const { assetModelId, count } = parseData(
          formData,
          z.object({
            assetModelId: z.string().min(1),
            count: z.coerce.number().int().min(1).max(100),
          })
        );

        const result = await addIndividualUnitsToAssetModel({
          assetModelId,
          count,
          organizationId,
          userId,
        });

        sendNotification({
          title: "Physical units added",
          message: `${result.addedCount} physical units were added with new QR identities.`,
          icon: { name: "success", variant: "success" },
          senderId: authSession.userId,
        });

        return payload({
          success: true,
          addedCount: result.addedCount,
          createdAssetIds: result.createdAssetIds,
        });
      }
      case ASSET_LIFECYCLE_INTENT.ARCHIVE: {
        const { assetIds } = parseData(
          formData,
          z
            .object({ assetIds: z.array(z.string()).min(1) })
            .and(CurrentSearchParamsSchema),
          {
            message:
              "Unable to archive the selected assets because the request was invalid. Please try again.",
            shouldBeCaptured: false,
          }
        );

        await archiveIoioItems({
          organizationId,
          itemIds: assetIds,
          archivedById: userId,
        });

        sendNotification({
          title: "Assets archived",
          message:
            "The selected assets were archived and can be restored later.",
          icon: { name: "success", variant: "success" },
          senderId: authSession.userId,
        });

        return payload({
          success: true,
          undo: { operation: "archive" as const },
        });
      }
      case ASSET_LIFECYCLE_INTENT.TRASH: {
        const { assetIds } = parseData(
          formData,
          z
            .object({ assetIds: z.array(z.string()).min(1) })
            .and(CurrentSearchParamsSchema),
          {
            message:
              "Unable to move the selected assets to Trash because the request was invalid. Please try again.",
            shouldBeCaptured: false,
          }
        );

        await trashIoioItems({
          organizationId,
          items: assetIds.map((itemId) => ({
            itemType: "ASSET" as const,
            itemId,
          })),
          trashedById: userId,
        });

        sendNotification({
          title: "Items deleted",
          message: "Deleted inventory items can be restored from Trash.",
          icon: { name: "success", variant: "success" },
          senderId: authSession.userId,
        });

        // Return success to the Inventory fetcher. React Router revalidates
        // the current list in place, preserving its filters and pagination.
        return payload({
          success: true,
          undo: { operation: "trash" as const },
        });
      }
      case "bulk-delete": {
        const { assetIds, currentSearchParams } = parseData(
          formData,
          z
            .object({ assetIds: z.array(z.string()).min(1) })
            .and(CurrentSearchParamsSchema)
        );

        // Acting user's timezone: when "select all" is active the deletion set
        // is resolved from the current date filters, which must truncate the
        // day in the user's tz (avoids an off-by-one for non-UTC users).
        const { timeZone } = await resolveUserFormatPrefsById(
          userId,
          getClientHint(request)
        );

        await bulkDeleteAssets({
          assetIds,
          organizationId,
          userId,
          currentSearchParams,
          settings,
          timeZone,
        });

        sendNotification({
          title: "Assets deleted",
          message: "Your assets has been deleted successfully",
          icon: { name: "success", variant: "success" },
          senderId: authSession.userId,
        });

        return payload({ success: true });
      }

      case "create-preset": {
        const { name, query } = parseData(formData, CreatePresetFormSchema);

        await createPreset({
          organizationId,
          ownerId: userId,
          name,
          query,
        });

        const savedFilterPresets = await listPresetsForUser({
          organizationId,
          ownerId: userId,
        });

        return payload({ savedFilterPresets });
      }

      case "rename-preset": {
        const { presetId, name } = parseData(formData, RenamePresetFormSchema);

        await renamePreset({
          id: presetId,
          organizationId,
          ownerId: userId,
          name,
        });

        const savedFilterPresets = await listPresetsForUser({
          organizationId,
          ownerId: userId,
        });

        return payload({ savedFilterPresets });
      }

      case "delete-preset": {
        const { presetId } = parseData(formData, DeletePresetFormSchema);

        await deletePreset({
          id: presetId,
          organizationId,
          ownerId: userId,
        });

        const savedFilterPresets = await listPresetsForUser({
          organizationId,
          ownerId: userId,
        });

        return payload({ savedFilterPresets });
      }

      case "toggle-star-preset": {
        const { presetId, starred } = parseData(
          formData,
          z.object({
            presetId: z.string().min(1),
            starred: z.string().transform((val) => val === "true"),
          })
        );

        await togglePresetStar({
          id: presetId,
          starred,
          organizationId,
          ownerId: userId,
        });

        const savedFilterPresets = await listPresetsForUser({
          organizationId,
          ownerId: userId,
        });

        return payload({ savedFilterPresets });
      }

      default: {
        checkExhaustiveSwitch(intent);
        return payload(null);
      }
    }
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    return data(error(reason), { status: reason.status });
  }
}

export function shouldRevalidate({
  actionResult,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
  /**
   * If we are toggling the sidebar, no need to revalidate this loader.
   * Revalidation happens in _layout
   */
  if (actionResult?.isTogglingSidebar) {
    return false;
  }

  return defaultShouldRevalidate;
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  { title: appendToMetaTitle(data?.header.title) },
];

export default function AssetIndexPage() {
  const { roles } = useUserRoleHelper();
  const { canImportAssets } = useLoaderData<typeof loader>();
  const canCreateAssets = userHasPermission({
    roles,
    entity: PermissionEntity.asset,
    action: PermissionAction.create,
  });

  return (
    <div className="relative">
      <Header hideQuickFind hidePageDescription />
      <StaffInventoryList
        headerActions={
          <>
            {canCreateAssets ? (
              <ImportButton
                canImportAssets={canImportAssets}
                to="/staff/import"
              />
            ) : null}
            <InventoryQrScanner
              audience="staff"
              buttonLabel="Scan QR"
              showIcon={false}
            />
            <When truthy={canCreateAssets}>
              <NewAssetDropdown canImportAssets={canImportAssets} />
            </When>
          </>
        }
        customEmptyStateContent={{
          title: "No assets yet",
          text: "Assets are the core of your inventory. Create your first asset to start tracking equipment, devices, or anything your team manages.",
          newButtonRoute: "/assets/new",
          newButtonContent: "Create your first asset",
        }}
      />
    </div>
  );
}
