import { useState } from "react";
import type { AssetReturnHandling, AssetType } from "@prisma/client";
import {
  Form,
  Link,
  redirect,
  useActionData,
  useLoaderData,
} from "react-router";
import {
  data,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  type MetaFunction,
} from "react-router";
import { z } from "zod";
import { AssetImage } from "~/components/assets/asset-image";
import { ASSET_IMAGE_FRAME_CLASSES } from "~/components/assets/asset-image/sizing";
import {
  formatStudentLabel,
  SectionHeading,
} from "~/components/ioio-student/student-ui";
import { PageBackLink } from "~/components/shared/page-back-link";
import { db } from "~/database/db.server";
import { getPhysicalUnitLabelFromTitle } from "~/modules/asset/physical-unit";
import { resolveAssetImagesForPresentation } from "~/modules/asset/service.server";
import { IOIO_OPENING_HOURS_GUIDANCE } from "~/modules/ioio-staff/preparation";
import { resolveReturnDestination } from "~/modules/ioio-student/return-destination";
import {
  cancelReturnItem,
  prepareReturnItem,
  submitReturnItem,
  type PreparedReturnProposal,
} from "~/modules/ioio-student/return-item.server";
import { requireStudentRead } from "~/modules/ioio-student/route.server";
import {
  getIoioKitDisplayName,
  getIoioPhysicalUnitDisplayName,
} from "~/modules/kit/ioio-kit-presentation";
import { refreshExpiredKitImages } from "~/modules/kit/service.server";
import { makeShelfError } from "~/utils/error";
import { error, payload } from "~/utils/http.server";
import { resolveStorageImageUrl } from "~/utils/storage.server";

const querySchema = z.object({
  bookingId: z.string().min(1),
  bookingAssetId: z.string().min(1),
  assetId: z.string().min(1),
});

const reportTypes = [
  { value: "ITEM_DAMAGED", label: "Broken or damaged" },
  { value: "KIT_INCOMPLETE", label: "Missing parts" },
  { value: "ITEM_MISSING", label: "Not working" },
  { value: "OTHER", label: "Other" },
] as const;

const actionSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("prepare-return"),
    bookingId: z.string().min(1),
    bookingAssetId: z.string().min(1),
    assetId: z.string().min(1),
    quantity: z.coerce.number().int().min(1),
    issueState: z.enum(["ok", "problem"]),
    reportType: z.string().optional(),
    issueComment: z.string().max(1000).optional(),
  }),
  z.object({
    intent: z.literal("cancel-return"),
    confirmationToken: z.string().uuid(),
  }),
  z.object({
    intent: z.literal("finish-return"),
    confirmationToken: z.string().uuid(),
    quantity: z.coerce.number().int().min(1),
  }),
]);

type ReturnItem = {
  bookingId: string;
  bookingAssetId: string;
  assetId: string;
  title: string;
  type: AssetType;
  returnHandling: AssetReturnHandling;
  isKit: boolean;
  kitName: string | null;
  unitLabel: string | null;
  quantity: number;
  image: {
    mainImage: string | null;
    thumbnailImage: string | null;
    assetModel: { image: string | null; thumbnailImage: string | null } | null;
    kitImage: string | null;
  };
  locationPath: string[];
  locationImage: string | null;
  returnZone: DestinationLocation | null;
  problemZone: DestinationLocation | null;
};

type DestinationLocation = {
  title: string;
  path: string[];
  image: string | null;
  description: string | null;
};

export const meta: MetaFunction<typeof loader> = () => [
  { title: "Return item" },
];

function buildLocationPath(
  locationId: string | null,
  locations: Array<{
    id: string;
    name: string;
    parentId: string | null;
    imageUrl: string | null;
    thumbnailUrl: string | null;
    description?: string | null;
  }>
) {
  const byId = new Map(locations.map((location) => [location.id, location]));
  const path: string[] = [];
  const visited = new Set<string>();
  let currentId = locationId;
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const current = byId.get(currentId);
    if (!current) break;
    path.unshift(current.name);
    currentId = current.parentId;
  }
  return path;
}

