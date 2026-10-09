import type { Location } from "@prisma/client";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { data, redirect, useLoaderData } from "react-router";
import { z } from "zod";
import Header from "~/components/layout/header";
import {
  LocationForm,
  NewLocationFormSchema,
} from "~/components/location/form";
import { IOIO_LOCATION_COLOR_VALUES } from "~/components/location/ioio-location-colors";
import { getLocationsForCreateAndEdit } from "~/modules/asset/service.server";
import {
  getLocation,
  removeLocationImage,
  updateLocation,
  updateLocationImage,
} from "~/modules/location/service.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { sendNotification } from "~/utils/emitter/send-notification.server";
import { makeShelfError, ShelfError } from "~/utils/error";
import {
  payload,
  error,
  getParams,
  getRefererPath,
  parseData,
  safeRedirect,
} from "~/utils/http.server";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

type LocationFormType = "room" | "section" | "shelf" | "container";
type LocationNode = Pick<Location, "id" | "name" | "parentId">;
const IoioLocationEditSchema = NewLocationFormSchema.extend({
  address: z
    .string()
    .optional()
    .transform((value) => value ?? ""),
});

function getLocationFormType(
  locationId: string,
  locations: LocationNode[]
): LocationFormType {
  const locationsById = new Map(
    locations.map((location) => [location.id, location])
  );
  const visited = new Set<string>();
  let current = locationsById.get(locationId);
  const childName = current?.name ?? "";
  const parentName = current?.parentId
    ? locationsById.get(current.parentId)?.name ?? ""
    : "";
  let depth = 0;

  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    depth += 1;
    current = current.parentId
      ? locationsById.get(current.parentId)
      : undefined;
  }

  if (depth <= 1) return "room";
  if (depth === 2) {
    return childName.toLocaleLowerCase().includes("shelf")
      ? "shelf"
      : "section";
  }
  if (depth === 3) {
    return parentName.toLocaleLowerCase().includes("shelf")
      ? "container"
      : "shelf";
  }
  return "container";
}

function getLocationDescendantIds(
  locationId: string,
  locations: LocationNode[]
) {
  const descendants = new Set<string>();
  const pending = [locationId];

  while (pending.length > 0) {
    const parentId = pending.pop();
    if (!parentId) continue;

    for (const location of locations) {
      if (location.parentId !== parentId || descendants.has(location.id)) {
        continue;
      }
      descendants.add(location.id);
      pending.push(location.id);
    }
  }

  return [...descendants];
}

function getLocationDepth(locationId: string, locations: LocationNode[]) {
  const locationsById = new Map(
    locations.map((location) => [location.id, location])
  );
  const visited = new Set<string>();
  let current = locationsById.get(locationId);
  let depth = 0;

  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    depth += 1;
    current = current.parentId
      ? locationsById.get(current.parentId)
      : undefined;
  }

  return depth;
}

function validateParentForLocationType({
  locationType,
  parentId,
  locations,
}: {
  locationType: LocationFormType;
  parentId: string | null;
  locations: LocationNode[];
}) {
  const parent = parentId
    ? locations.find((location) => location.id === parentId)
    : undefined;
  const parentDepth = parent ? getLocationDepth(parent.id, locations) : null;
  const valid =
    locationType === "room"
      ? !parentId
      : locationType === "section"
      ? parentDepth === 1
      : locationType === "shelf"
      ? parentDepth === 1 || parentDepth === 2
      : parentDepth === 3 ||
        (parentDepth === 2 && /^shelf\b/iu.test(parent?.name ?? ""));

  if (!valid) {
    throw new ShelfError({
      cause: null,
      message:
        locationType === "section"
          ? "A section must be placed inside a room."
          : locationType === "shelf"
          ? "A shelf must be placed inside a room or section."
          : locationType === "container"
          ? "A container must be placed inside a shelf."
          : "A room cannot have a parent location.",
      label: "Location",
      status: 400,
      shouldBeCaptured: false,
    });
  }
}

