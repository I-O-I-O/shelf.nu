import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { FormEvent, ReactNode } from "react";
import type { OrganizationRoles } from "@prisma/client";
import { AssetStatus } from "@prisma/client";
import { useAtomValue, useSetAtom } from "jotai";
import {
  ArchiveIcon,
  ChevronDownIcon,
  FolderInputIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PrinterIcon,
  Trash2Icon,
} from "lucide-react";
import {
  useFetcher,
  useLoaderData,
  useNavigate,
  useRevalidator,
} from "react-router";
import { openBulkDialogAtom } from "~/atoms/bulk-update-dialog";
import {
  bulkSelectionKey,
  removeSelectedBulkItemsAtom,
  selectedBulkItemsAtom,
  setSelectedBulkItemsAtom,
} from "~/atoms/list";
import { AssetImage } from "~/components/assets/asset-image";
import { getQuantityData } from "~/components/assets/asset-status-badge/quantity-data";
import { InventoryBulkActionBar } from "~/components/assets/assets-index/inventory-bulk-action-bar";
import {
  applyInventoryQuickFilter,
  type InventoryQuickFilter,
} from "~/components/assets/assets-index/inventory-quick-filters";
import {
  InventoryViewSelect,
  INVENTORY_FILTER_TRIGGER_CLASS_NAME,
} from "~/components/assets/assets-index/inventory-view-select";
import BulkArchiveDialog from "~/components/assets/bulk-archive-dialog";
import BulkCategoryUpdateDialog from "~/components/assets/bulk-category-update-dialog";
import BulkDownloadQrDialog from "~/components/assets/bulk-download-qr-dialog";
import BulkLocationUpdateDialog from "~/components/assets/bulk-location-update-dialog";
import BulkTrashDialog from "~/components/assets/bulk-trash-dialog";
import { CategoryBadge } from "~/components/assets/category-badge";
import { StaffInventoryUndoNotice } from "~/components/assets/staff-inventory-undo-notice";
import type { BulkUpdateSuccessContext } from "~/components/bulk-update-dialog/bulk-update-dialog";
import DynamicDropdown from "~/components/dynamic-dropdown/dynamic-dropdown";
import { ChevronRight } from "~/components/icons/library";
import { getIoioCategoryColor } from "~/components/ioio-staff/ioio-category-presentation";
import { Dialog, DialogPortal } from "~/components/layout/dialog";
import { EmptyState } from "~/components/list/empty-state";
import { SearchForm } from "~/components/list/filters/search-form";
import { Pagination } from "~/components/list/pagination";
import { IoioLocationCascadeSelect } from "~/components/location/ioio-location-cascade-select";
import { getIoioLocationColor } from "~/components/location/ioio-location-colors";
import { LocationBadge } from "~/components/location/location-badge";
import { Badge } from "~/components/shared/badge";
import { Button } from "~/components/shared/button";
import { DateS } from "~/components/shared/date";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/shared/dropdown";
import { EmptyTableValue } from "~/components/shared/empty-table-value";
import { Th, Td } from "~/components/table";
import {
  useClearValueFromParams,
  useSearchParams,
  useSearchParamHasValue,
} from "~/hooks/search-params";
import { useUserRoleHelper } from "~/hooks/user-user-role-helper";
import { getPhysicalUnitLabelFromTitle } from "~/modules/asset/physical-unit";
import {
  buildStaffInventoryDisplayRows,
  getStaffInventoryActionTargets,
  getStaffInventoryEditTarget,
  type StaffInventoryDisplayRow,
  summarizeStaffInventory,
} from "~/modules/asset/staff-inventory-view";
import type { AssetsFromViewItem } from "~/modules/asset/types";
import { getPrimaryLocation, isQuantityTracked } from "~/modules/asset/utils";
import type {
  BulkMutationUndo,
  BulkUndoRequest,
} from "~/modules/ioio-staff/bulk-undo";
import {
  getIoioKitDisplayName,
  getIoioPhysicalUnitDisplayName,
} from "~/modules/kit/ioio-kit-presentation";
import type { AssetIndexLoaderData } from "~/routes/_layout+/assets._index";
import { IOIO_KIT_CATEGORY_FILTER } from "~/utils/list";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { userHasPermission } from "~/utils/permissions/permission.validator.client";
import { tw } from "~/utils/tw";

type StaffInventorySourceItem = AssetsFromViewItem & {
  physicalAvailable?: number;
  preparedPickupHeld?: boolean;
};
type StaffInventoryItem = StaffInventoryDisplayRow<StaffInventorySourceItem>;
type ExpandedUnitAction =
  | "category"
  | "location"
  | "print"
  | "archive"
  | "trash";

type ExpandedUnitActionRequest = {
  action: ExpandedUnitAction;
  targetIds: string[];
};

function uniqueAssetIds(assetIds: string[]) {
  return [...new Set(assetIds)];
}

type StaffInventoryListProps = {
  headerActions?: ReactNode;
  customEmptyStateContent?: {
    title: string;
    text: ReactNode;
    newButtonRoute?: string;
    newButtonContent?: string;
  };
};

