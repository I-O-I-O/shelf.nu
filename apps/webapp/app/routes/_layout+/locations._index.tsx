import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { data, Link, useLoaderData } from "react-router";
import Header from "~/components/layout/header";
import type { HeaderData } from "~/components/layout/header/types";
import { ListContentWrapper } from "~/components/list/content-wrapper";
import { Filters } from "~/components/list/filters";
import { SortBy } from "~/components/list/filters/sort-by";
import { IoioLocationHierarchy } from "~/components/location/ioio-location-hierarchy";
import { Button } from "~/components/shared/button";
import { useSearchParams } from "~/hooks/search-params";
import { getLocations } from "~/modules/location/service.server";
import { LOCATION_SORTING_OPTIONS } from "~/modules/location/utils";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import {
  setCookie,
  updateCookieWithPerPage,
  userPrefs,
} from "~/utils/cookies.server";
import { makeShelfError } from "~/utils/error";
import { computeHasActiveFilters } from "~/utils/filter-params";
import { payload, error, getCurrentSearchParams } from "~/utils/http.server";
import { getParamsValues } from "~/utils/list";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

export async function loader({ context, request }: LoaderFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;

  try {
    const { organizationId } = await requirePermission({
      userId: authSession.userId,
      request,
      entity: PermissionEntity.location,
      action: PermissionAction.read,
    });
    const searchParams = getCurrentSearchParams(request);
    const { page, perPageParam, search, orderBy, orderDirection } =
      getParamsValues(searchParams);
    const selectedLocationId = searchParams.get("selectedLocation");
    const hasActiveFilters = computeHasActiveFilters(searchParams);
    const cookie = await updateCookieWithPerPage(request, perPageParam);
    const { perPage } = cookie;

    const firstPage = await getLocations({
      organizationId,
      page,
      perPage,
      search,
      orderBy,
      orderDirection,
    });
    const { locations, totalLocations } =
      firstPage.totalLocations > firstPage.locations.length
        ? await getLocations({
            organizationId,
            page: 1,
            perPage: firstPage.totalLocations,
            search,
            orderBy,
            orderDirection,
          })
        : firstPage;

    const header: HeaderData = {
      title: `Locations - ${totalLocations}`,
    };
    const modelName = {
      singular: "location",
      plural: "locations",
    };

    return data(
      payload({
        header,
        items: locations,
        search,
        page: 1,
        totalItems: totalLocations,
        totalPages: 1,
        perPage: Math.max(perPage, totalLocations),
        modelName,
        searchFieldLabel: "Search locations",
        hasActiveFilters,
        selectedLocationId,
      }),
      {
        headers: [setCookie(await userPrefs.serialize(cookie))],
      }
    );
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    throw data(error(reason), { status: reason.status });
  }
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  { title: data ? appendToMetaTitle(data.header.title) : "" },
];

export default function LocationsIndexPage() {
  const { items, selectedLocationId } = useLoaderData<typeof loader>();
  const [searchParams] = useSearchParams();
  const createdLocationId = searchParams.get("created")
    ? selectedLocationId
    : null;

  return (
    <>
      <Header hideQuickFind />
      <ListContentWrapper>
        <Filters
          slots={{
            "right-of-search": (
              <SortBy
                sortingOptions={LOCATION_SORTING_OPTIONS}
                defaultSortingBy="createdAt"
                defaultSortingDirection="desc"
              />
            ),
          }}
        >
          <div className="flex w-full justify-end md:w-auto">
            <Button
              to="new"
              role="link"
              aria-label="new location"
              data-test-id="createNewLocation"
              className="whitespace-nowrap"
            >
              New location
            </Button>
          </div>
        </Filters>
        {createdLocationId ? (
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-900">
            <span>Location created successfully.</span>
            <div className="flex items-center gap-2">
              <Link
                to={`/labels?locationId=${encodeURIComponent(
                  createdLocationId
                )}`}
                className="rounded-lg bg-green-800 px-3 py-2 font-semibold text-white hover:bg-green-900"
              >
                Create label
              </Link>
              <Link
                to="/locations"
                className="rounded-lg border border-green-300 bg-white px-3 py-2 font-semibold text-green-900 hover:bg-green-100"
              >
                Done
              </Link>
            </div>
          </div>
        ) : null}
        {items.length ? (
          <IoioLocationHierarchy
            locations={items}
            initialSelectedId={selectedLocationId}
          />
        ) : (
          <div className="rounded-2xl border border-dashed border-gray-200 bg-white px-5 py-10 text-center">
            <p className="text-lg font-bold text-gray-950">
              No locations found.
            </p>
            <p className="mt-2 text-sm text-gray-600">
              Create a location to organize assets by room, building, or site.
            </p>
            <Button to="new" className="mt-5">
              New location
            </Button>
          </div>
        )}
      </ListContentWrapper>
    </>
  );
}
