import { useState } from "react";
import { AssetType } from "@prisma/client";
import { MoreHorizontal } from "lucide-react";
import {
  useActionData,
  data,
  Form,
  Link,
  redirect,
  useLoaderData,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  type MetaFunction,
} from "react-router";
import { z } from "zod";
import { AssetImage } from "~/components/assets/asset-image";
import { Button } from "~/components/shared/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/shared/dropdown";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/shared/modal";
import { PageBackLink } from "~/components/shared/page-back-link";
import { db } from "~/database/db.server";
import { recordEvent } from "~/modules/activity-event/service.server";
import { getPhysicalUnitLabelFromTitle } from "~/modules/asset/physical-unit";
import { setIndividualAssetAvailability } from "~/modules/asset/service.server";
import { getSafeReturnTo } from "~/modules/booking/return-review-navigation";
import { completeSubmittedReturn } from "~/modules/ioio-student/return-item.server";
import { getStudentReturnIssueComment } from "~/modules/ioio-student/return-item.shared";
import {
  getIoioKitDisplayName,
  getIoioPhysicalUnitDisplayName,
} from "~/modules/kit/ioio-kit-presentation";
import { getCompactLocationSummary } from "~/modules/location/compact-location";
import { createNote } from "~/modules/note/service.server";
import { makeShelfError } from "~/utils/error";
import { error, payload } from "~/utils/http.server";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";
import { resolveUserDisplayName } from "~/utils/user";

const actionSchema = z.object({
  intent: z.enum(["mark-available", "disable"]),
  returnTo: z.string().optional(),
  note: z.string().max(500).optional().default(""),
});

async function requireStaff({
  context,
  request,
}: Pick<LoaderFunctionArgs, "context" | "request">) {
  const { userId } = context.getSession();
  const permission = await requirePermission({
    userId,
    request,
    entity: PermissionEntity.booking,
    action: PermissionAction.update,
  });
  if (permission.role !== "ADMIN" && permission.role !== "OWNER") {
    throw new Response("Staff access required", { status: 403 });
  }
  return { ...permission, userId };
}

function locationName(
  locations: Array<{ name: string }>,
  names: string[],
  fallback: string
) {
  const accepted = new Set(names.map((name) => name.toLowerCase()));
  return (
    locations.find((location) => accepted.has(location.name.toLowerCase()))
      ?.name ?? fallback
  );
}

const RETURN_ISSUE_LABELS: Record<string, string> = {
  ITEM_MISSING: "Item missing",
  ITEM_DAMAGED: "Item damaged",
  ITEM_NOT_WORKING: "Item not working",
  PART_MISSING: "Part missing",
  WRONG_LOCATION: "Wrong location",
  LOCATION_FULL: "Location full",
  CANNOT_FIND: "Cannot find item",
  KIT_INCOMPLETE: "Kit incomplete",
  OTHER: "Other reported issue",
};

export const meta: MetaFunction<typeof loader> = () => [
  { title: "Check returned item" },
];