export function StaffInventoryList({
  headerActions,
  customEmptyStateContent,
}: StaffInventoryListProps) {
  const { items, locations } = useLoaderData<AssetIndexLoaderData>();
  const rows = useMemo(
    () =>
      buildStaffInventoryDisplayRows(
        items as unknown as StaffInventorySourceItem[]
      ),
    [items]
  ) as StaffInventoryItem[];

  const hasItems = rows.length > 0;
  const selectedItems = useAtomValue(selectedBulkItemsAtom);
  const setSelectedItems = useSetAtom(setSelectedBulkItemsAtom);
  const removeSelectedItems = useSetAtom(removeSelectedBulkItemsAtom);
  const openBulkDialog = useSetAtom(openBulkDialogAtom);
  const navigate = useNavigate();
  const { roles } = useUserRoleHelper();
  const canBulkUpdate = userHasPermission({
    roles,
    entity: PermissionEntity.asset,
    action: PermissionAction.update,
  });
  const canBulkDelete = userHasPermission({
    roles,
    entity: PermissionEntity.asset,
    action: PermissionAction.delete,
  });
  const canPrintLabels = userHasPermission({
    roles,
    entity: PermissionEntity.qr,
    action: PermissionAction.read,
  });
  const selectedKeys = useMemo(
    () => new Set(selectedItems.map(bulkSelectionKey)),
    [selectedItems]
  );
  const isInventoryRowSelected = (item: StaffInventoryItem) =>
    getStaffInventoryActionTargets(item).every((member) =>
      selectedKeys.has(bulkSelectionKey(member))
    );
  const toggleInventoryRow = (item: StaffInventoryItem) => {
    const targets = getStaffInventoryActionTargets(item);
    if (targets.every((member) => selectedKeys.has(bulkSelectionKey(member)))) {
      removeSelectedItems(targets);
    } else {
      setSelectedItems(targets);
    }
  };
  const visibleSelectedCount = rows.filter(isInventoryRowSelected).length;
  const allVisibleSelected =
    rows.length > 0 && visibleSelectedCount === rows.length;
  const someVisibleSelected = visibleSelectedCount > 0 && !allVisibleSelected;
  const headerCheckboxRef = useRef<HTMLInputElement>(null);
  const [undoAction, setUndoAction] = useState<BulkUndoRequest | null>(null);

  const rememberBulkAction = useCallback(
    (context: BulkUpdateSuccessContext) => {
      const undo = context.fetcherData?.undo as BulkMutationUndo | undefined;
      if (!undo) return;

      const entries = context.selectedItems
        .filter((item) => item.id)
        .map((item) => ({
          assetId: item.id,
          ...(undo.operation === "category"
            ? {
                previousCategoryId: item.category?.id ?? null,
                expectedCategoryId: undo.targetCategoryId ?? null,
              }
            : {}),
          ...(undo.operation === "location"
            ? {
                previousLocationId:
                  item.assetLocations?.[0]?.location?.id ?? null,
                expectedLocationId: undo.targetLocationId ?? null,
              }
            : {}),
        }));

      if (entries.length > 0) {
        setUndoAction({
          operation: undo.operation,
          createdAt: Date.now(),
          entries,
        });
      }
    },
    []
  );

  const clearUndoAction = useCallback(() => setUndoAction(null), []);

  useEffect(() => {
    if (headerCheckboxRef.current) {
      headerCheckboxRef.current.indeterminate = someVisibleSelected;
    }
  }, [someVisibleSelected]);

  const toggleAllVisible = (checked: boolean) => {
    if (checked) {
      setSelectedItems(
        rows
          .filter((item) => !isInventoryRowSelected(item))
          .flatMap(getStaffInventoryActionTargets)
      );
      return;
    }

    removeSelectedItems(rows.flatMap(getStaffInventoryActionTargets));
  };
  const inventorySummary = useMemo(
    () =>
      summarizeStaffInventory(
        rows.map((item) => getStaffInventoryQuantities(item))
      ),
    [rows]
  );

  return (
    <div className="flex flex-col gap-4 pb-5 pt-4">
      <section className="overflow-hidden rounded border border-gray-200 bg-white">
        <div className="flex flex-col gap-3 border-b border-gray-200 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-base font-semibold text-gray-900">
              Inventory {inventorySummary.logicalItems}
            </h2>
            <p className="text-sm text-gray-500">
              Canonical quantities and current availability
            </p>
          </div>
          {headerActions ? (
            <div className="flex flex-wrap items-center gap-2">
              {headerActions}
            </div>
          ) : null}
        </div>
        <dl className="grid grid-cols-3 divide-x border-b border-gray-200 bg-gray-50/50">
          <InventorySummaryStat
            label="Total quantity"
            value={inventorySummary.totalQuantity}
          />
          <InventorySummaryStat
            label="Available"
            value={inventorySummary.available}
          />
          <InventorySummaryStat label="In use" value={inventorySummary.inUse} />
        </dl>
        <StaffInventoryFilters />
        {selectedItems.length > 0 ? (
          <InventoryBulkActionBar
            selectedCount={selectedItems.length}
            canUpdate={canBulkUpdate}
            canDelete={canBulkDelete}
            canPrintLabels={canPrintLabels}
            onChangeCategory={() => openBulkDialog("category")}
            onChangeLocation={() => openBulkDialog("location")}
            onArchive={() => openBulkDialog("archive")}
            onTrash={() => openBulkDialog("trash")}
            onPrintLabels={() => {
              const assetIds = uniqueAssetIds(
                selectedItems.map((item) => item.id)
              )
                .map(encodeURIComponent)
                .join(",");
              void navigate(`/labels?assetIds=${assetIds}`);
            }}
          />
        ) : null}
        {!hasItems ? (
          <EmptyState customContent={customEmptyStateContent} />
        ) : (
          <>
            <div className="hidden overflow-hidden md:block">
              <table className="w-full table-fixed border-collapse">
                <thead>
                  <tr>
                    <Th className="w-[4%] px-2">
                      <input
                        ref={headerCheckboxRef}
                        type="checkbox"
                        checked={allVisibleSelected}
                        onChange={(event) =>
                          toggleAllVisible(event.target.checked)
                        }
                        aria-label="Select all visible inventory items"
                        className="size-4 rounded border-gray-300 text-red-600 focus:ring-red-600"
                      />
                    </Th>
                    <Th className="w-[19%] md:px-3">Item</Th>
                    <Th className="w-[17%] md:px-3">Category</Th>
                    <Th className="w-[17%] md:px-3">Location</Th>
                    <Th className="w-[11%] px-1 md:px-2">Quantity</Th>
                    <Th className="w-[14%] md:px-3">Updated</Th>
                    <Th className="w-[18%] md:px-3">Actions</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((item) => (
                    <StaffInventoryRow
                      key={item.id}
                      item={item}
                      selected={isInventoryRowSelected(item)}
                      onToggle={() => toggleInventoryRow(item)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
            <div className="divide-y divide-gray-200 md:hidden">
              {rows.map((item) => (
                <StaffInventoryMobileRow
                  key={item.id}
                  item={item}
                  selected={isInventoryRowSelected(item)}
                  onToggle={() => toggleInventoryRow(item)}
                />
              ))}
            </div>
          </>
        )}
      </section>
      <Pagination className="border-t border-gray-200 bg-white" />
      {undoAction ? (
        <StaffInventoryUndoNotice
          action={undoAction}
          onExpire={clearUndoAction}
        />
      ) : null}
      <BulkCategoryUpdateDialog onSuccess={rememberBulkAction} />
      <BulkLocationUpdateDialog
        ioioLocations={locations.map(({ id, name, parentId }) => ({
          id,
          name,
          parentId,
        }))}
        strict
        onSuccess={rememberBulkAction}
      />
      <BulkArchiveDialog onSuccess={rememberBulkAction} />
      <BulkTrashDialog onSuccess={rememberBulkAction} />
    </div>
  );
}

function InventorySummaryStat({
  label,
  value,
}: {
  label: string;
  value: number;
}) {
  return (
    <div className="min-w-0 p-3 sm:px-4 sm:py-3">
      <dt className="truncate text-xs font-medium text-gray-500">{label}</dt>
      <dd className="mt-1 text-lg font-semibold tabular-nums text-gray-900">
        {value.toLocaleString()}
      </dd>
    </div>
  );
}

function StaffInventoryFilters() {
  const { categories, locations } = useLoaderData<AssetIndexLoaderData>();
  const filterParams = ["status", "category", "location"];
  const hasFiltersToClear = useSearchParamHasValue(...filterParams);
  const clearFilters = useClearValueFromParams(...filterParams);
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedCategoryIds = searchParams.getAll("category");
  const selectedCategory =
    selectedCategoryIds.length === 1
      ? categories.find((category) => category.id === selectedCategoryIds[0])
      : undefined;
  const selectedLocationId = searchParams.get("location");
  const selectedLocation = locations.find(
    (location) => location.id === selectedLocationId
  );
  const selectedLocationCount = searchParams.getAll("location").length;
  const selectedLocationColor = selectedLocation
    ? getIoioLocationColor({ name: selectedLocation.name })
    : null;
  const clearLocation = useClearValueFromParams("location");
  const hasAdditionalFilters = ["status", "category"].some(
    (key) => searchParams.getAll(key).length > 0
  );
  const categoryFilterLabel =
    selectedCategoryIds.length === 0
      ? "Category"
      : selectedCategoryIds.length === 1
      ? selectedCategory?.name ??
        (selectedCategoryIds[0] === IOIO_KIT_CATEGORY_FILTER
          ? "Kit"
          : selectedCategoryIds[0] === "uncategorized"
          ? "Uncategorized"
          : "Category")
      : `Category +${selectedCategoryIds.length}`;
  const categoryFilterColor =
    selectedCategoryIds.length === 1 &&
    selectedCategoryIds[0] !== "uncategorized"
      ? selectedCategory?.color ??
        getIoioCategoryColor(
          selectedCategoryIds[0] === IOIO_KIT_CATEGORY_FILTER ? "Kit" : null
        )
      : null;
  const activeFilterTriggerClassName = "border-red-200 bg-red-50 text-red-800";
  const activeStatus = searchParams.get("status");
  const kitsSelected = selectedCategoryIds.includes(IOIO_KIT_CATEGORY_FILTER);
  const viewFilter: InventoryQuickFilter = kitsSelected
    ? "kits"
    : activeStatus === AssetStatus.AVAILABLE
    ? "available"
    : activeStatus === AssetStatus.CHECKED_OUT
    ? "checked-out"
    : "all";

  return (
    <div className="ioio-inventory-filters flex flex-wrap items-center gap-3 border-b border-gray-200 bg-gray-50/50 px-4 py-3 text-sm text-gray-500">
      <SearchForm className="min-w-[240px] flex-[1_1_320px]" />
      <InventoryViewSelect
        value={viewFilter}
        onChange={(value) =>
          setSearchParams((current) =>
            applyInventoryQuickFilter(current, value)
          )
        }
      />
      <div className="w-[170px] shrink-0">
        <DynamicDropdown
          trigger={
            <span className="flex w-full min-w-0 cursor-pointer items-center gap-2 text-left">
              {categoryFilterColor ? (
                <span
                  aria-hidden="true"
                  className="size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: categoryFilterColor }}
                />
              ) : null}
              <span className="min-w-0 flex-1 truncate">
                {categoryFilterLabel}
              </span>
              <ChevronRight className="ml-auto size-4 shrink-0 rotate-90" />
            </span>
          }
          triggerWrapperClassName={tw(
            INVENTORY_FILTER_TRIGGER_CLASS_NAME,
            selectedCategoryIds.length > 0 && activeFilterTriggerClassName
          )}
          model={{ name: "category", queryKey: "name" }}
          label="Filter by category"
          placeholder="Search categories"
          initialDataKey="categories"
          countKey="totalCategories"
          withValueItem={{ id: IOIO_KIT_CATEGORY_FILTER, name: "Kit" }}
          withoutValueItem={{ id: "uncategorized", name: "Uncategorized" }}
          hideCounter
        />
      </div>
      <div className="w-[170px] shrink-0">
        <DynamicDropdown
          trigger={
            <span className="flex w-full min-w-0 cursor-pointer items-center gap-2 text-left">
              {selectedLocation && selectedLocationColor ? (
                <span
                  aria-hidden="true"
                  className="size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: selectedLocationColor.color }}
                />
              ) : null}
              <span className="min-w-0 flex-1 truncate">
                {selectedLocation
                  ? formatInventoryLocationName(selectedLocation.name)
                  : "Location"}
              </span>
              {selectedLocationCount > 1 ? (
                <span className="shrink-0 text-xs text-gray-500">
                  +{selectedLocationCount - 1}
                </span>
              ) : null}
              {selectedLocation ? (
                <span
                  role="button"
                  tabIndex={0}
                  aria-label="Clear location filter"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    clearLocation();
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      event.stopPropagation();
                      clearLocation();
                    }
                  }}
                  className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-sm leading-none text-gray-600 hover:bg-gray-200 hover:text-gray-950 focus:outline-none focus:ring-2 focus:ring-red-600 focus:ring-offset-1"
                >
                  <span aria-hidden="true">×</span>
                </span>
              ) : null}
              <ChevronRight className="ml-auto size-4 shrink-0 rotate-90" />
            </span>
          }
          triggerWrapperClassName={tw(
            INVENTORY_FILTER_TRIGGER_CLASS_NAME,
            selectedLocation && activeFilterTriggerClassName
          )}
          model={{ name: "location", queryKey: "name" }}
          label="Filter by location"
          placeholder="Search locations"
          initialDataKey="locations"
          countKey="totalLocations"
          getItemGroup={getInventoryLocationGroup}
          sortItems={sortInventoryLocationItems}
          renderItem={(item) => formatInventoryLocationName(item.name)}
          withoutValueItem={{
            id: "without-location",
            name: "Without location",
          }}
          hideCounter
        />
      </div>
      {hasFiltersToClear && hasAdditionalFilters ? (
        <Button
          type="button"
          variant="link"
          className="h-9 shrink-0 rounded-lg px-2 font-normal text-gray-500 hover:bg-red-50 hover:text-red-800"
          onClick={clearFilters}
        >
          Clear filters
        </Button>
      ) : null}
    </div>
  );
}

