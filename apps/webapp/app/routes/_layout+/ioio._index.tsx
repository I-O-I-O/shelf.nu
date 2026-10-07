import { Clock3, MapPin } from "lucide-react";
import { useRouteLoaderData, Link, useLoaderData } from "react-router";
import { data, type LoaderFunctionArgs, type MetaFunction } from "react-router";
import { AssetImage } from "~/components/assets/asset-image";
import {
  filterStudentInventory,
  getStudentLabAreaFilters,
  groupStudentAssets,
  type StudentInventoryItem,
} from "~/components/ioio-student/inventory-presentation";
import {
  formatStudentDateOnly,
  formatStudentLabel,
  formatStudentTitle,
  InventoryFilterControls,
  StudentAssetPlaceholder,
  StudentCheckoutButton,
} from "~/components/ioio-student/student-ui";
import { db } from "~/database/db.server";
import type { ResolvableAssetModelImage } from "~/modules/asset/image-resolution";
import { resolveAssetImagesForPresentation } from "~/modules/asset/service.server";
import { getPickupLocationDisplay } from "~/modules/ioio-staff/pickup-zone.server";
import {
  formatPickupHours,
  getPreparationPickupDeadline,
} from "~/modules/ioio-staff/preparation";
import {
  logIoioStudentLoadFailure,
  logIoioStudentLoadStage,
  withIoioStudentLoadStage,
} from "~/modules/ioio-student/load-diagnostics.server";
import { requireStudentRead } from "~/modules/ioio-student/route.server";
import type {
  StudentAsset,
  StudentLocation,
} from "~/modules/ioio-student/service.server";
import {
  getStudentAssets,
  getStudentCategories,
  getStudentLocations,
} from "~/modules/ioio-student/service.server";
import { getIoioPhysicalUnitDisplayName } from "~/modules/kit/ioio-kit-presentation";
import type { loader as layoutLoader } from "~/routes/_layout+/_layout";
import { makeShelfError } from "~/utils/error";
import { error, payload } from "~/utils/http.server";

export const meta: MetaFunction<typeof loader> = () => [{ title: "IOIO Lab" }];

