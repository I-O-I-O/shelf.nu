import { Clock3, MapPin } from "lucide-react";
import { useRouteLoaderData, Link, useLoaderData } from "react-router";
import { data, type LoaderFunctionArgs, type MetaFunction } from "react-router";
import { AssetImage } from "~/components/assets/asset-image";
import { ErrorContent } from "~/components/errors";
import { InventoryQrScanner } from "~/components/ioio/inventory-qr-scanner";
import {
  filterStudentInventory,
  getStudentLocationPath,
  groupStudentAssets,
} from "~/components/ioio-student/inventory-presentation";
import {
  AssetCard,
  InventoryFilterControls,
  formatStudentDateOnly,
  formatStudentLabel,
  formatStudentTitle,
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
import {
  getStudentAssets,
  getStudentCategories,
  getStudentLocations,
  type StudentAsset,
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
  const returnSubmitted = params.get("return") === "submitted";
  try {
    const [inventory, preparationOperations] = await Promise.all([
      withIoioStudentLoadStage(
        "4 home inventory query and filters",
        diagnosticRequest,
        async () => {
          const requestedCategory = params.get("category");
          const requestedItemType = params.get("itemType");
          const requestedAvailability = params.get("availability");
          const availability =
            requestedAvailability === "available" ||
            requestedAvailability === "unavailable"
              ? requestedAvailability
              : null;
          const itemType =
            requestedItemType === "quantity" ||
            requestedItemType === "individual"
              ? requestedItemType
              : null;
          const [categories, locations] = await Promise.all([
            getStudentCategories({ organizationId }),
            getStudentLocations({ organizationId }),
          ]);
          const categoryId = categories.some(
            (category) => category.id === requestedCategory
          )
            ? requestedCategory
            : null;
          const requestedLocation = params.get("location");
          const locationId = requestedLocation
            ? getStudentLocationPath(requestedLocation, locations)
              ? requestedLocation
              : null
            : null;
          const allAssets = await getStudentAssets({
            organizationId,
            query: params.get("q"),
            categoryId,
            locationId,
          });
          const assets = filterStudentInventory(groupStudentAssets(allAssets), {
            categoryId,
            itemType,
            availability,
          });

          return {
            assets,
            categories,
            locations,
            query: params.get("q") ?? "",
            categoryId,
            itemType,
            availability,
            locationId,
            hasSearchOrFilters: Boolean(
              params.get("q")?.trim() ||
                categoryId ||
                itemType ||
                locationId ||
                availability
            ),
          };
        }
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
        ...inventory,
        readyForPickup: readyForPickup.filter(
          (item): item is NonNullable<typeof item> => item !== null
        ),
        preparing,
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

export const ErrorBoundary = () => <ErrorContent />;

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
    categories,
    query,
    categoryId,
    itemType,
    availability,
    locationId,
    locations,
    hasSearchOrFilters,
    readyForPickup,
    preparing,
    returnSubmitted,
  } = useLoaderData<typeof loader>();
  const layoutData = useRouteLoaderData<typeof layoutLoader>(
    "routes/_layout+/_layout"
  );
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
      </section>

      <NeedsYourAttention
        readyForPickup={readyForPickup}
        preparing={preparing}
        accessApprovalPending={
          layoutData?.annualAccessApproval?.status === "PENDING"
        }
        workingHours={layoutData?.workingHours}
      />

      <section
        aria-labelledby="inventory-heading"
        className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5"
      >
        <div>
          <h2
            id="inventory-heading"
            className="text-xl font-black tracking-tight text-gray-950 sm:text-2xl"
          >
            Explore inventory
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-gray-600">
            Browse available equipment, filter by category or lab area, and add
            items to your borrow list.
          </p>
        </div>
        <div className="mt-4 min-w-0">
          <div
            role="group"
            aria-label="Inventory search and filters"
            className="min-w-0"
          >
            <InventoryFilterControls
              basePath="/ioio"
              categories={categories}
              locations={locations}
              query={query}
              locationId={locationId}
              categoryId={categoryId}
              itemType={itemType}
              availability={availability}
              scanAction={
                <InventoryQrScanner
                  audience="student"
                  buttonClassName="min-h-11 shrink-0 flex-row whitespace-nowrap rounded-xl border-gray-300 bg-white px-3 text-sm font-bold text-gray-800 shadow-none hover:border-red-200 hover:text-red-800 focus:outline-none focus:ring-2 focus:ring-red-600"
                  buttonLabel="Scan QR"
                  showIcon={false}
                />
              }
            />
          </div>
        </div>
        <p className="mt-4 text-sm text-gray-600" aria-live="polite">
          Showing {assets.length} {assets.length === 1 ? "item" : "items"}
        </p>
        {assets.length ? (
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            {assets.map((asset) => (
              <AssetCard key={asset.id} asset={asset} />
            ))}
          </div>
        ) : (
          <div className="mt-3 rounded-2xl border border-dashed border-gray-300 bg-white p-6 text-center sm:p-8">
            <h3 className="font-bold text-gray-950">
              {hasSearchOrFilters
                ? "No equipment matches your search"
                : "No equipment is listed yet"}
            </h3>
            <p className="mx-auto mt-2 max-w-md text-sm text-gray-600">
              {hasSearchOrFilters
                ? "Try a different search or clear your filters to see more equipment."
                : "Check back later, or ask a lab assistant for help."}
            </p>
            {hasSearchOrFilters ? (
              <Link
                to="/ioio"
                className="mt-4 inline-flex min-h-10 items-center rounded-xl bg-red-700 px-4 text-sm font-bold text-white hover:bg-red-800 focus:outline-none focus:ring-2 focus:ring-red-700 focus:ring-offset-2"
              >
                Clear search and filters
              </Link>
            ) : null}
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
                <span
                  className={item.unitLabel ? "ioio-identifier" : undefined}
                >
                  {formatStudentLabel(item.displayName)}
                </span>
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
