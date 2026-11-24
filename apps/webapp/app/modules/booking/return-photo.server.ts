import type { Asset, Booking, Organization } from "@prisma/client";
import { db } from "~/database/db.server";
import { getSupabaseAdmin } from "~/integrations/supabase/client";
import {
  DEFAULT_MAX_IMAGE_UPLOAD_SIZE,
  PUBLIC_BUCKET,
} from "~/utils/constants";
import { ShelfError } from "~/utils/error";
import { getFileUploadPath, parseFileFormData } from "~/utils/storage.server";

const label = "Booking";

function isImageFile(value: FormDataEntryValue | null): value is File {
  return (
    typeof File !== "undefined" &&
    value instanceof File &&
    value.size > 0 &&
    value.type.startsWith("image/")
  );
}

export async function prepareBookingReturnPhoto({
  formData,
  request,
  bookingId,
  organizationId,
  assetIds,
}: {
  formData: FormData;
  request: Request;
  bookingId: Booking["id"];
  organizationId: Organization["id"];
  assetIds?: Asset["id"][];
}) {
  const requiredRows = await db.bookingAsset.findMany({
    where: {
      bookingId,
      asset: {
        organizationId,
        requiresReturnPhoto: true,
        ...(assetIds?.length ? { id: { in: assetIds } } : {}),
      },
    },
    select: { asset: { select: { id: true, title: true } } },
  });

  if (requiredRows.length === 0) return null;

  const file = formData.get("image");
  if (!isImageFile(file)) {
    throw new ShelfError({
      cause: null,
      title: "Return photo required",
      message: "Add a photo before returning this item.",
      label,
      status: 400,
      shouldBeCaptured: false,
    });
  }

  const parsed = await parseFileFormData({
    request,
    bucketName: PUBLIC_BUCKET,
    newFileName: getFileUploadPath({
      organizationId,
      type: "booking-returns",
      typeId: bookingId,
    }),
    resizeOptions: { width: 1600, withoutEnlargement: true },
    generateThumbnail: true,
    thumbnailSize: 160,
    maxFileSize: DEFAULT_MAX_IMAGE_UPLOAD_SIZE,
  });

  const image = parsed.get("image");
  if (typeof image !== "string") {
    throw new ShelfError({
      cause: null,
      message: "The return photo could not be uploaded.",
      label,
      status: 400,
      shouldBeCaptured: false,
    });
  }

  let imagePath = image;
  let thumbnailPath: string | undefined;
  try {
    const parsedImage = JSON.parse(image) as {
      originalPath?: string;
      thumbnailPath?: string;
    };
    imagePath = parsedImage.originalPath ?? image;
    thumbnailPath = parsedImage.thumbnailPath;
  } catch {
    // Older storage adapters can return a plain path instead of JSON.
  }

  const { data } = getSupabaseAdmin()
    .storage.from(PUBLIC_BUCKET)
    .getPublicUrl(imagePath);
  const thumbnailUrl = thumbnailPath
    ? getSupabaseAdmin().storage.from(PUBLIC_BUCKET).getPublicUrl(thumbnailPath)
        .data.publicUrl
    : null;

  return {
    imageUrl: data.publicUrl,
    thumbnailUrl,
    assetTitles: requiredRows.map((row) => row.asset.title),
  };
}

export function formatReturnPhotoNote({
  imageUrl,
  assetTitles,
}: {
  imageUrl: string;
  assetTitles: string[];
}) {
  const items = assetTitles.join(", ");
  return `Return photo for ${items}:\n\n![Return photo](${imageUrl})`;
}