export async function loader({ context, request }: LoaderFunctionArgs) {
  const pathname = new URL(request.url).pathname;
  const diagnosticRequest =
    pathname === "/ioio" || pathname.startsWith("/ioio/");
  logIoioStudentLoadStage(
    "4 /ioio index-route loader entered",
    "STARTED",
    diagnosticRequest
  );
  const { userId, organizationId } = await withIoioStudentLoadStage(
    "4 Student inventory read authorization",
    diagnosticRequest,
    () => requireStudentRead({ context, request })
  );
  const params = new URL(request.url).searchParams;
  const requestedCategory = params.get("category");
  const returnSubmitted = params.get("return") === "submitted";
  const requestedItemType = params.get("itemType");
  const itemType =
    requestedItemType === "quantity" || requestedItemType === "individual"
      ? requestedItemType
      : null;
  try {
    const [categories, locations, preparationOperations] = await Promise.all([
      withIoioStudentLoadStage(
        "4 home categories (category/archive queries)",
        diagnosticRequest,
        () => getStudentCategories({ organizationId })
      ),
      withIoioStudentLoadStage(
        "4 home locations (location/archive/placement queries)",
        diagnosticRequest,
        () => getStudentLocations({ organizationId })
      ),
      withIoioStudentLoadStage(
        "4 home active preparation statuses",
        diagnosticRequest,
        () =>
          db.ioioWriteOperation.findMany({
            where: {
              organizationId,
              userId,
              operationType: "IOIO_PREPARATION",
              status: { in: ["PENDING_PREPARATION", "READY_FOR_PICKUP"] },
            },
            orderBy: { createdAt: "desc" },
            select: {
              id: true,
              assetId: true,
              quantity: true,
              createdAt: true,
              from: true,
              to: true,
              bookingAssetId: true,
              status: true,
              locationId: true,
              reviewedAt: true,
            },
          })
      ),
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
    const allAssets = await withIoioStudentLoadStage(
      "4 home inventory (archive, asset, and availability queries)",
      diagnosticRequest,
      () =>
        getStudentAssets({
          organizationId,
          query: params.get("q"),
          categoryId: selectedCategory,
          locationId: selectedLocation,
        })
    );
    const assets = await withIoioStudentLoadStage(
      "4 home inventory presentation",
      diagnosticRequest,
      () =>
        filterStudentInventory(groupStudentAssets(allAssets), {
          categoryId: selectedCategory,
          itemType,
        })
    );
    const studentTeamMembers = await db.teamMember.findMany({
      where: { organizationId, userId, deletedAt: null },
      select: { id: true },
    });
    const bookingAssetIds = preparationOperations
      .map((operation) => operation.bookingAssetId)
      .filter((id): id is string => Boolean(id));
    const bookingAssets = bookingAssetIds.length
      ? await db.bookingAsset.findMany({
          where: {
            id: { in: bookingAssetIds },
            booking: {
              organizationId,
              status: { in: ["ONGOING", "OVERDUE", "RESERVED"] },
              OR: [
                { custodianUserId: userId },
                ...(studentTeamMembers.length
                  ? [
                      {
                        custodianTeamMemberId: {
                          in: studentTeamMembers.map((member) => member.id),
                        },
                      },
                    ]
                  : []),
              ],
            },
          },
          select: {
            id: true,
            bookingId: true,
            sourceKitId: true,
            booking: { select: { from: true, to: true } },
            asset: {
              select: {
                id: true,
                title: true,
                type: true,
                sequentialId: true,
                mainImage: true,
                thumbnailImage: true,
                mainImageStoragePath: true,
                thumbnailImageStoragePath: true,
                assetModel: {
                  select: {
                    id: true,
                    name: true,
                    image: true,
                    thumbnailImage: true,
                    imageStoragePath: true,
                    thumbnailImageStoragePath: true,
                  },
                },
              },
            },
          },
        })
      : [];
    const sourceKitIds = Array.from(
      new Set(
        bookingAssets
          .map((bookingAsset) => bookingAsset.sourceKitId)
          .filter((id): id is string => Boolean(id))
      )
    );
    const sourceKits = sourceKitIds.length
      ? await db.kit.findMany({
          where: { organizationId, id: { in: sourceKitIds } },
          select: {
            id: true,
            name: true,
            image: true,
            imageStoragePath: true,
            imageExpiration: true,
          },
        })
      : [];
    const sourceKitById = new Map(sourceKits.map((kit) => [kit.id, kit]));
    const resolvedBookingAssets = await resolveAssetImagesForPresentation(
      bookingAssets.map((bookingAsset) => ({
        ...bookingAsset.asset,
        kitImage: bookingAsset.sourceKitId
          ? sourceKitById.get(bookingAsset.sourceKitId)?.image ?? null
          : null,
        kitImageStoragePath: bookingAsset.sourceKitId
          ? sourceKitById.get(bookingAsset.sourceKitId)?.imageStoragePath ??
            null
          : null,
      }))
    );
    const currentLoanAssets = new Map(
      bookingAssets.map((bookingAsset, index) => {
        const sourceKit = bookingAsset.sourceKitId
          ? sourceKitById.get(bookingAsset.sourceKitId)
          : null;
        const asset = resolvedBookingAssets[index];
        const unitLabel = bookingAsset.sourceKitId
          ? bookingAsset.asset.title.match(/(?:^|\s)(#\d+)\s*$/u)?.[1] ?? null
          : bookingAsset.asset.type === "INDIVIDUAL"
          ? bookingAsset.asset.title.match(/(?:^|\s)(#\d+)\s*$/u)?.[1] ??
            bookingAsset.asset.sequentialId
          : null;
        return [
          bookingAsset.id,
          {
            loan: bookingAsset.booking,
            item: {
              asset: {
                ...asset,
                kitImage: asset.kitImage ?? null,
              },
              isKit: Boolean(sourceKit),
              kitName: sourceKit?.name ?? null,
              unitLabel,
            },
          },
        ] as const;
      })
    );
    const attentionPreparationOperations = preparationOperations.filter(
      (operation) =>
        operation.status === "READY_FOR_PICKUP" ||
        operation.status === "PENDING_PREPARATION"
    );
    const readyForPickup = await Promise.all(
      attentionPreparationOperations
        .filter(
          (operation) =>
            operation.status === "READY_FOR_PICKUP" && operation.bookingAssetId
        )
        .map(async (operation) => {
          const loanAsset = currentLoanAssets.get(operation.bookingAssetId!);
          if (!loanAsset) return null;
          const { item } = loanAsset;
          const location = operation.locationId
            ? await getPickupLocationDisplay({
                organizationId,
                locationId: operation.locationId,
              })
            : null;
          const displayName = getIoioPhysicalUnitDisplayName({
            logicalProductName: item.kitName ?? item.asset.title,
            unitNumber: item.unitLabel,
            ...(item.isKit || item.asset.type === "INDIVIDUAL"
              ? { missingUnitLabel: "Unit number missing" }
              : {}),
          });
          return {
            id: operation.id,
            title: item.kitName ?? item.asset.title,
            displayName,
            asset: {
              id: item.asset.id,
              title: item.asset.title,
              type: item.asset.type,
              mainImage: item.asset.mainImage,
              thumbnailImage: item.asset.thumbnailImage,
              assetModel: item.asset.assetModel,
              kitImage: item.asset.kitImage,
            },
            pickupLocation: location?.label ?? null,
            pickupRoomName: location?.roomName ?? null,
            pickupZoneName: location?.zoneName ?? null,
            pickupDeadline: operation.reviewedAt
              ? getPreparationPickupDeadline(operation.reviewedAt)
              : null,
          };
        })
    );
    const pendingPreparationAssetIds = attentionPreparationOperations
      .filter(
        (operation) =>
          operation.status === "PENDING_PREPARATION" &&
          !operation.bookingAssetId &&
          operation.assetId
      )
      .map((operation) => operation.assetId!);
    const pendingPreparationAssets = pendingPreparationAssetIds.length
      ? await db.asset.findMany({
          where: { organizationId, id: { in: pendingPreparationAssetIds } },
          select: {
            id: true,
            title: true,
            type: true,
            mainImage: true,
            thumbnailImage: true,
            mainImageStoragePath: true,
            thumbnailImageStoragePath: true,
            assetModel: {
              select: {
                name: true,
                image: true,
                thumbnailImage: true,
                imageStoragePath: true,
                thumbnailImageStoragePath: true,
              },
            },
            assetKits: {
              select: {
                kit: {
                  select: {
                    name: true,
                    image: true,
                    imageExpiration: true,
                    imageStoragePath: true,
                  },
                },
              },
              take: 1,
            },
          },
        })
      : [];
    const resolvedPendingAssets = await resolveAssetImagesForPresentation(
      pendingPreparationAssets
    );
    const preparing = attentionPreparationOperations
      .filter((operation) => operation.status === "PENDING_PREPARATION")
      .map((operation) => {
        const loanAsset = operation.bookingAssetId
          ? currentLoanAssets.get(operation.bookingAssetId)
          : null;
        const asset =
          loanAsset?.item.asset ??
          resolvedPendingAssets.find(
            (candidate) => candidate.id === operation.assetId
          );
        if (!asset) return null;
        const logicalProductName =
          loanAsset?.item.kitName ??
          asset.assetModel?.name ??
          ("assetKits" in asset ? asset.assetKits[0]?.kit.name : null) ??
          asset.title;
        const title = loanAsset
          ? getIoioPhysicalUnitDisplayName({
              logicalProductName,
              unitNumber: loanAsset.item.unitLabel,
              ...(loanAsset.item.isKit ||
              loanAsset.item.asset.type === "INDIVIDUAL"
                ? { missingUnitLabel: "Unit number missing" }
                : {}),
            })
          : logicalProductName;
        return {
          id: operation.id,
          title,
          quantity: operation.quantity ?? 1,
          asset: {
            id: asset.id,
            title: asset.title,
            type: asset.type,
            mainImage: asset.mainImage,
            thumbnailImage: asset.thumbnailImage,
            assetModel: asset.assetModel,
            kitImage:
              "kitImage" in asset
                ? asset.kitImage
                : "assetKits" in asset
                ? asset.assetKits[0]?.kit.image ?? null
                : null,
          },
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);
    return data(
      payload({
        assets,
        readyForPickup: readyForPickup.filter(
          (item): item is NonNullable<typeof item> => item !== null
        ),
        preparing,
        categories,
        categoryId: selectedCategory,
        itemType,
        locationId: selectedLocation,
        locations,
        query: params.get("q") ?? "",
        returnSubmitted,
      })
    );
  } catch (cause) {
    logIoioStudentLoadFailure(
      "4 /ioio index-route loader boundary (unclassified)",
      cause,
      diagnosticRequest
    );
    const reason = makeShelfError(cause, { userId });
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

function availabilityLabel(asset: StudentAsset) {
  if (!asset.availableQuantity) return "Unavailable";
  return `Available · ${asset.availableQuantity}`;
}

function InventoryCard({
  asset,
  paths,
}: {
  asset: StudentInventoryItem;
  paths: Map<string, string[]>;
}) {
  const locationLabels = asset.locations.map((location) => {
    const path = paths.get(location.id) ?? [location.name];
    return path.map(formatStudentLabel).join(" / ");
  });

  return (
    <article className="group flex h-full flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm transition hover:-translate-y-0.5 hover:border-red-300 hover:shadow-md">
      <StudentAssetPlaceholder asset={asset} className="w-full shrink-0" />
      <div className="flex min-h-36 flex-1 flex-col p-4">
        <div className="min-h-[4.25rem]">
          <Link
            to={`/ioio/browse/${asset.id}`}
            className="line-clamp-2 min-h-10 font-bold leading-5 text-gray-950 group-hover:text-red-800 focus:outline-none focus:ring-2 focus:ring-red-700 focus:ring-offset-2"
          >
            {formatStudentTitle(asset.title, asset.type)}
          </Link>
          <span className="mt-1 inline-flex rounded-full bg-red-50 px-2 py-1 text-[11px] font-bold text-red-800">
            {availabilityLabel(asset)}
          </span>
        </div>
        {locationLabels.length ? (
          <p
            className="mt-3 line-clamp-2 min-h-10 text-xs leading-5 text-gray-500"
            title={locationLabels.join(" · ")}
          >
            {locationLabels.slice(0, 2).join(" · ")}
            {locationLabels.length > 2
              ? ` · +${locationLabels.length - 2} more locations`
              : ""}
          </p>
        ) : (
          <p className="mt-3 min-h-10 text-xs leading-5 text-gray-500">
            Location not recorded
          </p>
        )}
        <div className="mt-auto flex justify-end pt-3">
          <StudentCheckoutButton asset={asset} compact />
        </div>
      </div>
    </article>
  );
}

function AssistantMark() {
  return (
    <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-red-50 text-red-700">
      <svg
        aria-hidden="true"
        className="size-5"
        fill="none"
        viewBox="0 0 24 24"
      >
        <path
          d="M12 3v3M5.6 5.6l2.1 2.1M3 12h3M5.6 18.4l2.1-2.1M18.4 5.6l-2.1 2.1M21 12h-3M18.4 18.4l-2.1-2.1"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth="1.8"
        />
        <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="1.8" />
      </svg>
    </span>
  );
}

type AttentionImageAsset = {
  id: string;
  title: string;
  type: StudentAsset["type"];
  mainImage: string | null;
  thumbnailImage: string | null;
  assetModel: ResolvableAssetModelImage;
  kitImage?: string | null;
};

type ReadyPickupItem = {
  id: string;
  title: string;
  displayName: string;
  pickupLocation: string | null;
  pickupRoomName: string | null;
  pickupZoneName: string | null;
  pickupDeadline: Date | null;
  asset: AttentionImageAsset;
};

type PreparingItem = {
  id: string;
  title: string;
  quantity: number;
  asset: AttentionImageAsset;
};

export default function IoioHome() {
  const {
    assets,
    readyForPickup,
    preparing,
    categories,
    categoryId,
    itemType,
    locationId,
    locations,
    query,
    returnSubmitted,
  } = useLoaderData<typeof loader>();
  const layoutData = useRouteLoaderData<typeof layoutLoader>(
    "routes/_layout+/_layout"
  );
  const paths = locationPaths(locations);

  return (
    <div className="space-y-8 sm:space-y-10">
      {returnSubmitted ? (
        <div
          role="status"
          className="rounded-2xl border border-green-200 bg-green-50 p-4 text-sm font-semibold text-green-900"
        >
          Return submitted. A TA will check the item before it becomes available
          again.
        </div>
      ) : null}
      <section className="space-y-5">
        <h1 className="text-3xl font-black tracking-tight text-gray-950 sm:text-5xl">
          Find what you need in the lab.
        </h1>

        <form action="/ioio/ask" method="get">
          <label htmlFor="home-question" className="sr-only">
            Ask IOIO about equipment
          </label>
          <div className="rounded-[1.75rem] border border-gray-200 bg-white p-3 shadow-sm focus-within:border-red-300 focus-within:ring-4 focus-within:ring-red-50 sm:p-4">
            <div className="flex items-center gap-3">
              <AssistantMark />
              <input
                id="home-question"
                name="q"
                autoComplete="off"
                placeholder="Ask IOIO what you need..."
                className="min-h-11 min-w-0 flex-1 border-0 bg-transparent text-base text-gray-950 outline-none placeholder:text-gray-500 sm:text-lg"
              />
              <button
                type="submit"
                aria-label="Ask IOIO"
                className="flex min-h-11 min-w-11 items-center justify-center rounded-xl bg-red-700 px-3 text-xl font-black text-white transition hover:bg-red-800 focus:outline-none focus:ring-2 focus:ring-red-700 focus:ring-offset-2"
              >
                →
              </button>
            </div>
            <p className="mt-3 pl-12 text-xs leading-5 text-gray-500 sm:text-sm">
              Ask about equipment, locations, borrowing, or what to use for a
              project.
            </p>
          </div>
        </form>
      </section>

      <NeedsYourAttention
        readyForPickup={readyForPickup}
        preparing={preparing}
        accessApprovalPending={
          layoutData?.annualAccessApproval?.status === "PENDING"
        }
        workingHours={layoutData?.workingHours}
      />

      <section aria-labelledby="inventory-heading" className="space-y-5">
        <div>
          <h2
            id="inventory-heading"
            className="text-2xl font-black tracking-tight text-gray-950 sm:text-3xl"
          >
            Inventory
          </h2>
          <p className="mt-1 text-sm text-gray-600">
            Browse equipment directly, without needing to ask first.
          </p>
        </div>

        <InventoryFilterControls
          basePath="/ioio"
          categories={categories}
          locations={locations}
          query={query}
          locationId={locationId}
          categoryId={categoryId}
          itemType={itemType}
        />

        {assets.length ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {assets.map((asset) => (
              <InventoryCard key={asset.id} asset={asset} paths={paths} />
            ))}
          </div>
        ) : (
          <div className="rounded-2xl border border-gray-200 bg-gray-50 p-6 text-center">
            <p className="font-semibold text-gray-950">
              No equipment matches these filters yet.
            </p>
            <Link
              to="/ioio"
              className="mt-3 inline-block text-sm font-bold text-red-800 hover:text-red-900"
            >
              Show all inventory
            </Link>
          </div>
        )}
      </section>
    </div>
  );
}

function NeedsYourAttention({
  readyForPickup,
  preparing,
  accessApprovalPending,
  workingHours,
}: {
  readyForPickup: ReadyPickupItem[];
  preparing: PreparingItem[];
  accessApprovalPending: boolean;
  workingHours?: { enabled: boolean; weeklySchedule: unknown } | null;
}) {
  const visibleReady = readyForPickup.slice(0, 3);
  const visiblePreparing = preparing.slice(
    0,
    Math.max(0, 3 - visibleReady.length)
  );
  const hiddenLoanCount =
    readyForPickup.length +
    preparing.length -
    visibleReady.length -
    visiblePreparing.length;
  if (!readyForPickup.length && !preparing.length && !accessApprovalPending) {
    return null;
  }

  return (
    <section
      aria-labelledby="needs-attention-heading"
      className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2
          id="needs-attention-heading"
          className="text-lg font-black text-gray-950"
        >
          Needs your attention
        </h2>
        {hiddenLoanCount > 0 ? (
          <Link
            to="/ioio/loans?view=current"
            className="shrink-0 text-sm font-bold text-red-800 hover:underline"
          >
            View all in My Loans
          </Link>
        ) : null}
      </div>
      <div className="space-y-2">
        {visibleReady.map((item) => (
          <article
            key={item.id}
            className="flex min-w-0 flex-col gap-3 rounded-xl border border-green-200 bg-green-50 p-3 sm:flex-row sm:items-center"
          >
            <div className="size-14 shrink-0 overflow-hidden rounded-lg bg-white">
              <AssetImage
                asset={item.asset}
                alt={`Image of ${formatStudentTitle(item.title)}`}
                useThumbnail={false}
                className="size-full"
              />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-bold uppercase tracking-wide text-green-800">
                Ready for pickup
              </p>
              <p className="break-words font-bold text-gray-950">
                {formatStudentLabel(item.displayName)}
              </p>
              {item.pickupLocation ? (
                <p className="mt-0.5 flex items-start gap-1 text-xs text-gray-700">
                  <MapPin
                    className="mt-0.5 size-3.5 shrink-0"
                    aria-hidden="true"
                  />
                  <span>
                    {item.pickupRoomName
                      ? formatStudentLabel(item.pickupRoomName)
                      : formatStudentLabel(item.pickupLocation)}
                    {item.pickupRoomName && item.pickupZoneName ? (
                      <span className="block text-gray-600">
                        {formatStudentLabel(item.pickupZoneName)}
                      </span>
                    ) : null}
                  </span>
                </p>
              ) : null}
              {item.pickupDeadline ? (
                <p className="mt-1 text-sm font-semibold text-gray-900">
                  Pick up by {formatStudentDateOnly(item.pickupDeadline)}
                </p>
              ) : null}
              {workingHours ? (
                <p className="mt-0.5 flex items-center gap-1 text-xs text-gray-700">
                  <Clock3 className="size-3.5 shrink-0" aria-hidden="true" />
                  {formatPickupHours(workingHours)}
                </p>
              ) : null}
            </div>
            <Link
              to={`/ioio/loans?view=current&pickup=${encodeURIComponent(
                item.id
              )}`}
              className="inline-flex min-h-10 shrink-0 items-center justify-center rounded-lg bg-green-800 px-3 py-2 text-sm font-bold text-white hover:bg-green-900 focus:outline-none focus:ring-2 focus:ring-green-700 focus:ring-offset-2"
            >
              View pickup
            </Link>
          </article>
        ))}
        {visiblePreparing.map((item) => (
          <article
            key={item.id}
            className="flex min-w-0 flex-col gap-3 rounded-xl border border-amber-200 bg-amber-50/70 p-3 sm:flex-row sm:items-center"
          >
            <div className="size-14 shrink-0 overflow-hidden rounded-lg bg-white">
              <AssetImage
                asset={item.asset}
                alt={`Image of ${formatStudentTitle(item.title)}`}
                useThumbnail={false}
                className="size-full"
              />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-bold uppercase tracking-wide text-amber-900">
                Being prepared
              </p>
              <p className="truncate font-semibold text-gray-950">
                {item.quantity > 1 ? `${item.quantity}× ` : ""}
                {formatStudentTitle(item.title)}
              </p>
              <p className="text-xs text-gray-700">
                A TA is preparing your equipment.
              </p>
            </div>
            <Link
              to="/ioio/loans?view=current"
              className="inline-flex min-h-10 shrink-0 items-center justify-center rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm font-bold text-amber-950 hover:bg-amber-100 focus:outline-none focus:ring-2 focus:ring-amber-700 focus:ring-offset-2"
            >
              View status
            </Link>
          </article>
        ))}
      </div>
      {accessApprovalPending ? (
        <div className="mt-3 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="font-semibold text-gray-900">
                Access approval pending
              </p>
              <p className="text-xs text-gray-600">
                Your request has been sent to the IOIO TAs. You can continue
                browsing while you wait.
              </p>
            </div>
            <Link
              to="/ioio/settings/access-approval"
              className="text-xs font-bold text-red-800 hover:underline"
            >
              View status
            </Link>
          </div>
        </div>
      ) : null}
    </section>
  );
}
