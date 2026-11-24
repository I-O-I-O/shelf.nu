import { useCurrentOrganization } from "~/hooks/use-current-organization";
import { useIsUserAssetsPage } from "~/hooks/use-is-user-assets-page";
import type { AssetsFromViewItem } from "~/modules/asset/types";
import { getPrimaryLocation, isQuantityTracked } from "~/modules/asset/utils";
import { resolveDisplayCode } from "~/modules/barcode/display";
import { tw } from "~/utils/tw";
import AssetQuickActions from "./asset-quick-actions";
import { BulkListCardCheckbox } from "../../list/bulk-actions/bulk-list-card-checkbox";
import type { ListItemData } from "../../list/list-item";
import { LocationBadge } from "../../location/location-badge";
import { Button } from "../../shared/button";
import { AssetCodeBadge } from "../asset-code-badge";
import { AssetImage } from "../asset-image";
import { AssetStatusBadge } from "../asset-status-badge";
import { CategoryBadge } from "../category-badge";

export function MobileAssetCard({
  item: listItem,
  hasBulkActions = false,
}: {
  item: ListItemData;
  hasBulkActions?: boolean;
}) {
  // The loader supplies the asset view shape to both the desktop row and card.
  const item = listItem as AssetsFromViewItem;
  const isUserPage = useIsUserAssetsPage();
  const organization = useCurrentOrganization();
  const location = getPrimaryLocation(item);
  const displayCode = organization
    ? resolveDisplayCode({
        entity: item,
        organization,
        entityKind: "asset",
      })
    : null;
  const quantity =
    isQuantityTracked(item) && item.quantity != null ? item.quantity : null;
  const quantityLabel = quantity == null ? null : `${quantity} total`;
  const actionAsset = {
    id: item.id,
    title: item.title,
    mainImage: item.mainImage,
    qrId: item.qrCodes?.[0]?.id,
    sequentialId: item.sequentialId,
  };

  return (
    <article className="w-full min-w-0 rounded-lg border border-gray-200 bg-white p-3 shadow-sm">
      <div className="flex min-w-0 items-start gap-2">
        {hasBulkActions ? <BulkListCardCheckbox item={item} /> : null}
        <AssetImage
          asset={{
            id: item.id,
            mainImage: item.mainImage,
            thumbnailImage: item.thumbnailImage,
            mainImageExpiration: item.mainImageExpiration,
            assetModel: item.assetModel ?? null,
          }}
          alt={`Image of ${item.title}`}
          className="size-14 shrink-0 rounded border object-cover"
          withPreview
        />
        <div className="min-w-0 flex-1">
          <Button
            to={`/assets/${item.id}`}
            variant="link"
            className="block max-w-full break-words text-left font-semibold leading-snug text-gray-900 hover:text-gray-700"
          >
            {item.title}
          </Button>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <AssetStatusBadge
              id={item.id}
              status={item.status}
              availableToBook={item.availableToBook}
              asset={item}
            />
            {quantityLabel ? (
              <span className="text-xs font-medium text-gray-600">
                {quantityLabel}
                {item.unitOfMeasure ? ` ${item.unitOfMeasure}` : " units"}
              </span>
            ) : null}
            {!isUserPage && displayCode ? (
              <AssetCodeBadge {...displayCode} />
            ) : null}
          </div>
        </div>
        {!isUserPage ? (
          <AssetQuickActions
            asset={actionAsset}
            compact
            className="-mr-1 -mt-1"
          />
        ) : null}
      </div>

      <dl className="mt-3 grid min-w-0 grid-cols-1 gap-3 border-t border-gray-100 pt-3 text-sm min-[390px]:grid-cols-2">
        <div className="min-w-0">
          <dt className="text-xs font-medium text-gray-500">Category</dt>
          <dd className="mt-1 min-w-0">
            <CategoryBadge
              category={item.category}
              className="max-w-full whitespace-normal px-2 py-1 leading-tight [&>span]:whitespace-normal [&>span]:break-words"
            />
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs font-medium text-gray-500">Location</dt>
          <dd className="mt-1 min-w-0">
            {location ? (
              <LocationBadge
                location={{
                  id: location.id,
                  name: location.name,
                  parentId: location.parentId ?? undefined,
                  childCount: location._count?.children ?? 0,
                }}
                className={tw(
                  "ml-0 max-w-full whitespace-normal break-words",
                  "[&>span]:max-w-full [&>span]:break-words"
                )}
              />
            ) : (
              <span className="text-gray-500">Not set</span>
            )}
          </dd>
        </div>
      </dl>
    </article>
  );
}
