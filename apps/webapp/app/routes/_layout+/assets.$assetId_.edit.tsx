import { useMemo } from "react";
import {
  AssetStatus,
  AssetType,
  BookingStatus,
  TagUseFor,
} from "@prisma/client";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { data, redirect, useLoaderData } from "react-router";
import { z } from "zod";
import { NewAssetFormSchema } from "~/components/assets/form";
import { IoioAssetCreateForm } from "~/components/assets/ioio-asset-create-form";
import { IoioPhysicalUnitEditForm } from "~/components/assets/ioio-physical-unit-edit-form";

import Header from "~/components/layout/header";
import type { HeaderData } from "~/components/layout/header/types";
import { db } from "~/database/db.server";
import {
  getPhysicalUnitNumberFromTitle,
  normalizePhysicalUnitNumber,
} from "~/modules/asset/physical-unit";
import {
  bulkUpdateAssetCategory,
  bulkUpdateAssetLocation,
  getAllEntriesForCreateAndEdit,
  getAsset,
  convertIndividualProductToQuantityTracked,
  convertQuantityTrackedAssetBulk,
  ensureIndividualAssetModel,
  setIndividualAssetAvailability,
  updateAsset,
  updateAssetMainImage,
} from "~/modules/asset/service.server";
import { getPrimaryLocation } from "~/modules/asset/utils";
import { getAssetIndexSettings } from "~/modules/asset-index-settings/service.server";
import {
  clearAssetModelImage,
  getAssetModel,
  getAssetModels,
  updateAssetModel,
  updateAssetModelImage,
} from "~/modules/asset-model/service.server";
import { getActiveCustomFields } from "~/modules/custom-field/service.server";
import { getIoioArchivedItemIds } from "~/modules/ioio-staff/archive.server";
import { updateKitLocation } from "~/modules/kit/service.server";
import { createQr } from "~/modules/qr/service.server";

import { buildTagsSet } from "~/modules/tag/service.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { extractBarcodesFromFormData } from "~/utils/barcode-form-data.server";
import {
  extractCustomFieldValuesFromPayload,
  mergedSchema,
} from "~/utils/custom-fields";
import { sendNotification } from "~/utils/emitter/send-notification.server";
import { makeShelfError, ShelfError } from "~/utils/error";
import {
  assertIsPost,
  payload,
  error,
  getCurrentSearchParams,
  getParams,
  getRefererPath,
  parseData,
  safeRedirect,
} from "~/utils/http.server";
import { Logger } from "~/utils/logger";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";
import { slugify } from "~/utils/slugify";
import { removeStorageImageObject } from "~/utils/storage.server";

export type AssetEditLoaderData = typeof loader;

async function getPhysicalUnitAvailabilityBlock({
  id,
  organizationId,
  status,
}: {
  id: string;
  organizationId: string;
  status: AssetStatus;
}): Promise<string | null> {
  if (status === AssetStatus.CHECKED_OUT) {
    return "This unit is checked out and cannot be marked available until it is returned.";
  }
  if (status === AssetStatus.IN_CUSTODY) {
    return "This unit is assigned to someone and must be released from custody first.";
  }

  const [custody, activeBooking, preparationHold, unresolvedIssue] =
    await Promise.all([
      db.custody.findFirst({ where: { assetId: id }, select: { id: true } }),
      db.bookingAsset.findFirst({
        where: {
          assetId: id,
          checkedInAt: null,
          booking: {
            organizationId,
            status: {
              in: [
                BookingStatus.RESERVED,
                BookingStatus.ONGOING,
                BookingStatus.OVERDUE,
              ],
            },
          },
        },
        select: { id: true },
      }),
      db.ioioWriteOperation.findFirst({
        where: {
          organizationId,
          assetId: id,
          operationType: "IOIO_PREPARATION",
          status: { in: ["READY_FOR_PICKUP", "CANCELLED_PICKUP"] },
        },
        select: { status: true },
      }),
      db.ioioWriteOperation.findFirst({
        where: {
          organizationId,
          assetId: id,
          operationType: "REPORT_PROBLEM",
          status: "SUCCEEDED",
        },
        select: { id: true },
      }),
    ]);

  if (custody) {
    return "This unit is assigned to someone and must be released from custody first.";
  }
  if (activeBooking) {
    return "This unit is part of an active loan or reservation.";
  }
  if (preparationHold?.status === "CANCELLED_PICKUP") {
    return "This unit is waiting to be put back after a cancelled pickup.";
  }
  if (preparationHold) {
    return "This unit is staged for pickup and must be checked back in first.";
  }
  if (unresolvedIssue) {
    return "Resolve the existing issue report before changing availability.";
  }
  return null;
}

