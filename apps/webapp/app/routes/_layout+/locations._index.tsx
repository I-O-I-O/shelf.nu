import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { data, useLoaderData } from "react-router";
import { z } from "zod";
import Header from "~/components/layout/header";
import type { HeaderData } from "~/components/layout/header/types";
import { ListContentWrapper } from "~/components/list/content-wrapper";
import {
  getFirstAvailableIoioColor,
  getIoioRoomColorError,
  getIoioSectionColorError,
  getUsedIoioRoomColors,
  getUsedIoioSectionColors,
} from "~/components/location/ioio-location-colors";
import { IoioLocationHierarchy } from "~/components/location/ioio-location-hierarchy";
import { db } from "~/database/db.server";
import { getIoioArchivedItemIds } from "~/modules/ioio-staff/archive.server";
import {
  findDuplicateIoioSiblingName,
  getIoioLocationParentError,
  summarizeIoioLocationInventory,
} from "~/modules/location/ioio-hierarchy";
import { validateIoioLocationMove } from "~/modules/location/ioio-location-move";
import {
  createLocation,
  getLocations,
  updateLocation,
} from "~/modules/location/service.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import {
  setCookie,
  updateCookieWithPerPage,
  userPrefs,
} from "~/utils/cookies.server";
import { makeShelfError, ShelfError } from "~/utils/error";
import {
  payload,
  error,
  getCurrentSearchParams,
  parseData,
} from "~/utils/http.server";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

const inlineCreateSchema = z.object({
  intent: z.literal("inline-create"),
  locationType: z.enum(["room", "section", "shelf", "container"]),
  parentId: z
    .string()
    .optional()
    .transform((value) => (value ? value : null)),
  name: z.string().trim().min(1, "A name is required."),
  color: z.string().optional(),
});

const moveLocationSchema = z.object({
  intent: z.literal("move-location"),
  locationId: z.string().min(1),
  locationType: z.enum(["room", "section", "shelf", "container"]),
  parentId: z
    .string()
    .optional()
    .transform((value) => (value ? value : null)),
});

export async function loader({ context, request }: LoaderFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;

  try {
    const { organizationId } = await requirePermission({
      userId: authSession.userId,
      request,
      entity: PermissionEntity.location,
      action: PermissionAction.read,
    });
    const searchParams = getCurrentSearchParams(request);
    const perPageParam = Number(searchParams.get("perPage")) || 0;
    const cookie = await updateCookieWithPerPage(request, perPageParam);
    const { perPage } = cookie;

    const [firstPage, archivedAssetIds] = await Promise.all([
      getLocations({ organizationId, page: 1, perPage }),
      getIoioArchivedItemIds({ organizationId, itemType: "ASSET" }),
    ]);
    const { locations, totalLocations } =
      firstPage.totalLocations > firstPage.locations.length
        ? await getLocations({
            organizationId,
            page: 1,
            perPage: firstPage.totalLocations,
          })
        : firstPage;

    const [activeAssignments, unassignedAssetCount] = await Promise.all([
      db.assetLocation.findMany({
        where: {
          organizationId,
          asset: {
            organizationId,
            id: { notIn: archivedAssetIds },
          },
        },
        select: { assetId: true, locationId: true },
        distinct: ["assetId", "locationId"],
      }),
      db.asset.count({
        where: {
          organizationId,
          id: { notIn: archivedAssetIds },
          assetLocations: { none: {} },
        },
      }),
    ]);
    const inventorySummary = summarizeIoioLocationInventory({
      locations,
      assignments: activeAssignments,
      unassignedAssetCount,
    });

    const header: HeaderData = {
      title: "Locations",
    };
    return data(
      payload({
        header,
        items: locations,
        totalLocations,
        inventorySummary,
      }),
      {
        headers: [setCookie(await userPrefs.serialize(cookie))],
      }
    );
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    throw data(error(reason), { status: reason.status });
  }
}

