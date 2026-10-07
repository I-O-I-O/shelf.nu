import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { AssetType } from "@prisma/client";
import type {
  LinksFunction,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { data, useLoaderData } from "react-router";
import { z } from "zod";
import { loadIoioQrLogoDataUrl } from "~/components/ioio-staff/ioio-branded-qr";
import { getIoioCategoryColor } from "~/components/ioio-staff/ioio-category-presentation";
import {
  fitsIoioA4Portrait,
  formatIoioDimension,
  getIoioCloseUpPreviewSize,
  getIoioA4Capacity,
  getIoioA4PreviewScale,
  getIoioDefaultPrintSize,
  getIoioDefaultQrEnabled,
  getIoioPrintDimensionsError,
  getIoioPrintDimensions,
  IOIO_A4,
  IOIO_PRINT_SIZE_ORDER,
  IOIO_PRINT_SIZE_PRESETS,
  type IoioPrintSizeKey,
} from "~/components/ioio-staff/ioio-label-sizing";
import {
  getIoioLabelColor,
  getIoioLocationIdentifier,
  getIoioLocationPathIdentifier,
  IOIO_LABEL_CUSTOM_TEXT_MAX_LENGTH,
  IOIO_LABEL_COLORS,
  getIoioLabelQrError,
  normalizeIoioCustomLabelText,
  normalizeIoioLabelText,
  IoioLabelPreview,
  type IoioLabelData,
} from "~/components/ioio-staff/ioio-labels";
import Header from "~/components/layout/header";
import { getEffectiveIoioLocationColor } from "~/components/location/ioio-location-colors";
import { formatIoioRoomHeader } from "~/components/location/ioio-location-hierarchy";
import { db } from "~/database/db.server";
import { requireIoioStaffAccess } from "~/modules/ioio-staff/access.server";
import { getIoioArchivedItemIds } from "~/modules/ioio-staff/archive.server";
import {
  getIoioKitDisplayName,
  getIoioKitPhysicalUnitNumber,
  getIoioPhysicalUnitDisplayName,
} from "~/modules/kit/ioio-kit-presentation";
import { getQrBaseUrl } from "~/modules/qr/utils.server";
import labelsCss from "~/styles/ioio-labels.css?url";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { SERVER_URL } from "~/utils/env";
import { makeShelfError } from "~/utils/error";
import { error, payload } from "~/utils/http.server";

export const links: LinksFunction = () => [
  { rel: "stylesheet", href: labelsCss },
];

const queryIdSchema = z.string().trim().min(1).max(100);

type LocationRecord = {
  id: string;
  name: string;
  parentId: string | null;
  color: string | null;
};

type ItemRecord = {
  kind: "asset" | "kit";
  id: string;
  name: string;
  unitNumber?: string | null;
  category: string | null;
  categoryColor?: string | null;
  locationId: string | null;
  assetCount?: number;
  productId?: string;
  status?: string | null;
  updatedAt?: Date | string | null;
  qrValue?: string;
};

type KitSourceRecord = {
  id: string;
  name: string;
  category: string | null;
  categoryColor?: string | null;
};

type AssetLabelCandidate = {
  id: string;
  title: string;
  type: AssetType;
  category: { name: string; color: string | null } | null;
  assetModel: {
    id: string;
    name: string;
    defaultCategory: { name: string; color: string | null } | null;
  } | null;
  assetLocations: Array<{ locationId: string }>;
  qrCodes: Array<{ id: string }>;
};

function parseIds(value: string | null) {
  if (!value) return [];
  return value
    .split(",")
    .map((id) => queryIdSchema.safeParse(id.trim()))
    .filter(
      (result): result is { success: true; data: string } => result.success
    )
    .map((result) => result.data)
    .slice(0, 500);
}

function getConvertedAssetIds(meta: unknown) {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return [];

  const conversionMeta = meta as {
    conversion?: unknown;
    resultingAssetIds?: unknown;
  };
  if (conversionMeta.conversion !== "QUANTITY_TO_INDIVIDUAL_BULK") {
    return [];
  }

  const resultingAssetIds = conversionMeta.resultingAssetIds;
  return Array.isArray(resultingAssetIds)
    ? resultingAssetIds.filter(
        (assetId): assetId is string => typeof assetId === "string"
      )
    : [];
}

function assetToLabelItem(
  asset: AssetLabelCandidate,
  qrBaseUrl: string
): ItemRecord {
  const model = asset.type === AssetType.INDIVIDUAL ? asset.assetModel : null;
  const category = asset.category ?? model?.defaultCategory ?? null;

  if (model) {
    return {
      kind: "kit",
      id: asset.id,
      productId: model.id,
      name: model.name,
      unitNumber: getIoioKitPhysicalUnitNumber({ name: asset.title }),
      category: category?.name ?? null,
      categoryColor: category?.color ?? null,
      locationId: asset.assetLocations[0]?.locationId ?? null,
      qrValue: asset.qrCodes[0]
        ? `${qrBaseUrl}/${encodeURIComponent(asset.qrCodes[0].id)}`
        : undefined,
    };
  }

  return {
    kind: "asset",
    id: asset.id,
    name: asset.title,
    category: asset.category?.name ?? null,
    categoryColor: asset.category?.color ?? null,
    locationId: asset.assetLocations[0]?.locationId ?? null,
    qrValue: asset.qrCodes[0]
      ? `${qrBaseUrl}/${encodeURIComponent(asset.qrCodes[0].id)}`
      : undefined,
  };
}

export async function loader({ context, request }: LoaderFunctionArgs) {
  try {
    const { organizationId } = await requireIoioStaffAccess({
      context,
      request,
    });
    const qrBaseUrl = getQrBaseUrl();
    const params = new URL(request.url).searchParams;
    const locationIds = [
      ...parseIds(params.get("locationIds")),
      ...parseIds(params.get("locationId")),
    ];
    const requestedAssetIds = [
      ...new Set([
        ...parseIds(params.get("assetIds")),
        ...parseIds(params.get("assetId")),
      ]),
    ];
    const kitId =
      params.get("kitId") ??
      (params.get("type") === "kit" ? params.get("id") : null);
    const [archivedAssetIds, archivedKitIds, conversionEvents] =
      await Promise.all([
        getIoioArchivedItemIds({ organizationId, itemType: "ASSET" }),
        kitId
          ? getIoioArchivedItemIds({ organizationId, itemType: "KIT" })
          : [],
        requestedAssetIds.length
          ? db.activityEvent.findMany({
              where: {
                organizationId,
                action: "ASSET_QUANTITY_CHANGED",
                entityType: "ASSET",
                entityId: { in: requestedAssetIds },
              },
              orderBy: { occurredAt: "desc" },
              select: { entityId: true, meta: true },
            })
          : [],
      ]);

    const convertedAssetIdsBySource = new Map<string, string[]>();
    for (const event of conversionEvents) {
      if (convertedAssetIdsBySource.has(event.entityId)) continue;
      const resultingAssetIds = getConvertedAssetIds(event.meta);
      if (resultingAssetIds.length > 0) {
        convertedAssetIdsBySource.set(event.entityId, resultingAssetIds);
      }
    }
    const resolvedAssetIds = [
      ...new Set(
        requestedAssetIds.flatMap(
          (assetId) => convertedAssetIdsBySource.get(assetId) ?? [assetId]
        )
      ),
    ];

    const [locations, selectedAssets, kit, assets, kitPhysicalUnits] =
      await Promise.all([
        db.location.findMany({
          where: { organizationId },
          select: { id: true, name: true, parentId: true, color: true },
          orderBy: { name: "asc" },
        }),
        resolvedAssetIds.length
          ? db.asset.findMany({
              where: {
                id: { in: resolvedAssetIds },
                organizationId,
                NOT: { id: { in: archivedAssetIds } },
              },
              select: {
                id: true,
                title: true,
                type: true,
                category: { select: { name: true, color: true } },
                assetModel: {
                  select: {
                    id: true,
                    name: true,
                    defaultCategory: { select: { name: true, color: true } },
                  },
                },
                assetLocations: {
                  orderBy: { createdAt: "asc" },
                  take: 1,
                  select: { locationId: true },
                },
                qrCodes: { select: { id: true }, take: 1 },
              },
            })
          : [],
        kitId
          ? db.kit.findFirst({
              where: {
                id: kitId,
                organizationId,
                NOT: { id: { in: archivedKitIds } },
              },
              select: {
                id: true,
                name: true,
                status: true,
                updatedAt: true,
                category: { select: { name: true, color: true } },
                location: { select: { id: true } },
                _count: { select: { assetKits: true } },
                qrCodes: { select: { id: true }, take: 1 },
              },
            })
          : null,
        db.asset.findMany({
          where: { organizationId, id: { notIn: archivedAssetIds } },
          take: 500,
          select: {
            id: true,
            title: true,
            type: true,
            category: { select: { name: true, color: true } },
            assetModel: {
              select: {
                id: true,
                name: true,
                defaultCategory: { select: { name: true, color: true } },
              },
            },
            assetLocations: {
              orderBy: { createdAt: "asc" },
              take: 1,
              select: { locationId: true },
            },
            qrCodes: { select: { id: true }, take: 1 },
          },
          orderBy: { title: "asc" },
        }),
        db.asset.findMany({
          // Inventory groups these individually tracked Assets by AssetModel.
          // No limit here: selecting a model must expose every active unit.
          where: {
            organizationId,
            type: AssetType.INDIVIDUAL,
            assetModelId: { not: null },
            id: { notIn: archivedAssetIds },
          },
          select: {
            id: true,
            title: true,
            status: true,
            updatedAt: true,
            category: { select: { name: true, color: true } },
            assetModel: {
              select: {
                id: true,
                name: true,
                defaultCategory: { select: { name: true, color: true } },
              },
            },
            assetLocations: {
              orderBy: [{ createdAt: "asc" }, { id: "asc" }],
              take: 1,
              select: { locationId: true },
            },
            qrCodes: { select: { id: true }, take: 1 },
          },
          orderBy: [
            { assetModelId: "asc" },
            { createdAt: "asc" },
            { id: "asc" },
          ],
        }),
      ]);

    const asset =
      resolvedAssetIds
        .map((id) => selectedAssets.find((candidate) => candidate.id === id))
        .find((candidate) => Boolean(candidate)) ?? null;

    const item: ItemRecord | null = asset
      ? assetToLabelItem(asset, qrBaseUrl)
      : kit
      ? {
          kind: "kit",
          id: kit.id,
          name: getIoioKitDisplayName(kit),
          unitNumber: getIoioKitPhysicalUnitNumber(kit),
          category: kit.category?.name ?? null,
          categoryColor: kit.category?.color ?? null,
          locationId: kit.location?.id ?? null,
          assetCount: kit._count.assetKits,
          status: kit.status,
          updatedAt: kit.updatedAt,
          qrValue: kit.qrCodes[0]
            ? `${qrBaseUrl}/${encodeURIComponent(kit.qrCodes[0].id)}`
            : undefined,
        }
      : null;

    const assetCandidates = [
      ...new Map(
        [...selectedAssets, ...assets].map((candidate) => [
          candidate.id,
          candidate,
        ])
      ).values(),
    ];
    const assetItems: ItemRecord[] = assetCandidates.map((candidate) =>
      assetToLabelItem(candidate, qrBaseUrl)
    );
    const kitSourcesById = new Map<string, KitSourceRecord>();
    const kitItems: ItemRecord[] = kitPhysicalUnits.flatMap((physicalUnit) => {
      const model = physicalUnit.assetModel;
      if (!model) return [];

      kitSourcesById.set(model.id, {
        id: model.id,
        name: model.name,
        category: model.defaultCategory?.name ?? null,
        categoryColor: model.defaultCategory?.color ?? null,
      });

      return [
        {
          kind: "kit",
          id: physicalUnit.id,
          productId: model.id,
          name: model.name,
          unitNumber: getIoioKitPhysicalUnitNumber({
            name: physicalUnit.title,
          }),
          category:
            physicalUnit.category?.name ?? model.defaultCategory?.name ?? null,
          categoryColor:
            physicalUnit.category?.color ??
            model.defaultCategory?.color ??
            null,
          locationId: physicalUnit.assetLocations[0]?.locationId ?? null,
          status: physicalUnit.status,
          updatedAt: physicalUnit.updatedAt,
          qrValue: physicalUnit.qrCodes[0]
            ? `${qrBaseUrl}/${encodeURIComponent(physicalUnit.qrCodes[0].id)}`
            : undefined,
        },
      ];
    });

    const nativeKitItem: ItemRecord | null = kit
      ? {
          kind: "kit",
          id: kit.id,
          productId: kit.id,
          name: getIoioKitDisplayName(kit),
          unitNumber: getIoioKitPhysicalUnitNumber(kit),
          category: kit.category?.name ?? null,
          categoryColor: kit.category?.color ?? null,
          locationId: kit.location?.id ?? null,
          assetCount: kit._count.assetKits,
          status: kit.status,
          updatedAt: kit.updatedAt,
          qrValue: kit.qrCodes[0]
            ? `${qrBaseUrl}/${encodeURIComponent(kit.qrCodes[0].id)}`
            : undefined,
        }
      : null;
    const kitSources: KitSourceRecord[] = [
      ...[...kitSourcesById.values()].sort((left, right) =>
        left.name.localeCompare(right.name, undefined, {
          numeric: true,
          sensitivity: "base",
        })
      ),
      ...(nativeKitItem
        ? [
            {
              id: nativeKitItem.id,
              name: nativeKitItem.name,
              category: nativeKitItem.category,
              categoryColor: nativeKitItem.categoryColor,
            },
          ]
        : []),
    ];
    const kitUnits = nativeKitItem ? [...kitItems, nativeKitItem] : kitItems;
    const selectedItem: ItemRecord | null = asset ? item : nativeKitItem;

    const orderedAssets = asset
      ? [
          assetItems.find((candidate) => candidate.id === asset.id) ?? item,
          ...assetItems.filter((candidate) => candidate.id !== asset.id),
        ].filter((candidate): candidate is ItemRecord => candidate !== null)
      : assetItems;
    return data(
      payload({
        header: { title: "Labels" },
        locations,
        appBaseUrl: SERVER_URL,
        assets: orderedAssets,
        kits: kitSources,
        kitUnits,
        initialLocationIds: [...new Set(locationIds)],
        initialItemIds: resolvedAssetIds,
        item: selectedItem,
      })
    );
  } catch (cause) {
    const reason = makeShelfError(cause);
    throw data(error(reason), { status: reason.status });
  }
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  { title: data ? appendToMetaTitle(data.header.title) : "Labels" },
];

function shortLocationName(name: string) {
  return normalizeIoioLabelText(
    name.replace(/^(?:section|shelf|container|box)\s+/iu, "").trim()
  );
}

function getPath(id: string, locationsById: Map<string, LocationRecord>) {
  const path: LocationRecord[] = [];
  const seen = new Set<string>();
  let current = locationsById.get(id);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.unshift(current);
    current = current.parentId
      ? locationsById.get(current.parentId)
      : undefined;
  }
  return path;
}