export async function loader({ context, request, params }: LoaderFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;
  const { assetId: id } = getParams(params, z.object({ assetId: z.string() }), {
    additionalData: { userId },
  });

  try {
    const productGroupMode =
      new URL(request.url).searchParams.get("productGroup") === "1";
    const { organizationId, currentOrganization, userOrganizations } =
      await requirePermission({
        userId,
        request,
        entity: PermissionEntity.asset,
        action: PermissionAction.update,
      });

    const asset = await getAsset({
      organizationId,
      id,
      include: {
        tags: true,
        customFields: true,
        assetKits: {
          select: {
            kit: {
              select: {
                id: true,
                name: true,
                locationId: true,
              },
            },
          },
        },
        // Pull the primary placement so the edit form can pre-fill the
        // location picker.
        assetLocations: {
          select: {
            locationId: true,
            location: { select: { id: true, name: true } },
          },
        },
        barcodes: {
          select: {
            id: true,
            type: true,
            value: true,
          },
        },
        qrCodes: {
          take: 1,
          select: { id: true, createdAt: true },
        },
        assetModel: { select: { id: true, name: true } },
      },
      userOrganizations,
      request,
    });

    const isPhysicalUnit =
      asset.type === AssetType.INDIVIDUAL && Boolean(asset.assetModelId);
    const availabilityBlock = isPhysicalUnit
      ? await getPhysicalUnitAvailabilityBlock({ id, organizationId, asset })
      : null;

    if (
      productGroupMode &&
      (!asset.assetModelId || asset.type !== "INDIVIDUAL")
    ) {
      return redirect(`/assets/${encodeURIComponent(id)}/edit`);
    }

    const archivedAssetIds = asset.assetModelId
      ? await getIoioArchivedItemIds({
          organizationId,
          itemType: "ASSET",
        })
      : [];
    const productGroup =
      productGroupMode && asset.assetModelId
        ? await getAssetModel({
            id: asset.assetModelId,
            organizationId,
          })
        : null;
    const physicalUnitRecords = asset.assetModelId
      ? await db.asset.findMany({
          where: {
            organizationId,
            assetModelId: asset.assetModelId,
            type: "INDIVIDUAL",
            id: { notIn: archivedAssetIds },
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: {
            id: true,
            title: true,
            status: true,
            assetLocations: { select: { locationId: true } },
            qrCodes: {
              take: 1,
              select: { id: true, createdAt: true },
            },
          },
        })
      : asset.type === "INDIVIDUAL"
      ? [
          {
            id: asset.id,
            title: asset.title,
            status: asset.status,
            assetLocations: asset.assetLocations.map(({ locationId }) => ({
              locationId,
            })),
            qrCodes: asset.qrCodes?.slice(0, 1) ?? [],
          },
        ]
      : [];
    const physicalUnits = physicalUnitRecords.map((unit) => ({
      id: unit.id,
      title: unit.title,
      status: unit.status,
      assetLocations: unit.assetLocations,
      qrId: unit.qrCodes[0]?.id ?? null,
      qrCreatedAt: unit.qrCodes[0]?.createdAt ?? null,
    }));

    const productLocationIds = productGroup
      ? Array.from(
          new Set(
            physicalUnits.map(
              (unit) => unit.assetLocations[0]?.locationId ?? null
            )
          )
        )
      : [];
    const productLocationIsMixed = productLocationIds.length > 1;
    const productLocationId = productLocationIsMixed
      ? null
      : productLocationIds[0] ?? null;

    const [
      { categories, totalCategories, tags, locations, totalLocations },
      { assetModels, totalAssetModels },
    ] = await Promise.all([
      getAllEntriesForCreateAndEdit({
        request,
        organizationId,
        defaults: {
          category: asset.categoryId,
          location: productGroup
            ? productLocationId
            : getPrimaryLocation(asset)?.id ?? null,
        },
        tagUseFor: TagUseFor.ASSET,
      }),
      getAssetModels({ organizationId, page: 1, perPage: 100 }),
    ]);

    const searchParams = getCurrentSearchParams(request);

    const customFields = await getActiveCustomFields({
      organizationId,
      category: searchParams.get("category") ?? asset.categoryId,
    });

    const header: HeaderData = {
      title: `Edit | ${productGroup?.name ?? asset.title}`,
      subHeading: asset.id,
    };

    return payload({
      asset,
      productGroup,
      productLocationId,
      productLocationIsMixed,
      header,
      categories,
      totalCategories,
      tags,
      totalTags: tags.length,
      locations,
      totalLocations,
      assetModels,
      totalAssetModels,
      physicalUnits,
      availabilityBlock,
      currency: currentOrganization?.currency,
      customFields,
      referer: getRefererPath(request),
    });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId, id });
    throw data(error(reason), { status: reason.status });
  }
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  { title: data ? appendToMetaTitle(data.header.title) : "" },
];

