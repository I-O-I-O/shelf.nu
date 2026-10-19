import { Link, Outlet, useLoaderData, useLocation } from "react-router";
import { data, type LoaderFunctionArgs, type MetaFunction } from "react-router";
import { ErrorContent } from "~/components/errors";
import {
  filterStudentInventory,
  getStudentLocationPath,
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

export const meta: MetaFunction<typeof loader> = () => [
  { title: "Browse equipment | IOIO Lab" },
];

export async function loader({ context, request }: LoaderFunctionArgs) {
  const { userId, organizationId } = await requireStudentRead({
    context,
    request,
  });
  try {
    const params = new URL(request.url).searchParams;
    const requestedCategory = params.get("category");
    const requestedItemType = params.get("itemType");
    const requestedAvailability = params.get("availability");
    const availability =
      requestedAvailability === "available" ||
      requestedAvailability === "unavailable"
        ? requestedAvailability
        : null;
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
    const selectedLocation = requestedLocation
      ? getStudentLocationPath(requestedLocation, locations)
        ? requestedLocation
        : null
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
      availability,
    });
    return data(
      payload({
        assets: filteredAssets,
        categories,
        locations,
        query: params.get("q") ?? "",
        categoryId: selectedCategory,
        itemType,
        availability,
        locationId: selectedLocation,
        hasSearchOrFilters: Boolean(
          params.get("q")?.trim() ||
            selectedCategory ||
            itemType ||
            selectedLocation ||
            availability
        ),
      })
    );
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    throw data(error(reason), { status: reason.status });
  }
}

export const ErrorBoundary = () => <ErrorContent />;

export default function IoioBrowse() {
  const location = useLocation();
  const {
    assets,
    categories,
    query,
    categoryId,
    itemType,
    availability,
    locationId,
    locations,
    hasSearchOrFilters,
  } = useLoaderData<typeof loader>();
  if (location.pathname !== "/ioio/browse") return <Outlet />;
  return (
    <div>
      <SectionHeading
        title="Browse equipment"
        text="Find equipment by name, lab area, or type. Check what is ready to borrow and add it to your borrow list."
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
          availability={availability}
        />
      </div>

      <p className="mb-4 text-sm text-gray-600" aria-live="polite">
        Showing {assets.length} {assets.length === 1 ? "item" : "items"}
      </p>
      {assets.length ? (
        <div className="grid gap-3 md:grid-cols-2">
          {assets.map((asset) => (
            <AssetCard key={asset.id} asset={asset} />
          ))}
        </div>
      ) : (
        <div className="rounded-2xl border border-dashed border-gray-300 bg-white p-6 text-center sm:p-8">
          <h2 className="font-bold text-gray-950">
            {hasSearchOrFilters
              ? "No equipment matches your search"
              : "No equipment is listed yet"}
          </h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-gray-600">
            {hasSearchOrFilters
              ? "Try a different search or clear your filters to see more equipment."
              : "Check back later, or ask a lab assistant for help."}
          </p>
          {hasSearchOrFilters ? (
            <Link
              to="/ioio/browse"
              className="mt-4 inline-flex min-h-10 items-center rounded-xl bg-red-700 px-4 text-sm font-bold text-white hover:bg-red-800 focus:outline-none focus:ring-2 focus:ring-red-700 focus:ring-offset-2"
            >
              Clear search and filters
            </Link>
          ) : null}
        </div>
      )}
    </div>
  );
}