function locationLevel(path: LocationRecord[]) {
  if (path.length <= 1) return "room" as const;
  if (path.length === 2) return "section" as const;
  if (path.length === 3) return "shelf" as const;
  return "container" as const;
}

function makeLocationLabel(
  location: LocationRecord,
  locationsById: Map<string, LocationRecord>,
  overrideLevel: "room" | "section" | "shelf" | "container" | undefined,
  appBaseUrl: string
): IoioLabelData {
  const path = getPath(location.id, locationsById);
  const actualLevel = locationLevel(path);
  const level = overrideLevel ?? actualLevel;
  const roomHeader = path[0]
    ? formatIoioRoomHeader(path[0].name)
    : "Location not recorded";
  const sectionIdentifier = path[1]
    ? getIoioLocationIdentifier(path[1].name, "section")
    : undefined;
  const shelfIdentifier = path[2]
    ? getIoioLocationIdentifier(path[2].name, "shelf", sectionIdentifier)
    : undefined;
  const target =
    path[
      level === "room" ? 0 : level === "section" ? 1 : level === "shelf" ? 2 : 3
    ] ?? location;
  const color = getEffectiveIoioLocationColor({
    location: target,
    locations: [...locationsById.values()],
    locationType: level,
  });
  const code =
    level === "room"
      ? getIoioLocationIdentifier(target.name, "section")
      : level === "section"
      ? getIoioLocationIdentifier(target.name, "section")
      : level === "shelf"
      ? getIoioLocationIdentifier(target.name, "shelf", sectionIdentifier)
      : getIoioLocationIdentifier(target.name, "box", shelfIdentifier);
  const variant =
    level === "room"
      ? "room"
      : level === "section"
      ? "section"
      : level === "shelf"
      ? "shelf"
      : "box";
  const title = level === "container" ? "CONTAINER" : level.toUpperCase();

  return {
    layout:
      variant === "section" || variant === "shelf" || variant === "room"
        ? "section"
        : "horizontal",
    variant,
    color: color.color,
    colorName: color.name,
    code,
    title,
    subtitle: "",
    room: roomHeader,
    headerMeta: roomHeader,
    scanText:
      level === "container"
        ? "Scan for live contents"
        : "Scan to view this location",
    qrValue:
      actualLevel === "container" && level === "container"
        ? `${appBaseUrl}/ioio/browse?location=${encodeURIComponent(
            location.id
          )}`
        : undefined,
  };
}