export const handle = {
  breadcrumb: () => "single",
};

export async function action({ context, request, params }: ActionFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;
  const { assetId: id } = getParams(params, z.object({ assetId: z.string() }), {
    additionalData: { userId },
  });

  try {
    assertIsPost(request);

    const { organizationId, canUseBarcodes, role } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.asset,
      action: PermissionAction.update,
    });

    const clonedRequest = request.clone();
    const formData = await clonedRequest.formData();

    if (formData.get("intent") === "physical-unit-availability") {
      const { availabilityAction } = parseData(
        formData,
        z.object({
          availabilityAction: z.enum(["available", "unavailable"]),
        })
      );
      try {
        const result = await setIndividualAssetAvailability({
          id,
          detailAssetId: id,
          organizationId,
          userId,
          action: availabilityAction,
        });
        return payload({
          success: true,
          intent: "physical-unit-availability",
          availableToBook: result.availableToBook,
        });
      } catch (cause) {
        if (cause instanceof ShelfError && cause.status === 409) {
          return data(
            { success: false, error: { message: cause.message } },
            { status: 409 }
          );
        }
        throw cause;
      }
    }

    if (formData.get("intent") === "ensure-individual-model") {
      const assetModelId = await ensureIndividualAssetModel({
        id,
        organizationId,
        userId,
      });

      return payload({ assetModelId });
    }

    if (
      formData.get("intent") === "update-physical-unit-number" ||
      formData.get("intent") === "ensure-physical-unit-qr"
    ) {
      const unitId = String(formData.get("unitId") ?? "");
      if (formData.get("intent") === "update-physical-unit-number") {
        await requirePermission({
          userId,
          request,
          entity: PermissionEntity.assetModel,
          action: PermissionAction.update,
        });
      }
      const parent = await db.asset.findFirst({
        where: { id, organizationId },
        select: { assetModelId: true, type: true },
      });
      const unit = unitId
        ? await db.asset.findFirst({
            where: {
              id: unitId,
              organizationId,
              type: AssetType.INDIVIDUAL,
              assetModelId: parent?.assetModelId ?? "__missing__",
            },
            select: {
              id: true,
              title: true,
              assetModelId: true,
              qrCodes: { take: 1, select: { id: true } },
            },
          })
        : null;
      const archivedUnit = unitId
        ? await db.ioioArchivedItem.findFirst({
            where: {
              organizationId,
              itemType: "ASSET",
              itemId: unitId,
              restoredAt: null,
            },
            select: { itemId: true },
          })
        : null;

      if (
        !parent?.assetModelId ||
        parent.type !== AssetType.INDIVIDUAL ||
        !unit ||
        archivedUnit
      ) {
        throw new ShelfError({
          cause: null,
          title: "Physical unit not found",
          message: "This physical unit is no longer part of the product.",
          label: "Assets",
          status: 404,
          shouldBeCaptured: false,
        });
      }

      if (formData.get("intent") === "update-physical-unit-number") {
        const normalizedUnitNumber = normalizePhysicalUnitNumber(
          String(formData.get("unitNumber") ?? "")
        );
        if (!normalizedUnitNumber) {
          throw new ShelfError({
            cause: null,
            title: "Invalid unit number",
            message: "Enter a unit number such as 001 or #001.",
            label: "Assets",
            status: 400,
            shouldBeCaptured: false,
          });
        }

        const siblings = await db.asset.findMany({
          where: {
            organizationId,
            assetModelId: parent.assetModelId,
            type: AssetType.INDIVIDUAL,
            NOT: { id: unit.id },
          },
          select: { id: true, title: true },
        });
        const duplicate = siblings.find(
          (sibling) =>
            getPhysicalUnitNumberFromTitle(sibling.title) ===
            normalizedUnitNumber
        );
        if (duplicate) {
          throw new ShelfError({
            cause: null,
            title: "Unit number already exists",
            message: `Unit #${normalizedUnitNumber} already exists for this product.`,
            label: "Assets",
            status: 409,
            shouldBeCaptured: false,
          });
        }

        const productModel = await db.assetModel.findFirst({
          where: { id: parent.assetModelId, organizationId },
          select: { name: true },
        });
        if (!productModel) {
          throw new ShelfError({
            cause: null,
            message: "The product model could not be found.",
            label: "Assets",
            status: 404,
            shouldBeCaptured: false,
          });
        }

        await db.asset.update({
          where: { id: unit.id, organizationId },
          data: { title: `${productModel.name} #${normalizedUnitNumber}` },
        });
        return payload({
          success: true,
          intent: "update-physical-unit-number",
          unitId: unit.id,
        });
      }

      const qrId =
        unit.qrCodes[0]?.id ??
        (
          await createQr({
            userId,
            assetId: unit.id,
            organizationId,
          })
        ).id;
      return payload({
        success: true,
        intent: "ensure-physical-unit-qr",
        unitId: unit.id,
        qrId,
      });
    }

    if (formData.get("intent") === "convert-product-to-quantity") {
      await requirePermission({
        userId,
        request,
        entity: PermissionEntity.assetModel,
        action: PermissionAction.update,
      });
      const conversion = await convertIndividualProductToQuantityTracked({
        id,
        organizationId,
        userId,
      });
      sendNotification({
        title: "Tracking changed",
        message: `The product is now tracked as one Quantity item with ${conversion.quantity} units.`,
        icon: { name: "success", variant: "success" },
        senderId: userId,
      });
      return payload(conversion);
    }

    if (formData.get("intent") === "convert-all-units") {
      const conversion = await convertQuantityTrackedAssetBulk({
        id,
        organizationId,
        userId,
      });

      sendNotification({
        title: "Quantity converted",
        message: `${conversion.convertedCount} individual assets are now tracked separately.`,
        icon: { name: "success", variant: "success" },
        senderId: userId,
      });

      return payload({
        convertedAssetIds: conversion.createdAssetIds,
        convertedCount: conversion.convertedCount,
        remainingQuantity: conversion.remainingQuantity,
      });
    }

    const searchParams = getCurrentSearchParams(request);

    const customFields = await getActiveCustomFields({
      organizationId,
      category:
        searchParams.get("category") ?? String(formData.get("category")),
    });

    const FormSchema = mergedSchema({
      baseSchema: NewAssetFormSchema,
      customFields: customFields.map((cf) => ({
        id: cf.id,
        name: slugify(cf.name),
        helpText: cf?.helpText || "",
        required: cf.required,
        type: cf.type.toLowerCase() as "text" | "number" | "date" | "boolean",
        options: cf.options,
      })),
    });

    const parsedData = parseData(formData, FormSchema, {
      additionalData: { userId, organizationId },
    });

    if (
      formData.get("productGroup") === "1" ||
      new URL(request.url).searchParams.get("productGroup") === "1"
    ) {
      await requirePermission({
        userId,
        request,
        entity: PermissionEntity.assetModel,
        action: PermissionAction.update,
      });

      const representative = await db.asset.findFirst({
        where: { id, organizationId },
        select: { assetModelId: true, type: true },
      });
      if (
        !representative?.assetModelId ||
        representative.type !== "INDIVIDUAL"
      ) {
        throw new ShelfError({
          cause: null,
          message: "This item is no longer an individually tracked product.",
          label: "Assets",
          status: 409,
          shouldBeCaptured: false,
        });
      }

      const productModel = await getAssetModel({
        id: representative.assetModelId,
        organizationId,
      });
      const archivedAssetIds = await getIoioArchivedItemIds({
        organizationId,
        itemType: "ASSET",
      });
      const productUnits = await db.asset.findMany({
        where: {
          organizationId,
          assetModelId: productModel.id,
          type: "INDIVIDUAL",
          id: { notIn: archivedAssetIds },
        },
        select: { id: true, title: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });

      if (productUnits.length === 0) {
        throw new ShelfError({
          cause: null,
          message: "This product has no active physical units to edit.",
          label: "Assets",
          status: 409,
          shouldBeCaptured: false,
        });
      }

      const settings = await getAssetIndexSettings({
        userId,
        organizationId,
        canUseBarcodes,
        role,
      });
      const categoryId =
        parsedData.category && parsedData.category !== "uncategorized"
          ? parsedData.category
          : null;
      const locationChangeSubmitted = formData.has("newLocationId");

      if (
        locationChangeSubmitted &&
        (parsedData.newLocationId ?? "") !==
          (parsedData.currentLocationId ?? "")
      ) {
        await bulkUpdateAssetLocation({
          userId,
          assetIds: productUnits.map((unit) => unit.id),
          organizationId,
          newLocationId: parsedData.newLocationId || null,
          currentSearchParams: null,
          settings,
          strict: true,
        });
      }

      await bulkUpdateAssetCategory({
        userId,
        assetIds: productUnits.map((unit) => unit.id),
        organizationId,
        categoryId,
        currentSearchParams: null,
        settings,
      });

      await updateAssetModel({
        id: productModel.id,
        organizationId,
        name: parsedData.title,
        description: parsedData.description,
        defaultCategoryId: categoryId,
      });

      const uploadedProductImage = await updateAssetModelImage({
        request,
        assetModelId: productModel.id,
        organizationId,
      });
      if (formData.get("clearMainImage") === "true" && !uploadedProductImage) {
        await clearAssetModelImage({
          assetModelId: productModel.id,
          organizationId,
        });
      }

      await Promise.all(
        productUnits.map((unit) => {
          const unitTitle = replaceProductNamePrefix({
            title: unit.title,
            previousName: productModel.name,
            nextName: parsedData.title,
          });
          return updateAsset({
            id: unit.id,
            ...(unitTitle ? { title: unitTitle } : {}),
            minQuantity: parsedData.minQuantity,
            requiresBorrowApproval: parsedData.requiresBorrowApproval,
            requiresStaffPreparation: parsedData.requiresStaffPreparation,
            requiresReturnPhoto: parsedData.requiresReturnPhoto,
            maxBorrowDays: parsedData.maxBorrowDays,
            extensionBorrowDays: parsedData.extensionBorrowDays,
            returnHandling: parsedData.returnHandling,
            userId,
            organizationId,
            request,
          });
        })
      );

      sendNotification({
        title: "Inventory product updated",
        message: "The product and its active physical units have been updated.",
        icon: { name: "success", variant: "success" },
        senderId: userId,
      });

      return payload({ success: true });
    }

    const customFieldsValues = extractCustomFieldValuesFromPayload({
      payload: parsedData,
      customFieldDef: customFields,
    });

    const uploadedNewImage = await updateAssetMainImage({
      request,
      assetId: id,
      userId: authSession.userId,
      organizationId,
    });

    /**
     * "Use the model's image instead" / "Remove image" — drops the asset's own
     * image so `resolveAssetImage` falls through to its model's cover image,
     * or to the placeholder when it has no model.
     *
     * Applied as part of the `updateAsset` payload below rather than as its own
     * committed write: `updateAsset` can still reject (kit-managed location,
     * quantity over pool, barcode gating, preferred-barcode membership), and a
     * standalone clear would already have nulled the image while the action
     * reports failure. The URL is a signed one-way pointer, so the user could
     * not restore it — the edit must be all-or-nothing.
     *
     * Suppressed when this same submit uploaded a replacement, so "clear +
     * upload" keeps the upload.
     */
    const shouldClearImage =
      formData.get("clearMainImage") === "true" && !uploadedNewImage;

    const {
      title,
      description,
      category,
      assetModelId,
      newLocationId,
      currentLocationId,
      valuation,
      preferredBarcodeId,
      addAnother,
      redirectTo,
      quantity,
      minQuantity,
      consumptionType,
      unitOfMeasure,
      requiresBorrowApproval,
      requiresStaffPreparation,
      requiresReturnPhoto,
      maxBorrowDays,
      extensionBorrowDays,
      returnHandling,
      type,
    } = parsedData;

    /** This checks if tags are passed and build the  */
    const tags = buildTagsSet(parsedData.tags);

    /** Extract barcode data from form */
    const barcodes = canUseBarcodes
      ? extractBarcodesFromFormData(formData)
      : [];

    /**
     * A kit-linked asset cannot receive a second manual placement when it is
     * individually tracked. In that case the location picker edits the
     * parent kit location, which already cascades the native Shelf placement
     * to its contents. Keep the asset update itself location-neutral so the
     * existing asset service remains the authority for placement writes.
     */
    let assetLocationId = newLocationId;
    let assetCurrentLocationId = currentLocationId;
    const assetWithKit = await getAsset({
      id,
      organizationId,
      request,
      include: {
        assetKits: {
          take: 1,
          select: {
            kit: { select: { id: true, locationId: true } },
          },
        },
      },
    });
    const parentKit = assetWithKit.assetKits[0]?.kit;
    if (parentKit) {
      const requestedLocationId = newLocationId || null;
      if (requestedLocationId !== parentKit.locationId) {
        await updateKitLocation({
          id: parentKit.id,
          organizationId,
          currentLocationId: parentKit.locationId,
          newLocationId: requestedLocationId,
          userId,
        });
      }

      const resolvedLocationId = requestedLocationId ?? "";
      assetLocationId = resolvedLocationId;
      assetCurrentLocationId = resolvedLocationId;
    }

    await updateAsset({
      id,
      title,
      description,
      categoryId: category ? category : "uncategorized",
      assetModelId: assetModelId || null,
      tags,
      newLocationId: assetLocationId,
      currentLocationId: assetCurrentLocationId,
      userId: authSession.userId,
      customFieldsValues,
      barcodes,
      // Only honor preferredBarcodeId when the org has the barcode add-on.
      // The UI hides the selector otherwise; this is defense-in-depth.
      preferredBarcodeId: canUseBarcodes ? preferredBarcodeId : undefined,
      valuation,
      organizationId,
      request,
      quantity,
      minQuantity,
      consumptionType,
      unitOfMeasure,
      requiresBorrowApproval,
      requiresStaffPreparation,
      requiresReturnPhoto,
      maxBorrowDays,
      extensionBorrowDays,
      returnHandling,
      type,
      // Nulled inside updateAsset's transaction — see `shouldClearImage`.
      ...(shouldClearImage && {
        mainImage: null,
        mainImageExpiration: null,
        thumbnailImage: null,
        mainImageStoragePath: null,
        thumbnailImageStoragePath: null,
      }),
    });

    if (shouldClearImage) {
      await Promise.all(
        [
          assetWithKit.mainImageStoragePath,
          assetWithKit.thumbnailImageStoragePath,
        ]
          .filter((path): path is string => !!path)
          .map((objectPath) =>
            removeStorageImageObject({ bucketName: "assets", objectPath })
          )
      ).catch((cleanupCause: unknown) => {
        Logger.dev("[IOIO IMAGE] cleared asset image cleanup failed", {
          assetId: id,
          cleanupCause,
        });
      });
    }

    sendNotification({
      title: "Asset updated",
      message: "Your asset has been updated successfully",
      icon: { name: "success", variant: "success" },
      senderId: authSession.userId,
    });

    if (addAnother) {
      return redirect(`/assets/new`);
    }

    // If redirectTo is provided, redirect back to previous page
    // Otherwise stay on current page (e.g., when opened in new tab)
    if (redirectTo) {
      return redirect(safeRedirect(redirectTo, `/assets/${id}`));
    }

    return payload({ success: true });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId, id });
    return data(error(reason), { status: reason.status });
  }
}

