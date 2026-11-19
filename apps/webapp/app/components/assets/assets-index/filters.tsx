import { AssetStatus } from "@prisma/client";
import { StatusFilter } from "~/components/booking/status-filter";
import DynamicDropdown from "~/components/dynamic-dropdown/dynamic-dropdown";
import { ChevronRight } from "~/components/icons/library";
import ImageWithPreview from "~/components/image-with-preview/image-with-preview";
import { Filters } from "~/components/list/filters";
import { SortBy } from "~/components/list/filters/sort-by";
import { Button } from "~/components/shared/button";
import When from "~/components/when/when";
import {
  useClearValueFromParams,
  useSearchParamHasValue,
} from "~/hooks/search-params";
import { useAssetIndexViewState } from "~/hooks/use-asset-index-view-state";
import { useCurrentOrganization } from "~/hooks/use-current-organization";
import { useUserRoleHelper } from "~/hooks/user-user-role-helper";
import { userHasCustodyViewPermission } from "~/utils/permissions/custody-and-bookings-permissions.validator.client";
import type { OrganizationPermissionSettings } from "~/utils/permissions/custody-and-bookings-permissions.validator.client";
import { resolveTeamMemberName } from "~/utils/user";
import { AdvancedFilteringAndSorting } from "./advanced-asset-index-filters-and-sorting";
import { ConfigureColumnsDropdown } from "./configure-columns-dropdown";
import { MobileAssetFilters } from "./mobile-asset-filters";
import { SavedFilterPresetsControls } from "./saved-filter-presets";
import { AvailabilityViewToggle } from "./view-toggle";

export const ASSET_SORTING_OPTIONS = {
  title: "Name",
  createdAt: "Date created",
  updatedAt: "Date updated",
} as const;

export function AssetIndexFilters({
  disableTeamMemberFilter,
}: {
  disableTeamMemberFilter?: boolean;
}) {
  /** Used for filtering based on user type */
  const filterParams: string[] = ["category", "tag", "location"];
  if (!disableTeamMemberFilter) {
    filterParams.push("teamMember");
  }
  const hasFiltersToClear = useSearchParamHasValue(...filterParams);
  const clearFilters = useClearValueFromParams(...filterParams);
  const { roles } = useUserRoleHelper();

  const { modeIsSimple, modeIsAdvanced } = useAssetIndexViewState();

  const organization = useCurrentOrganization();
  const canSeeAllCustody = userHasCustodyViewPermission({
    roles,
    organization: organization as OrganizationPermissionSettings, // Here we can be sure as TeamMemberBadge is only used in the context of an organization/logged in route
  });

  if (modeIsSimple) {
    return (
      <Filters
        slots={{
          "left-of-search": <StatusFilter statusItems={AssetStatus} />,
          "right-of-search": (
            <div className="flex items-center gap-2">
              <SortBy
                sortingOptions={ASSET_SORTING_OPTIONS}
                defaultSortingBy="createdAt"
                className="flex-1"
              />

              <AvailabilityViewToggle />
            </div>
          ),
        }}
      >
        <div className="flex w-full items-center justify-end gap-2 md:w-auto md:gap-6">
          {hasFiltersToClear ? (
            <div className="hidden gap-6 md:flex">
              <Button
                as="button"
                onClick={clearFilters}
                variant="link"
                className="block min-w-28 max-w-none font-normal text-gray-600 hover:text-gray-700"
                type="button"
              >
                Clear all filters
              </Button>
              <div className="text-gray-600"> | </div>
            </div>
          ) : null}
          <MobileAssetFilters>
            <AssetSimpleFilterOptions
              compact
              canSeeAllCustody={canSeeAllCustody}
              disableTeamMemberFilter={disableTeamMemberFilter}
            />
          </MobileAssetFilters>
          <div className="hidden w-full items-center justify-around gap-2 md:flex md:w-auto md:justify-end lg:gap-4">
            <AssetSimpleFilterOptions
              canSeeAllCustody={canSeeAllCustody}
              disableTeamMemberFilter={disableTeamMemberFilter}
            />
          </div>
        </div>
      </Filters>
    );
  }

  if (modeIsAdvanced) {
    return <AdvancedAssetIndexFilters />;
  }
}