export async function loader({ context, params, request }: LoaderFunctionArgs) {
  const auth = await requireStaff({ context, request });
  const returnTo = getSafeReturnTo(
    new URL(request.url).searchParams.get("returnTo")
  );
  try {
    const operation = await db.ioioWriteOperation.findFirst({
      where: {
        id: params.operationId,
        organizationId: auth.organizationId,
        operationType: "RETURN_ITEM",
        status: "SUBMITTED",
      },
      select: {
        id: true,
        userId: true,
        assetId: true,
        bookingId: true,
        bookingAssetId: true,
        quantity: true,
        reportType: true,
        description: true,
        locationId: true,
        createdAt: true,
      },
    });
    if (
      !operation ||
      !operation.assetId ||
      !operation.bookingId ||
      !operation.bookingAssetId ||
      !operation.quantity
    ) {
      throw new Response("This return task is no longer available.", {
        status: 404,
      });
    }

    const [booking, member, locations] = await Promise.all([
      db.booking.findFirst({
        where: {
          id: operation.bookingId,
          organizationId: auth.organizationId,
        },
        select: {
          id: true,
          bookingAssets: {
            where: {
              id: operation.bookingAssetId,
              assetId: operation.assetId,
            },
            select: {
              id: true,
              sourceKitId: true,
              checkedOutAt: true,
              checkedInAt: true,
              asset: {
                select: {
                  id: true,
                  title: true,
                  type: true,
                  returnHandling: true,
                  mainImage: true,
                  thumbnailImage: true,
                },
              },
            },
          },
        },
      }),
      db.teamMember.findFirst({
        where: {
          organizationId: auth.organizationId,
          userId: operation.userId,
          deletedAt: null,
        },
        select: {
          name: true,
          user: {
            select: {
              displayName: true,
              firstName: true,
              lastName: true,
            },
          },
        },
      }),
      db.location.findMany({
        where: { organizationId: auth.organizationId },
        select: { id: true, name: true, parentId: true },
      }),
    ]);
    const bookingAsset = booking?.bookingAssets[0];
    if (!bookingAsset || bookingAsset.checkedInAt) {
      throw new Response("This return task is already completed.", {
        status: 409,
      });
    }

    const kit = bookingAsset.sourceKitId
      ? await db.kit.findFirst({
          where: {
            organizationId: auth.organizationId,
            id: bookingAsset.sourceKitId,
          },
          select: { id: true, name: true },
        })
      : null;
    const isProblem = operation.reportType !== "RETURN_ITEM";
    const isKit = Boolean(bookingAsset.sourceKitId);
    const returnToReturnZone =
      bookingAsset.asset.returnHandling === "RETURN_TO_RETURN_ZONE";
    const unitLabel =
      isKit || bookingAsset.asset.type === "INDIVIDUAL"
        ? getPhysicalUnitLabelFromTitle(bookingAsset.asset.title)
        : null;
    const displayTitle =
      isKit || bookingAsset.asset.type === "INDIVIDUAL"
        ? getIoioPhysicalUnitDisplayName({
            logicalProductName: kit
              ? getIoioKitDisplayName(kit)
              : bookingAsset.asset.title,
            unitNumber: unitLabel,
            missingUnitLabel: "Unit number missing",
          })
        : bookingAsset.asset.title;
    const memberName = resolveUserDisplayName(member?.user) || member?.name;
    const locationById = new Map(
      locations.map((location) => [location.id, location])
    );
    const actualLocationNames: string[] = [];
    const visitedLocationIds = new Set<string>();
    let currentLocation = operation.locationId
      ? locationById.get(operation.locationId)
      : undefined;
    while (currentLocation && !visitedLocationIds.has(currentLocation.id)) {
      visitedLocationIds.add(currentLocation.id);
      actualLocationNames.unshift(currentLocation.name);
      currentLocation = currentLocation.parentId
        ? locationById.get(currentLocation.parentId)
        : undefined;
    }
    const locationSummary = getCompactLocationSummary(actualLocationNames);
    const actualLocation = [locationSummary.room, locationSummary.storageLabel]
      .filter(Boolean)
      .join(" · ");

    return data(
      payload({
        task: {
          id: operation.id,
          assetId: bookingAsset.asset.id,
          title: displayTitle,
          image: {
            mainImage: bookingAsset.asset.mainImage,
            thumbnailImage: bookingAsset.asset.thumbnailImage,
          },
          isKit,
          isProblem,
          quantity: operation.quantity,
          returnedBy: memberName || "Shelf user",
          returnedAt: operation.createdAt,
          studentComment: getStudentReturnIssueComment(operation.description),
          issueType: isProblem
            ? (operation.reportType
                ? RETURN_ISSUE_LABELS[operation.reportType]
                : undefined) ?? "Reported issue"
            : null,
          returnTo,
          expectedLocation:
            actualLocation ||
            (isProblem
              ? locationName(
                  locations,
                  [
                    "Problem / Broken Zone",
                    "Problem / Repair Zone",
                    "Problem Zone",
                  ],
                  "Problem / Broken Zone"
                )
              : returnToReturnZone
              ? locationName(
                  locations,
                  ["Kit Return Zone", "IOIO Return Zone", "Return Zone"],
                  "Return Zone"
                )
              : "Assigned storage location"),
        },
      })
    );
  } catch (cause) {
    if (cause instanceof Response) throw cause;
    const reason = makeShelfError(cause, { userId: auth.userId });
    throw data(error(reason), { status: reason.status });
  }
}

