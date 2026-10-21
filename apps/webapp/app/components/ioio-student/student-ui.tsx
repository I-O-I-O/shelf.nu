import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import {
  Form,
  Link,
  useNavigate,
  useNavigation,
  useRouteLoaderData,
} from "react-router";
import { AssetImage } from "~/components/assets/asset-image";
import {
  ASSET_IMAGE_FRAME_CLASSES,
  type AssetImageFrameVariant,
} from "~/components/assets/asset-image/sizing";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from "~/components/shared/sheet";
import type {
  StudentAsset,
  StudentCategory,
  StudentLocation,
} from "~/modules/ioio-student/service.server";
import type { loader as layoutLoader } from "~/routes/_layout+/_layout";
import {
  useStudentCheckout,
  type StudentCheckoutItemDraft,
} from "./checkout-context";
import {
  type StudentInventoryItem,
  getStudentLabAreaFilters,
  getStudentLocationPath,
} from "./inventory-presentation";

export function formatStudentDate(value: Date) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function formatStudentLabel(value: string) {
  return value
    .replace(new RegExp(`\\s*${String.fromCharCode(0x2014)}\\s*`, "g"), " / ")
    .replace(new RegExp(`\\s*${String.fromCharCode(0x2013)}\\s*`, "g"), " - ");
}

export function formatStudentTitle(value: string, type?: StudentAsset["type"]) {
  if (type !== "QUANTITY_TRACKED") return formatStudentLabel(value);
  return formatStudentLabel(value)
    .replace(/\s+#\s*[^#]+$/, "")
    .trim();
}

export function StudentAssetPlaceholder({
  asset,
  className = "",
  variant = "card",
  imageFit = "cover",
}: {
  asset?: Pick<
    StudentAsset,
    "id" | "title" | "type" | "mainImage" | "thumbnailImage" | "assetModel"
  > & { kitImage?: string | null };
  className?: string;
  variant?: Extract<AssetImageFrameVariant, "card" | "detail" | "thumbnail">;
  imageFit?: "contain" | "cover";
}) {
  return (
    <div
      className={`relative flex w-full items-center justify-center overflow-hidden bg-gray-100 ${ASSET_IMAGE_FRAME_CLASSES[variant]} ${className}`}
    >
      {asset ? (
        <AssetImage
          asset={{
            id: asset.id,
            mainImage: asset.mainImage,
            thumbnailImage: asset.thumbnailImage,
            assetModel: asset.assetModel,
            kitImage: asset.kitImage,
          }}
          alt={`Image of ${formatStudentTitle(asset.title, asset.type)}`}
          useThumbnail={false}
          imageFit={imageFit}
          className="size-full"
        />
      ) : (
        <div className="flex size-14 items-center justify-center rounded-3xl border border-gray-200 bg-white text-red-700 shadow-sm">
          <svg
            aria-hidden="true"
            className="size-8"
            fill="none"
            viewBox="0 0 48 48"
          >
            <rect
              height="24"
              rx="4"
              stroke="currentColor"
              strokeWidth="2.5"
              width="32"
              x="8"
              y="12"
            />
            <path
              d="M16 8v4M32 8v4M16 36v4M32 36v4"
              stroke="currentColor"
              strokeWidth="2.5"
            />
            <circle cx="18" cy="24" fill="currentColor" r="3" />
            <path
              d="M26 21h8M26 27h5"
              stroke="currentColor"
              strokeLinecap="round"
              strokeWidth="2.5"
            />
          </svg>
        </div>
      )}
    </div>
  );
}

/** Format a date-only Shelf value without converting it through a timezone. */
export function formatStudentDateOnly(value: string | Date) {
  const raw = typeof value === "string" ? value : value.toISOString();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return formatStudentDate(new Date(raw));
  const [, year, month, day] = match;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
    new Date(Number(year), Number(month) - 1, Number(day))
  );
}