function normalizeLocationName(name: string) {
  return name
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

function findDestinationLocation(
  locations: Array<{
    id: string;
    name: string;
    parentId: string | null;
    imageUrl: string | null;
    thumbnailUrl: string | null;
    description?: string | null;
  }>,
  names: string[]
): DestinationLocation | null {
  const acceptedNames = new Set(names.map(normalizeLocationName));
  const location = locations.find(({ name }) =>
    acceptedNames.has(normalizeLocationName(name))
  );
  if (!location) return null;
  return {
    title: location.name,
    path: buildLocationPath(location.id, locations).map(formatStudentLabel),
    image: location.thumbnailUrl ?? location.imageUrl ?? null,
    description: location.description ?? null,
  };
}

export async function loader({ context, request }: LoaderFunctionArgs) {
  const auth = await requireStudentRead({ context, request });
  const parsedParams = querySchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams)
  );
  if (!parsedParams.success) return redirect("/ioio/loans");
  try {
    const params = parsedParams.data;
    const teamMembers = await db.teamMember.findMany({
      where: {
        userId: auth.userId,
        organizationId: auth.organizationId,
        deletedAt: null,
      },
      select: { id: true },
    });
    const booking = await db.booking.findFirst({
      where: {
        id: params.bookingId,
        organizationId: auth.organizationId,
        status: { in: ["ONGOING", "OVERDUE"] },
        OR: [
          { custodianUserId: auth.userId },
          ...(teamMembers.length
            ? [
                {
                  custodianTeamMemberId: {
                    in: teamMembers.map(({ id }) => id),
                  },
                },
              ]
            : []),
        ],
      },
      select: {
        id: true,
        bookingAssets: {
          where: { id: params.bookingAssetId, assetId: params.assetId },
          select: {
            id: true,
            quantity: true,
            checkedOutAt: true,
            checkedInAt: true,
            sourceKitId: true,
            asset: {
              select: {
                id: true,
                title: true,
                type: true,
                returnHandling: true,
                mainImage: true,
                thumbnailImage: true,
                mainImageStoragePath: true,
                thumbnailImageStoragePath: true,
                assetModel: {
                  select: {
                    image: true,
                    thumbnailImage: true,
                    imageStoragePath: true,
                    thumbnailImageStoragePath: true,
                  },
                },
                assetKits: { select: { kitId: true } },
                assetLocations: {
                  select: {
                    location: {
                      select: {
                        id: true,
                        name: true,
                        parentId: true,
                        imageUrl: true,
                        thumbnailUrl: true,
                      },
                    },
                  },
                  take: 1,
                },
              },
            },
          },
        },
      },
    });
    const bookingAsset = booking?.bookingAssets[0];
    if (!booking || !bookingAsset?.checkedOutAt || bookingAsset.checkedInAt) {
      throw new Error("This borrowed item is no longer available to return.");
    }

    const kitRecord = bookingAsset.sourceKitId
      ? await db.kit.findFirst({
          where: {
            id: bookingAsset.sourceKitId,
            organizationId: auth.organizationId,
          },
          select: {
            id: true,
            name: true,
            image: true,
            imageExpiration: true,
            imageStoragePath: true,
            organizationId: true,
          },
        })
      : null;
    const kit = kitRecord
      ? (await refreshExpiredKitImages([kitRecord]))[0] ?? null
      : null;
    const locations = await db.location.findMany({
      where: { organizationId: auth.organizationId },
      select: {
        id: true,
        name: true,
        parentId: true,
        description: true,
        imageUrl: true,
        thumbnailUrl: true,
        imageStoragePath: true,
        thumbnailImageStoragePath: true,
      },
    });
    const resolvedLocations = await Promise.all(
      locations.map(async (location) => {
        const [imageUrl, thumbnailUrl] = await Promise.all([
          resolveStorageImageUrl({
            bucketName: "files",
            objectPath: location.imageStoragePath,
            legacyUrl: location.imageUrl,
            isPublic: true,
          }),
          resolveStorageImageUrl({
            bucketName: "files",
            objectPath: location.thumbnailImageStoragePath,
            legacyUrl: location.thumbnailUrl,
            isPublic: true,
          }),
        ]);
        return { ...location, imageUrl, thumbnailUrl };
      })
    );
    const assignedLocationId =
      bookingAsset.asset.assetLocations[0]?.location.id;
    const assignedLocation = resolvedLocations.find(
      (location) => location.id === assignedLocationId
    );
    const returnZone = findDestinationLocation(resolvedLocations, [
      "Kit Return Zone",
      "IOIO Return Zone",
      "Return Zone",
      "Return Section",
      "Returns Area",
    ]);
    const problemZone = findDestinationLocation(resolvedLocations, [
      "Problem / Broken Zone",
      "Broken Zone",
      "Problem / Repair Zone",
      "Problem Zone",
      "Repair Zone",
    ]);
    const [resolvedAsset] = await resolveAssetImagesForPresentation([
      bookingAsset.asset,
    ]);
    const item: ReturnItem = {
      bookingId: booking.id,
      bookingAssetId: bookingAsset.id,
      assetId: bookingAsset.asset.id,
      title: bookingAsset.asset.title,
      type: bookingAsset.asset.type,
      isKit: Boolean(bookingAsset.sourceKitId),
      kitName: kit ? getIoioKitDisplayName(kit) : null,
      unitLabel:
        bookingAsset.sourceKitId || bookingAsset.asset.type === "INDIVIDUAL"
          ? getPhysicalUnitLabelFromTitle(bookingAsset.asset.title)
          : null,
      quantity: bookingAsset.quantity,
      image: {
        mainImage: resolvedAsset.mainImage,
        thumbnailImage: resolvedAsset.thumbnailImage,
        assetModel: resolvedAsset.assetModel,
        kitImage: kit?.image ?? null,
      },
      locationPath: buildLocationPath(
        assignedLocation?.id ?? null,
        resolvedLocations
      ).map(formatStudentLabel),
      locationImage:
        assignedLocation?.thumbnailUrl ?? assignedLocation?.imageUrl ?? null,
      returnZone,
      problemZone,
      returnHandling: bookingAsset.asset.returnHandling,
    };
    return data(payload({ item }));
  } catch (cause) {
    const reason = makeShelfError(cause, { userId: auth.userId });
    throw data(error(reason), { status: reason.status });
  }
}