export async function action({ context, params, request }: ActionFunctionArgs) {
  const auth = await requireStaff({ context, request });
  let submittedIntent: z.infer<typeof actionSchema>["intent"] | undefined;
  let submittedNote = "";
  try {
    const {
      intent,
      returnTo: submittedReturnTo,
      note,
    } = actionSchema.parse(Object.fromEntries(await request.formData()));
    submittedIntent = intent;
    submittedNote = note;
    const returnTo = getSafeReturnTo(submittedReturnTo ?? null);
    const operation = await db.ioioWriteOperation.findFirst({
      where: {
        id: params.operationId,
        organizationId: auth.organizationId,
        operationType: "RETURN_ITEM",
        status: "SUBMITTED",
      },
      select: { id: true, assetId: true, reportType: true },
    });
    if (!operation) {
      throw new Error("This return task is no longer available.");
    }
    if (intent === "disable" && operation.reportType === "RETURN_ITEM") {
      throw new Error("Only a reported problem can be disabled here.");
    }
    await completeSubmittedReturn(
      { operationId: operation.id },
      { context, request }
    );

    if (intent === "disable") {
      if (!operation.assetId) {
        throw new Error("The returned item could not be identified.");
      }
      const asset = await db.asset.findFirst({
        where: { id: operation.assetId, organizationId: auth.organizationId },
        select: { id: true, type: true, availableToBook: true },
      });
      if (!asset) {
        throw new Error("The returned item could not be found.");
      }

      const safeNote = note.trim();
      if (asset.type === AssetType.INDIVIDUAL) {
        await setIndividualAssetAvailability({
          id: asset.id,
          detailAssetId: asset.id,
          organizationId: auth.organizationId,
          userId: auth.userId,
          action: "unavailable",
          note: safeNote || "Disabled after return inspection.",
        });
      } else if (asset.availableToBook) {
        await db.$transaction(async (tx) => {
          await tx.asset.update({
            where: { id: asset.id, organizationId: auth.organizationId },
            data: { availableToBook: false },
          });
          await createNote(
            {
              content: `Temporarily disabled after return inspection.${
                safeNote ? ` ${safeNote}` : ""
              }`,
              type: "UPDATE",
              userId: auth.userId,
              assetId: asset.id,
              organizationId: auth.organizationId,
            },
            tx
          );
          await recordEvent(
            {
              organizationId: auth.organizationId,
              actorUserId: auth.userId,
              action: "ASSET_STATUS_CHANGED",
              entityType: "ASSET",
              entityId: asset.id,
              assetId: asset.id,
              field: "availableToBook",
              fromValue: true,
              toValue: false,
              meta: {
                source: "STAFF_RETURN_INSPECTION",
                action: "unavailable",
                note: safeNote || null,
              },
            },
            tx
          );
        });
      }
    }
    return redirect(returnTo);
  } catch (cause) {
    if (cause instanceof Response) throw cause;
    const reason = makeShelfError(cause, { userId: auth.userId });
    return data(
      {
        ok: false as const,
        error: reason.message,
        intent: submittedIntent,
        note: submittedNote,
      },
      { status: reason.status }
    );
  }
}