function getInventoryLocationGroup(item: { name: string }): string {
  if (/^[A-Z]\d{3}(?:\s|$)/u.test(item.name)) return "Rooms";
  if (/\bsection\b/iu.test(item.name)) return "Sections";
  if (/\b(?:shelf|container)\b/iu.test(item.name)) return "Shelves";
  return "Other locations";
}

function sortInventoryLocationItems(
  items: Array<{ id: string; name: string; metadata: Record<string, any> }>
) {
  const groupOrder: Record<string, number> = {
    Rooms: 0,
    Sections: 1,
    Shelves: 2,
    "Other locations": 3,
  };

  return [...items].sort((left, right) => {
    const leftGroup = getInventoryLocationGroup(left);
    const rightGroup = getInventoryLocationGroup(right);
    const groupDifference = groupOrder[leftGroup] - groupOrder[rightGroup];

    if (groupDifference !== 0) return groupDifference;

    return formatInventoryLocationName(left.name).localeCompare(
      formatInventoryLocationName(right.name),
      undefined,
      { numeric: true, sensitivity: "base" }
    );
  });
}

function formatInventoryLocationName(name: string): string {
  const codeFirstName = name.match(/^([A-Z]\d{3})\s+—\s+(.+)$/u);
  if (codeFirstName) return `${codeFirstName[2]} - ${codeFirstName[1]}`;

  return name.replace(/\s*—\s*/gu, " - ");
}