function AssetSimpleFilterOptions({
  compact = false,
  canSeeAllCustody,
  disableTeamMemberFilter,
}: {
  compact?: boolean;
  canSeeAllCustody: boolean;
  disableTeamMemberFilter?: boolean;
}) {
  const filterButton = (label: string) => (
    <div
      className={
        compact
          ? "flex min-h-11 w-full min-w-0 items-center justify-between gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-left text-sm font-semibold text-gray-800"
          : "flex cursor-pointer items-center gap-2"
      }
    >
      <span className={compact ? "min-w-0 break-words" : undefined}>
        {label}
      </span>
      <ChevronRight
        aria-hidden="true"
        className={
          compact ? "size-4 shrink-0 rotate-90" : "hidden rotate-90 md:inline"
        }
      />
    </div>
  );
  const triggerWrapperClassName = compact ? "w-full min-w-0" : undefined;

  return (
    <div
      className={
        compact
          ? "flex w-full min-w-0 flex-col gap-2"
          : "flex w-full items-center justify-around gap-2 md:w-auto md:justify-end"
      }
    >
      <DynamicDropdown
        trigger={filterButton("Categories")}
        triggerWrapperClassName={triggerWrapperClassName}
        model={{ name: "category", queryKey: "name" }}
        label="Filter by category"
        placeholder="Search categories"
        initialDataKey="categories"
        countKey="totalCategories"
        withoutValueItem={{ id: "uncategorized", name: "Uncategorized" }}
      />
      <DynamicDropdown
        trigger={filterButton("Tags")}
        triggerWrapperClassName={triggerWrapperClassName}
        model={{ name: "tag", queryKey: "name" }}
        label="Filter by tag"
        initialDataKey="tags"
        countKey="totalTags"
        withoutValueItem={{ id: "untagged", name: "Without tag" }}
      />
      <DynamicDropdown
        trigger={filterButton("Locations")}
        triggerWrapperClassName={triggerWrapperClassName}
        model={{ name: "location", queryKey: "name" }}
        label="Filter by location"
        initialDataKey="locations"
        countKey="totalLocations"
        withoutValueItem={{
          id: "without-location",
          name: "Without location",
        }}
        renderItem={({ metadata }) => (
          <div className="flex min-w-0 items-center gap-2">
            <ImageWithPreview
              thumbnailUrl={metadata.thumbnailUrl}
              alt={metadata.name}
              className="size-6 shrink-0 rounded-[2px]"
            />
            <span className="min-w-0 break-words">{metadata.name}</span>
          </div>
        )}
      />
      <When truthy={canSeeAllCustody && !disableTeamMemberFilter}>
        <DynamicDropdown
          trigger={filterButton("Custodian")}
          triggerWrapperClassName={triggerWrapperClassName}
          model={{
            name: "teamMember",
            queryKey: "name",
            deletedAt: null,
            // A read FILTER — the workspace custody override governs.
            custodyPurpose: "custody-filter",
          }}
          renderItem={(item) => resolveTeamMemberName(item, true)}
          label="Filter by custodian"
          placeholder="Search team members"
          initialDataKey="teamMembers"
          countKey="totalTeamMembers"
          withoutValueItem={{ id: "without-custody", name: "Without custody" }}
        />
      </When>
    </div>
  );
}

function AdvancedAssetIndexFilters() {
  return (
    <Filters
      slots={{
        "left-of-search": <AdvancedFilteringAndSorting />,
        "right-of-search": <AvailabilityViewToggle modeIsSimple={false} />,
      }}
      searchClassName="leading-5"
    >
      <div className="flex w-full items-center justify-around gap-2 md:w-auto md:justify-end">
        <SavedFilterPresetsControls />
        <ConfigureColumnsDropdown />
      </div>
    </Filters>
  );
}