export default function ReturnCheckPage() {
  const { task } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const [disableDialogOpen, setDisableDialogOpen] = useState(false);
  const isSubmitting = navigation.state !== "idle";
  const backLabel = task.returnTo.startsWith("/bookings")
    ? "Back to Loans"
    : "Back to Operations";
  return (
    <main className="mx-auto max-w-2xl space-y-5">
      <PageBackLink to={task.returnTo}>{backLabel}</PageBackLink>
      <header>
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-red-700">
          Staff return check
        </p>
        <h1 className="mt-1 text-3xl font-black tracking-tight text-gray-950">
          <Link
            to={`/assets/${task.assetId}`}
            className="hover:text-red-800 hover:underline"
          >
            {task.title}
          </Link>
        </h1>
      </header>
      <section className="rounded-3xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5">
        <div className="flex flex-wrap gap-4">
          <Link
            to={`/assets/${task.assetId}`}
            aria-label={`Open asset: ${task.title}`}
            className="size-24 shrink-0 overflow-hidden rounded-2xl bg-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700"
          >
            <AssetImage
              asset={{
                id: task.assetId,
                mainImage: task.image.mainImage,
                thumbnailImage: task.image.thumbnailImage,
                assetModel: null,
              }}
              alt={`Image of ${task.title}`}
              useThumbnail={false}
              className="size-full"
            />
          </Link>
          <dl className="grid min-w-0 flex-1 content-start gap-x-5 gap-y-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="font-semibold text-gray-500">Returned by</dt>
              <dd className="font-bold text-gray-950">{task.returnedBy}</dd>
            </div>
            <div>
              <dt className="font-semibold text-gray-500">Returned</dt>
              <dd className="font-bold text-gray-950">
                {new Date(task.returnedAt).toLocaleDateString()}
              </dd>
            </div>
            {!task.isProblem ? (
              <div>
                <dt className="font-semibold text-gray-500">Status</dt>
                <dd className="font-bold text-amber-800">
                  Waiting for staff check
                </dd>
              </div>
            ) : null}
            <div className="sm:col-span-2">
              <dt className="font-semibold text-gray-500">Current location</dt>
              <dd className="break-words font-bold text-gray-950">
                {task.expectedLocation}
              </dd>
            </div>
          </dl>
        </div>
        {task.issueType ? (
          <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm">
            <p className="font-semibold text-amber-800">Reported problem</p>
            <p className="mt-1 font-bold text-amber-950">{task.issueType}</p>
          </div>
        ) : null}
        {task.studentComment ? (
          <div className="mt-4 rounded-2xl bg-gray-50 p-3 text-sm text-gray-700">
            <p className="font-bold text-gray-950">Student comment</p>
            <p className="mt-1 whitespace-pre-wrap">{task.studentComment}</p>
          </div>
        ) : null}
        {actionData &&
        "ok" in actionData &&
        !actionData.ok &&
        actionData.intent === "mark-available" ? (
          <p
            role="alert"
            className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-800"
          >
            {actionData.error}
          </p>
        ) : null}
        <div className="mt-5 flex flex-wrap items-center justify-end gap-2 border-t border-gray-100 pt-4">
          {task.isProblem ? (
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={`Return actions for ${task.title}`}
                  disabled={isSubmitting}
                  className="inline-flex size-10 items-center justify-center rounded-lg border border-gray-300 bg-white text-gray-700 hover:border-red-300 hover:text-red-800 focus:outline-none focus:ring-2 focus:ring-red-300 disabled:opacity-50"
                >
                  <MoreHorizontal className="size-5" aria-hidden="true" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48 p-1">
                <DropdownMenuItem
                  onSelect={() => setDisableDialogOpen(true)}
                  className="text-red-800 focus:bg-red-50"
                >
                  Checked - disable
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          <Form method="post">
            <input type="hidden" name="intent" value="mark-available" />
            <input type="hidden" name="returnTo" value={task.returnTo} />
            <Button type="submit" disabled={isSubmitting}>
              Checked - make available
            </Button>
          </Form>
        </div>
      </section>
      <AlertDialog open={disableDialogOpen} onOpenChange={setDisableDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Keep {task.title} unavailable?</AlertDialogTitle>
            <AlertDialogDescription>
              The item has been checked and will remain unavailable for
              borrowing.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Form method="post" className="space-y-4">
            <input type="hidden" name="intent" value="disable" />
            <input type="hidden" name="returnTo" value={task.returnTo} />
            <label className="block text-sm font-semibold text-gray-800">
              Optional note
              <textarea
                name="note"
                defaultValue={
                  actionData &&
                  "ok" in actionData &&
                  !actionData.ok &&
                  actionData.intent === "disable"
                    ? actionData.note
                    : ""
                }
                maxLength={500}
                rows={3}
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 font-normal focus:border-red-600 focus:outline-none focus:ring-2 focus:ring-red-200"
              />
            </label>
            {actionData &&
            "ok" in actionData &&
            !actionData.ok &&
            actionData.intent === "disable" ? (
              <p role="alert" className="text-sm text-red-800">
                {actionData.error}
              </p>
            ) : null}
            <AlertDialogFooter>
              <AlertDialogCancel asChild>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={isSubmitting}
                >
                  Cancel
                </Button>
              </AlertDialogCancel>
              <Button type="submit" variant="danger" disabled={isSubmitting}>
                Disable
              </Button>
            </AlertDialogFooter>
          </Form>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}