function replaceProductNamePrefix({
  title,
  previousName,
  nextName,
}: {
  title: string;
  previousName: string;
  nextName: string;
}) {
  if (previousName === nextName) return undefined;
  if (!title.toLocaleLowerCase().startsWith(previousName.toLocaleLowerCase())) {
    return undefined;
  }
  return `${nextName}${title.slice(previousName.length)}`;
}

export default function AssetEditPage() {
  const {
    asset,
    physicalUnits,
    availabilityBlock,
    productGroup,
    productLocationId,
    productLocationIsMixed,
    referer,
  } = useLoaderData<typeof loader>();
  const tags = useMemo(
    () => asset.tags?.map((tag) => ({ label: tag.name, value: tag.id })) || [],
    [asset.tags]
  );

  const isPhysicalUnit =
    !productGroup &&
    asset.type === AssetType.INDIVIDUAL &&
    Boolean(asset.assetModelId);
  const generalTitle = productGroup?.name ?? asset.title;

  return (
    <div className="relative">
      <Header
        title={isPhysicalUnit ? "Edit physical unit" : "Edit general item"}
        hideQuickFind
      />
      {isPhysicalUnit ? (
        <IoioPhysicalUnitEditForm
          id={asset.id}
          title={asset.title}
          status={asset.status}
          availableToBook={asset.availableToBook}
          availabilityBlock={availabilityBlock}
          qrId={asset.qrCodes[0]?.id}
        />
      ) : (
        <IoioAssetCreateForm
          id={asset.id}
          sequentialId={asset.sequentialId}
          mainImage={productGroup?.image ?? asset.mainImage}
          thumbnailImage={productGroup?.thumbnailImage ?? asset.thumbnailImage}
          mainImageExpiration={
            !productGroup && asset.mainImageExpiration
              ? new Date(asset.mainImageExpiration)
              : null
          }
          title={generalTitle}
          categoryId={asset.categoryId}
          assetModelId={asset.assetModelId}
          locationId={
            productGroup
              ? productLocationId
              : getPrimaryLocation(asset)?.id ?? null
          }
          description={productGroup?.description ?? asset.description}
          valuation={asset.valuation}
          type={asset.type}
          quantity={asset.quantity}
          minQuantity={asset.minQuantity}
          consumptionType={asset.consumptionType}
          unitOfMeasure={asset.unitOfMeasure}
          requiresBorrowApproval={asset.requiresBorrowApproval}
          requiresStaffPreparation={asset.requiresStaffPreparation}
          requiresReturnPhoto={asset.requiresReturnPhoto}
          maxBorrowDays={asset.maxBorrowDays}
          extensionBorrowDays={asset.extensionBorrowDays}
          returnHandling={asset.returnHandling}
          tags={tags}
          barcodes={asset.barcodes}
          preferredBarcodeId={asset.preferredBarcodeId}
          showAssetModel={false}
          physicalUnits={physicalUnits}
          productGroup={
            productGroup
              ? {
                  name: productGroup.name,
                  locationIsMixed: productLocationIsMixed,
                  hasImage: Boolean(productGroup.image),
                }
              : undefined
          }
          referer={referer}
        />
      )}
    </div>
  );
}