export function SectionHeading({
  title,
  text,
}: {
  title: string;
  text?: string;
}) {
  return (
    <div className="mb-5">
      <p className="mb-2 text-xs font-black uppercase tracking-[0.18em] text-red-800">
        IOIO Lab
      </p>
      <h1 className="text-3xl font-black tracking-tight text-gray-950 sm:text-4xl">
        {title}
      </h1>
      {text ? (
        <p className="mt-2 max-w-2xl text-base leading-6 text-gray-600">
          {text}
        </p>
      ) : null}
    </div>
  );
}

export function InventoryFilterControls({
  basePath,
  categories,
  locations,
  query,
  locationId,
  categoryId,
  itemType,
  scanAction,
}: {
  basePath: string;
  categories: StudentCategory[];
  locations: StudentLocation[];
  query: string;
  locationId: string | null;
  categoryId: string | null;
  itemType: string | null;
  scanAction?: ReactNode;
}) {
  const navigate = useNavigate();
  const navigation = useNavigation();
  const searching = navigation.state !== "idle";
  const areaFilters = getStudentLabAreaFilters(locations);
  const appliedFilters = {
    categoryId: categoryId ?? "",
    itemType: itemType ?? "",
    locationId: locationId ?? "",
  };
  const [filterPanelOpen, setFilterPanelOpen] = useState(false);
  const [draftFilters, setDraftFilters] = useState(appliedFilters);
  const handleFilterPanelOpenChange = (open: boolean) => {
    // Every non-Apply close path discards draft edits. Opening always starts
    // from the URL-backed filters currently applied to the inventory.
    setDraftFilters(appliedFilters);
    setFilterPanelOpen(open);
  };
  const handleApplyFilters = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFilterPanelOpen(false);
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (draftFilters.categoryId) {
      params.set("category", draftFilters.categoryId);
    }
    if (draftFilters.itemType) params.set("itemType", draftFilters.itemType);
    if (draftFilters.locationId) {
      params.set("location", draftFilters.locationId);
    }
    const search = params.toString();
    void navigate(search ? `${basePath}?${search}` : basePath);
  };
  const activeFilterCount = [categoryId, itemType, locationId].filter(
    Boolean
  ).length;
  const activeFilters = [
    query.trim() ? { key: "q", label: `Search: ${query.trim()}` } : null,
    categoryId
      ? {
          key: "category",
          label: `Category: ${
            categories.find((category) => category.id === categoryId)?.name ??
            "Selected"
          }`,
        }
      : null,
    itemType
      ? {
          key: "itemType",
          label:
            itemType === "individual"
              ? "Item type: Kits"
              : "Item type: Normal items",
        }
      : null,
    locationId
      ? {
          key: "location",
          label: `Location: ${
            getStudentLocationPath(locationId, locations)?.join(" › ") ??
            areaFilters.find((area) => area.locationId === locationId)?.label ??
            "Selected"
          }`,
        }
      : null,
  ].filter(
    (filter): filter is { key: string; label: string } => filter !== null
  );
  const removeFilterHref = (removedKey: string) => {
    const params = new URLSearchParams();
    const values = [
      { key: "q", value: query },
      { key: "category", value: categoryId ?? "" },
      { key: "itemType", value: itemType ?? "" },
      { key: "location", value: locationId ?? "" },
    ];
    for (const { key, value } of values) {
      if (key !== removedKey && value) params.set(key, value);
    }
    const search = params.toString();
    return search ? `${basePath}?${search}` : basePath;
  };
  const hiddenFilters = (
    includeSearch = true
  ): Array<{ name: string; value: string }> => [
    ...(includeSearch ? [{ name: "q", value: query }] : []),
    { name: "location", value: locationId ?? "" },
    { name: "category", value: categoryId ?? "" },
    { name: "itemType", value: itemType ?? "" },
  ];

  return (
    <div className="space-y-3">
      <div
        data-testid="inventory-controls-row"
        className="flex flex-wrap items-center gap-2"
      >
        <Form
          method="get"
          action={basePath}
          className="flex min-w-0 flex-1 basis-80 gap-2"
        >
          <label
            htmlFor={`${basePath.replaceAll("/", "-")}-search`}
            className="sr-only"
          >
            Search inventory
          </label>
          <input
            key={query}
            id={`${basePath.replaceAll("/", "-")}-search`}
            name="q"
            defaultValue={query}
            placeholder="Search by item name or description"
            className="min-h-11 min-w-0 flex-1 rounded-xl border border-gray-300 bg-white px-3 text-sm focus:border-red-600 focus:outline-none focus:ring-2 focus:ring-red-600"
          />
          {hiddenFilters(false)
            .filter(({ name, value }) => name !== "q" && value)
            .map(({ name, value }) => (
              <input key={name} type="hidden" name={name} value={value} />
            ))}
          <button
            type="submit"
            disabled={searching}
            className="min-h-11 shrink-0 whitespace-nowrap rounded-xl border border-gray-300 bg-white px-3 text-sm font-bold text-gray-800 hover:border-red-200 hover:text-red-800 focus:outline-none focus:ring-2 focus:ring-red-600"
          >
            {searching ? "Searching…" : "Search"}
          </button>
        </Form>

        {scanAction}

        <Sheet
          open={filterPanelOpen}
          onOpenChange={handleFilterPanelOpenChange}
        >
          <SheetTrigger asChild>
            <button
              type="button"
              aria-label={
                activeFilterCount
                  ? `Filters, ${activeFilterCount} applied`
                  : "Filters"
              }
              className="flex min-h-11 shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-xl border border-gray-300 bg-white px-3 text-sm font-bold text-gray-800 hover:border-red-200 hover:text-red-800 focus:outline-none focus:ring-2 focus:ring-red-600"
            >
              Filters
              {activeFilterCount ? (
                <span className="rounded-full bg-red-700 px-1.5 py-0.5 text-[10px] text-white">
                  {activeFilterCount}
                </span>
              ) : null}
            </button>
          </SheetTrigger>
          <SheetContent
            side="right"
            className="flex w-[min(24rem,calc(100vw-1rem))] flex-col gap-4 overflow-y-auto border-l bg-white p-5 sm:w-96"
          >
            <div className="space-y-1 pr-8">
              <SheetTitle className="text-left text-xl font-black text-gray-950">
                Filters
              </SheetTitle>
              <SheetDescription className="text-left text-sm text-gray-600">
                Choose how to narrow the inventory, then apply your changes.
              </SheetDescription>
            </div>
            <form onSubmit={handleApplyFilters} className="grid gap-5">
              <label className="text-sm font-semibold text-gray-800">
                Category
                <select
                  value={draftFilters.categoryId}
                  onChange={(event) =>
                    setDraftFilters((current) => ({
                      ...current,
                      categoryId: event.target.value,
                    }))
                  }
                  className="mt-1 min-h-10 w-full rounded-lg border border-gray-300 bg-white px-2 text-sm"
                >
                  <option value="">All categories</option>
                  {categories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
                </select>
              </label>
              <fieldset className="min-w-0">
                <legend className="text-sm font-semibold text-gray-800">
                  Item type
                </legend>
                <div className="mt-1 flex flex-wrap gap-2">
                  {[
                    { value: "", label: "All items" },
                    { value: "quantity", label: "Normal items" },
                    { value: "individual", label: "Kits" },
                  ].map((option, index) => {
                    const id = `${basePath.replaceAll(
                      "/",
                      "-"
                    )}-item-type-${index}`;
                    return (
                      <label key={option.value || "all"}>
                        <input
                          id={id}
                          className="peer sr-only"
                          type="radio"
                          value={option.value}
                          checked={draftFilters.itemType === option.value}
                          onChange={() =>
                            setDraftFilters((current) => ({
                              ...current,
                              itemType: option.value,
                            }))
                          }
                        />
                        <span className="inline-flex min-h-9 cursor-pointer items-center rounded-full border border-gray-200 bg-white px-3 text-xs font-bold text-gray-700 transition peer-checked:border-red-700 peer-checked:bg-red-700 peer-checked:text-white peer-focus-visible:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-red-700 peer-focus-visible:ring-offset-2 hover:border-red-200 hover:text-red-800">
                          {option.label}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>
              <fieldset className="min-w-0">
                <legend className="text-sm font-semibold text-gray-800">
                  Lab area
                </legend>
                <div className="mt-1 flex flex-wrap gap-2">
                  {areaFilters.map((area, index) => {
                    const id = `${basePath.replaceAll(
                      "/",
                      "-"
                    )}-lab-area-${index}`;
                    return (
                      <label key={area.key}>
                        <input
                          id={id}
                          className="peer sr-only"
                          type="radio"
                          value={area.locationId ?? ""}
                          checked={
                            (area.locationId ?? "") === draftFilters.locationId
                          }
                          onChange={() =>
                            setDraftFilters((current) => ({
                              ...current,
                              locationId: area.locationId ?? "",
                            }))
                          }
                        />
                        <span className="inline-flex min-h-9 cursor-pointer items-center rounded-full border border-gray-200 bg-white px-3 text-xs font-bold text-gray-700 transition peer-checked:border-red-700 peer-checked:bg-red-700 peer-checked:text-white peer-focus-visible:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-red-700 peer-focus-visible:ring-offset-2 hover:border-red-200 hover:text-red-800">
                          {formatStudentLabel(area.label)}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>
              <div className="flex flex-wrap gap-2 border-t border-gray-200 pt-4">
                <button
                  type="submit"
                  className="min-h-10 flex-1 rounded-lg bg-red-700 px-3 text-sm font-bold text-white hover:bg-red-800"
                >
                  Apply filters
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setDraftFilters({
                      categoryId: "",
                      itemType: "",
                      locationId: "",
                    })
                  }
                  className="min-h-10 rounded-lg border border-gray-300 px-3 text-sm font-bold text-gray-700 hover:border-red-200 hover:text-red-800"
                >
                  Clear
                </button>
              </div>
            </form>
          </SheetContent>
        </Sheet>
      </div>

      {activeFilters.length ? (
        <div
          role="group"
          aria-label="Active inventory filters"
          className="flex flex-wrap items-center gap-2"
        >
          <span className="text-xs font-semibold text-gray-600">Showing:</span>
          {activeFilters.map((filter) => (
            <Link
              key={filter.key}
              to={removeFilterHref(filter.key)}
              aria-label={`Remove ${filter.label} filter`}
              className="inline-flex min-h-9 max-w-full items-center gap-2 rounded-full border border-red-200 bg-red-50 px-3 py-1 text-xs font-semibold text-red-900 hover:border-red-400 hover:bg-red-100 focus:outline-none focus:ring-2 focus:ring-red-700 focus:ring-offset-2"
            >
              <span className="max-w-[min(18rem,calc(100vw-7rem))] truncate">
                {filter.label}
              </span>
              <span aria-hidden="true" className="text-sm leading-none">
                ×
              </span>
            </Link>
          ))}
          <Link
            to={basePath}
            className="inline-flex min-h-9 items-center px-2 text-xs font-bold text-gray-700 underline-offset-2 hover:text-red-800 hover:underline focus:outline-none focus:ring-2 focus:ring-red-700 focus:ring-offset-2"
          >
            Clear all
          </Link>
        </div>
      ) : null}
    </div>
  );
}

export function AssetCard({
  asset,
  variant = "inventory",
  compact = false,
}: {
  asset: StudentAsset | StudentInventoryItem;
  variant?: "inventory" | "assistant";
  compact?: boolean;
}) {
  const availableNow = Boolean(
    asset.availableToBook && asset.availableQuantity
  );
  const availability = availableNow
    ? asset.availableQuantity === 1
      ? "1 ready to borrow"
      : `${asset.availableQuantity} ready to borrow`
    : asset.status === "IN_CUSTODY" || asset.status === "CHECKED_OUT"
    ? "Currently on loan"
    : asset.availableToBook
    ? "None ready to borrow"
    : "Temporarily unavailable";
  const totalQuantity = asset.quantity ?? (asset.type === "INDIVIDUAL" ? 1 : 0);
  const locationSummary = asset.locations.length
    ? asset.locations
        .map(
          (location) =>
            location.displayPath ?? formatStudentLabel(location.name)
        )
        .join(" · ")
    : "Location not recorded";

  return (
    <article
      className={`flex min-w-0 flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white transition hover:border-red-200 hover:shadow-sm ${
        variant === "assistant" ? "h-full" : "self-start"
      }`}
    >
      <Link
        to={`/ioio/browse/${asset.id}`}
        aria-label={`View ${formatStudentTitle(asset.title, asset.type)}`}
        className="block focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700"
      >
        <StudentAssetPlaceholder asset={asset} />
      </Link>
      <div
        className={`flex min-w-0 flex-col ${
          variant === "assistant" ? `flex-1 ${compact ? "p-3" : "p-4"}` : "p-3"
        }`}
      >
        <div className={variant === "assistant" ? "min-h-10" : ""}>
          <Link
            to={`/ioio/browse/${asset.id}`}
            className="line-clamp-2 font-bold leading-5 text-gray-950 underline-offset-4 hover:text-red-800 hover:underline focus:outline-none focus:ring-2 focus:ring-red-700"
          >
            {formatStudentTitle(asset.title, asset.type)}
          </Link>
        </div>
        {variant === "assistant" ? (
          <>
            <p className="mt-2 text-sm font-semibold text-gray-800">
              {totalQuantity} {totalQuantity === 1 ? "unit" : "units"} ·{" "}
              {asset.availableQuantity ?? 0} available
            </p>
            {asset.category?.name ? (
              <p className="mt-1 text-xs text-gray-500">
                {formatStudentLabel(asset.category.name)}
              </p>
            ) : null}
            <p className="mt-1 text-xs leading-4 text-gray-500">
              {locationSummary}
            </p>
            <Link
              to={`/ioio/browse/${asset.id}`}
              className="mt-3 inline-flex min-h-10 items-center self-start text-sm font-bold text-red-800 underline-offset-4 hover:underline focus:outline-none focus:ring-2 focus:ring-red-700"
            >
              View in Inventory
            </Link>
          </>
        ) : (
          <>
            <p className="mt-1 line-clamp-2 text-xs leading-4 text-gray-500">
              {locationSummary}
            </p>
            <div className="mt-2 flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-2">
              <p
                className={`text-sm font-bold ${
                  availableNow ? "text-green-800" : "text-gray-600"
                }`}
              >
                {availability}
              </p>
              <StudentCheckoutButton asset={asset} compact={compact} primary />
            </div>
          </>
        )}
      </div>
    </article>
  );
}

export function StudentCheckoutButton({
  asset,
  compact = false,
  availabilityOverride,
  primary = false,
  borrowLabel = "Add to borrow list",
}: {
  asset: StudentAsset | StudentInventoryItem | StudentCheckoutItemDraft;
  compact?: boolean;
  availabilityOverride?: number;
  primary?: boolean;
  borrowLabel?: string;
}) {
  const { addItem, hasItem, removeItem } = useStudentCheckout();
  const layoutData = useRouteLoaderData<typeof layoutLoader>(
    "routes/_layout+/_layout"
  );
  const [justAdded, setJustAdded] = useState(false);
  const inCheckout = hasItem(asset.id);
  const availableQuantity = availabilityOverride ?? asset.availableQuantity;
  const available = Boolean(asset.availableToBook && availableQuantity);
  const approvalRequired =
    !layoutData?.isIoioStaff &&
    !layoutData?.isIoioTA &&
    layoutData?.annualAccessApproval != null &&
    layoutData.annualAccessApproval.required &&
    layoutData.annualAccessApproval.status !== "APPROVED";

  useEffect(() => {
    if (!justAdded) return;
    const timeout = window.setTimeout(() => setJustAdded(false), 1400);
    return () => window.clearTimeout(timeout);
  }, [justAdded]);

  if (!available && !inCheckout) {
    return (
      <span className="shrink-0 rounded-full bg-gray-100 px-2.5 py-1.5 text-xs font-bold text-gray-500">
        {asset.status === "IN_CUSTODY" || asset.status === "CHECKED_OUT"
          ? "On loan"
          : "Unavailable"}
      </span>
    );
  }

  if (approvalRequired && !inCheckout) {
    return (
      <Link
        to="/ioio/settings/access-approval"
        className={`max-w-full rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-center text-xs font-bold text-red-800 hover:border-red-400 hover:bg-red-100 focus:outline-none focus:ring-2 focus:ring-red-700 focus:ring-offset-2 ${
          compact ? "whitespace-normal" : "shrink-0"
        }`}
      >
        Approval required
      </Link>
    );
  }

  return (
    <button
      type="button"
      aria-pressed={inCheckout}
      aria-label={inCheckout ? "In borrow list" : borrowLabel}
      onClick={() => {
        if (inCheckout) {
          removeItem(asset.id);
          setJustAdded(false);
        } else {
          addItem(asset);
          setJustAdded(true);
        }
      }}
      className={`min-h-10 max-w-full rounded-xl border px-3 py-2 text-xs font-bold transition focus:outline-none focus:ring-2 focus:ring-red-700 focus:ring-offset-2 ${
        inCheckout
          ? "border-red-700 bg-red-700 text-white hover:bg-red-800"
          : primary
          ? "border-red-700 bg-red-700 text-white hover:border-red-800 hover:bg-red-800"
          : "border-red-200 bg-red-50 text-red-800 hover:border-red-400 hover:bg-red-100"
      } ${
        compact ? "shrink-0 whitespace-normal px-2.5 text-left" : "shrink-0"
      }`}
    >
      {inCheckout ? (
        <span className="inline-flex items-center gap-1.5">
          {justAdded ? (
            <svg aria-hidden="true" viewBox="0 0 20 20" className="size-4">
              <path
                d="m4 10 3.5 3.5L16 5"
                fill="none"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
              />
            </svg>
          ) : null}
          {justAdded ? "Added" : "In borrow list"}
        </span>
      ) : (
        borrowLabel
      )}
    </button>
  );
}

export function LocationTree({ locations }: { locations: StudentLocation[] }) {
  if (!locations.length) {
    return (
      <p className="rounded-xl bg-white p-4 text-sm text-gray-600">
        No locations yet.
      </p>
    );
  }

  return (
    <ul className="space-y-3">
      {locations.map((location) => (
        <li
          key={location.id}
          className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm"
        >
          <div className="flex min-w-0 items-center gap-3">
            {location.thumbnailUrl || location.imageUrl ? (
              <img
                src={location.thumbnailUrl ?? location.imageUrl ?? undefined}
                alt=""
                aria-hidden="true"
                className="size-12 shrink-0 rounded-lg object-cover"
              />
            ) : null}
            <div className="min-w-0">
              <Link
                to={`/ioio/browse?location=${location.id}`}
                className="font-bold text-gray-950 underline-offset-4 hover:text-red-800 hover:underline focus:outline-none focus:ring-2 focus:ring-red-700"
              >
                {formatStudentLabel(location.name)}
              </Link>
              <span className="ml-2 text-xs text-gray-600">
                {location.assetCount} asset placement
                {location.assetCount === 1 ? "" : "s"}
              </span>
            </div>
          </div>
          {location.children.length ? (
            <div className="mt-3 border-l-2 border-red-200 pl-4">
              <LocationTree locations={location.children} />
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
