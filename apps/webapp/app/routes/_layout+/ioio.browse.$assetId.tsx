import { useLoaderData } from "react-router";
import { data, type LoaderFunctionArgs, type MetaFunction } from "react-router";
import { z } from "zod";
import { AssetDetailInformation } from "~/components/assets/asset-detail-information";
import { AskAboutItemButton } from "~/components/ioio/ask-about-item-button";
import { groupStudentAssets } from "~/components/ioio-student/inventory-presentation";
import {
  formatStudentTitle,
  StudentAssetPlaceholder,
  StudentCheckoutButton,
} from "~/components/ioio-student/student-ui";
import { PageBackLink } from "~/components/shared/page-back-link";
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
  parentPath: string[] = [],
  paths = new Map<string, string[]>()
) {
  for (const location of locations) {
    const path = [...parentPath, location.name];
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
  const availability =
    asset.type === "INDIVIDUAL"
      ? `${asset.quantity ?? 1} physical units, ${
          asset.availableQuantity ?? 0
        } available`
      : asset.availableQuantity
      ? `${asset.availableQuantity} available`
      : "Unavailable";

  return (
    <div className="mx-auto max-w-3xl">
      <PageBackLink to="/ioio" className="mb-5">
        Back to Inventory
      </PageBackLink>
      <h1 className="mb-5 text-3xl font-black tracking-tight text-gray-950 sm:text-4xl">
        {formatStudentTitle(asset.title, asset.type)}
      </h1>
      <div className="mb-5">
        <AskAboutItemButton
          itemName={formatStudentTitle(asset.title, asset.type)}
          assetId={asset.id}
          kitId={asset.kits[0]?.id}
          locationId={asset.locations[0]?.id}
          to="/ioio/ask"
        />
      </div>

      <div className="space-y-4">
        <section className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
          <StudentAssetPlaceholder asset={asset} variant="detail" />
          <div className="p-5">
            <div className="mt-4 flex justify-end">
              <StudentCheckoutButton asset={asset} />
            </div>
          </div>
        </section>

        <AssetDetailInformation
          categoryName={asset.category?.name}
          locations={asset.locations.map((location) => ({
            path: paths.get(location.id) ?? [location.name],
            href: `/ioio/browse?location=${location.id}`,
          }))}
          availability={availability}
          tracking={
            asset.type === "INDIVIDUAL" ? "Individual QR tracking" : null
          }
          maxBorrowDays={asset.maxBorrowDays}
          description={asset.description}
        />
      </div>
    </div>
  );
}