export async function loader({ context, request, params }: LoaderFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;
  const { locationId: id } = getParams(
    params,
    z.object({ locationId: z.string() }),
    {
      additionalData: { userId },
    }
  );

  try {
    const { organizationId, userOrganizations } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.location,
      action: PermissionAction.update,
    });
    const { location } = await getLocation({
      organizationId,
      id,
      userOrganizations,
      request,
      orderBy: "createdAt",
    });
    const pickerUrl = new URL(request.url);
    pickerUrl.searchParams.set("getAll", "location");
    const { locations, totalLocations } = await getLocationsForCreateAndEdit({
      organizationId,
      request: new Request(pickerUrl),
      defaultLocation: location.parentId,
    });
    const locationType = getLocationFormType(location.id, locations);
    const excludeLocationIds = [
      location.id,
      ...getLocationDescendantIds(location.id, locations),
    ];

    return payload({
      location,
      locations,
      totalLocations,
      locationType,
      excludeLocationIds,
      header: { title: "Edit location" },
      referer: getRefererPath(request),
    });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId, id });
    throw data(error(reason), { status: reason.status });
  }
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  { title: data ? appendToMetaTitle(data.header.title) : "" },
];

export const handle = {
  breadcrumb: () => <span>Edit</span>,
  name: "locations.$locationId.edit",
};

export async function action({ context, request, params }: ActionFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;
  const { locationId: id } = getParams(
    params,
    z.object({ locationId: z.string() }),
    {
      additionalData: { userId },
    }
  );

  try {
    const { organizationId, userOrganizations } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.location,
      action: PermissionAction.update,
    });
    const imageRequest = request.clone();
    const formData = await request.formData();
    const parsedData = parseData(formData, IoioLocationEditSchema, {
      additionalData: { userId, organizationId, id },
    });
    const { location } = await getLocation({
      organizationId,
      id,
      userOrganizations,
      request,
    });
    const pickerUrl = new URL(request.url);
    pickerUrl.searchParams.set("getAll", "location");
    const { locations } = await getLocationsForCreateAndEdit({
      organizationId,
      request: new Request(pickerUrl),
      defaultLocation: location.parentId,
    });
    const locationType = getLocationFormType(id, locations);
    const { name, description, address, parentId } = parsedData;
    validateParentForLocationType({
      locationType,
      parentId,
      locations,
    });
    const submittedColor = formData.get("color");
    if (
      locationType === "room" &&
      typeof submittedColor === "string" &&
      submittedColor.length > 0 &&
      !IOIO_LOCATION_COLOR_VALUES.includes(submittedColor)
    ) {
      throw new ShelfError({
        cause: null,
        message: "Choose a supported room color.",
        label: "Location",
        status: 400,
        shouldBeCaptured: false,
      });
    }
    const color =
      locationType === "room"
        ? typeof submittedColor === "string" &&
          IOIO_LOCATION_COLOR_VALUES.includes(submittedColor)
          ? submittedColor
          : location.color &&
            IOIO_LOCATION_COLOR_VALUES.includes(location.color)
          ? location.color
          : "#455A64"
        : null;

    const updatedLocation = await updateLocation({
      id,
      userId,
      name,
      description,
      address,
      organizationId,
      parentId,
      color,
    });
    const hasNewImage =
      formData.get("image") instanceof File &&
      (formData.get("image") as File).size > 0;
    if (formData.get("clearImage") === "true" && !hasNewImage) {
      await removeLocationImage({ locationId: id, organizationId });
    } else {
      await updateLocationImage({
        request: imageRequest,
        locationId: id,
        organizationId,
        prevImageUrl: updatedLocation.imageUrl,
        prevThumbnailUrl: updatedLocation.thumbnailUrl,
      });
    }

    sendNotification({
      title: "Location updated",
      message: "Your location has been updated successfully",
      icon: { name: "success", variant: "success" },
      senderId: userId,
    });

    if (parsedData.addAnother) {
      return redirect("/locations/new");
    }

    if (parsedData.redirectTo) {
      return redirect(safeRedirect(parsedData.redirectTo, `/locations/${id}`));
    }

    return payload({ success: true });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId, id });
    return data(error(reason), { status: reason.status });
  }
}

export default function LocationEditPage() {
  const { location, locations, locationType, excludeLocationIds, referer } =
    useLoaderData<typeof loader>();

  return (
    <div className="relative">
      <Header title="Edit location" />
      <div className="items-top mt-6 flex w-full justify-between md:w-min">
        <LocationForm
          name={location.name}
          description={location.description}
          color={location.color}
          address={location.address}
          imageUrl={location.imageUrl}
          thumbnailUrl={location.thumbnailUrl}
          parentId={location.parentId}
          referer={referer}
          excludeLocationId={location.id}
          excludeLocationIds={excludeLocationIds}
          locations={locations}
          locationType={locationType}
          ioioMode
        />
      </div>
    </div>
  );
}
