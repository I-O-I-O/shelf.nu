import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { data, redirect, useLoaderData } from "react-router";
import { z } from "zod";
import Header from "~/components/layout/header";
import { IOIO_LOCATION_COLOR_VALUES } from "~/components/location/ioio-location-colors";
import { IoioLocationCreationForm } from "~/components/location/ioio-location-creation-form";
import { db } from "~/database/db.server";
import { getLocationsForCreateAndEdit } from "~/modules/asset/service.server";
import {
  findDuplicateIoioSiblingName,
  getIoioLocationParentError,
} from "~/modules/location/ioio-hierarchy";
import {
  createLocation,
  updateLocationImage,
} from "~/modules/location/service.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { sendNotification } from "~/utils/emitter/send-notification.server";
import { makeShelfError, ShelfError } from "~/utils/error";
import { payload, error, parseData } from "~/utils/http.server";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

const title = "New location";

const IoioLocationCreationSchema = z.object({
  locationType: z.enum(["room", "section", "shelf", "container"]),
  name: z.string().optional(),
  parentId: z
    .string()
    .optional()
    .transform((value) => (value ? value : null)),
  color: z
    .string()
    .optional()
    .transform((value) => (value === undefined ? undefined : value || null))
    .refine(
      (value) => !value || IOIO_LOCATION_COLOR_VALUES.includes(value),
      "Choose a supported room color."
    ),
});

function throwLocationValidationError(message: string): never {
  throw new ShelfError({
    cause: null,
    message,
    label: "Location",
    status: 400,
    shouldBeCaptured: false,
  });
}

export async function loader({ context, request }: LoaderFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;

  try {
    const { organizationId } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.location,
      action: PermissionAction.create,
    });
    const pickerUrl = new URL(request.url);
    pickerUrl.searchParams.set("getAll", "location");
    const { locations, totalLocations } = await getLocationsForCreateAndEdit({
      organizationId,
      request: new Request(pickerUrl),
    });

    return payload({
      header: { title },
      locations,
      totalLocations,
    });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    throw data(error(reason), { status: reason.status });
  }
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  { title: data ? appendToMetaTitle(data.header.title) : "" },
];

export const handle = {
  breadcrumb: () => <span>{title}</span>,
  name: "locations.new",
};

export async function action({ context, request }: ActionFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;

  try {
    const { organizationId } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.location,
      action: PermissionAction.create,
    });
    const imageRequest = request.clone();
    const parsedData = parseData(
      await request.formData(),
      IoioLocationCreationSchema,
      {
        additionalData: { userId, organizationId },
      }
    );
    const { locationType, name, parentId, color: submittedColor } = parsedData;
    const finalName = name?.trim() ?? "";

    if (!finalName) throwLocationValidationError("A name is required.");

    const parent = parentId
      ? await db.location.findFirst({
          where: { id: parentId, organizationId },
          select: {
            id: true,
            name: true,
            parentId: true,
            parent: { select: { parentId: true } },
          },
        })
      : null;

    const parentError = getIoioLocationParentError({
      locationType,
      parentId,
      parent: parent
        ? {
            name: parent.name,
            parentId: parent.parentId,
            grandparentId: parent.parent?.parentId ?? null,
          }
        : null,
    });
    if (parentError) throwLocationValidationError(parentError);

    const siblingLocations = await db.location.findMany({
      where: { organizationId, parentId: parentId ?? null },
      select: { name: true },
    });
    const duplicate = findDuplicateIoioSiblingName(
      siblingLocations.map(({ name: siblingName }) => siblingName),
      finalName
    );

    if (duplicate) {
      throwLocationValidationError(
        `A location named ${duplicate.name} already exists in ${
          parent?.name ?? "the top level"
        }.`
      );
    }

    const color = locationType === "room" ? submittedColor ?? "#455A64" : null;

    const location = await createLocation({
      name: finalName,
      description: "",
      address: "",
      userId,
      organizationId,
      parentId,
      color,
    });

    await updateLocationImage({
      request: imageRequest,
      locationId: location.id,
      organizationId,
      prevImageUrl: location.imageUrl,
      prevThumbnailUrl: location.thumbnailUrl,
    });

    sendNotification({
      title: "Location created",
      message: "Your location has been created successfully",
      icon: { name: "success", variant: "success" },
      senderId: userId,
    });

    if (new URL(request.url).searchParams.get("returnTo") === "/labels") {
      return redirect(`/labels?locationId=${location.id}`);
    }

    return redirect(`/locations?selectedLocation=${location.id}&created=1`);
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    return data(error(reason), { status: reason.status });
  }
}

export default function NewLocationPage() {
  const { locations } = useLoaderData<typeof loader>();

  return (
    <div className="relative">
      <Header title="New location" />
      <IoioLocationCreationForm locations={locations} />
    </div>
  );
}
