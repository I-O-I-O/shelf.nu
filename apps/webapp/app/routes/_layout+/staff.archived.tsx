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
import { requireIoioStaffAccess } from "~/modules/ioio-staff/access.server";
import {
  IOIO_ITEM_DISPOSITION,
  moveIoioCategoryToDisposition,
  restoreIoioCategory,
  restoreIoioItems,
  trashIoioItems,
} from "~/modules/ioio-staff/archive.server";
import { getIoioRecoverableCategories } from "~/modules/ioio-staff/recoverable-categories.server";
import { getIoioRecoverableInventoryItems } from "~/modules/ioio-staff/recoverable-items.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { makeShelfError } from "~/utils/error";
import { error, payload } from "~/utils/http.server";

const ActionSchema = z.enum(["restore", "trash"]);

export async function loader({ context, request }: LoaderFunctionArgs) {
  const { organizationId } = await requireIoioStaffAccess({ context, request });
  const [items, categories] = await Promise.all([
    getIoioRecoverableInventoryItems({
      organizationId,
      disposition: IOIO_ITEM_DISPOSITION.ARCHIVE,
    }),
    getIoioRecoverableCategories({
      organizationId,
      disposition: IOIO_ITEM_DISPOSITION.ARCHIVE,
    }),
  ]);

  return payload({
    header: {
      title: `Archived inventory - ${items.length + categories.length}`,
    },
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
        .enum(["restore-category", "trash-category"])
        .parse(formData.get("intent"));

      if (categoryIntent === "restore-category") {
        await restoreIoioCategory({
          organizationId,
          categoryId,
          restoredById: userId,
        });
      } else {
        await moveIoioCategoryToDisposition({
          organizationId,
          categoryId,
          movedById: userId,
          disposition: IOIO_ITEM_DISPOSITION.TRASH,
        });
      }

      return redirect("/staff/archived");
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

    if (intent === "trash") {
      await trashIoioItems({
        organizationId,
        items,
        trashedById: userId,
      });
    } else {
      await restoreIoioItems({
        organizationId,
        items,
        restoredById: userId,
      });
    }

    return redirect("/staff/archived");
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    return data(error(reason), { status: reason.status });
  }
}

export const meta: MetaFunction<typeof loader> = ({ data: loaderData }) => [
  {
    title: loaderData
      ? appendToMetaTitle(loaderData.header.title)
      : "Archived inventory",
  },
];

export const handle = {
  breadcrumb: () => <Link to="/staff/archived">Archived</Link>,
};

export default function StaffArchivedInventoryPage() {
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
            Archived inventory
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            Archived items remain recoverable and keep their native Shelf data.
          </p>
        </div>
      </header>
      <RecoverableCategoryList categories={categories} mode="archive" />
      <RecoverableInventoryList items={items} mode="archive" />
    </div>
  );
}