function makeItemLabel(
  item: ItemRecord,
  locationsById: Map<string, LocationRecord>
): IoioLabelData {
  const locationPathEntries = item.locationId
    ? getPath(item.locationId, locationsById)
    : [];
  const roomHeader = locationPathEntries[0]
    ? formatIoioRoomHeader(locationPathEntries[0].name)
    : "Location not recorded";
  const color = getItemDefaultLabelColor(item, locationsById);
  const colorPresentation = getIoioLabelColor(color);
  const assignedIdentifier =
    item.kind === "kit"
      ? getIoioLocationPathIdentifier(locationPathEntries)
      : null;
  return {
    layout: "horizontal",
    variant: item.kind === "kit" ? "kit" : "item",
    color,
    colorName: colorPresentation.name,
    code: item.kind === "kit" ? "KIT" : "ITEM",
    title:
      item.kind === "kit"
        ? getIoioKitDisplayName(item)
        : normalizeIoioLabelText(item.name),
    subtitle: "",
    unitNumber: item.kind === "kit" ? item.unitNumber : undefined,
    room: roomHeader,
    headerMeta:
      item.kind === "kit" && assignedIdentifier
        ? `${roomHeader} - ${assignedIdentifier}`
        : roomHeader,
    headerRightText: item.kind === "kit" ? "KIT" : undefined,
    scanText: "Scan to view this item",
    qrValue: item.qrValue,
  };
}

function getItemDefaultLabelColor(
  item: ItemRecord,
  locationsById: Map<string, LocationRecord>
) {
  const path = item.locationId ? getPath(item.locationId, locationsById) : [];
  const lastLocation = path.at(-1);
  return lastLocation
    ? getEffectiveIoioLocationColor({
        location: lastLocation,
        locations: [...locationsById.values()],
      }).color
    : getIoioLabelColor(
        item.categoryColor ?? getIoioCategoryColor(item.category)
      ).color;
}

function typeLabel(type: "room" | "section" | "shelf" | "container") {
  return type[0].toUpperCase() + type.slice(1);
}

type LabelType = "room" | "section" | "shelf" | "container" | "item" | "kit";

const IOIO_LABEL_TYPES = ["section", "shelf", "container", "kit"] as const;

function sourceTypeTitle(type: LabelType) {
  return type === "item"
    ? "Individual item"
    : type === "kit"
    ? "Kit"
    : typeLabel(type);
}

