import { randomUUID } from "node:crypto";
import { AssetType } from "@prisma/client";
import { db } from "~/database/db.server";
import { recordEvent } from "~/modules/activity-event/service.server";
import { createNote } from "~/modules/note/service.server";
import { createReport } from "~/modules/report-found/service.server";

/** Mark a returned asset unavailable and create its normal Broken items report. */
export async function disableReturnedAssetFromUse({
  assetId,
  organizationId,
  userId,
  note = "",
}: {
  assetId: string;
  organizationId: string;
  userId: string;
  note?: string;
}) {
  const safeNote = note.trim();
  await db.$transaction(async (tx) => {
    const asset = await tx.asset.findFirst({
      where: { id: assetId, organizationId },
      select: {
        id: true,
        title: true,
        type: true,
        status: true,
        availableToBook: true,
      },
    });
    if (!asset) throw new Error("The returned item could not be found.");

    if (asset.type === AssetType.INDIVIDUAL) {
      if (asset.status !== "AVAILABLE") {
        throw new Error(
          "This unit must be checked in before it can be disabled from use."
        );
      }
      const [custody, activeCheckout] = await Promise.all([
        tx.custody.findFirst({
          where: { assetId: asset.id },
          select: { id: true },
        }),
        tx.bookingAsset.findFirst({
          where: {
            assetId: asset.id,
            checkedOutAt: { not: null },
            checkedInAt: null,
            booking: {
              organizationId,
              status: { in: ["ONGOING", "OVERDUE"] },
            },
          },
          select: { id: true },
        }),
      ]);
      if (custody || activeCheckout) {
        throw new Error(
          "This unit is still checked out or assigned to someone. Release it before disabling it."
        );
      }
    }

    await tx.asset.update({
      where: { id: asset.id, organizationId },
      data: { availableToBook: false },
    });
    const reporter = await tx.user.findUniqueOrThrow({
      where: { id: userId },
      select: { email: true },
    });
    const description = safeNote || "Disabled after return inspection.";
    const report = await createReport({
      email: reporter.email,
      content: `[IOIO staff report]\nIssue: ITEM_DAMAGED\nDescription: ${description}`,
      assetId: asset.id,
      client: tx,
    });
    await tx.ioioWriteOperation.create({
      data: {
        operationType: "REPORT_PROBLEM",
        source: "IOIO_STAFF_RETURN_INSPECTION",
        status: "SUCCEEDED",
        idempotencyKey: randomUUID(),
        userId,
        organizationId,
        reportType: "ITEM_DAMAGED",
        description,
        assetId: asset.id,
        resultReportId: report.id,
        completedAt: new Date(),
      },
    });
    await createNote(
      {
        content: `Marked broken after return inspection.${
          safeNote ? ` ${safeNote}` : ""
        }`,
        type: "UPDATE",
        userId,
        assetId: asset.id,
        organizationId,
      },
      tx
    );
    await recordEvent(
      {
        organizationId,
        actorUserId: userId,
        action: "ASSET_STATUS_CHANGED",
        entityType: "ASSET",
        entityId: asset.id,
        assetId: asset.id,
        field: "availableToBook",
        fromValue: asset.availableToBook,
        toValue: false,
        meta: {
          source: "STAFF_RETURN_INSPECTION",
          action: "broken",
          note: safeNote || null,
        },
      },
      tx
    );
  });
}