type StaffInventoryQuantities = {
  totalQuantity: number;
  availableQuantity: number;
};

function getStaffInventoryQuantities(
  item: StaffInventoryItem
): StaffInventoryQuantities {
  if (item.isExpandable) {
    return item.members.reduce<StaffInventoryQuantities>(
      (summary, member) => {
        const memberQuantity: StaffInventoryQuantities =
          getStaffInventoryQuantities({
            ...member,
            duplicateRecordCount: 1,
            members: [member],
            logicalTitle: member.title,
            isExpandable: false,
          });
        return {
          totalQuantity: summary.totalQuantity + memberQuantity.totalQuantity,
          availableQuantity:
            summary.availableQuantity + memberQuantity.availableQuantity,
        };
      },
      { totalQuantity: 0, availableQuantity: 0 }
    );
  }

  const quantityData = getQuantityData(item);
  const totalQuantity = isQuantityTracked(item) ? item.quantity ?? 0 : 1;
  const availableQuantity = isQuantityTracked(item)
    ? Math.max(
        0,
        item.physicalAvailable ??
          quantityData?.available ??
          (item.availableToBook && item.status !== "CHECKED_OUT"
            ? totalQuantity
            : 0)
      )
    : !item.preparedPickupHeld &&
      item.availableToBook &&
      item.status === "AVAILABLE"
    ? 1
    : 0;

  return { totalQuantity, availableQuantity };
}

