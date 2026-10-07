import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { data, Link, redirect, useLoaderData } from "react-router";
import { z } from "zod";
import { RecoverableCategoryList } from "~/components/ioio-staff/recoverable-category-list";
import { RecoverableInventoryList } from "~/components/ioio-staff/recoverable-inventory-list";
import { PageBackLink } from "~/components/shared/page-back-link";
import { deleteAsset, deleteOtherImages } from "~/modules/asset/service.server";
import { requireIoioStaffAccess } from "~/modules/ioio-staff/access.server";
import {
  IOIO_ITEM_DISPOSITION,
  permanentlyDeleteIoioCategory,
  removeIoioRecoveryMarker,
  restoreIoioCategory,
  restoreIoioItems,
} from "~/modules/ioio-staff/archive.server";
import { getIoioRecoverableCategories } from "~/modules/ioio-staff/recoverable-categories.server";
import { getIoioRecoverableInventoryItems } from "~/modules/ioio-staff/recoverable-items.server";
import { deleteKit, deleteKitImage } from "~/modules/kit/service.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { makeShelfError } from "~/utils/error";
import { error, payload } from "~/utils/http.server";

const ActionSchema = z.enum(["restore", "delete-permanently"]);

export async function loader({ context, request }: LoaderFunctionArgs) {
  const { organizationId } = await requireIoioStaffAccess({ context, request });
  const [items, categories] = await Promise.all([
    getIoioRecoverableInventoryItems({
      organizationId,
      disposition: IOIO_ITEM_DISPOSITION.TRASH,
    }),
    getIoioRecoverableCategories({
      organizationId,
      disposition: IOIO_ITEM_DISPOSITION.TRASH,
    }),
  ]);

  return payload({
    header: { title: `Trash - ${items.length + categories.length}` },
    items,
    categories,
  });
}

export async function action({ context, request }: ActionFunctionArgs) {
  const { organizationId, userId } = await requireIoioStaffAccess({
    context,
    request,
  });

  try {
    const formData = await request.formData();
    const categoryId = formData.get("categoryId");
    if (typeof categoryId === "string" && categoryId.length > 0) {
      const categoryIntent = z
        .enum(["restore-category", "delete-category-permanently"])
        .parse(formData.get("intent"));

      if (categoryIntent === "restore-category") {
        await restoreIoioCategory({
          organizationId,
          categoryId,
          restoredById: userId,
        });
      } else {
        await permanentlyDeleteIoioCategory({ organizationId, categoryId });
      }

      return redirect("/staff/trash");
    }

    const intent = ActionSchema.parse(formData.get("intent"));
    const itemTypes = formData.getAll("itemType").map(String);
    const itemIds = formData.getAll("itemId").map(String);
    if (
      itemTypes.length === 0 ||
      itemTypes.length !== itemIds.length ||
      !itemTypes.every((itemType) => itemType === "ASSET" || itemType === "KIT")
    ) {
      throw new Error("Select at least one inventory item.");
    }

    const items = itemIds.map((itemId, index) => ({
      itemId,
      itemType: itemTypes[index] as "ASSET" | "KIT",
    }));

    if (intent === "restore") {
      await restoreIoioItems({
        organizationId,
        items,
        restoredById: userId,
      });
    } else {
      const trashItems = await getIoioRecoverableInventoryItems({
        organizationId,
        disposition: IOIO_ITEM_DISPOSITION.TRASH,
      });
      const selectedKeys = new Set(
        items.map((item) => `${item.itemType}:${item.itemId}`)
      );
      const selectedTrashItems = trashItems.filter((item) =>
        item.lifecycleItems.some((lifecycleItem) =>
          selectedKeys.has(`${lifecycleItem.itemType}:${lifecycleItem.itemId}`)
        )
      );
      const selectedTrashLifecycleKeys = new Set(
        selectedTrashItems.flatMap((item) =>
          item.lifecycleItems.map(
            (lifecycleItem) =>
              `${lifecycleItem.itemType}:${lifecycleItem.itemId}`
          )
        )
      );

      if (
        [...selectedKeys].some(
          (selectedKey) => !selectedTrashLifecycleKeys.has(selectedKey)
        )
      ) {
        throw new Error(
          "One or more selected items are no longer in Trash. Refresh and try again."
        );
      }

      for (const item of selectedTrashItems) {
        if (item.itemType === "ASSET") {
          await deleteAsset({
            organizationId,
            id: item.itemId,
            actorUserId: userId,
          });

          if (item.assetImage?.mainImage) {
            await deleteOtherImages({
              userId,
              assetId: item.itemId,
              data: { path: `main-image-${item.itemId}.jpg` },
            });
          }
        } else {
          await deleteKit({
            id: item.itemId,
            organizationId,
            actorUserId: userId,
          });

          if (item.kitImage?.image) {
            await deleteKitImage({ url: item.kitImage.image });
          }
        }

        await removeIoioRecoveryMarker({
          organizationId,
          itemType: item.itemType,
          itemId: item.itemId,
        });
      }
    }

    return redirect("/staff/trash");
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    return data(error(reason), { status: reason.status });
  }
}

export const meta: MetaFunction<typeof loader> = ({ data: loaderData }) => [
  {
    title: loaderData ? appendToMetaTitle(loaderData.header.title) : "Trash",
  },
];

export const handle = {
  breadcrumb: () => <Link to="/staff/trash">Trash</Link>,
};

export default function StaffTrashPage() {
  const { items, categories } = useLoaderData<typeof loader>();

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <PageBackLink to="/assets" className="mb-5">
            Back to inventory
          </PageBackLink>
          <p className="text-xs font-black uppercase tracking-[0.18em] text-red-800">
            Inventory
          </p>
          <h1 className="mt-2 text-3xl font-black tracking-tight text-gray-950">
            Trash
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            Deleted items stay recoverable here and keep their native Shelf
            data.
          </p>
        </div>
      </header>
      <RecoverableCategoryList categories={categories} mode="trash" />
      <RecoverableInventoryList items={items} mode="trash" />
    </div>
  );
}
