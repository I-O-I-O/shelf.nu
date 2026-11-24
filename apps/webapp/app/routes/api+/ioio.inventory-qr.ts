import type { LoaderFunctionArgs } from "react-router";
import { getStudentLocationPath } from "~/components/ioio-student/inventory-presentation";
import { db } from "~/database/db.server";
import {
  getInventoryQrDestination,
  parseInventoryQrValue,
  type ResolvedQrTarget,
} from "~/modules/ioio/scan-qr";
import { requireStudentRead } from "~/modules/ioio-student/route.server";
import {
  getStudentAssets,
  getStudentKits,
  getStudentLocations,
} from "~/modules/ioio-student/service.server";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

const unavailable = () =>
  Response.json(
    { error: "This item is not available to your account." },
    { status: 404 }
  );

export async function loader({ context, request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const value = url.searchParams.get("value") ?? "";
  const audience = url.searchParams.get("audience");
  if (audience !== "student" && audience !== "staff") {
    return Response.json({ error: "QR code not recognized." }, { status: 400 });
  }

  let organizationId: string;
  if (audience === "student") {
    ({ organizationId } = await requireStudentRead({ context, request }));
  } else {
    const { userId } = context.getSession();
    ({ organizationId } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.asset,
      action: PermissionAction.read,
    }));
  }

  const parsed = parseInventoryQrValue(value, url.origin);
  if (parsed.kind === "invalid") {
    return Response.json({ error: "QR code not recognized." }, { status: 400 });
  }

  let target: ResolvedQrTarget | null = null;
  if (parsed.kind === "location") {
    if (audience === "student") {
      const locations = await getStudentLocations({ organizationId });
      const allowedLocation = Boolean(
        getStudentLocationPath(parsed.locationId, locations)
      );
      if (!allowedLocation) return unavailable();
    } else {
      const location = await db.location.findFirst({
        where: { id: parsed.locationId, organizationId },
        select: { id: true },
      });
      if (!location) return unavailable();
    }
    target = { kind: "location", locationId: parsed.locationId };
  } else {
    const qr = await db.qr.findFirst({
      where: { id: parsed.qrId, organizationId },
      select: { assetId: true, kitId: true },
    });
    if (!qr) return unavailable();

    if (qr.assetId) {
      const asset =
        audience === "student"
          ? (await getStudentAssets({ organizationId })).find(
              (item) => item.id === qr.assetId
            )
          : await db.asset.findFirst({
              where: { id: qr.assetId, organizationId },
              select: { id: true },
            });
      if (!asset) return unavailable();
      target = { kind: "asset", assetId: qr.assetId };
    } else if (qr.kitId) {
      const kit =
        audience === "student"
          ? (await getStudentKits({ organizationId })).find(
              (item) => item.id === qr.kitId
            )
          : await db.kit.findFirst({
              where: { id: qr.kitId, organizationId },
              select: { id: true },
            });
      if (!kit) return unavailable();
      target = { kind: "kit", kitId: qr.kitId };
    }
  }

  if (!target) return unavailable();
  return Response.json({
    destination: getInventoryQrDestination(target, audience),
  });
}