function StaffInventoryRow({
  item,
  selected,
  onToggle,
}: {
  item: StaffInventoryItem;
  selected: boolean;
  onToggle: () => void;
}) {
  const { roles } = useUserRoleHelper();
  const location = getPrimaryLocation(item);
  const { availableQuantity, totalQuantity } =
    getStaffInventoryQuantities(item);
  const [expanded, setExpanded] = useState(false);
  const [selectedPhysicalUnitIds, setSelectedPhysicalUnitIds] = useState<
    string[]
  >([]);
  const [physicalUnitAction, setPhysicalUnitAction] =
    useState<ExpandedUnitActionRequest | null>(null);
  useEffect(() => {
    const memberIds = new Set(item.members.map((member) => member.id));
    setSelectedPhysicalUnitIds((ids) => ids.filter((id) => memberIds.has(id)));
  }, [item.members]);
  return (
    <Fragment>
      <tr className="hover:bg-gray-50">
        <Td className="w-[4%] px-2">
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggle}
            aria-label={`Select ${item.logicalTitle}`}
            className="size-4 rounded border-gray-300 text-red-600 focus:ring-red-600"
          />
        </Td>
        <Td className="min-w-0 whitespace-normal md:px-3">
          <div className="flex items-center gap-3">
            <AssetImage
              asset={{
                id: item.id,
                mainImage: item.mainImage,
                thumbnailImage: item.thumbnailImage,
                mainImageExpiration: item.mainImageExpiration,
                assetModel: item.assetModel ?? null,
                kitImage: item.assetKits?.[0]?.kit?.image ?? null,
              }}
              alt={`Image of ${item.logicalTitle}`}
              useThumbnail={false}
              className="size-9 shrink-0 rounded border object-cover"
            />
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <Button
                  to={`/assets/${item.id}`}
                  variant="link"
                  className="min-w-0 truncate p-0 text-left font-medium text-gray-900 hover:text-gray-700"
                  title={item.logicalTitle}
                >
                  {item.logicalTitle}
                </Button>
                {item.isExpandable ? (
                  <button
                    type="button"
                    className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-red-50 text-xs font-semibold text-red-700 hover:bg-red-100 focus:outline-none focus:ring-2 focus:ring-red-600"
                    aria-label={
                      (expanded ? "Collapse " : "Expand ") + item.logicalTitle
                    }
                    aria-expanded={expanded}
                    onClick={() => setExpanded((value) => !value)}
                  >
                    <ChevronDownIcon
                      className={
                        "size-4 transition-transform" +
                        (expanded ? " rotate-180" : "")
                      }
                    />
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        </Td>
        <Td className="min-w-0 whitespace-normal md:px-3">
          <CategoryBadge
            className="max-w-full whitespace-normal break-words text-left"
            category={
              item.category
                ? {
                    ...item.category,
                  }
                : null
            }
          />
        </Td>
        <Td className="min-w-0 whitespace-normal md:px-3">
          {location ? (
            <LocationBadge
              location={{
                id: location.id,
                name: formatStaffLocationName(location.name),
                parentId: location.parentId ?? undefined,
                childCount: location._count?.children ?? 0,
              }}
              className="ml-0 max-w-full whitespace-normal break-words text-left"
            />
          ) : (
            <EmptyTableValue />
          )}
        </Td>
        <Td className="px-1 text-center md:px-2">
          <div className="flex min-w-0 flex-col items-center">
            <span
              aria-label={`${availableQuantity} of ${totalQuantity} available`}
            >
              <QuantityPill
                available={availableQuantity}
                total={totalQuantity}
              />
            </span>
          </div>
        </Td>
        <Td className="whitespace-nowrap text-sm text-gray-600">
          <DateS
            date={item.updatedAt}
            options={{ year: "numeric", month: "short", day: "numeric" }}
          />
        </Td>
        <Td className="md:px-3">
          <StaffInventoryActions
            item={item}
            roles={roles}
            physicalUnitIds={selectedPhysicalUnitIds}
            onPhysicalUnitAction={(action) =>
              setPhysicalUnitAction({
                action,
                targetIds: uniqueAssetIds(selectedPhysicalUnitIds),
              })
            }
          />
        </Td>
      </tr>
      {item.isExpandable && expanded ? (
        <StaffInventoryExpandedUnits
          item={item}
          roles={roles}
          selectedUnitIds={selectedPhysicalUnitIds}
          onSelectedUnitIdsChange={setSelectedPhysicalUnitIds}
          actionRequest={physicalUnitAction}
          onActionRequestChange={setPhysicalUnitAction}
        />
      ) : null}
    </Fragment>
  );
}

function StaffInventoryExpandedUnits({
  item,
  roles,
  selectedUnitIds,
  onSelectedUnitIdsChange,
  actionRequest,
  onActionRequestChange,
}: {
  item: StaffInventoryItem;
  roles: OrganizationRoles[] | undefined;
  selectedUnitIds: string[];
  onSelectedUnitIdsChange: (ids: string[]) => void;
  actionRequest: ExpandedUnitActionRequest | null;
  onActionRequestChange: (request: ExpandedUnitActionRequest | null) => void;
}) {
  return (
    <tr className="bg-gray-50/70">
      <Td colSpan={7} className="px-4 py-3 md:px-6">
        <StaffInventoryExpandedUnitsContent
          item={item}
          roles={roles}
          selectedUnitIds={selectedUnitIds}
          onSelectedUnitIdsChange={onSelectedUnitIdsChange}
          actionRequest={actionRequest}
          onActionRequestChange={onActionRequestChange}
        />
      </Td>
    </tr>
  );
}

function StaffInventoryExpandedUnitsContent({
  item,
  roles,
  selectedUnitIds,
  onSelectedUnitIdsChange,
  actionRequest,
  onActionRequestChange,
}: {
  item: StaffInventoryItem;
  roles: OrganizationRoles[] | undefined;
  selectedUnitIds: string[];
  onSelectedUnitIdsChange: (ids: string[]) => void;
  actionRequest: ExpandedUnitActionRequest | null;
  onActionRequestChange: (request: ExpandedUnitActionRequest | null) => void;
}) {
  const { categories, locations } = useLoaderData<AssetIndexLoaderData>();
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const fetcher = useFetcher<{
    success?: boolean;
    error?: { message?: string };
  }>();
  const selectedUnits = useMemo(
    () =>
      item.members
        .slice()
        .sort((left, right) =>
          left.title.localeCompare(right.title, undefined, { numeric: true })
        ),
    [item.members]
  );
  const selectAllRef = useRef<HTMLInputElement>(null);
  const canUpdate = userHasPermission({
    roles,
    entity: PermissionEntity.asset,
    action: PermissionAction.update,
  });
  const canDelete = userHasPermission({
    roles,
    entity: PermissionEntity.asset,
    action: PermissionAction.delete,
  });
  const canReadQr = userHasPermission({
    roles,
    entity: PermissionEntity.qr,
    action: PermissionAction.read,
  });
  const selectedUnitSet = useMemo(
    () => new Set(selectedUnitIds),
    [selectedUnitIds]
  );
  const allSelected =
    selectedUnits.length > 0 &&
    selectedUnits.every((unit) => selectedUnitSet.has(unit.id));
  const someSelected = selectedUnitIds.length > 0 && !allSelected;
  const actionTargets = selectedUnits.filter(
    (unit) => actionRequest?.targetIds.includes(unit.id) ?? false
  );
  const ioioLocations = locations.map(({ id, name, parentId }) => ({
    id,
    name,
    parentId,
  }));

  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someSelected;
  }, [someSelected]);

  useEffect(() => {
    if (!fetcher.data?.success || !actionRequest) return;
    const completedAction = actionRequest.action;
    onActionRequestChange(null);
    if (completedAction === "archive" || completedAction === "trash") {
      onSelectedUnitIdsChange(
        selectedUnitIds.filter((id) => !actionRequest.targetIds.includes(id))
      );
    }
    void revalidator.revalidate();
  }, [
    actionRequest,
    fetcher.data,
    onActionRequestChange,
    onSelectedUnitIdsChange,
    revalidator,
    selectedUnitIds,
  ]);

  const openAction = (
    nextAction: ExpandedUnitAction,
    targetIds = selectedUnitIds
  ) => {
    const uniqueTargetIds = uniqueAssetIds(targetIds);
    if (uniqueTargetIds.length === 0) return;
    onActionRequestChange({
      action: nextAction,
      targetIds: uniqueTargetIds,
    });
  };

  const getUnitActionTargets = (unitId: string) =>
    uniqueAssetIds(
      selectedUnitIds.includes(unitId) ? selectedUnitIds : [unitId]
    );

  const printSelectedLabels = useCallback(
    (targetIds = selectedUnitIds) => {
      const uniqueTargetIds = uniqueAssetIds(targetIds);
      if (uniqueTargetIds.length === 0) return;
      const assetIds = uniqueTargetIds.map(encodeURIComponent).join(",");
      void navigate(`/labels?assetIds=${assetIds}`);
    },
    [navigate, selectedUnitIds]
  );

  useEffect(() => {
    if (actionRequest?.action !== "print") return;
    printSelectedLabels(actionRequest.targetIds);
    onActionRequestChange(null);
  }, [actionRequest, onActionRequestChange, printSelectedLabels]);

  const toggleAll = (checked: boolean) => {
    onSelectedUnitIdsChange(
      checked ? selectedUnits.map((unit) => unit.id) : []
    );
  };

  const busy = fetcher.state !== "idle";
  const formError = fetcher.data?.error?.message;

  return (
    <div className="space-y-2 border-l-2 border-red-200 pl-3 sm:pl-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">
          Physical units
        </span>
        <label className="inline-flex items-center gap-2 text-sm text-gray-700">
          <input
            ref={selectAllRef}
            type="checkbox"
            checked={allSelected}
            onChange={(event) => toggleAll(event.target.checked)}
            aria-label={`Select all ${selectedUnits.length} physical units`}
            className="size-4 rounded border-gray-300 text-red-600 focus:ring-red-600"
          />
          <span>Select all {selectedUnits.length}</span>
        </label>
      </div>

      {selectedUnitIds.length > 0 ? (
        <p className="rounded-md border border-red-100 bg-red-50/60 p-2 text-sm font-semibold text-gray-900">
          {selectedUnitIds.length} selected
        </p>
      ) : null}

      <div className="space-y-1">
        {selectedUnits.map((member) => {
          const location = getPrimaryLocation(member);
          const unitLabel = getUnitLabel(member.title);
          return (
            <div
              key={member.id}
              className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-x-3 gap-y-1 rounded-md border border-gray-200 bg-white px-2 py-1.5 text-sm"
            >
              <input
                id={`expanded-unit-${member.id}`}
                type="checkbox"
                checked={selectedUnitSet.has(member.id)}
                onChange={() =>
                  onSelectedUnitIdsChange(
                    selectedUnitIds.includes(member.id)
                      ? selectedUnitIds.filter((id) => id !== member.id)
                      : [...selectedUnitIds, member.id]
                  )
                }
                aria-label={`Select physical unit ${unitLabel}`}
                className="size-4 shrink-0 rounded border-gray-300 text-red-600 focus:ring-red-600"
              />
              <span className="min-w-0 whitespace-normal break-words font-medium text-gray-900">
                {unitLabel}
              </span>
              <div className="flex min-w-0 items-center justify-end gap-2">
                <Badge
                  color={member.status === "AVAILABLE" ? "#dcfce7" : "#fee2e2"}
                  textColor={
                    member.status === "AVAILABLE" ? "#166534" : "#b91c1c"
                  }
                  withDot={false}
                  className="shrink-0 px-2 py-1 text-xs font-semibold"
                >
                  {member.status === "AVAILABLE" ? "Available" : "In use"}
                </Badge>
                <span className="hidden shrink-0 text-xs font-medium text-gray-600 sm:inline">
                  QR: {member.qrCodes?.[0]?.id ? "Active" : "Not assigned"}
                </span>
                {location ? (
                  <span className="hidden min-w-0 max-w-28 truncate text-xs text-gray-500 lg:inline">
                    {formatStaffLocationName(location.name)}
                  </span>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {canUpdate ? (
                  <Button
                    to={`/assets/${member.id}/edit`}
                    size="sm"
                    variant="secondary"
                    className="size-8 shrink-0 rounded-lg p-1.5"
                    aria-label={`Edit ${unitLabel}`}
                    tooltip="Edit this physical unit"
                  >
                    <PencilIcon className="size-4" />
                  </Button>
                ) : null}
                {canUpdate || canDelete || canReadQr ? (
                  <DropdownMenu modal={false}>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        className="size-8 rounded-lg p-1.5"
                        aria-label={`More actions for ${unitLabel}`}
                      >
                        <MoreHorizontalIcon className="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      align="end"
                      className="min-w-52 max-w-60"
                    >
                      {canUpdate ? (
                        <DropdownMenuItem
                          className="flex min-h-10 flex-row items-center gap-3 whitespace-nowrap px-3 py-2"
                          onSelect={() =>
                            openAction(
                              "category",
                              getUnitActionTargets(member.id)
                            )
                          }
                        >
                          <FolderInputIcon className="size-5 shrink-0" />
                          <span>Change category</span>
                        </DropdownMenuItem>
                      ) : null}
                      {canUpdate ? (
                        <DropdownMenuItem
                          className="flex min-h-10 flex-row items-center gap-3 whitespace-nowrap px-3 py-2"
                          onSelect={() =>
                            openAction(
                              "location",
                              getUnitActionTargets(member.id)
                            )
                          }
                        >
                          <FolderInputIcon className="size-5 shrink-0" />
                          <span>Change location</span>
                        </DropdownMenuItem>
                      ) : null}
                      {canReadQr ? (
                        <DropdownMenuItem
                          className="flex min-h-10 flex-row items-center gap-3 whitespace-nowrap px-3 py-2"
                          onSelect={() =>
                            printSelectedLabels(getUnitActionTargets(member.id))
                          }
                        >
                          <PrinterIcon className="size-5 shrink-0" />
                          <span>Print label / QR</span>
                        </DropdownMenuItem>
                      ) : null}
                      {canDelete ? <DropdownMenuSeparator /> : null}
                      {canDelete ? (
                        <DropdownMenuItem
                          className="flex min-h-10 flex-row items-center gap-3 whitespace-nowrap px-3 py-2"
                          onSelect={() =>
                            openAction(
                              "archive",
                              getUnitActionTargets(member.id)
                            )
                          }
                        >
                          <ArchiveIcon className="size-5 shrink-0" />
                          <span>Archive</span>
                        </DropdownMenuItem>
                      ) : null}
                      {canDelete ? (
                        <DropdownMenuItem
                          className="flex min-h-10 flex-row items-center gap-3 whitespace-nowrap px-3 py-2 text-red-700"
                          onSelect={() =>
                            openAction("trash", getUnitActionTargets(member.id))
                          }
                        >
                          <Trash2Icon className="size-5 shrink-0" />
                          <span>Move to trash</span>
                        </DropdownMenuItem>
                      ) : null}
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      {formError ? (
        <p className="text-sm text-error-600" role="alert">
          {formError}
        </p>
      ) : null}

      {actionRequest && actionRequest.action !== "print" ? (
        <ExpandedUnitActionDialog
          action={actionRequest.action}
          assetIds={actionRequest.targetIds}
          categories={categories}
          locations={ioioLocations}
          selectedUnits={actionTargets}
          fetcher={fetcher}
          busy={busy}
          onClose={() => {
            if (!busy) onActionRequestChange(null);
          }}
        />
      ) : null}
    </div>
  );
}

function ExpandedUnitActionDialog({
  action,
  assetIds,
  categories,
  locations,
  selectedUnits,
  fetcher,
  busy,
  onClose,
}: {
  action: ExpandedUnitAction;
  assetIds: string[];
  categories: Array<{ id: string; name: string }>;
  locations: Array<{ id: string; name: string; parentId: string | null }>;
  selectedUnits: StaffInventoryItem["members"];
  fetcher: ReturnType<typeof useFetcher>;
  busy: boolean;
  onClose: () => void;
}) {
  const title =
    action === "location"
      ? `Change location for ${assetIds.length} physical unit${
          assetIds.length === 1 ? "" : "s"
        }`
      : action === "category"
      ? `Change category for ${assetIds.length} physical unit${
          assetIds.length === 1 ? "" : "s"
        }`
      : action === "archive"
      ? `Archive ${assetIds.length} physical unit${
          assetIds.length === 1 ? "" : "s"
        }`
      : `Move ${assetIds.length} physical unit${
          assetIds.length === 1 ? "" : "s"
        } to trash`;
  const [searchParams] = useSearchParams();
  const currentCategory =
    selectedUnits.length === 1 ? selectedUnits[0].category?.id ?? "" : "";

  const submitAction = (
    event: FormEvent<HTMLFormElement>,
    actionUrl: string,
    intent?: string
  ) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);

    // Keep the expanded-unit selection independent from the main inventory
    // selection atom. The payload is assembled once from the actual Asset IDs
    // captured by the row, so the browser never submits one request per unit.
    assetIds.forEach((assetId, index) => {
      formData.set(`assetIds[${index}]`, assetId);
    });
    formData.set("currentSearchParams", searchParams.toString());
    if (intent) formData.set("intent", intent);

    void fetcher.submit(formData, { method: "post", action: actionUrl });
  };

  return (
    <DialogPortal>
      <Dialog
        title={title}
        open={true}
        onClose={onClose}
        className="lg:w-[440px]"
      >
        {action === "location" ? (
          <fetcher.Form
            method="post"
            action="/api/assets/bulk-update-location"
            onSubmit={(event) =>
              submitAction(event, "/api/assets/bulk-update-location")
            }
            className="space-y-4 px-6 pb-6"
          >
            <ExpandedUnitIds searchParams={searchParams.toString()} />
            <IoioLocationCascadeSelect
              locations={locations}
              fieldName="newLocationId"
              required
              disabled={busy}
            />
            <ExpandedUnitDialogButtons busy={busy} onClose={onClose} />
          </fetcher.Form>
        ) : action === "category" ? (
          <fetcher.Form
            method="post"
            action="/api/assets/bulk-update-category"
            onSubmit={(event) =>
              submitAction(event, "/api/assets/bulk-update-category")
            }
            className="space-y-4 px-6 pb-6"
          >
            <ExpandedUnitIds searchParams={searchParams.toString()} />
            <label className="block text-sm font-medium text-gray-800">
              Category
              <select
                name="category"
                defaultValue={currentCategory}
                disabled={busy}
                className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:border-red-600 focus:outline-none focus:ring-2 focus:ring-red-600"
              >
                <option value="">Uncategorized</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
            </label>
            <ExpandedUnitDialogButtons busy={busy} onClose={onClose} />
          </fetcher.Form>
        ) : (
          <fetcher.Form
            method="post"
            action="/assets?index"
            onSubmit={(event) =>
              submitAction(
                event,
                "/assets?index",
                action === "archive" ? "bulk-archive" : "bulk-trash"
              )
            }
            className="space-y-4 px-6 pb-6"
          >
            <ExpandedUnitIds searchParams={searchParams.toString()} />
            <input
              type="hidden"
              name="intent"
              defaultValue={
                action === "archive" ? "bulk-archive" : "bulk-trash"
              }
            />
            <p className="text-sm text-gray-600">
              {action === "archive"
                ? "These physical units will be hidden from active Inventory and can be restored later."
                : "These physical units will be hidden from active Inventory and can be restored from Trash."}
            </p>
            <ExpandedUnitDialogButtons
              busy={busy}
              onClose={onClose}
              submitLabel={action === "archive" ? "Archive" : "Move to trash"}
              danger
            />
          </fetcher.Form>
        )}
      </Dialog>
    </DialogPortal>
  );
}

function ExpandedUnitIds({ searchParams }: { searchParams: string }) {
  return (
    <input
      type="hidden"
      name="currentSearchParams"
      defaultValue={searchParams}
    />
  );
}

function ExpandedUnitDialogButtons({
  busy,
  onClose,
  submitLabel = "Confirm",
  danger = false,
}: {
  busy: boolean;
  onClose: () => void;
  submitLabel?: string;
  danger?: boolean;
}) {
  return (
    <div className="flex gap-3">
      <Button
        type="button"
        variant="secondary"
        width="full"
        disabled={busy}
        onClick={onClose}
      >
        Cancel
      </Button>
      <Button
        type="submit"
        variant={danger ? "danger" : "primary"}
        width="full"
        disabled={busy}
      >
        {submitLabel}
      </Button>
    </div>
  );
}

function getUnitLabel(title: string): string {
  return getIoioPhysicalUnitDisplayName({
    logicalProductName: getIoioKitDisplayName({ name: title }),
    unitNumber: getPhysicalUnitLabelFromTitle(title),
    missingUnitLabel: "Unit number missing",
  });
}

function StaffInventoryMobileRow({
  item,
  selected,
  onToggle,
}: {
  item: StaffInventoryItem;
  selected: boolean;
  onToggle: () => void;
}) {
  const { roles } = useUserRoleHelper();
  const location = getPrimaryLocation(item);
  const { availableQuantity, totalQuantity } =
    getStaffInventoryQuantities(item);
  const [expanded, setExpanded] = useState(false);
  const [selectedPhysicalUnitIds, setSelectedPhysicalUnitIds] = useState<
    string[]
  >([]);
  const [physicalUnitAction, setPhysicalUnitAction] =
    useState<ExpandedUnitActionRequest | null>(null);
  useEffect(() => {
    const memberIds = new Set(item.members.map((member) => member.id));
    setSelectedPhysicalUnitIds((ids) => ids.filter((id) => memberIds.has(id)));
  }, [item.members]);

  return (
    <article className="space-y-4 p-4">
      <div className="flex min-w-0 items-center gap-3">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          aria-label={`Select ${item.logicalTitle}`}
          className="size-4 shrink-0 rounded border-gray-300 text-red-600 focus:ring-red-600"
        />
        <AssetImage
          asset={{
            id: item.id,
            mainImage: item.mainImage,
            thumbnailImage: item.thumbnailImage,
            mainImageExpiration: item.mainImageExpiration,
            assetModel: item.assetModel ?? null,
            kitImage: item.assetKits?.[0]?.kit?.image ?? null,
          }}
          alt={`Image of ${item.logicalTitle}`}
          useThumbnail={false}
          className="size-9 shrink-0 rounded border object-cover"
        />
        <Button
          to={`/assets/${item.id}`}
          variant="link"
          className="min-w-0 truncate p-0 text-left font-medium text-gray-900 hover:text-gray-700"
          title={item.logicalTitle}
        >
          {item.logicalTitle}
        </Button>
        {item.isExpandable ? (
          <button
            type="button"
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-red-50 text-red-700 focus:outline-none focus:ring-2 focus:ring-red-600"
            aria-label={
              (expanded ? "Collapse " : "Expand ") + item.logicalTitle
            }
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            <ChevronDownIcon
              className={
                "size-4 transition-transform" + (expanded ? " rotate-180" : "")
              }
            />
          </button>
        ) : null}
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
        <div className="min-w-0">
          <dt className="text-xs font-medium uppercase tracking-wide text-gray-400">
            Category
          </dt>
          <dd className="mt-1 min-w-0">
            <CategoryBadge
              className="max-w-full whitespace-normal break-words text-left"
              category={
                item.category
                  ? {
                      ...item.category,
                    }
                  : null
              }
            />
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs font-medium uppercase tracking-wide text-gray-400">
            Location
          </dt>
          <dd className="mt-1 min-w-0">
            {location ? (
              <LocationBadge
                location={{
                  id: location.id,
                  name: formatStaffLocationName(location.name),
                  parentId: location.parentId ?? undefined,
                  childCount: location._count?.children ?? 0,
                }}
                className="ml-0 max-w-full whitespace-normal break-words text-left"
              />
            ) : (
              <EmptyTableValue />
            )}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs font-medium uppercase tracking-wide text-gray-400">
            Quantity
          </dt>
          <dd
            aria-label={`${availableQuantity} of ${totalQuantity} available`}
            className="mt-1 flex min-w-0 flex-col items-center"
          >
            <QuantityPill available={availableQuantity} total={totalQuantity} />
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-gray-400">
            Updated
          </dt>
          <dd className="mt-1 text-sm text-gray-600">
            <DateS
              date={item.updatedAt}
              options={{ year: "numeric", month: "short", day: "numeric" }}
            />
          </dd>
        </div>
      </dl>
      <div className="border-t border-gray-100 pt-3">
        <StaffInventoryActions
          item={item}
          roles={roles}
          physicalUnitIds={selectedPhysicalUnitIds}
          onPhysicalUnitAction={(action) =>
            setPhysicalUnitAction({
              action,
              targetIds: uniqueAssetIds(selectedPhysicalUnitIds),
            })
          }
        />
      </div>
      {item.isExpandable && expanded ? (
        <div className="rounded-lg bg-gray-50 p-3">
          <StaffInventoryExpandedUnitsContent
            item={item}
            roles={roles}
            selectedUnitIds={selectedPhysicalUnitIds}
            onSelectedUnitIdsChange={setSelectedPhysicalUnitIds}
            actionRequest={physicalUnitAction}
            onActionRequestChange={setPhysicalUnitAction}
          />
        </div>
      ) : null}
    </article>
  );
}

function formatStaffLocationName(name: string): string {
  const roomCodeFirst = name.match(/^([A-Z]\d{3})\s+\u2014\s+(.+)$/u);
  if (roomCodeFirst) {
    return `${roomCodeFirst[2]} / ${roomCodeFirst[1]}`;
  }

  return name.replace(/\s*\u2014\s*/gu, " / ");
}

function QuantityPill({
  available,
  total,
}: {
  available: number;
  total: number;
}) {
  const hasAvailability = available > 0;
  return (
    <Badge
      color={hasAvailability ? "#dcfce7" : "#fee2e2"}
      textColor={hasAvailability ? "#166534" : "#b91c1c"}
      withDot={false}
      className="inline-flex min-w-14 shrink-0 justify-center whitespace-nowrap px-2 py-1 text-sm font-semibold tabular-nums"
    >
      {available}/{total}
    </Badge>
  );
}

function StaffInventoryActions({
  item,
  roles,
  physicalUnitIds = [],
  onPhysicalUnitAction,
}: {
  item: StaffInventoryItem;
  roles: OrganizationRoles[] | undefined;
  physicalUnitIds?: string[];
  onPhysicalUnitAction?: (action: ExpandedUnitAction) => void;
}) {
  const canUpdate = userHasPermission({
    roles,
    entity: PermissionEntity.asset,
    action: PermissionAction.update,
  });
  const canUpdateAssetModel = userHasPermission({
    roles,
    entity: PermissionEntity.assetModel,
    action: PermissionAction.update,
  });
  const canDelete = userHasPermission({
    roles,
    entity: PermissionEntity.asset,
    action: PermissionAction.delete,
  });
  const canReadQr = userHasPermission({
    roles,
    entity: PermissionEntity.qr,
    action: PermissionAction.read,
  });
  const navigate = useNavigate();
  const selectedItems = useAtomValue(selectedBulkItemsAtom);
  const setSelectedItems = useSetAtom(selectedBulkItemsAtom);
  const openBulkDialog = useSetAtom(openBulkDialogAtom);
  const [isBulkQrOpen, setIsBulkQrOpen] = useState(false);
  const isRowSelected = selectedItems.some(
    (selectedItem) => bulkSelectionKey(selectedItem) === bulkSelectionKey(item)
  );
  const hasPhysicalUnitSelection =
    item.isExpandable && physicalUnitIds.length > 0 && onPhysicalUnitAction;
  const assetModelId = item.assetModelId ?? item.assetModel?.id;
  const canEditGeneralItem = assetModelId ? canUpdateAssetModel : canUpdate;

  const selectActionTargets = () => {
    if (!isRowSelected) {
      setSelectedItems(item.isExpandable ? item.members : [item]);
      return;
    }

    const expandedSelection = selectedItems.flatMap((selectedItem) =>
      bulkSelectionKey(selectedItem) === bulkSelectionKey(item) &&
      item.isExpandable
        ? item.members
        : [selectedItem]
    );
    const uniqueSelection = Array.from(
      new Map(expandedSelection.map((entry) => [entry.id, entry])).values()
    );
    setSelectedItems(uniqueSelection);
  };

  const openCategoryDialog = () => {
    if (hasPhysicalUnitSelection) {
      onPhysicalUnitAction("category");
      return;
    }
    selectActionTargets();
    openBulkDialog("category");
  };

  const openLocationDialog = () => {
    if (hasPhysicalUnitSelection) {
      onPhysicalUnitAction("location");
      return;
    }
    selectActionTargets();
    openBulkDialog("location");
  };

  const printLabelsOrQr = () => {
    if (hasPhysicalUnitSelection) {
      onPhysicalUnitAction("print");
      return;
    }
    if (item.isExpandable && (!isRowSelected || selectedItems.length === 1)) {
      const assetIds = item.members
        .map((member) => member.id)
        .map((assetId) => encodeURIComponent(assetId))
        .join(",");
      void navigate(`/labels?assetIds=${assetIds}`);
      return;
    }

    if (isRowSelected && selectedItems.length > 1) {
      setIsBulkQrOpen(true);
      return;
    }

    void navigate(`/labels?assetId=${encodeURIComponent(item.id)}`);
  };

  const openLifecycleDialog = (type: "archive" | "trash") => {
    if (hasPhysicalUnitSelection) {
      onPhysicalUnitAction(type);
      return;
    }
    selectActionTargets();
    openBulkDialog(type);
  };

  return (
    <>
      <div className="flex items-center gap-1.5 whitespace-nowrap">
        {canEditGeneralItem ? (
          <Button
            to={getStaffInventoryEditTarget({
              assetId: item.id,
              assetModelId,
            })}
            size="sm"
            variant="secondary"
            className="size-8 shrink-0 rounded-lg p-1.5"
            aria-label={assetModelId ? "Edit general item" : "Edit item"}
            tooltip={assetModelId ? "Edit general item" : "Edit item"}
          >
            <PencilIcon className="size-4" />
          </Button>
        ) : null}
        {canUpdate || canReadQr || canDelete ? (
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="size-8 shrink-0 rounded-lg p-1.5"
                aria-label="More actions"
                tooltip="More actions"
              >
                <MoreHorizontalIcon className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-52 max-w-60">
              {canUpdate ? (
                <DropdownMenuItem
                  className="flex min-h-10 flex-row items-center gap-3 whitespace-nowrap px-3 py-2 text-gray-700 hover:text-gray-900"
                  onSelect={openCategoryDialog}
                >
                  <FolderInputIcon className="size-5 shrink-0" />
                  <span>Change category</span>
                </DropdownMenuItem>
              ) : null}
              {canUpdate ? (
                <DropdownMenuItem
                  className="flex min-h-10 flex-row items-center gap-3 whitespace-nowrap px-3 py-2 text-gray-700 hover:text-gray-900"
                  onSelect={openLocationDialog}
                >
                  <FolderInputIcon className="size-5 shrink-0" />
                  <span>Change location</span>
                </DropdownMenuItem>
              ) : null}
              {canReadQr ? (
                <DropdownMenuItem
                  className="flex min-h-10 flex-row items-center gap-3 whitespace-nowrap px-3 py-2 text-gray-700 hover:text-gray-900"
                  onSelect={printLabelsOrQr}
                >
                  <PrinterIcon className="size-5 shrink-0" />
                  <span>Print label / QR</span>
                </DropdownMenuItem>
              ) : null}
              {canDelete ? <DropdownMenuSeparator /> : null}
              {canDelete ? (
                <DropdownMenuItem
                  className="flex min-h-10 flex-row items-center gap-3 whitespace-nowrap px-3 py-2 text-gray-700 hover:text-gray-900"
                  onSelect={() => openLifecycleDialog("archive")}
                >
                  <ArchiveIcon className="size-5 shrink-0" />
                  <span>Archive</span>
                </DropdownMenuItem>
              ) : null}
              {canDelete ? (
                <DropdownMenuItem
                  className="flex min-h-10 flex-row items-center gap-3 whitespace-nowrap px-3 py-2 text-red-700 hover:text-red-800"
                  onSelect={() => openLifecycleDialog("trash")}
                >
                  <Trash2Icon className="size-5 shrink-0" />
                  <span>Move to trash</span>
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
      <BulkDownloadQrDialog
        isDialogOpen={isBulkQrOpen}
        onClose={() => setIsBulkQrOpen(false)}
      />
    </>
  );
}
