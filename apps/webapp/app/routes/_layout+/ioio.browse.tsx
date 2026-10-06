import { Outlet, useLoaderData, useLocation } from "react-router";
import { data, type LoaderFunctionArgs } from "react-router";
import {
  filterStudentInventory,
  getStudentLabAreaFilters,
  groupStudentAssets,
} from "~/components/ioio-student/inventory-presentation";
import {
  AssetCard,
  InventoryFilterControls,
  SectionHeading,
} from "~/components/ioio-student/student-ui";
import { requireStudentRead } from "~/modules/ioio-student/route.server";
import {
  getStudentAssets,
  getStudentCategories,
  getStudentLocations,
} from "~/modules/ioio-student/service.server";
import { makeShelfError } from "~/utils/error";
import { error, payload } from "~/utils/http.server";

export async function loader({ context, request }: LoaderFunctionArgs) {
  const { userId, organizationId } = await requireStudentRead({
    context,
    request,
  });
  try {
    const params = new URL(request.url).searchParams;
    const requestedCategory = params.get("category");
    const requestedItemType = params.get("itemType");
    const itemType =
      requestedItemType === "quantity" || requestedItemType === "individual"
        ? requestedItemType
        : null;
    const [categories, locations] = await Promise.all([
      getStudentCategories({ organizationId }),
      getStudentLocations({ organizationId }),
    ]);
    const selectedCategory = categories.some(
      (category) => category.id === requestedCategory
    )
      ? requestedCategory
      : null;
    const requestedLocation = params.get("location");
    const selectedLocation = getStudentLabAreaFilters(locations).some(
      (area) => area.locationId === requestedLocation
    )
      ? requestedLocation
      : null;
    const [assets] = await Promise.all([
      getStudentAssets({
        organizationId,
        query: params.get("q"),
        categoryId: selectedCategory,
        locationId: selectedLocation,
      }),
    ]);
    const filteredAssets = filterStudentInventory(groupStudentAssets(assets), {
      categoryId: selectedCategory,
      itemType,
    });
    return data(
      payload({
        assets: filteredAssets,
        categories,
        locations,
        query: params.get("q") ?? "",
        categoryId: selectedCategory,
        itemType,
        locationId: selectedLocation,
      })
    );
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    throw data(error(reason), { status: reason.status });
  }
}

export default function IoioBrowse() {
  const location = useLocation();
  const {
    assets,
    categories,
    query,
    categoryId,
    itemType,
    locationId,
    locations,
  } = useLoaderData<typeof loader>();
  if (location.pathname !== "/ioio/browse") return <Outlet />;
  return (
    <div>
      <SectionHeading
        title="Inventory"
        text="Search current Shelf records. This view is read-only for students."
      />
      <div className="mb-5">
        <InventoryFilterControls
          basePath="/ioio/browse"
          categories={categories}
          locations={locations}
          query={query}
          locationId={locationId}
          categoryId={categoryId}
          itemType={itemType}
        />
      </div>

      <p className="mb-4 text-sm text-gray-600" aria-live="polite">
        {assets.length} result{assets.length === 1 ? "" : "s"}
      </p>
      {assets.length ? (
        <div className="grid gap-3 md:grid-cols-2">
          {assets.map((asset) => (
            <AssetCard key={asset.id} asset={asset} />
          ))}
        </div>
      ) : (
        <div className="rounded-2xl border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-600">
          No matching Shelf assets. Try a different search.
        </div>
      )}
    </div>
  );
}