type ReturnActionData =
  | { ok: true; intent: "return-prepared"; proposal: PreparedReturnProposal }
  | { ok: false; error: string };

export async function action({ context, request }: ActionFunctionArgs) {
  const auth = await requireStudentRead({ context, request });
  const isIoioStaff = auth.role === "ADMIN" || auth.role === "OWNER";
  try {
    const parsed = actionSchema.parse(
      Object.fromEntries(await request.formData())
    );
    if (parsed.intent === "prepare-return") {
      if (
        parsed.issueState === "problem" &&
        (!parsed.reportType ||
          !reportTypes.some(({ value }) => value === parsed.reportType))
      ) {
        throw new Error("Choose what is wrong with the item.");
      }
      return data<ReturnActionData>({
        ok: true,
        intent: "return-prepared",
        proposal: await prepareReturnItem(
          {
            booking_id: parsed.bookingId,
            booking_asset_id: parsed.bookingAssetId,
            asset_id: parsed.assetId,
            quantity: parsed.quantity,
          },
          { context, request, auth },
          {
            issueState: parsed.issueState,
            reportType: parsed.reportType,
            issueComment: parsed.issueComment,
          }
        ),
      });
    }
    if (parsed.intent === "cancel-return") {
      await cancelReturnItem(parsed.confirmationToken, {
        context,
        request,
        auth,
      });
      return redirect(isIoioStaff ? "/home" : "/ioio/loans");
    }

    await submitReturnItem(
      {
        confirmationToken: parsed.confirmationToken,
        quantity: parsed.quantity,
      },
      { context, request, auth }
    );
    return redirect(isIoioStaff ? "/home" : "/ioio?return=submitted");
  } catch (cause) {
    const reason = makeShelfError(cause, { userId: auth.userId });
    return data(
      { ok: false as const, error: reason.message },
      { status: reason.status }
    );
  }
}

function DestinationVisual({
  title,
  subtitle,
  image,
  description,
}: {
  title: string;
  subtitle: string;
  image: string | null;
  description?: string | null;
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-gray-200 bg-gray-50">
      <div
        className={`overflow-hidden bg-gray-100 ${ASSET_IMAGE_FRAME_CLASSES.instruction}`}
      >
        {image ? (
          <img
            src={image}
            alt="Return destination"
            className="max-h-full max-w-full object-contain"
          />
        ) : (
          <div className="flex flex-col items-center gap-3 text-gray-500">
            <span className="flex size-16 items-center justify-center rounded-2xl border-2 border-dashed border-gray-300 bg-white text-3xl">
              ↓
            </span>
            <span className="text-xs font-bold uppercase tracking-[0.16em]">
              Place item here
            </span>
          </div>
        )}
      </div>
      <div className="border-t border-gray-200 bg-white p-4">
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-gray-500">
          Return to
        </p>
        <p className="mt-1 text-xl font-black text-gray-950">{title}</p>
        <p className="mt-1 text-sm text-gray-600">{subtitle}</p>
        {description ? (
          <p className="mt-2 text-sm text-gray-500">{description}</p>
        ) : null}
      </div>
    </div>
  );
}