export async function action({ context, request }: ActionFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;

  try {
    const formData = await request.formData();
    if (formData.get("intent") === "move-location") {
      const { organizationId } = await requirePermission({
        userId,
        request,
        entity: PermissionEntity.location,
        action: PermissionAction.update,
      });
      const { locationId, locationType, parentId } = parseData(
        formData,
        moveLocationSchema,
        { additionalData: { userId, organizationId } }
      );
      const locations = await db.location.findMany({
        where: { organizationId },
        select: { id: true, name: true, parentId: true, color: true },
      });
      const moveError = validateIoioLocationMove({
        locationId,
        locationType,
        parentId,
        locations,
      });
      if (moveError) {
        throw new ShelfError({
          cause: null,
          message: moveError,
          label: "Location",
          status: 400,
          shouldBeCaptured: false,
        });
      }

      const location = locations.find((entry) => entry.id === locationId);
      const siblings = await db.location.findMany({
        where: { organizationId, parentId },
        select: { id: true, name: true, parentId: true, color: true },
      });
      const duplicateName = findDuplicateIoioSiblingName(
        siblings
          .filter((sibling) => sibling.id !== locationId)
          .map(({ name: siblingName }) => siblingName),
        location?.name ?? ""
      );
      if (duplicateName) {
        throw new ShelfError({
          cause: null,
          message: `A location named ${duplicateName} already exists here.`,
          label: "Location",
          status: 400,
          shouldBeCaptured: false,
        });
      }

      if (locationType === "section" && location?.color) {
        const colorError = getIoioSectionColorError({
          color: location.color,
          locations: [
            ...siblings,
            ...locations.filter((entry) => entry.id === parentId),
          ],
          parentId,
          currentLocationId: locationId,
        });
        if (colorError) {
          throw new ShelfError({
            cause: null,
            message: `${colorError} Edit the section to choose another color before moving it.`,
            label: "Location",
            status: 400,
            shouldBeCaptured: false,
          });
        }
      }

      const movedLocation = await updateLocation({
        id: locationId,
        userId,
        organizationId,
        parentId,
        ioioColorType:
          locationType === "room" || locationType === "section"
            ? locationType
            : undefined,
      });

      return data(
        payload({
          success: true,
          location: {
            id: movedLocation.id,
            name: movedLocation.name,
            parentId: movedLocation.parentId,
          },
        })
      );
    }

    const { organizationId } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.location,
      action: PermissionAction.create,
    });
    const { locationType, parentId, name, color } = parseData(
      formData,
      inlineCreateSchema,
      { additionalData: { userId, organizationId } }
    );

    const parent = parentId
      ? await db.location.findFirst({
          where: { id: parentId, organizationId },
          select: {
            id: true,
            name: true,
            parentId: true,
            color: true,
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
    if (parentError) {
      throw new ShelfError({
        cause: null,
        message: parentError,
        label: "Location",
        status: 400,
        shouldBeCaptured: false,
      });
    }

    const siblings = await db.location.findMany({
      where: { organizationId, parentId },
      select: { id: true, name: true, parentId: true, color: true },
    });
    const colorLocations = parent ? [...siblings, parent] : siblings;
    const duplicateName = findDuplicateIoioSiblingName(
      siblings.map(({ name: siblingName }) => siblingName),
      name
    );
    if (duplicateName) {
      throw new ShelfError({
        cause: null,
        message: `A location named ${duplicateName} already exists under this parent.`,
        label: "Location",
        status: 400,
        shouldBeCaptured: false,
      });
    }

    const selectedColor =
      locationType === "room"
        ? color ??
          getFirstAvailableIoioColor(
            getUsedIoioRoomColors({ locations: siblings })
          )
        : locationType === "section"
        ? color ??
          getFirstAvailableIoioColor(
            getUsedIoioSectionColors({ locations: colorLocations, parentId })
          )
        : null;
    if (locationType === "room") {
      const colorError = getIoioRoomColorError({
        color: selectedColor,
        locations: colorLocations,
      });
      if (colorError) {
        throw new ShelfError({
          cause: null,
          message: colorError,
          label: "Location",
          status: 400,
          shouldBeCaptured: false,
        });
      }
    }
    if (locationType === "section") {
      const colorError = getIoioSectionColorError({
        color: selectedColor,
        locations: colorLocations,
        parentId,
      });
      if (colorError) {
        throw new ShelfError({
          cause: null,
          message: colorError,
          label: "Location",
          status: 400,
          shouldBeCaptured: false,
        });
      }
    }

    const location = await createLocation({
      name,
      description: "",
      address: "",
      userId,
      organizationId,
      parentId,
      color: selectedColor,
      ioioColorType:
        locationType === "room" || locationType === "section"
          ? locationType
          : undefined,
    });

    return data(payload({ success: true, location }));
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    return data(error(reason), { status: reason.status });
  }
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  { title: data ? appendToMetaTitle(data.header.title) : "" },
];

export default function LocationsIndexPage() {
  const { items, inventorySummary } = useLoaderData<typeof loader>();

  return (
    <>
      <Header hideQuickFind />
      <ListContentWrapper>
        <IoioLocationHierarchy
          locations={items}
          inventorySummary={inventorySummary}
        />
      </ListContentWrapper>
    </>
  );
}
