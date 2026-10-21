import { useLoaderData } from "react-router";
import { data, type LoaderFunctionArgs, type MetaFunction } from "react-router";
import { z } from "zod";
import { AssetDetailImage } from "~/components/assets/asset-image";
import { IoioAssetDetailLayout } from "~/components/ioio-staff/ioio-asset-detail-layout";
import {
  getStudentBrowseLocationIdForPath,
  groupStudentAssets,
} from "~/components/ioio-student/inventory-presentation";
import {
  formatStudentTitle,
  StudentCheckoutButton,
} from "~/components/ioio-student/student-ui";
import { requireStudentRead } from "~/modules/ioio-student/route.server";
import {
  getStudentAsset,
  getStudentAssets,
  getStudentLocations,
  type StudentLocation,
} from "~/modules/ioio-student/service.server";
import { makeShelfError } from "~/utils/error";
import { error, getParams, payload } from "~/utils/http.server";

export const meta: MetaFunction<typeof loader> = () => [
  { title: "Inventory item" },
];

export async function loader({ context, request, params }: LoaderFunctionArgs) {
  const { userId, organizationId } = await requireStudentRead({
    context,
    request,
  });
  const { assetId } = getParams(params, z.object({ assetId: z.string() }));
  try {
    const [asset, allAssets, locations] = await Promise.all([
      getStudentAsset({ organizationId, assetId }),
      getStudentAssets({ organizationId }),
      getStudentLocations({ organizationId }),
    ]);
    if (!asset) throw new Response("Not found", { status: 404 });
    const groupedAssets = groupStudentAssets(allAssets);
    let groupedAsset = groupedAssets.find((candidate) =>
      candidate.sourceAssetIds.includes(assetId)
    );
    // A converted quantity source can still be reached through an older link,
    // even though it is intentionally hidden from the catalog. Resolve that
    // link to the same active physical-unit group used by the catalog so the
    // detail page cannot fall back to the retired zero-quantity row.
    if (
      !groupedAsset &&
      asset.type === "QUANTITY_TRACKED" &&
      (asset.quantity ?? 0) <= 0
    ) {
      const normalizedTitle = normalizeProductTitle(asset.title);
      groupedAsset = groupedAssets.find(
        (candidate) =>
          candidate.type === "INDIVIDUAL" &&
          normalizeProductTitle(candidate.title) === normalizedTitle
      );
    }
    return data(payload({ asset: groupedAsset ?? asset, locations }));
  } catch (cause) {
    const reason = makeShelfError(cause, { userId, assetId });
    throw data(error(reason), { status: reason.status });
  }
}

function locationPaths(
  locations: StudentLocation[],
  parentPath: { names: string[]; ids: string[] } = { names: [], ids: [] },
  paths = new Map<string, { names: string[]; ids: string[] }>()
) {
  for (const location of locations) {
    const path = {
      names: [...parentPath.names, location.name],
      ids: [...parentPath.ids, location.id],
    };
    paths.set(location.id, path);
    locationPaths(location.children, path, paths);
  }
  return paths;
}

function normalizeProductTitle(title: string) {
  return title
    .trim()
    .replace(/\s+#\d+$/u, "")
    .toLocaleLowerCase();
}

export default function IoioAssetDetail() {
  const { asset, locations } = useLoaderData<typeof loader>();
  const paths = locationPaths(locations);
  const totalQuantity =
    asset.type === "INDIVIDUAL"
      ? asset.quantity ?? 1
      : asset.type === "QUANTITY_TRACKED"
      ? asset.quantity ?? asset.availableQuantity ?? 0
      : 1;
  const availableQuantity = asset.availableToBook
    ? Math.max(0, asset.availableQuantity ?? 0)
    : 0;
  const unitLabel =
    asset.type === "INDIVIDUAL"
      ? "kits"
      : asset.type === "QUANTITY_TRACKED"
      ? "items"
      : "item";

  return (
    <IoioAssetDetailLayout
      backTo="/ioio"
      backLabel="Back to inventory"
      title={formatStudentTitle(asset.title, asset.type)}
      description={asset.description}
      image={
        <AssetDetailImage
          asset={asset}
          alt={`Image of ${formatStudentTitle(asset.title, asset.type)}`}
        />
      }
      actions={<StudentCheckoutButton asset={asset} primary />}
      categoryName={asset.category?.name}
      locations={asset.locations.map((location) => {
        const locationPath = paths.get(location.id);
        const browseLocationId = getStudentBrowseLocationIdForPath(
          locationPath?.ids ?? [location.id],
          locations
        );

        return {
          path: locationPath?.names ?? [location.name],
          href: browseLocationId
            ? `/ioio?location=${encodeURIComponent(browseLocationId)}`
            : "/ioio",
        };
      })}
      availableQuantity={availableQuantity}
      totalQuantity={totalQuantity}
      unitLabel={unitLabel}
      tracking={asset.type === "INDIVIDUAL" ? "Individual QR tracking" : null}
      maxBorrowDays={asset.maxBorrowDays}
    />
  );
}