export default function IoioReturn() {
  const { item } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [issueState, setIssueState] = useState<"ok" | "problem" | null>(null);
  const [reportType, setReportType] = useState("");
  const [problemComment, setProblemComment] = useState("");
  const proposal =
    actionData?.ok && actionData.intent === "return-prepared"
      ? actionData.proposal
      : null;
  const title = item.kitName ?? item.title;
  const displayTitle =
    item.isKit || item.type === "INDIVIDUAL"
      ? getIoioPhysicalUnitDisplayName({
          logicalProductName: title,
          unitNumber: item.unitLabel,
          missingUnitLabel: "Unit number missing",
        })
      : title;
  const destination = resolveReturnDestination({
    hasProblem: issueState === "problem",
    returnHandling: item.returnHandling,
  });
  const destinationIsProblem = destination === "BROKEN_ZONE";
  const destinationIsReturnZone = destination === "RETURN_ZONE";
  const selectedDestination = destinationIsProblem
    ? item.problemZone
    : destinationIsReturnZone
    ? item.returnZone
    : null;
  const normalLocation = item.locationPath.length
    ? item.locationPath
    : ["Current Inventory location not recorded"];

  return (
    <div className="mx-auto max-w-2xl">
      <PageBackLink to="/ioio/loans" className="mb-5">
        Back to My Loans
      </PageBackLink>
      <SectionHeading
        title="Return item"
        text="A short guided return for equipment you borrowed."
      />

      <section className="rounded-3xl border border-gray-200 bg-white p-5 shadow-sm sm:p-7">
        <div className="flex items-center gap-4 border-b border-gray-100 pb-5">
          <Link
            to={`/ioio/browse/${item.assetId}`}
            aria-label={`View ${formatStudentLabel(displayTitle)}`}
            className="size-20 shrink-0 overflow-hidden rounded-2xl bg-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700"
          >
            <AssetImage
              asset={{
                id: item.assetId,
                mainImage: item.image.mainImage,
                thumbnailImage: item.image.thumbnailImage,
                assetModel: item.image.assetModel,
                kitImage: item.image.kitImage,
              }}
              alt={`Image of ${formatStudentLabel(displayTitle)}`}
              useThumbnail={false}
              className="size-full"
            />
          </Link>
          <div>
            <h2 className="text-xl font-black text-gray-950">
              <Link
                to={`/ioio/browse/${item.assetId}`}
                className="hover:text-red-800 hover:underline"
              >
                {formatStudentLabel(displayTitle)}
              </Link>
            </h2>
            <p className="mt-1 text-sm text-gray-600">
              {item.quantity} {item.quantity === 1 ? "unit" : "units"} currently
              borrowed
            </p>
          </div>
        </div>

        {!proposal ? (
          <div className="space-y-5 pt-6">
            <div>
              <h3 className="text-lg font-black text-gray-950">
                Is there anything wrong with this item?
              </h3>
              <p className="mt-1 text-sm text-gray-600">
                Choose what best describes the item before you return it.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => setIssueState("ok")}
                className={`rounded-2xl border p-4 text-left font-bold ${
                  issueState === "ok"
                    ? "border-green-600 bg-green-50 text-green-900"
                    : "border-gray-200 hover:border-green-300"
                }`}
              >
                Everything is OK
              </button>
              <button
                type="button"
                onClick={() => setIssueState("problem")}
                className={`rounded-2xl border p-4 text-left font-bold ${
                  issueState === "problem"
                    ? "border-red-600 bg-red-50 text-red-900"
                    : "border-gray-200 hover:border-red-300"
                }`}
              >
                Something is wrong
              </button>
            </div>
            {issueState === "problem" ? (
              <div className="space-y-4 rounded-2xl bg-red-50 p-4">
                <label className="block text-sm font-bold text-gray-900">
                  What is wrong?
                  <select
                    value={reportType}
                    onChange={(event) => setReportType(event.target.value)}
                    className="mt-2 min-h-11 w-full rounded-xl border border-gray-300 bg-white px-3 font-normal"
                  >
                    <option value="">Choose an issue</option>
                    {reportTypes.map((type) => (
                      <option key={type.value} value={type.value}>
                        {type.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-sm font-bold text-gray-900">
                  What happened?{" "}
                  <span className="font-normal text-gray-500">Optional</span>
                  <textarea
                    value={problemComment}
                    onChange={(event) => setProblemComment(event.target.value)}
                    rows={3}
                    maxLength={1000}
                    className="mt-2 w-full rounded-xl border border-gray-300 bg-white px-3 py-2 font-normal"
                    placeholder="Tell the TAs what they should check."
                  />
                </label>
              </div>
            ) : null}
            {issueState ? (
              <Form method="post">
                <input type="hidden" name="intent" value="prepare-return" />
                <input type="hidden" name="bookingId" value={item.bookingId} />
                <input
                  type="hidden"
                  name="bookingAssetId"
                  value={item.bookingAssetId}
                />
                <input type="hidden" name="assetId" value={item.assetId} />
                <input type="hidden" name="quantity" value={item.quantity} />
                <input type="hidden" name="issueState" value={issueState} />
                <input type="hidden" name="reportType" value={reportType} />
                <input
                  type="hidden"
                  name="issueComment"
                  value={problemComment}
                />
                <button
                  type="submit"
                  disabled={issueState === "problem" && !reportType}
                  className="w-full rounded-xl bg-red-700 px-4 py-3 font-bold text-white hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Continue
                </button>
              </Form>
            ) : null}
          </div>
        ) : (
          <div className="space-y-5 pt-6">
            <div>
              <p className="text-sm font-bold uppercase tracking-[0.16em] text-gray-500">
                Next step
              </p>
              <h3 className="mt-1 text-2xl font-black text-gray-950">
                {destinationIsProblem
                  ? "Take this item to the Problem / Broken Zone"
                  : destinationIsReturnZone
                  ? "Take this item to the Return section"
                  : "Return this item to its Inventory location"}
              </h3>
            </div>
            <DestinationVisual
              title={
                destinationIsProblem
                  ? selectedDestination?.title ?? "Problem / Broken Zone"
                  : destinationIsReturnZone
                  ? selectedDestination?.title ?? "Return section"
                  : normalLocation.at(-1) ?? "Inventory location"
              }
              subtitle={
                destinationIsProblem
                  ? selectedDestination?.path.join(" / ") ??
                    "Do not place this item back into normal storage."
                  : destinationIsReturnZone
                  ? selectedDestination?.path.join(" / ") ??
                    "A TA will check this item before it becomes available again."
                  : normalLocation.join(" / ")
              }
              image={
                destinationIsProblem || destinationIsReturnZone
                  ? selectedDestination?.image ?? null
                  : item.locationImage
              }
              description={selectedDestination?.description}
            />
            <p className="text-sm leading-6 text-gray-600">
              {IOIO_OPENING_HOURS_GUIDANCE}
            </p>
            <Form method="post" className="space-y-4">
              <input
                type="hidden"
                name="confirmationToken"
                value={proposal.confirmationToken}
              />
              <input type="hidden" name="quantity" value={proposal.quantity} />
              <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
                <button
                  type="submit"
                  name="intent"
                  value="finish-return"
                  className="flex-1 rounded-xl bg-red-700 px-4 py-3 font-bold text-white hover:bg-red-800 sm:min-w-40"
                >
                  I&apos;ve placed it there — confirm return
                </button>
                <button
                  type="submit"
                  name="intent"
                  value="cancel-return"
                  className="flex-1 rounded-xl border border-gray-300 px-4 py-3 text-center font-bold text-gray-700 hover:border-gray-400 hover:text-gray-900 sm:flex-none"
                >
                  Cancel return
                </button>
              </div>
            </Form>
          </div>
        )}
        {actionData && !actionData.ok ? (
          <p
            role="alert"
            className="mt-4 rounded-xl bg-red-50 p-3 text-sm font-semibold text-red-800"
          >
            {actionData.error}
          </p>
        ) : null}
      </section>
    </div>
  );
}
