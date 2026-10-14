import { useEffect, useState } from "react";
import { Form, Link, useNavigation, useRouteLoaderData } from "react-router";
import { AssetImage } from "~/components/assets/asset-image";
import {
  ASSET_IMAGE_FRAME_CLASSES,
  type AssetImageFrameVariant,
} from "~/components/assets/asset-image/sizing";
import type {
  StudentAsset,
  StudentCategory,
  StudentLocation,
} from "~/modules/ioio-student/service.server";
import type { loader as layoutLoader } from "~/routes/_layout+/_layout";
import { useStudentCheckout } from "./checkout-context";
import {
  type StudentInventoryItem,
  getStudentLabAreaFilters,
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
  availability,
}: {
  basePath: string;
  categories: StudentCategory[];
  locations: StudentLocation[];
  query: string;
  locationId: string | null;
  categoryId: string | null;
  itemType: string | null;
  availability: string | null;
}) {
  const navigation = useNavigation();
  const searching = navigation.state !== "idle";
  const areaFilters = getStudentLabAreaFilters(locations);
  const activeFilterCount = [
    categoryId,
    itemType,
    locationId,
    availability,
  ].filter(Boolean).length;
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
          label: `Lab area: ${
            areaFilters.find((area) => area.locationId === locationId)?.label ??
            "Selected"
          }`,
        }
      : null,
    availability
      ? {
          key: "availability",
          label:
            availability === "available"
              ? "Availability: Ready to borrow"
              : "Availability: Not ready to borrow",
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
      { key: "availability", value: availability ?? "" },
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
    { name: "availability", value: availability ?? "" },
  ];

  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
        <Form method="get" action={basePath} className="flex min-w-0 gap-2">
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
            className="min-h-11 rounded-xl border border-gray-300 bg-white px-4 text-sm font-bold text-gray-800 hover:border-red-200 hover:text-red-800 focus:outline-none focus:ring-2 focus:ring-red-600"
          >
            {searching ? "Searching…" : "Search"}
          </button>
        </Form>

        <details className="relative rounded-xl border border-gray-200 bg-white">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-center gap-2 px-4 text-sm font-bold text-gray-800 focus:outline-none focus:ring-2 focus:ring-red-600">
            Filters
            {activeFilterCount ? (
              <span className="rounded-full bg-red-700 px-1.5 py-0.5 text-[10px] text-white">
                {activeFilterCount}
              </span>
            ) : null}
          </summary>
          <Form
            key={`${categoryId ?? ""}-${itemType ?? ""}-${locationId ?? ""}-${
              availability ?? ""
            }`}
            method="get"
            action={basePath}
            className="absolute right-0 z-10 mt-2 grid w-[min(22rem,calc(100vw-2rem))] gap-3 rounded-2xl border border-gray-200 bg-white p-4 shadow-xl sm:right-0"
          >
            <input type="hidden" name="q" value={query} />
            <label className="text-sm font-semibold text-gray-800">
              Category
              <select
                name="category"
                defaultValue={categoryId ?? ""}
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
                Availability
              </legend>
              <div className="mt-1 flex flex-wrap gap-2">
                {[
                  { value: "", label: "Any availability" },
                  { value: "available", label: "Ready to borrow" },
                  { value: "unavailable", label: "Not ready to borrow" },
                ].map((option, index) => {
                  const id = `${basePath.replaceAll(
                    "/",
                    "-"
                  )}-availability-${index}`;
                  return (
                    <label key={option.value || "any"}>
                      <input
                        id={id}
                        className="peer sr-only"
                        type="radio"
                        name="availability"
                        value={option.value}
                        defaultChecked={(availability ?? "") === option.value}
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
                        name="itemType"
                        value={option.value}
                        defaultChecked={(itemType ?? "") === option.value}
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
                        name="location"
                        value={area.locationId ?? ""}
                        defaultChecked={
                          (area.locationId ?? null) === locationId
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
            <div className="flex gap-2">
              <button
                type="submit"
                className="min-h-10 flex-1 rounded-lg bg-red-700 px-3 text-sm font-bold text-white hover:bg-red-800"
              >
                Apply filters
              </button>
              <Link
                to={basePath}
                className="flex min-h-10 items-center rounded-lg border border-gray-300 px-3 text-sm font-bold text-gray-700 hover:border-red-200 hover:text-red-800"
              >
                Clear
              </Link>
            </div>
          </Form>
        </details>
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
    <article className="flex h-full min-w-0 flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white transition hover:border-red-200 hover:shadow-sm">
      <Link
        to={`/ioio/browse/${asset.id}`}
        aria-label={`View ${formatStudentTitle(asset.title, asset.type)}`}
        className="block focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700"
      >
        <StudentAssetPlaceholder asset={asset} />
      </Link>
      <div
        className={`flex min-w-0 flex-1 flex-col ${compact ? "p-3" : "p-4"}`}
      >
        <div className="min-h-10">
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
            <p className="mt-3 line-clamp-2 min-h-10 text-xs leading-4 text-gray-500">
              {locationSummary}
            </p>
            <div className="mt-auto flex flex-col items-start gap-2 pt-3 sm:flex-row sm:items-end sm:justify-between sm:gap-3">
              <p
                className={`text-sm font-bold ${
                  availableNow ? "text-green-800" : "text-gray-600"
                }`}
              >
                {availability}
              </p>
              <StudentCheckoutButton asset={asset} compact={compact} />
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
}: {
  asset: StudentAsset | StudentInventoryItem;
  compact?: boolean;
  availabilityOverride?: number;
  primary?: boolean;
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
      aria-label={inCheckout ? "In borrow list" : "Add to borrow list"}
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
        "Add to borrow list"
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