function getLabelPdfTitle(labels: IoioLabelData[], type: LabelType) {
  const sourceType = sourceTypeTitle(type);
  const label = labels[0];
  let title = sourceType;

  if (labels.length === 1 && label) {
    const variant = label.variant ?? type;
    switch (variant) {
      case "room":
      case "section":
      case "shelf":
        title = `${typeLabel(variant)} ${label.code}`;
        break;
      case "box":
        title = `Container ${label.code}`;
        break;
      case "container":
        title = `Container ${label.code}`;
        break;
      default:
        title = label.title.trim() || sourceType;
    }
  } else if (labels.length > 1) {
    title = `${sourceType} labels (${labels.length})`;
  }

  return normalizeIoioLabelText(title)
    .replace(/[<>:"/\\|?*]/gu, "-")
    .split("")
    .map((character) =>
      character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
        ? "-"
        : character
    )
    .join("")
    .replace(/\s+/gu, " ")
    .replace(/[. ]+$/u, "")
    .trim();
}

function locationOptionLabel(location: LocationRecord, isRoom = false) {
  return isRoom ? location.name : normalizeIoioLabelText(location.name);
}

export default function LabelsPage() {
  const {
    locations,
    appBaseUrl,
    initialLocationIds,
    initialItemIds,
    item,
    assets,
    kits,
    kitUnits,
  } = useLoaderData<typeof loader>();
  const locationsById = useMemo(
    () => new Map(locations.map((location) => [location.id, location])),
    [locations]
  );
  const initialPath = initialLocationIds[0]
    ? getPath(initialLocationIds[0], locationsById)
    : [];
  const initialLocationType = initialPath.length
    ? locationLevel(initialPath)
    : "shelf";
  const requestedInitialLabelType: LabelType = item
    ? item.kind === "asset"
      ? "item"
      : "kit"
    : initialLocationType;
  // Section and Shelf remain printable label types, but QR is only supported
  // for Containers and inventory items/units.
  const initialLabelType: LabelType =
    requestedInitialLabelType === "room" ||
    (requestedInitialLabelType === "item" && !item)
      ? "shelf"
      : requestedInitialLabelType;
  const initialLocationLabelLevel =
    initialLabelType === "section" ||
    initialLabelType === "shelf" ||
    initialLabelType === "container"
      ? initialLabelType
      : null;
  const initialLocationColor = initialPath.length
    ? getEffectiveIoioLocationColor({
        location: initialPath[initialPath.length - 1],
        locations: [...locationsById.values()],
        locationType: initialLocationType,
      }).color
    : null;
  const [labelType, setLabelType] = useState<LabelType>(initialLabelType);
  const [printSizeKey, setPrintSizeKey] = useState<IoioPrintSizeKey>(() =>
    getIoioDefaultPrintSize(initialLabelType)
  );
  const [roomId, setRoomId] = useState(initialPath[0]?.id ?? "");
  const [sectionId, setSectionId] = useState(initialPath[1]?.id ?? "");
  const [shelfId, setShelfId] = useState(initialPath[2]?.id ?? "");
  const [containerId, setContainerId] = useState(initialPath[3]?.id ?? "");
  const [batchLocationIds, setBatchLocationIds] = useState<string[]>(() =>
    initialLocationLabelLevel
      ? initialLocationIds.filter(
          (id) =>
            locationLevel(getPath(id, locationsById)) ===
            initialLocationLabelLevel
        )
      : []
  );
  const [selectedItemIds, setSelectedItemIds] = useState<string[]>(
    initialItemIds.length
      ? initialItemIds
      : item?.kind === "asset"
      ? [item.id]
      : []
  );
  const [selectedKitSourceId, setSelectedKitSourceId] = useState(
    item?.kind === "kit" ? item.productId ?? item.id : ""
  );
  const [selectedKitUnitIds, setSelectedKitUnitIds] = useState<string[]>(
    item?.kind === "kit" ? [item.id] : []
  );
  const [itemSearch, setItemSearch] = useState("");
  const [qrOverrides, setQrOverrides] = useState<
    Partial<Record<LabelType, boolean>>
  >({});
  const qrSupported = labelType !== "section" && labelType !== "shelf";
  const includeQr =
    qrSupported &&
    (qrOverrides[labelType] ?? getIoioDefaultQrEnabled(labelType));
  const [previewMode, setPreviewMode] = useState<"a4" | "close-up">("a4");
  const [labelColor, setLabelColor] = useState<string>(() =>
    item
      ? getItemDefaultLabelColor(item, locationsById)
      : initialLocationColor ?? "#1565C0"
  );
  const [labelColorWasChosen, setLabelColorWasChosen] = useState(false);
  const [showTypeLabel, setShowTypeLabel] = useState(true);
  const [labelCustomText, setLabelCustomText] = useState("");
  const [qrLogoHref, setQrLogoHref] = useState<string>();
  const [qrLogoLoadError, setQrLogoLoadError] = useState<string | null>(null);
  const [closeUpStageSize, setCloseUpStageSize] = useState({
    width: 0,
    height: 0,
  });
  const closeUpCanvasRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!includeQr) {
      setQrLogoHref(undefined);
      setQrLogoLoadError(null);
      return;
    }

    let active = true;
    setQrLogoHref(undefined);
    setQrLogoLoadError(null);
    void loadIoioQrLogoDataUrl().then(
      (dataUrl) => {
        if (active) setQrLogoHref(dataUrl);
      },
      () => {
        if (active) {
          setQrLogoLoadError(
            "The IOIO logo could not be loaded. Reload the page before printing or exporting labels."
          );
        }
      }
    );
    return () => {
      active = false;
    };
  }, [includeQr]);

  const childrenByParentId = useMemo(() => {
    const result = new Map<string, LocationRecord[]>();
    for (const location of locations) {
      if (!location.parentId) continue;
      result.set(location.parentId, [
        ...(result.get(location.parentId) ?? []),
        location,
      ]);
    }
    for (const [parentId, children] of result) {
      result.set(
        parentId,
        children.sort((left, right) =>
          left.name.localeCompare(right.name, undefined, {
            numeric: true,
            sensitivity: "base",
          })
        )
      );
    }
    return result;
  }, [locations]);
  const rooms = useMemo(
    () =>
      locations
        .filter((location) => !location.parentId)
        .sort((left, right) =>
          left.name.localeCompare(right.name, undefined, {
            numeric: true,
            sensitivity: "base",
          })
        ),
    [locations]
  );
  const allItems = useMemo(() => {
    const byId = new Map<string, ItemRecord>();
    for (const candidate of [...assets, ...kitUnits]) {
      byId.set(candidate.id, candidate);
    }
    if (item) byId.set(item.id, item);
    return [...byId.values()];
  }, [assets, kitUnits, item]);
  const selectedItemKind =
    labelType === "item" ? "asset" : labelType === "kit" ? "kit" : null;
  const selectedIds =
    labelType === "kit" ? selectedKitUnitIds : selectedItemIds;
  const selectedItems = selectedIds
    .map((id) =>
      allItems.find(
        (candidate) =>
          candidate.id === id && candidate.kind === selectedItemKind
      )
    )
    .filter((candidate): candidate is ItemRecord => Boolean(candidate));
  const selectedItem = selectedItems[0];
  const selectedKitSource = kits.find(
    (candidate) => candidate.id === selectedKitSourceId
  );
  const kitUnitsForSource = selectedKitSource
    ? kitUnits.filter(
        (candidate) => candidate.productId === selectedKitSource.id
      )
    : [];
  const allKitUnitsSelected =
    kitUnitsForSource.length > 0 &&
    kitUnitsForSource.every((unit) => selectedKitUnitIds.includes(unit.id));
  const sections = (childrenByParentId.get(roomId) ?? []).filter(
    (location) =>
      locationLevel(getPath(location.id, locationsById)) === "section"
  );
  const shelvesParentId = sectionId || roomId;
  const shelves = (childrenByParentId.get(shelvesParentId) ?? []).filter(
    (location) => locationLevel(getPath(location.id, locationsById)) === "shelf"
  );
  const boxes = (childrenByParentId.get(shelfId) ?? []).filter(
    (location) =>
      locationLevel(getPath(location.id, locationsById)) === "container"
  );
  const selectedLocationId =
    labelType === "room"
      ? roomId
      : labelType === "section"
      ? sectionId
      : labelType === "shelf"
      ? shelfId
      : labelType === "container"
      ? containerId
      : "";
  const siblingOptions =
    labelType === "room"
      ? rooms
      : labelType === "section"
      ? sections
      : labelType === "shelf"
      ? shelves
      : boxes;
  const filteredItems = allItems
    .filter((candidate) => candidate.kind === "asset")
    .filter((candidate) =>
      itemSearch.trim()
        ? `${candidate.name} ${candidate.category ?? ""}`
            .toLocaleLowerCase()
            .includes(itemSearch.trim().toLocaleLowerCase())
        : true
    )
    .slice(0, 100);
  const filteredKits = kits
    .filter((candidate) =>
      itemSearch.trim()
        ? `${candidate.name} ${candidate.category ?? ""}`
            .toLocaleLowerCase()
            .includes(itemSearch.trim().toLocaleLowerCase())
        : true
    )
    .slice(0, 100);
  const kitSourceOptions =
    selectedKitSource &&
    !filteredKits.some((candidate) => candidate.id === selectedKitSource.id)
      ? [selectedKitSource, ...filteredKits]
      : filteredKits;

  useEffect(() => {
    const source =
      labelType === "item" || labelType === "kit" ? selectedItem : null;
    setLabelColorWasChosen(false);
    setLabelColor(
      source
        ? getItemDefaultLabelColor(source, locationsById)
        : getIoioLabelColor(
            selectedLocationId
              ? getEffectiveIoioLocationColor({
                  location: locationsById.get(selectedLocationId),
                  locations: [...locationsById.values()],
                }).color
              : "#1565C0"
          ).color
    );
    if (source?.locationId) {
      const path = getPath(source.locationId, locationsById);
      setRoomId(path[0]?.id ?? "");
      setSectionId(path[1]?.id ?? "");
      setShelfId(path[2]?.id ?? "");
      setContainerId(path[3]?.id ?? "");
    }
  }, [labelType, locationsById, selectedItem, selectedLocationId]);

  const labels = useMemo(() => {
    if (labelType === "item" || labelType === "kit") {
      return selectedItems.map((candidate) =>
        makeItemLabel(candidate, locationsById)
      );
    }
    const ids = batchLocationIds.length
      ? batchLocationIds
      : [selectedLocationId];
    return ids
      .map((id) => locationsById.get(id))
      .filter((location): location is LocationRecord => Boolean(location))
      .sort((left, right) =>
        shortLocationName(left.name).localeCompare(
          shortLocationName(right.name),
          undefined,
          { numeric: true, sensitivity: "base" }
        )
      )
      .map((location) =>
        makeLocationLabel(location, locationsById, labelType, appBaseUrl)
      );
  }, [
    appBaseUrl,
    batchLocationIds,
    labelType,
    locationsById,
    selectedItems,
    selectedLocationId,
  ]);

  const normalizedCustomText = normalizeIoioCustomLabelText(labelCustomText);
  const printableLabels = useMemo(
    () =>
      labels.map((label) => ({
        ...label,
        ...(normalizedCustomText ? { customText: normalizedCustomText } : {}),
        color: labelColorWasChosen ? labelColor : label.color,
        colorName: getIoioLabelColor(
          labelColorWasChosen ? labelColor : label.color
        ).name,
        showTypeLabel,
        ...(includeQr ? {} : { qrValue: undefined }),
      })),
    [
      includeQr,
      labelColor,
      labelColorWasChosen,
      labels,
      normalizedCustomText,
      showTypeLabel,
    ]
  );
  const currentLabel = printableLabels[0];
  const labelLayout =
    currentLabel?.layout ??
    (labelType === "section" ? "section" : "horizontal");
  const printDimensions = getIoioPrintDimensions(
    labelLayout,
    printSizeKey,
    labelType
  );
  const printDimensionsError = getIoioPrintDimensionsError(printDimensions);
  const qrGenerationError = useMemo(
    () =>
      includeQr
        ? printableLabels
            .map((label) => getIoioLabelQrError(label, printDimensions))
            .find((message): message is string => Boolean(message)) ?? null
        : null,
    [includeQr, printableLabels, printDimensions]
  );
  const a4PreviewScale = getIoioA4PreviewScale(printDimensions);
  const a4Capacity = getIoioA4Capacity(printDimensions);
  const previewLabels = printDimensionsError ? [] : printableLabels;
  useEffect(() => {
    const canvas = closeUpCanvasRef.current;
    if (!canvas || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      setCloseUpStageSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      });
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  const closeUpLabelSize = getIoioCloseUpPreviewSize(
    closeUpStageSize.width,
    closeUpStageSize.height,
    printDimensions
  );
  const fitsA4 = fitsIoioA4Portrait(printDimensions);
  const printUnavailableReason = printDimensionsError
    ? printDimensionsError
    : qrGenerationError
    ? qrGenerationError
    : includeQr && !qrLogoHref
    ? qrLogoLoadError ?? "Loading IOIO label branding…"
    : fitsA4
    ? null
    : "This size does not fit the current A4 sheet layout. The preview remains to scale, but Print / PDF is unavailable for this preset.";
  const labelPages =
    !fitsA4 || printDimensionsError
      ? []
      : Array.from(
          {
            length: Math.max(
              1,
              Math.ceil(previewLabels.length / a4Capacity.capacity)
            ),
          },
          (_, pageIndex) =>
            previewLabels.slice(
              pageIndex * a4Capacity.capacity,
              (pageIndex + 1) * a4Capacity.capacity
            )
        );
  function chooseType(nextType: LabelType) {
    setLabelType(nextType);
    setPrintSizeKey(getIoioDefaultPrintSize(nextType));
    if (nextType === "item" || nextType === "kit") {
      if (nextType !== labelType) setSelectedItemIds([]);
      if (nextType === "kit" && nextType !== labelType) {
        setSelectedKitSourceId("");
        setSelectedKitUnitIds([]);
      }
      setBatchLocationIds([]);
      return;
    }
    const nextLocationId =
      nextType === "room"
        ? roomId
        : nextType === "section"
        ? sectionId
        : nextType === "shelf"
        ? shelfId
        : containerId;
    setBatchLocationIds(nextLocationId ? [nextLocationId] : []);
  }

  function stepPrintSize(direction: -1 | 1) {
    const currentIndex = IOIO_PRINT_SIZE_ORDER.indexOf(printSizeKey);
    const nextIndex = Math.min(
      IOIO_PRINT_SIZE_ORDER.length - 1,
      Math.max(0, currentIndex + direction)
    );
    setPrintSizeKey(IOIO_PRINT_SIZE_ORDER[nextIndex]);
  }

  function chooseRoom(nextId: string) {
    setRoomId(nextId);
    setSectionId("");
    setShelfId("");
    setContainerId("");
    setBatchLocationIds(nextId ? [nextId] : []);
  }

  function chooseSection(nextId: string) {
    setSectionId(nextId);
    setShelfId("");
    setContainerId("");
    setBatchLocationIds(nextId ? [nextId] : []);
  }

  function chooseShelf(nextId: string) {
    setShelfId(nextId);
    setContainerId("");
    setBatchLocationIds(nextId ? [nextId] : []);
  }

  function chooseContainer(nextId: string) {
    setContainerId(nextId);
    setBatchLocationIds(nextId ? [nextId] : []);
  }

  function chooseKitSource(nextId: string) {
    setSelectedKitSourceId(nextId);
    const firstUnit = kitUnits.find(
      (candidate) => candidate.productId === nextId
    );
    setSelectedKitUnitIds(firstUnit ? [firstUnit.id] : []);
  }

  function toggleBatchLocation(id: string) {
    setBatchLocationIds((current) =>
      current.includes(id)
        ? current.filter((value) => value !== id)
        : [...current, id]
    );
  }

  function printLabels() {
    if (!currentLabel || printUnavailableReason) return;
    const previousTitle = document.title;
    document.title = getLabelPdfTitle(printableLabels, labelType);
    let titleRestoreTimeout: number | undefined;
    const restoreTitle = () => {
      document.title = previousTitle;
      if (titleRestoreTimeout !== undefined) {
        window.clearTimeout(titleRestoreTimeout);
      }
      window.removeEventListener("afterprint", restoreTitle);
    };
    window.addEventListener("afterprint", restoreTitle, { once: true });
    titleRestoreTimeout = window.setTimeout(restoreTitle, 60_000);
    window.print();
  }

  return (
    <div className="ioio-label-route">
      <Header hideQuickFind classNames="ioio-label-route-header" />
      <div className="ioio-label-workspace mx-auto max-w-7xl px-4 py-1 sm:px-6 lg:px-8">
        <div className="ioio-label-controls ioio-label-page-header mb-1 flex flex-wrap items-start justify-between gap-2">
          <div>
            <h1 className="mt-0.5 text-2xl font-black tracking-tight text-gray-950">
              Label generator
            </h1>
          </div>
        </div>

        <div className="ioio-label-columns grid gap-4 lg:grid-cols-[minmax(18rem,0.95fr)_minmax(0,1.9fr)]">
          <aside className="ioio-label-controls ioio-label-settings space-y-2">
            <section className="ioio-label-step-card rounded-2xl border border-gray-200 bg-white p-2.5 shadow-sm">
              <h2 className="text-base font-bold text-gray-950">
                1. Choose label type
              </h2>
              <p className="mt-1 text-xs text-gray-600">
                Choose what physical level or item you want to label.
              </p>
              <div className="mt-2 grid grid-cols-2 gap-2">
                {IOIO_LABEL_TYPES.map((type) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => chooseType(type)}
                    className={`rounded-lg border p-2 text-sm font-bold ${
                      labelType === type
                        ? "border-gray-950 bg-gray-950 text-white"
                        : "border-gray-300 bg-white text-gray-800 hover:border-red-300 hover:text-red-800"
                    }`}
                  >
                    {sourceTypeTitle(type)}
                  </button>
                ))}
              </div>
            </section>

            <section className="ioio-label-step-card rounded-2xl border border-gray-200 bg-white p-2.5 shadow-sm">
              <h2 className="text-base font-bold text-gray-950">
                2. Choose source
              </h2>
              {labelType === "item" || labelType === "kit" ? (
                <div className="mt-2 space-y-2">
                  <label className="block text-sm font-semibold text-gray-800">
                    Search {labelType === "kit" ? "kits" : "inventory"}
                    <input
                      value={itemSearch}
                      onChange={(event) => setItemSearch(event.target.value)}
                      placeholder={
                        labelType === "kit"
                          ? "Search kits..."
                          : "Search items..."
                      }
                      className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-normal text-gray-900 outline-none focus:border-red-500 focus:ring-2 focus:ring-red-100"
                    />
                  </label>
                  {labelType === "kit" ? (
                    <>
                      <label className="block text-sm font-semibold text-gray-800">
                        Choose kit source
                        <select
                          value={selectedKitSourceId}
                          onChange={(event) =>
                            chooseKitSource(event.target.value)
                          }
                          className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-normal text-gray-900 outline-none focus:border-red-500 focus:ring-2 focus:ring-red-100"
                        >
                          <option value="">Select a kit to label</option>
                          {kitSourceOptions.map((candidate) => (
                            <option key={candidate.id} value={candidate.id}>
                              {candidate.name}
                            </option>
                          ))}
                        </select>
                      </label>

                      {selectedKitSource ? (
                        <fieldset className="rounded-lg border border-gray-200 p-2.5">
                          <legend className="px-1 text-sm font-semibold text-gray-800">
                            Choose physical unit
                          </legend>
                          <button
                            type="button"
                            onClick={() =>
                              setSelectedKitUnitIds(
                                allKitUnitsSelected
                                  ? []
                                  : kitUnitsForSource.map((unit) => unit.id)
                              )
                            }
                            className="mb-1 rounded-md p-1 text-xs font-bold text-red-700 hover:bg-red-50"
                          >
                            {allKitUnitsSelected
                              ? "Deselect all"
                              : "Select all"}
                          </button>
                          <div className="max-h-32 space-y-1 overflow-y-auto">
                            {kitUnitsForSource.map((unit) => (
                              <label
                                key={unit.id}
                                className="flex items-center gap-2 rounded-md p-1 text-xs text-gray-700 hover:bg-gray-50"
                              >
                                <input
                                  type="checkbox"
                                  aria-label={`Select physical unit ${getIoioPhysicalUnitDisplayName(
                                    {
                                      logicalProductName: unit.name,
                                      unitNumber: unit.unitNumber,
                                      missingUnitLabel: "Unit number missing",
                                    }
                                  )}`}
                                  checked={selectedKitUnitIds.includes(unit.id)}
                                  onChange={(event) =>
                                    setSelectedKitUnitIds((current) =>
                                      event.target.checked
                                        ? [...current, unit.id]
                                        : current.filter((id) => id !== unit.id)
                                    )
                                  }
                                  className="size-4 shrink-0 accent-red-700"
                                />
                                <span className="font-bold text-gray-900">
                                  {getIoioPhysicalUnitDisplayName({
                                    logicalProductName: unit.name,
                                    unitNumber: unit.unitNumber,
                                    missingUnitLabel: "Unit number missing",
                                  })}
                                </span>
                              </label>
                            ))}
                            {kitUnitsForSource.length === 0 ? (
                              <p className="px-1 py-2 text-xs text-gray-500">
                                No active physical units are available for this
                                Kit.
                              </p>
                            ) : null}
                          </div>
                          {selectedKitUnitIds.length > 1 ? (
                            <p className="mt-2 text-xs font-semibold text-gray-600">
                              {selectedKitUnitIds.length} physical units
                              selected for batch printing.
                            </p>
                          ) : null}
                        </fieldset>
                      ) : null}
                    </>
                  ) : (
                    <>
                      <label className="block text-sm font-semibold text-gray-800">
                        Individual item
                        <select
                          value={selectedItems[0]?.id ?? ""}
                          onChange={(event) =>
                            setSelectedItemIds(
                              event.target.value ? [event.target.value] : []
                            )
                          }
                          className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-normal text-gray-900 outline-none focus:border-red-500 focus:ring-2 focus:ring-red-100"
                        >
                          <option value="">Select item</option>
                          {filteredItems.map((candidate) => (
                            <option key={candidate.id} value={candidate.id}>
                              {normalizeIoioLabelText(candidate.name)}
                            </option>
                          ))}
                        </select>
                      </label>
                      <p className="text-xs text-gray-500">
                        Shelf data fills the name, room, and QR target
                        automatically.
                      </p>
                    </>
                  )}
                </div>
              ) : (
                <div className="mt-2 space-y-2">
                  <label className="block text-sm font-semibold text-gray-800">
                    Room
                    <select
                      value={roomId}
                      onChange={(event) => chooseRoom(event.target.value)}
                      className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-normal text-gray-900 outline-none focus:border-red-500 focus:ring-2 focus:ring-red-100"
                    >
                      <option value="">Select room</option>
                      {rooms.map((room) => (
                        <option key={room.id} value={room.id}>
                          {locationOptionLabel(room, true)}
                        </option>
                      ))}
                    </select>
                  </label>

                  {labelType !== "room" ? (
                    <label className="block text-sm font-semibold text-gray-800">
                      Section{labelType === "shelf" ? " (optional)" : ""}
                      <select
                        value={sectionId}
                        onChange={(event) => chooseSection(event.target.value)}
                        className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-normal text-gray-900 outline-none focus:border-red-500 focus:ring-2 focus:ring-red-100"
                      >
                        <option value="">
                          {labelType === "shelf"
                            ? "Use shelves directly in this room"
                            : "Select section"}
                        </option>
                        {sections.map((section) => (
                          <option key={section.id} value={section.id}>
                            {normalizeIoioLabelText(section.name)}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}

                  {labelType === "shelf" || labelType === "container" ? (
                    <label className="block text-sm font-semibold text-gray-800">
                      Shelf
                      <select
                        value={shelfId}
                        onChange={(event) => chooseShelf(event.target.value)}
                        className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-normal text-gray-900 outline-none focus:border-red-500 focus:ring-2 focus:ring-red-100"
                      >
                        <option value="">Select shelf</option>
                        {shelves.map((shelf) => (
                          <option key={shelf.id} value={shelf.id}>
                            {normalizeIoioLabelText(shelf.name)}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}

                  {labelType === "container" ? (
                    <label className="block text-sm font-semibold text-gray-800">
                      Container
                      <select
                        value={containerId}
                        onChange={(event) =>
                          chooseContainer(event.target.value)
                        }
                        className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-normal text-gray-900 outline-none focus:border-red-500 focus:ring-2 focus:ring-red-100"
                      >
                        <option value="">Select container</option>
                        {boxes.map((box) => (
                          <option key={box.id} value={box.id}>
                            {normalizeIoioLabelText(box.name)}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}

                  {selectedLocationId && siblingOptions.length > 1 ? (
                    <div className="border-t border-gray-100 pt-3">
                      <p className="text-xs font-bold uppercase tracking-wide text-gray-500">
                        Batch labels
                      </p>
                      <div className="ioio-label-batch-list mt-2 max-h-40 space-y-1 overflow-y-auto pr-1">
                        {siblingOptions.map((location) => (
                          <label
                            key={location.id}
                            className="flex items-center gap-2 text-sm text-gray-700"
                          >
                            <input
                              type="checkbox"
                              checked={batchLocationIds.includes(location.id)}
                              onChange={() => toggleBatchLocation(location.id)}
                              className="size-4 accent-red-700"
                            />
                            {normalizeIoioLabelText(location.name)}
                          </label>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              )}
            </section>

            <section className="ioio-label-step-card rounded-2xl border border-gray-200 bg-white p-2.5 shadow-sm">
              <h2 className="text-base font-bold text-gray-950">
                3. Label style
              </h2>
              <div className="mt-2 space-y-1.5">
                <label className="block text-sm font-semibold text-gray-800">
                  Label colour
                  <select
                    value={labelColor}
                    onChange={(event) => {
                      setLabelColorWasChosen(true);
                      setLabelColor(event.target.value);
                    }}
                    className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-normal text-gray-900 outline-none focus:border-red-500 focus:ring-2 focus:ring-red-100"
                  >
                    {IOIO_LABEL_COLORS.map((color) => (
                      <option key={color.color} value={color.color}>
                        {color.name} {color.color}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-sm font-semibold text-gray-800">
                  Label text (optional)
                  <input
                    type="text"
                    value={labelCustomText}
                    maxLength={IOIO_LABEL_CUSTOM_TEXT_MAX_LENGTH}
                    onChange={(event) =>
                      setLabelCustomText(
                        normalizeIoioCustomLabelText(event.target.value)
                      )
                    }
                    placeholder="e.g. Workshop Kit"
                    className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-normal text-gray-900 outline-none placeholder:text-gray-400 focus:border-red-500 focus:ring-2 focus:ring-red-100"
                  />
                  <span className="mt-1 block text-xs font-normal text-gray-500">
                    Adds a small custom name to the printed label.
                  </span>
                </label>
                {qrSupported ? (
                  <label className="flex items-center gap-2 text-sm font-semibold text-gray-800">
                    <input
                      type="checkbox"
                      checked={includeQr}
                      onChange={(event) =>
                        setQrOverrides((current) => ({
                          ...current,
                          [labelType]: event.target.checked,
                        }))
                      }
                      className="size-4 accent-red-700"
                    />
                    Include QR
                  </label>
                ) : null}
                {labelType !== "item" ? (
                  <label className="flex items-center gap-2 text-sm font-semibold text-gray-800">
                    <input
                      type="checkbox"
                      checked={showTypeLabel}
                      onChange={(event) =>
                        setShowTypeLabel(event.target.checked)
                      }
                      className="size-4 accent-red-700"
                    />
                    Show type label
                  </label>
                ) : null}
              </div>
            </section>

            <section className="ioio-label-step-card rounded-2xl border border-gray-200 bg-white p-2.5 shadow-sm">
              <h2 className="text-base font-bold text-gray-950">
                4. Print size
              </h2>
              <p className="mt-1 text-xs text-gray-600">
                Choose the physical size for every label in this batch.
              </p>
              <div className="mt-2 flex items-center justify-between gap-2">
                <button
                  type="button"
                  aria-label="Decrease size"
                  title="Decrease size"
                  disabled={printSizeKey === IOIO_PRINT_SIZE_ORDER[0]}
                  onClick={() => stepPrintSize(-1)}
                  className="inline-flex size-9 items-center justify-center rounded-lg border border-gray-300 bg-white text-lg font-bold text-gray-800 hover:border-red-300 hover:text-red-800 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <span aria-hidden="true">−</span>
                </button>
                {IOIO_PRINT_SIZE_PRESETS.map((preset) => (
                  <button
                    key={preset.key}
                    type="button"
                    aria-label={
                      preset.key === "s"
                        ? "Small"
                        : preset.key === "m"
                        ? "Medium"
                        : "Large"
                    }
                    title={
                      preset.key === "s"
                        ? "Small"
                        : preset.key === "m"
                        ? "Medium"
                        : "Large"
                    }
                    aria-pressed={printSizeKey === preset.key}
                    onClick={() => setPrintSizeKey(preset.key)}
                    className={`inline-flex size-9 items-center justify-center rounded-lg border text-sm font-black ${
                      printSizeKey === preset.key
                        ? "border-red-700 bg-red-700 text-white"
                        : "border-gray-300 bg-white text-gray-800 hover:border-red-300 hover:text-red-800"
                    }`}
                  >
                    {preset.label}
                  </button>
                ))}
                <button
                  type="button"
                  aria-label="Increase size"
                  title="Increase size"
                  disabled={
                    printSizeKey ===
                    IOIO_PRINT_SIZE_ORDER[IOIO_PRINT_SIZE_ORDER.length - 1]
                  }
                  onClick={() => stepPrintSize(1)}
                  className="inline-flex size-9 items-center justify-center rounded-lg border border-gray-300 bg-white text-lg font-bold text-gray-800 hover:border-red-300 hover:text-red-800 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <span aria-hidden="true">+</span>
                </button>
              </div>

              <div className="ioio-label-size-summary mt-2 flex items-center justify-between gap-3 rounded-lg bg-red-50 px-3 py-2">
                <span className="text-xs font-bold uppercase tracking-wide text-red-800">
                  Size: {printSizeKey.toUpperCase()}
                </span>
                <span
                  className="text-sm font-black text-gray-950"
                  aria-live="polite"
                >
                  {formatIoioDimension(printDimensions.widthMm)} ×{" "}
                  {formatIoioDimension(printDimensions.heightMm)} mm
                </span>
              </div>

              {printUnavailableReason ? (
                <p
                  className="mt-2 text-[11px] leading-4 text-red-700"
                  role="alert"
                >
                  {printUnavailableReason}
                </p>
              ) : (
                <p className="mt-2 text-[11px] leading-4 text-gray-500">
                  A4 estimate: {a4Capacity.columns} × {a4Capacity.rows} labels
                  per sheet with {IOIO_A4.gapMm} mm gaps. Print at 100% or
                  Actual size.
                </p>
              )}
            </section>
          </aside>

          <main className="ioio-label-preview-column min-w-0 lg:sticky lg:top-4">
            <div className="ioio-label-controls mb-2 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-lg font-bold text-gray-950">Preview</h2>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <p className="text-xs font-bold text-gray-500">
                  {formatIoioDimension(printDimensions.widthMm)} ×{" "}
                  {formatIoioDimension(printDimensions.heightMm)} mm
                </p>
                <div
                  className="flex rounded-lg border border-gray-300 bg-white p-0.5"
                  role="group"
                  aria-label="Preview mode"
                >
                  <button
                    type="button"
                    aria-pressed={previewMode === "a4"}
                    onClick={() => setPreviewMode("a4")}
                    className={`rounded-md px-2 py-1 text-xs font-bold ${
                      previewMode === "a4"
                        ? "bg-gray-900 text-white"
                        : "text-gray-600 hover:bg-gray-100"
                    }`}
                  >
                    A4 scale
                  </button>
                  <button
                    type="button"
                    aria-pressed={previewMode === "close-up"}
                    onClick={() => setPreviewMode("close-up")}
                    className={`rounded-md px-2 py-1 text-xs font-bold ${
                      previewMode === "close-up"
                        ? "bg-gray-900 text-white"
                        : "text-gray-600 hover:bg-gray-100"
                    }`}
                  >
                    Close-up
                  </button>
                </div>
              </div>
            </div>
            <div className="ioio-label-preview-scroll-area">
              {fitsA4 && !printDimensionsError ? (
                labelPages.map((page, pageIndex) => (
                  <div
                    key={`label-page-${pageIndex}`}
                    className={`ioio-label-sheet ioio-label-a4-paper ${
                      previewMode === "close-up"
                        ? "ioio-label-preview-a4-hidden"
                        : ""
                    } ${
                      pageIndex < labelPages.length - 1
                        ? "ioio-label-sheet-page"
                        : ""
                    }`}
                    style={
                      {
                        "--ioio-print-columns": a4Capacity.columns,
                        "--ioio-print-label-width": `${printDimensions.widthMm}mm`,
                        "--ioio-print-label-height": `${printDimensions.heightMm}mm`,
                        "--ioio-label-gap": `${IOIO_A4.gapMm}mm`,
                        "--ioio-a4-columns":
                          page.length === 1 ? 1 : a4Capacity.columns,
                        "--ioio-a4-label-width": `${a4PreviewScale.widthPercent}%`,
                        "--ioio-a4-label-height": `${a4PreviewScale.heightPercent}%`,
                        "--ioio-a4-gap-x": `${a4PreviewScale.gapXPercent}%`,
                        "--ioio-a4-gap-y": `${a4PreviewScale.gapYPercent}%`,
                      } as CSSProperties
                    }
                  >
                    {page.length ? (
                      page.map((label, index) => (
                        <div
                          key={`${label.code}-${pageIndex}-${index}`}
                          className="ioio-print-label ioio-a4-label"
                        >
                          <IoioLabelPreview
                            label={label}
                            size={printDimensions}
                            logoHref={qrLogoHref}
                            logoError={qrLogoLoadError}
                          />
                        </div>
                      ))
                    ) : (
                      <div className="ioio-label-a4-empty">
                        {printDimensionsError ??
                          "Choose a label type and source on the left."}
                      </div>
                    )}
                  </div>
                ))
              ) : printDimensionsError ? (
                <div className="ioio-label-a4-paper ioio-label-a4-empty">
                  {printDimensionsError}
                </div>
              ) : (
                <div
                  className={`ioio-label-a4-comparison-viewport ${
                    previewMode === "close-up"
                      ? "ioio-label-preview-a4-hidden"
                      : ""
                  }`}
                >
                  {previewLabels[0] ? (
                    <div
                      className="ioio-label-a4-comparison-stage"
                      style={
                        {
                          width: `${
                            Math.max(IOIO_A4.widthMm, printDimensions.widthMm) *
                            2
                          }px`,
                          height: `${
                            Math.max(
                              IOIO_A4.heightMm,
                              printDimensions.heightMm
                            ) * 2
                          }px`,
                          "--ioio-a4-outline-width": `${IOIO_A4.widthMm * 2}px`,
                          "--ioio-a4-outline-height": `${
                            IOIO_A4.heightMm * 2
                          }px`,
                          "--ioio-a4-label-width": `${
                            printDimensions.widthMm * 2
                          }px`,
                          "--ioio-a4-label-height": `${
                            printDimensions.heightMm * 2
                          }px`,
                        } as CSSProperties
                      }
                    >
                      <div className="ioio-label-a4-comparison-paper" />
                      <div className="ioio-label-a4-comparison-label">
                        <IoioLabelPreview
                          label={previewLabels[0]}
                          size={printDimensions}
                          logoHref={qrLogoHref}
                          logoError={qrLogoLoadError}
                        />
                      </div>
                    </div>
                  ) : (
                    <div className="ioio-label-a4-empty">
                      Choose a label type and source on the left.
                    </div>
                  )}
                </div>
              )}
              <div
                ref={closeUpCanvasRef}
                className={`ioio-label-close-up-canvas ${
                  previewMode === "a4"
                    ? "ioio-label-preview-close-up-hidden"
                    : ""
                }`}
              >
                {previewLabels.length ? (
                  previewLabels.map((label, index) => (
                    <div
                      key={`close-up-${label.code}-${index}`}
                      className={`ioio-label-close-up-label ${
                        label.layout === "section"
                          ? "ioio-label-close-up-label-section"
                          : ""
                      }`}
                      style={{
                        width: `${closeUpLabelSize.width}px`,
                        height: `${closeUpLabelSize.height}px`,
                      }}
                    >
                      <IoioLabelPreview
                        label={label}
                        size={printDimensions}
                        logoHref={qrLogoHref}
                        logoError={qrLogoLoadError}
                      />
                    </div>
                  ))
                ) : (
                  <div className="ioio-label-a4-empty">
                    {printDimensionsError ??
                      "Choose a label type and source on the left."}
                  </div>
                )}
              </div>
              {previewMode === "a4" ? (
                <p className="ioio-label-a4-caption" aria-label="A4 paper size">
                  {fitsA4
                    ? "A4 · 210 × 297 mm"
                    : "A4 outline at the same scale · label exceeds the sheet"}
                </p>
              ) : null}
            </div>
            <div className="ioio-label-controls ioio-label-preview-actions mt-1 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                disabled={!currentLabel || Boolean(printUnavailableReason)}
                onClick={printLabels}
                className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-bold text-gray-800 hover:border-red-300 hover:bg-red-50 hover:text-red-800 disabled:cursor-not-allowed disabled:text-gray-400"
              >
                Print / PDF
              </button>
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
